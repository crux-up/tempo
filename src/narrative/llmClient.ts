import Anthropic, {
  APIError,
  AuthenticationError,
  PermissionDeniedError,
  RateLimitError,
  type ClientOptions,
} from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { AppError, LlmError, NotConfiguredError, UpstreamRateLimitedError } from '../errors.js';
import type { Logger } from '../logger.js';
import type { FactSheet } from './factSheet.js';
import { SYSTEM_PROMPT } from './prompt.js';
import { NarrativeDraftSchema, type NarrativeDraft } from './schema.js';

type MessageParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
type Message = Anthropic.Beta.Messages.BetaMessage;

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};
/** `model` is the model that wrote the draft; a server-side fallback can make it differ from the requested one. */
export type NarrativeModelResult = { draft: NarrativeDraft; model: string; usage: TokenUsage };

export interface NarrativeModel {
  draft(sheet: FactSheet): Promise<NarrativeModelResult>;
}

/** The one SDK call the model needs; tests replace it so no request leaves the process. */
export type CreateMessage = (params: MessageParams, options: { signal: AbortSignal }) => Promise<Message>;

/**
 * Time limits for one `draft()` call. `attemptTimeoutMs` bounds each attempt (SDK retries included);
 * `deadlineMs` bounds the whole call; the retry for invalid output runs only when at least `minRetryBudgetMs` of
 * the deadline remains. The retry check reads the injected clock (`now`); the abort timers always use real time.
 */
export type ModelLimits = { attemptTimeoutMs: number; deadlineMs: number; minRetryBudgetMs: number };

const DEFAULT_LIMITS: ModelLimits = { attemptTimeoutMs: 120_000, deadlineMs: 150_000, minRetryBudgetMs: 60_000 };
const MAX_TOKENS = 16_000;
const SDK_MAX_RETRIES = 1;
/** Attempts per draft: the first, plus one retry when a finished answer is not valid JSON for the schema. */
const MAX_ATTEMPTS = 2;
const DEFAULT_RETRY_AFTER_SECONDS = 60;
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const OUTPUT_FORMAT = betaZodOutputFormat(NarrativeDraftSchema);

export const EMPTY_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

const REFUSED = 'The model declined to analyse this data';
const TRUNCATED = 'The model ran out of output tokens before finishing the narrative';
const INVALID_OUTPUT = 'The model returned output that does not match the narrative schema';
const TIMED_OUT = 'The model did not answer in time';

/** Pinned, so an ANTHROPIC_BASE_URL in the environment cannot send the key and fact sheets to another host. */
const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';

/**
 * Time limits are enforced by the abort signal passed with each call, so a timed-out attempt is never retried by
 * the SDK. The SDK's own timeout is only a backstop at the request deadline.
 */
export function anthropicClientOptions(apiKey: string): ClientOptions {
  return { apiKey, baseURL: ANTHROPIC_BASE_URL, maxRetries: SDK_MAX_RETRIES, timeout: DEFAULT_LIMITS.deadlineMs };
}

function buildRequest(model: string, sheet: FactSheet): MessageParams {
  return {
    model,
    max_tokens: MAX_TOKENS,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'high', format: OUTPUT_FORMAT },
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: JSON.stringify(sheet) }],
    betas: [FALLBACK_BETA],
    fallbacks: 'default',
  };
}

/**
 * The text the serving model wrote: text blocks after the last `fallback` block (output before it belongs to a
 * model that declined), joined.
 */
function finalText(message: Message): string | null {
  const lastFallback = message.content.findLastIndex((block) => block.type === 'fallback');
  const texts = message.content
    .slice(lastFallback + 1)
    .flatMap((block) => (block.type === 'text' ? [block.text] : []));
  return texts.length === 0 ? null : texts.join('');
}

/** The draft in the response's text, or null when it is missing, not JSON or does not match the schema. */
function parseDraft(message: Message): NarrativeDraft | null {
  const text = finalText(message);
  if (text === null) return null;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = NarrativeDraftSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

/** Token counts for the message: the sum over `usage.iterations` when present (fallback hops), else the totals. */
function messageUsage(message: Message): TokenUsage {
  const { usage } = message;
  const iterations = usage.iterations ?? [];
  if (iterations.length === 0) {
    return {
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cacheReadTokens: usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
    };
  }
  return iterations.reduce<TokenUsage>(
    (sum, it) => ({
      inputTokens: sum.inputTokens + it.input_tokens,
      outputTokens: sum.outputTokens + it.output_tokens,
      cacheReadTokens: sum.cacheReadTokens + (it.cache_read_input_tokens ?? 0),
      cacheWriteTokens: sum.cacheWriteTokens + (it.cache_creation_input_tokens ?? 0),
    }),
    EMPTY_USAGE,
  );
}

export const addUsage = (a: TokenUsage, b: TokenUsage): TokenUsage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
  cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
});

