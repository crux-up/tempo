import { z } from 'zod';
import { ConfigError } from './errors.js';

export type Config = {
  githubToken: string;
  anthropicApiKey: string | null;
  anthropicModel: string;
  port: number;
  databasePath: string;
  syncTtlMinutes: number;
  syncMaxPages: number;
  syncMaxSeconds: number;
  logLevel: string;
};

// Empty strings (e.g. `PORT=` in a .env file) count as unset.
const blankToUndefined = (value: unknown) => (value === '' ? undefined : value);

const text = (fallback: string) => z.preprocess(blankToUndefined, z.string().default(fallback));
const positiveInt = (fallback: number) =>
  z.preprocess(blankToUndefined, z.coerce.number().int().positive().default(fallback));

const envSchema = z.object({
  GITHUB_TOKEN: z.string().min(1),
  ANTHROPIC_API_KEY: z.preprocess(blankToUndefined, z.string().optional()),
  ANTHROPIC_MODEL: text('claude-opus-5-5'),
  PORT: z.preprocess(blankToUndefined, z.coerce.number().int().min(1).max(65535).default(3000)),
  DATABASE_PATH: text('./data/tempo.db'),
  SYNC_TTL_MINUTES: positiveInt(15),
  SYNC_MAX_PAGES: positiveInt(40),
  SYNC_MAX_SECONDS: positiveInt(25),
  LOG_LEVEL: z.preprocess(
    blankToUndefined,
    z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  ),
});

/**
 * Parses environment variables into a typed Config.
 * Errors name the offending variables only, never their values.
 */
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const names = [...new Set(result.error.issues.map((issue) => String(issue.path[0])))];
    throw new ConfigError(`Invalid or missing environment variables: ${names.join(', ')}`);
  }
  const e = result.data;
  return {
    githubToken: e.GITHUB_TOKEN,
    anthropicApiKey: e.ANTHROPIC_API_KEY ?? null,
    anthropicModel: e.ANTHROPIC_MODEL,
    port: e.PORT,
    databasePath: e.DATABASE_PATH,
    syncTtlMinutes: e.SYNC_TTL_MINUTES,
    syncMaxPages: e.SYNC_MAX_PAGES,
    syncMaxSeconds: e.SYNC_MAX_SECONDS,
    logLevel: e.LOG_LEVEL,
  };
}
