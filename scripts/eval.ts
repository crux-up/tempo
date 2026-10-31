import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_ANTHROPIC_MODEL } from '../src/config.js';
import type { FactSheet } from '../src/narrative/factSheet.js';
import { createAnthropicNarrativeModel, type TokenUsage } from '../src/narrative/llmClient.js';
import { PROMPT_VERSION } from '../src/narrative/prompt.js';
import { confidenceCap, verifyNarrative, type Narrative } from '../src/narrative/verify.js';

/** `minConfidence` catches a timid model: when a hypothesis is expected, it must reach at least this confidence. */
type EvalCase = { name: string; expectHypothesis: boolean; minConfidence?: number; sheet: FactSheet };
type Row = {
  name: string;
  confidence: number | null;
  checks: Record<string, boolean>;
  warnings: string[];
  error: { label: string; message: string } | null;
  latencyMs: number;
};

const CASES_DIR = join(import.meta.dirname, 'evalCases');
/** With no hypothesis expected, a hypothesis is still fine when the model holds it at or below this confidence. */
const WEAK_CONFIDENCE = 0.5;
const CHECKS = ['parsed', 'evidence', 'findings', 'cap', 'hypothesis', 'alternatives'] as const;
const WEEK_NAME = /\d{4}-W\d{2}/g;

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

function readApiKey(): string | null {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    console.error('ANTHROPIC_API_KEY is not set (environment or .env)');
    return null;
  }
  return key;
}

const errorOf = (err: unknown) =>
  err instanceof Error
    ? { label: err.name, message: err.message }
    : { label: 'UnknownError', message: 'unknown error' };

/** Prose fields of the narrative, for the no-numbers check. */
function prose(narrative: Narrative): string[] {
  const { hypothesis } = narrative;
  return [
    narrative.summary,
    ...narrative.findings.map((f) => f.claim),
    ...(hypothesis ? [hypothesis.statement, hypothesis.reasoning, ...hypothesis.alternatives] : []),
    ...narrative.caveats,
  ];
}

/** Logins named in the sheet; they may contain digits legitimately. Longest first, so a login is removed whole. */
function loginsOf(sheet: FactSheet): string[] {
  const logins = new Set<string>();
  for (const fact of sheet.facts) {
    if (fact.unit === 'login' && typeof fact.value === 'string') logins.add(fact.value);
    const match = /^person\.(.+)\.[A-Za-z]+$/.exec(fact.id);
    if (match?.[1]) logins.add(match[1]);
  }
  return [...logins].sort((a, b) => b.length - a.length);
}

/** Number of prose fields with a digit once ISO week names and logins are removed. */
function digitFields(narrative: Narrative, sheet: FactSheet): number {
  const logins = loginsOf(sheet);
  return prose(narrative).filter((text) => {
    let rest = text.replace(WEEK_NAME, '');
    for (const login of logins) rest = rest.split(login).join('');
    return /\d/.test(rest);
  }).length;
}

async function main(): Promise<void> {
  const apiKey = readApiKey();
  if (apiKey === null) {
    process.exitCode = 1;
    return;
  }
  const model = process.env.ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL;
  const narrativeModel = createAnthropicNarrativeModel({ apiKey, model, logger });
  const rows: Row[] = [];
  const total: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

  for (const testCase of loadCases()) {
    const started = Date.now();
    const row: Row = { name: testCase.name, confidence: null, checks: {}, warnings: [], error: null, latencyMs: 0 };
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
        ? confidence !== null && confidence >= (testCase.minConfidence ?? 0)
        : confidence === null || confidence <= WEAK_CONFIDENCE;
      row.checks.alternatives = narrative.hypothesis === null || narrative.hypothesis.alternatives.length > 0;
      const digits = digitFields(narrative, testCase.sheet);
      if (digits > 0) row.warnings.push(`${digits} prose field(s) contain digits`);
    } catch (err) {
      row.latencyMs = Date.now() - started;
      row.checks.parsed = false;
      row.error = errorOf(err);
    }
    rows.push(row);
  }

  const mark = (ok: boolean | undefined) => (ok === undefined ? '-' : ok ? 'pass' : 'FAIL');
  const widths = [16, ...CHECKS.map((c) => Math.max(c.length, 4) + 2), 12, 10, 6, 20];
  const line = (cells: string[]) => cells.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join('');
  console.log(`model ${model}, prompt ${PROMPT_VERSION}`);
  console.log(line(['case', ...CHECKS, 'confidence', 'latency', 'warn', 'error']));
  for (const row of rows) {
    console.log(
      line([
        row.name,
        ...CHECKS.map((c) => mark(row.checks[c])),
        row.confidence === null ? 'none' : row.confidence.toFixed(2),
        `${(row.latencyMs / 1000).toFixed(1)}s`,
        String(row.warnings.length),
        row.error?.label ?? '-',
      ]),
    );
    if (row.error) console.log(`  error: ${row.error.message}`);
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
    process.exitCode = 1;
    return;
  }
  console.log('All cases passed');
}

await main();
