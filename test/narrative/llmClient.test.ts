import type Anthropic from '@anthropic-ai/sdk';
import {
  APIConnectionTimeoutError,
  AuthenticationError,
  BadRequestError,
  InternalServerError,
  RateLimitError,
} from '@anthropic-ai/sdk';
import { beforeEach, describe, expect, it } from 'vitest';
import { LlmError, NotConfiguredError, UpstreamRateLimitedError } from '../../src/errors.js';
import type { Logger } from '../../src/logger.js';
import { buildFactSheet } from '../../src/narrative/factSheet.js';
import { createAnthropicNarrativeModel, type CreateMessage } from '../../src/narrative/llmClient.js';
import { SYSTEM_PROMPT } from '../../src/narrative/prompt.js';
import { DRAFT } from './fakes.js';
import { smallReport } from './reportFixture.js';

type Params = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
type Message = Anthropic.Beta.Messages.BetaMessage;

const API_KEY = 'sk-ant-TESTKEY0123456789';
const sheet = buildFactSheet(smallReport());

const message = (overrides: { text?: string; stop_reason?: string; model?: string } = {}): Message =>
  ({
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: overrides.model ?? 'claude-opus-5-5',
    content: overrides.text === undefined ? [] : [{ type: 'text', text: overrides.text, citations: null }],
    stop_reason: overrides.stop_reason ?? 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 800, cache_creation_input_tokens: 0 },
  }) as unknown as Message;

const valid = () => message({ text: JSON.stringify(DRAFT) });

let calls: Params[];
let logs: string[];
const logger: Logger = {
  debug: (obj, msg) => logs.push(JSON.stringify({ obj, msg })),
  info: (obj, msg) => logs.push(JSON.stringify({ obj, msg })),
  warn: (obj, msg) => logs.push(JSON.stringify({ obj, msg })),
};

/** Answers each call with the next scripted response; an Error is thrown instead of returned. */
const scripted = (...responses: Array<Message | Error>): CreateMessage => {
  return async (params) => {
    calls.push(params);
    const next = responses.shift();
    if (!next) throw new Error('no scripted response left');
    if (next instanceof Error) throw next;
    return next;
  };
};

const modelWith = (createMessage: CreateMessage) =>
  createAnthropicNarrativeModel({ apiKey: API_KEY, model: 'claude-opus-5-5', logger, createMessage });

beforeEach(() => {
  calls = [];
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
  });

  it('returns the parsed draft, the model that served it and token usage', async () => {
    const result = await modelWith(scripted(message({ text: JSON.stringify(DRAFT), model: 'claude-opus-4-8' }))).draft(
      sheet,
    );

    expect(result).toEqual({
      draft: DRAFT,
      model: 'claude-opus-4-8',
      usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 800 },
    });
  });

  it('retries once when the output does not match the schema, summing usage', async () => {
    const result = await modelWith(scripted(message({ text: '{"summary": 1}' }), valid())).draft(sheet);

    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(calls[0]);
    expect(result.draft).toEqual(DRAFT);
    expect(result.usage).toEqual({ inputTokens: 2000, outputTokens: 400, cacheReadTokens: 1600 });
  });

  it('retries once on truncated output, then gives up with LlmError', async () => {
    const truncated = () => message({ text: '{"summary": "Rev', stop_reason: 'max_tokens' });

    await expect(modelWith(scripted(truncated(), truncated())).draft(sheet)).rejects.toThrow(
      new LlmError('The model returned output that does not match the narrative schema'),
    );
    expect(calls).toHaveLength(2);
  });

  it('maps a refusal to LlmError without retrying', async () => {
    const refusal = message({ stop_reason: 'refusal' });

    await expect(modelWith(scripted(refusal)).draft(sheet)).rejects.toThrow(
      new LlmError('The model declined to analyse this data'),
    );
    expect(calls).toHaveLength(1);
  });

  it('maps a rejected API key to NotConfiguredError', async () => {
    const err = new AuthenticationError(401, { type: 'error' }, 'invalid x-api-key', new Headers());

    await expect(modelWith(scripted(err)).draft(sheet)).rejects.toThrow(
      new NotConfiguredError('ANTHROPIC_API_KEY was rejected'),
    );
  });

  it('maps an upstream rate limit to UpstreamRateLimitedError with its retry-after', async () => {
    const err = new RateLimitError(429, { type: 'error' }, 'rate limited', new Headers({ 'retry-after': '17' }));

    const thrown = await modelWith(scripted(err))
      .draft(sheet)
      .catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(UpstreamRateLimitedError);
    expect(thrown).toMatchObject({ retryAfterSeconds: 17 });
    expect((thrown as Error).message).toContain('Anthropic');
  });

  it.each([
    ['a server error', new InternalServerError(529, { type: 'error' }, 'overloaded: upstream detail', new Headers())],
    ['a bad request', new BadRequestError(400, { type: 'error' }, 'bad: upstream detail', new Headers())],
    ['a timeout', new APIConnectionTimeoutError()],
  ])('maps %s to LlmError without echoing upstream text', async (_name, err) => {
    const thrown = await modelWith(scripted(err))
      .draft(sheet)
      .catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(LlmError);
    expect((thrown as Error).message).not.toContain('upstream detail');
    expect(calls).toHaveLength(1);
  });

  it('logs model, latency and token usage but never the key or the prompt', async () => {
    await modelWith(scripted(valid())).draft(sheet);

    const all = logs.join('\n');
    expect(all).toContain('"latencyMs"');
    expect(all).toContain('"cacheReadTokens":800');
    expect(all).toContain('"model":"claude-opus-5-5"');
    expect(all).not.toContain(API_KEY);
    expect(all).not.toContain('team.prsOpened');
    expect(all).not.toContain('engineering-analytics');
  });
});
