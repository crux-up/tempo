import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FactSheet } from '../src/narrative/factSheet.js';
import { createAnthropicNarrativeModel, type TokenUsage } from '../src/narrative/llmClient.js';
import { PROMPT_VERSION } from '../src/narrative/prompt.js';
import { confidenceCap, verifyNarrative } from '../src/narrative/verify.js';

type EvalCase = { name: string; expectHypothesis: boolean; sheet: FactSheet };
type Row = { name: string; confidence: number | null; checks: Record<string, boolean>; warnings: string[]; failure: string | null; latencyMs: number };

const CASES_DIR = join(import.meta.dirname, 'evalCases');
const DEFAULT_MODEL = 'claude-opus-5-5';
/** With no hypothesis expected, a hypothesis is still fine when the model holds it at or below this confidence. */
const WEAK_CONFIDENCE = 0.5;
const CHECKS = ['parsed', 'evidence', 'findings', 'cap', 'hypothesis'] as const;

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: (_obj: object, msg?: string) => console.error(`model warning: ${msg ?? ''}`),
};

function loadCases(): EvalCase[] {
  return readdirSync(CASES_DIR)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => JSON.parse(readFileSync(join(CASES_DIR, file), 'utf8')) as EvalCase);
}

function readApiKey(): string {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    console.error('ANTHROPIC_API_KEY is not set (environment or .env)');
    process.exit(1);
  }
  return key;
}

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : 'unknown error');

async function main(): Promise<void> {
  const model = process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;
  const narrativeModel = createAnthropicNarrativeModel({ apiKey: readApiKey(), model, logger });
  const rows: Row[] = [];
  const total: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

  for (const testCase of loadCases()) {
    const started = Date.now();
    const row: Row = { name: testCase.name, confidence: null, checks: {}, warnings: [], failure: null, latencyMs: 0 };
    try {
      const result = await narrativeModel.draft(testCase.sheet);
      row.latencyMs = Date.now() - started;
      total.inputTokens += result.usage.inputTokens;
      total.outputTokens += result.usage.outputTokens;
      total.cacheReadTokens += result.usage.cacheReadTokens;
      total.cacheWriteTokens += result.usage.cacheWriteTokens;

      const narrative = verifyNarrative(result.draft, testCase.sheet);
      const cap = confidenceCap(testCase.sheet);
      const confidence = narrative.hypothesis?.confidence ?? null;
      row.confidence = result.draft.hypothesis?.confidence ?? null;
      row.checks.parsed = true;
      row.checks.evidence = narrative.verification.droppedEvidenceIds.length === 0;
      row.checks.findings = narrative.verification.droppedFindings === 0;
      // The model's own confidence is checked, not the clamped one: verification would hide an overshoot.
      row.checks.cap = cap === null || (result.draft.hypothesis?.confidence ?? 0) <= cap.max;
      row.checks.hypothesis = testCase.expectHypothesis
        ? confidence !== null
        : confidence === null || confidence <= WEAK_CONFIDENCE;
      if (/\d/.test(narrative.summary)) row.warnings.push('summary contains digits');
    } catch (err) {
      row.latencyMs = Date.now() - started;
      row.checks.parsed = false;
      row.failure = errorMessage(err);
    }
    rows.push(row);
  }

  const mark = (ok: boolean | undefined) => (ok === undefined ? '-' : ok ? 'pass' : 'FAIL');
  const widths = [14, ...CHECKS.map((c) => Math.max(c.length, 4) + 2), 12, 10, 8];
  const line = (cells: string[]) => cells.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join('');
  console.log(`model ${model}, prompt ${PROMPT_VERSION}`);
  console.log(line(['case', ...CHECKS, 'confidence', 'latency', 'warn']));
  for (const row of rows) {
    console.log(
      line([
        row.name,
        ...CHECKS.map((c) => mark(row.checks[c])),
        row.confidence === null ? 'none' : row.confidence.toFixed(2),
        `${(row.latencyMs / 1000).toFixed(1)}s`,
        String(row.warnings.length),
      ]),
    );
    if (row.failure) console.log(`  error: ${row.failure}`);
    for (const warning of row.warnings) console.log(`  warning: ${warning}`);
  }
  const latency = rows.reduce((sum, row) => sum + row.latencyMs, 0);
  console.log(
    `tokens: input ${total.inputTokens}, output ${total.outputTokens}, ` +
      `cache read ${total.cacheReadTokens}, cache write ${total.cacheWriteTokens}; latency ${(latency / 1000).toFixed(1)}s`,
  );

  const failed = rows.filter((row) => Object.values(row.checks).some((ok) => !ok));
  if (failed.length > 0) {
    console.error(`FAILED: ${failed.map((row) => row.name).join(', ')}`);
    process.exit(1);
  }
  console.log('All cases passed');
}

await main();
