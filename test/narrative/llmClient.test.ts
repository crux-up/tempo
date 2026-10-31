import type Anthropic from '@anthropic-ai/sdk';
import {
  APIConnectionTimeoutError,
  APIUserAbortError,
  AuthenticationError,
  BadRequestError,
  InternalServerError,
  PermissionDeniedError,
  RateLimitError,
} from '@anthropic-ai/sdk';
import { beforeEach, describe, expect, it } from 'vitest';
import { LlmError, NotConfiguredError, UpstreamRateLimitedError } from '../../src/errors.js';
import type { Logger } from '../../src/logger.js';
import { buildFactSheet } from '../../src/narrative/factSheet.js';
import {
  anthropicClientOptions,
  createAnthropicNarrativeModel,
  type CreateMessage,
  type ModelLimits,
} from '../../src/narrative/llmClient.js';
import { SYSTEM_PROMPT } from '../../src/narrative/prompt.js';
import { DRAFT } from './fakes.js';
import { smallReport } from './reportFixture.js';

type Params = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
type Message = Anthropic.Beta.Messages.BetaMessage;
type Block = Record<string, unknown>;

const API_KEY = 'sk-ant-TESTKEY0123456789';
const sheet = buildFactSheet(smallReport());

const textBlock = (text: string): Block => ({ type: 'text', text, citations: null });

const message = (
  overrides: {
    text?: string;
    content?: Block[];
    stop_reason?: string;
    model?: string;
    stop_details?: Block;
    iterations?: Block[];
  } = {},
): Message =>
  ({
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: overrides.model ?? 'claude-opus-5-5',
    content: overrides.content ?? (overrides.text === undefined ? [] : [textBlock(overrides.text)]),
    stop_reason: overrides.stop_reason ?? 'end_turn',
    stop_details: overrides.stop_details ?? null,
    stop_sequence: null,
    usage: {
      input_tokens: 1000,
      output_tokens: 200,
      cache_read_input_tokens: 800,
      cache_creation_input_tokens: 0,
      iterations: overrides.iterations ?? null,
    },
  }) as unknown as Message;

const valid = () => message({ text: JSON.stringify(DRAFT) });

let calls: Params[];
let signals: AbortSignal[];
let logs: Array<{ obj: Record<string, unknown>; msg?: string }>;
const push = (obj: object, msg?: string) => logs.push({ obj: obj as Record<string, unknown>, msg });
const logger: Logger = { debug: push, info: push, warn: push };

/** Answers each call with the next scripted response; an Error is thrown, a function is awaited. */
type Step = Message | Error | ((signal: AbortSignal) => Promise<Message>);
const scripted = (...responses: Step[]): CreateMessage => {
  return async (params, options) => {
    calls.push(params);
    signals.push(options.signal);
    const next = responses.shift();
    if (!next) throw new Error('no scripted response left');
    if (next instanceof Error) throw next;
    if (typeof next === 'function') return next(options.signal);
    return next;
  };
};

/** Settles only when the signal aborts, the way the SDK does: with APIUserAbortError. */
const hangUntilAborted = (signal: AbortSignal) =>
  new Promise<Message>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new APIUserAbortError()), { once: true });
  });

const modelWith = (createMessage: CreateMessage, extra: { limits?: Partial<ModelLimits>; now?: () => number } = {}) =>
  createAnthropicNarrativeModel({ apiKey: API_KEY, model: 'claude-opus-5-5', logger, createMessage, ...extra });

const failure = (createMessage: CreateMessage, extra: Parameters<typeof modelWith>[1] = {}) =>
  modelWith(createMessage, extra)
    .draft(sheet)
    .then(
      () => {
        throw new Error('expected draft() to fail');
      },
      (e: unknown) => e as Error,
    );

const logged = (msg: string) => logs.filter((l) => l.msg === msg).map((l) => l.obj);

beforeEach(() => {
  calls = [];
  signals = [];
  logs = [];
});