function retryAfterSeconds(error: RateLimitError): number {
  const seconds = Number(error.headers.get('retry-after'));
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : DEFAULT_RETRY_AFTER_SECONDS;
}

/** Maps SDK failures to problem errors. Upstream messages are not passed on: they are not written for our clients. */
function toAppError(error: unknown, timedOut: boolean): AppError {
  if (timedOut) return new LlmError(TIMED_OUT);
  if (error instanceof AppError) return error;
  if (error instanceof AuthenticationError) return new NotConfiguredError('ANTHROPIC_API_KEY was rejected');
  if (error instanceof PermissionDeniedError) {
    return new NotConfiguredError('ANTHROPIC_API_KEY lacks access to the configured model');
  }
  if (error instanceof RateLimitError) return new UpstreamRateLimitedError(retryAfterSeconds(error), 'Anthropic');
  if (error instanceof APIError) {
    const status = error.status === undefined ? 'no response' : `status ${error.status}`;
    return new LlmError(`The language model request failed (${status})`);
  }
  return new LlmError('The language model request failed');
}

/** What an operator needs to trace a failure, without upstream message text. */
function failureDetails(error: unknown): Record<string, unknown> {
  // SDK error classes leave `name` as "Error"; the constructor name says which one it was.
  const cause = error instanceof Error ? (error.name === 'Error' ? error.constructor.name : error.name) : typeof error;
  if (!(error instanceof APIError)) return { cause };
  return { cause, status: error.status ?? null, requestId: error.requestID ?? null };
}

function sdkCreateMessage(apiKey: string): CreateMessage {
  const client = new Anthropic(anthropicClientOptions(apiKey));
  return (params, options) => client.beta.messages.create(params, options);
}

/**
 * Drafts a narrative with structured output, within `limits` (defaults: 120 s per attempt, 150 s overall).
 * A refusal, any stop reason other than end_turn, or a timeout fails at once. A finished answer that is not valid
 * JSON for the schema is requested once more with the same request when enough of the deadline remains, then
 * fails. The SDK retries a rate limit, overload or connection failure once.
 */
export function createAnthropicNarrativeModel(opts: {
  apiKey: string;
  model: string;
  logger: Logger;
  createMessage?: CreateMessage;
  limits?: Partial<ModelLimits>;
  now?: () => number;
}): NarrativeModel {
  const { logger } = opts;
  const send = opts.createMessage ?? sdkCreateMessage(opts.apiKey);
  const limits: ModelLimits = { ...DEFAULT_LIMITS, ...opts.limits };
  const now = opts.now ?? (() => performance.now());

  return {
    async draft(sheet) {
      const request = buildRequest(opts.model, sheet);
      const deadline = AbortSignal.timeout(limits.deadlineMs);
      const callStartedAt = now();
      let usage = EMPTY_USAGE;

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        if (attempt > 1 && limits.deadlineMs - (now() - callStartedAt) < limits.minRetryBudgetMs) {
          logger.warn({ model: opts.model, attempt }, 'Skipping language model retry: deadline too close');
          break;
        }
        const signal = AbortSignal.any([deadline, AbortSignal.timeout(limits.attemptTimeoutMs)]);
        const startedAt = now();
        let message: Message;
        try {
          message = await send(request, { signal });
        } catch (error) {
          const mapped = toAppError(error, signal.aborted);
          logger.warn(
            {
              model: opts.model,
              attempt,
              latencyMs: Math.round(now() - startedAt),
              error: mapped.name,
              ...failureDetails(error),
            },
            'Language model call failed',
          );
          throw mapped;
        }

        const attemptUsage = messageUsage(message);
        usage = addUsage(usage, attemptUsage);
        const draft = message.stop_reason === 'end_turn' ? parseDraft(message) : null;
        logger.info(
          {
            requestedModel: opts.model,
            model: message.model,
            attempt,
            stopReason: message.stop_reason,
            refusalCategory: message.stop_details?.category ?? null,
            latencyMs: Math.round(now() - startedAt),
            ...attemptUsage,
            validOutput: draft !== null,
          },
          'Language model call finished',
        );
        if (message.stop_reason === 'refusal') throw new LlmError(REFUSED);
        if (message.stop_reason === 'max_tokens') throw new LlmError(TRUNCATED);
        if (message.stop_reason !== 'end_turn') {
          throw new LlmError(`The model stopped before finishing the narrative (${message.stop_reason ?? 'unknown'})`);
        }
        if (draft) return { draft, model: message.model, usage };
      }
      throw new LlmError(INVALID_OUTPUT);
    },
  };
}
