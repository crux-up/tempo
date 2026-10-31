import Anthropic, { APIError, AuthenticationError, RateLimitError } from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { AppError, LlmError, NotConfiguredError, UpstreamRateLimitedError } from '../errors.js';
import type { Logger } from '../logger.js';
import type { FactSheet } from './factSheet.js';
import { SYSTEM_PROMPT } from './prompt.js';
import { NarrativeDraftSchema, type NarrativeDraft } from './schema.js';

type MessageParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
type Message = Anthropic.Beta.Messages.BetaMessage;

export type TokenUsage = { inputTokens: number; outputTokens: number; cacheReadTokens: number };
/** `model` is the model that wrote the draft; a server-side fallback can make it differ from the requested one. */
export type NarrativeModelResult = { draft: NarrativeDraft; model: string; usage: TokenUsage };

export interface NarrativeModel {
  draft(sheet: FactSheet): Promise<NarrativeModelResult>;
}

/** The one SDK call the model needs; tests replace it so no request leaves the process. */
export type CreateMessage = (params: MessageParams) => Promise<Message>;

const MAX_TOKENS = 16_000;
const TIMEOUT_MS = 60_000;
const SDK_MAX_RETRIES = 2;
/** Attempts per draft: the first, plus one repair retry when the output does not match the schema. */
const MAX_ATTEMPTS = 2;
const DEFAULT_RETRY_AFTER_SECONDS = 60;
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const OUTPUT_FORMAT = betaZodOutputFormat(NarrativeDraftSchema);

const REFUSED = 'The model declined to analyse this data';
const INVALID_OUTPUT = 'The model returned output that does not match the narrative schema';

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

/** The draft in the response's text, or null when it is missing, truncated or does not match the schema. */
function parseDraft(message: Message): NarrativeDraft | null {
  const text = message.content.find((block) => block.type === 'text')?.text;
  if (text === undefined) return null;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = NarrativeDraftSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

function retryAfterSeconds(error: RateLimitError): number {
  const seconds = Number(error.headers.get('retry-after'));
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : DEFAULT_RETRY_AFTER_SECONDS;
}

/** Maps SDK failures to problem errors. Upstream messages are not passed on: they are not written for our clients. */
function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof AuthenticationError) return new NotConfiguredError('ANTHROPIC_API_KEY was rejected');
  if (error instanceof RateLimitError) return new UpstreamRateLimitedError(retryAfterSeconds(error), 'Anthropic');
  if (error instanceof APIError) {
    const status = error.status === undefined ? 'no response' : `status ${error.status}`;
    return new LlmError(`The language model request failed (${status})`);
  }
  return new LlmError('The language model request failed');
}

function sdkCreateMessage(apiKey: string): CreateMessage {
  const client = new Anthropic({ apiKey, timeout: TIMEOUT_MS, maxRetries: SDK_MAX_RETRIES });
  return (params) => client.beta.messages.create(params);
}

const addUsage = (total: TokenUsage, message: Message): TokenUsage => ({
  inputTokens: total.inputTokens + message.usage.input_tokens,
  outputTokens: total.outputTokens + message.usage.output_tokens,
  cacheReadTokens: total.cacheReadTokens + (message.usage.cache_read_input_tokens ?? 0),
});

/**
 * Drafts a narrative with structured output. A refusal fails at once; output that does not parse against the
 * schema (including output cut off at max_tokens) is requested once more with the same request, then fails. The SDK
 * itself retries rate limits, overloads and connection errors.
 */
export function createAnthropicNarrativeModel(opts: {
  apiKey: string;
  model: string;
  logger: Logger;
  createMessage?: CreateMessage;
}): NarrativeModel {
  const { logger } = opts;
  const send = opts.createMessage ?? sdkCreateMessage(opts.apiKey);

  return {
    async draft(sheet) {
      const request = buildRequest(opts.model, sheet);
      let usage: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const startedAt = performance.now();
        let message: Message;
        try {
          message = await send(request);
        } catch (error) {
          const mapped = toAppError(error);
          logger.warn(
            { model: opts.model, attempt, latencyMs: Math.round(performance.now() - startedAt), error: mapped.name },
            'Language model call failed',
          );
          throw mapped;
        }
        usage = addUsage(usage, message);
        const draft = message.stop_reason === 'refusal' ? null : parseDraft(message);
        logger.info(
          {
            requestedModel: opts.model,
            model: message.model,
            attempt,
            stopReason: message.stop_reason,
            latencyMs: Math.round(performance.now() - startedAt),
            inputTokens: message.usage.input_tokens,
            outputTokens: message.usage.output_tokens,
            cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
            cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
            validOutput: draft !== null,
          },
          'Language model call finished',
        );
        if (message.stop_reason === 'refusal') throw new LlmError(REFUSED);
        if (draft) return { draft, model: message.model, usage };
      }
      throw new LlmError(INVALID_OUTPUT);
    },
  };
}