describe('createAnthropicNarrativeModel', () => {
  it('sends a structured-output request with a cacheable system prompt and the sheet as JSON', async () => {
    await modelWith(scripted(valid())).draft(sheet);

    const params = calls[0] as Params & Record<string, unknown>;
    expect(params).toMatchObject({
      model: 'claude-opus-5-5',
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high', format: { type: 'json_schema' } },
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: JSON.stringify(sheet) }],
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });
    expect(params).not.toHaveProperty('temperature');
    expect(signals[0]).toBeInstanceOf(AbortSignal);
  });

  it('configures the SDK client with one retry and a timeout no longer than the request deadline', () => {
    expect(anthropicClientOptions(API_KEY)).toEqual({ apiKey: API_KEY, maxRetries: 1, timeout: 150_000 });
  });

  it('returns the parsed draft, the model that served it and token usage', async () => {
    const result = await modelWith(scripted(message({ text: JSON.stringify(DRAFT), model: 'claude-opus-4-8' }))).draft(
      sheet,
    );

    expect(result).toEqual({
      draft: DRAFT,
      model: 'claude-opus-4-8',
      usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 800, cacheWriteTokens: 0 },
    });
  });

  it('reads only the text after the last fallback block, joining split text blocks', async () => {
    const json = JSON.stringify(DRAFT);
    const content = [
      textBlock('{"summary": "partial output from the declining model'),
      { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-4-8' } },
      textBlock(json.slice(0, 40)),
      textBlock(json.slice(40)),
    ];

    const result = await modelWith(scripted(message({ content, model: 'claude-opus-4-8' }))).draft(sheet);

    expect(result.draft).toEqual(DRAFT);
  });

  it('sums token usage over usage.iterations when present', async () => {
    const iterations = [
      { type: 'message', input_tokens: 300, output_tokens: 50, cache_read_input_tokens: 100, cache_creation_input_tokens: 40 },
      {
        type: 'fallback_message',
        input_tokens: 700,
        output_tokens: 250,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 60,
      },
    ];

    const result = await modelWith(scripted(message({ text: JSON.stringify(DRAFT), iterations }))).draft(sheet);

    expect(result.usage).toEqual({ inputTokens: 1000, outputTokens: 300, cacheReadTokens: 100, cacheWriteTokens: 100 });
    expect(logged('Language model call finished')[0]).toMatchObject({ cacheWriteTokens: 100, inputTokens: 1000 });
  });

  it('retries once when the output does not match the schema, summing usage', async () => {
    const result = await modelWith(scripted(message({ text: '{"summary": 1}' }), valid())).draft(sheet);

    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(calls[0]);
    expect(result.draft).toEqual(DRAFT);
    expect(result.usage).toEqual({ inputTokens: 2000, outputTokens: 400, cacheReadTokens: 1600, cacheWriteTokens: 0 });
  });

  it('gives up with LlmError when the retry is also invalid', async () => {
    const err = await failure(scripted(message({ text: 'not json' }), message({ text: '{}' })));

    expect(err).toEqual(new LlmError('The model returned output that does not match the narrative schema'));
    expect(calls).toHaveLength(2);
  });

  it('fails at once when the output hits max_tokens', async () => {
    const err = await failure(scripted(message({ text: '{"summary": "Rev', stop_reason: 'max_tokens' })));

    expect(err).toEqual(new LlmError('The model ran out of output tokens before finishing the narrative'));
    expect(calls).toHaveLength(1);
  });

  it.each(['pause_turn', 'stop_sequence', 'tool_use'])('fails at once on stop_reason %s', async (stopReason) => {
    const err = await failure(scripted(message({ text: JSON.stringify(DRAFT), stop_reason: stopReason }), valid()));

    expect(err).toEqual(new LlmError(`The model stopped before finishing the narrative (${stopReason})`));
    expect(calls).toHaveLength(1);
  });

  it('maps a refusal to LlmError without retrying and logs the refusal category', async () => {
    const refusal = message({ stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber' } });

    const err = await failure(scripted(refusal));

    expect(err).toEqual(new LlmError('The model declined to analyse this data'));
    expect(calls).toHaveLength(1);
    expect(logged('Language model call finished')[0]).toMatchObject({ stopReason: 'refusal', refusalCategory: 'cyber' });
  });

  it('maps a rejected API key to NotConfiguredError', async () => {
    const err = new AuthenticationError(401, { type: 'error' }, 'invalid x-api-key', new Headers());

    expect(await failure(scripted(err))).toEqual(new NotConfiguredError('ANTHROPIC_API_KEY was rejected'));
  });

  it('maps a 403 to NotConfiguredError about model access', async () => {
    const err = new PermissionDeniedError(403, { type: 'error' }, 'no access', new Headers());

    expect(await failure(scripted(err))).toEqual(
      new NotConfiguredError('ANTHROPIC_API_KEY lacks access to the configured model'),
    );
  });

  it('maps an upstream rate limit to UpstreamRateLimitedError with its retry-after', async () => {
    const err = new RateLimitError(429, { type: 'error' }, 'rate limited', new Headers({ 'retry-after': '17' }));

    const thrown = await failure(scripted(err));

    expect(thrown).toBeInstanceOf(UpstreamRateLimitedError);
    expect(thrown).toMatchObject({ retryAfterSeconds: 17 });
    expect(thrown.message).toContain('Anthropic');
  });

  it.each([
    ['a server error', new InternalServerError(529, { type: 'error' }, 'overloaded: upstream detail', new Headers())],
    ['a bad request', new BadRequestError(400, { type: 'error' }, 'bad: upstream detail', new Headers())],
    ['a connection timeout', new APIConnectionTimeoutError()],
  ])('maps %s to LlmError without echoing upstream text', async (_name, err) => {
    const thrown = await failure(scripted(err));

    expect(thrown).toBeInstanceOf(LlmError);
    expect(thrown.message).not.toContain('upstream detail');
    expect(calls).toHaveLength(1);
  });

  it('logs status and request id of an API error', async () => {
    const headers = new Headers({ 'request-id': 'req_0123' });
    await failure(scripted(new InternalServerError(500, { type: 'error' }, 'boom', headers)));

    expect(logged('Language model call failed')[0]).toMatchObject({
      error: 'LlmError',
      cause: 'InternalServerError',
      status: 500,
      requestId: 'req_0123',
    });
  });

  it('logs the original error name of a non-SDK failure', async () => {
    const err = await failure(scripted(new TypeError('fetch failed')));

    expect(err).toEqual(new LlmError('The language model request failed'));
    expect(logged('Language model call failed')[0]).toMatchObject({ cause: 'TypeError' });
  });

  it('fails with a timeout error when an attempt exceeds its time limit, without retrying', async () => {
    const err = await failure(scripted(hangUntilAborted), { limits: { attemptTimeoutMs: 20 } });

    expect(err).toEqual(new LlmError('The model did not answer in time'));
    expect(calls).toHaveLength(1);
  });

  it('fails with a timeout error when the request deadline passes', async () => {
    const err = await failure(scripted(hangUntilAborted), { limits: { deadlineMs: 20 } });

    expect(err).toEqual(new LlmError('The model did not answer in time'));
  });

  it('skips the retry when less than the retry budget of the deadline remains', async () => {
    let clock = 0;
    const slowInvalid = async () => {
      clock = 100_000;
      return message({ text: 'not json' });
    };

    const err = await failure(scripted(slowInvalid, valid()), { now: () => clock });

    expect(err).toEqual(new LlmError('The model returned output that does not match the narrative schema'));
    expect(calls).toHaveLength(1);
  });

  it('logs model, latency and token usage but never the key or the prompt', async () => {
    await modelWith(scripted(valid())).draft(sheet);

    const all = JSON.stringify(logs);
    expect(all).toContain('"latencyMs"');
    expect(all).toContain('"cacheReadTokens":800');
    expect(all).toContain('"model":"claude-opus-5-5"');
    expect(all).not.toContain(API_KEY);
    expect(all).not.toContain('team.prsOpened');
    expect(all).not.toContain('engineering-analytics');
  });
});
