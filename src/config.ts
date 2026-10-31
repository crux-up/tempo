import { existsSync } from 'node:fs';
import { z } from 'zod';
import { ConfigError } from './errors.js';

export type Config = {
  githubToken: string;
  anthropicApiKey: string | null;
  anthropicModel: string;
  host: string;
  port: number;
  databasePath: string;
  syncTtlMinutes: number;
  syncMaxPages: number;
  syncMaxSeconds: number;
  /** New (uncached) narratives allowed per rolling hour, across all clients. */
  narrativeMaxPerHour: number;
  /** Host names (any port) the server answers to; anything else is refused, which stops DNS rebinding. */
  allowedHosts: string[];
  /** Trust X-Forwarded-* headers: set only behind a reverse proxy that writes them. */
  trustProxy: boolean;
  logLevel: string;
};

export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5-5';

// Empty strings (e.g. `PORT=` in a .env file) count as unset.
const blankToUndefined = (value: unknown) => (value === '' ? undefined : value);

const text = (fallback: string) => z.preprocess(blankToUndefined, z.string().default(fallback));
const positiveInt = (fallback: number) =>
  z.preprocess(blankToUndefined, z.coerce.number().int().positive().default(fallback));

const HOST_NAME = /^[a-z0-9.:-]+$/;

/** Comma-separated host names, lowercased, with IPv6 brackets dropped. */
const hostList = (fallback: string) =>
  z.preprocess(
    blankToUndefined,
    z
      .string()
      .default(fallback)
      .transform((list) => list.split(',').map((host) => host.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1')))
      .pipe(z.array(z.string().regex(HOST_NAME)).min(1)),
  );

const envSchema = z.object({
  GITHUB_TOKEN: z.string().min(1),
  ANTHROPIC_API_KEY: z.preprocess(blankToUndefined, z.string().optional()),
  ANTHROPIC_MODEL: text(DEFAULT_ANTHROPIC_MODEL),
  HOST: z.preprocess(
    blankToUndefined,
    z
      .string()
      .regex(/^[A-Za-z0-9.:-]+$/)
      .default('127.0.0.1'),
  ),
  PORT: z.preprocess(blankToUndefined, z.coerce.number().int().min(1).max(65535).default(3000)),
  DATABASE_PATH: text('./data/tempo.db'),
  SYNC_TTL_MINUTES: positiveInt(15),
  SYNC_MAX_PAGES: positiveInt(40),
  SYNC_MAX_SECONDS: positiveInt(25),
  NARRATIVE_MAX_PER_HOUR: positiveInt(30),
  ALLOWED_HOSTS: hostList('localhost,127.0.0.1'),
  TRUST_PROXY: z.preprocess(blankToUndefined, z.enum(['true', 'false']).default('false')),
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
    host: e.HOST,
    port: e.PORT,
    databasePath: e.DATABASE_PATH,
    syncTtlMinutes: e.SYNC_TTL_MINUTES,
    syncMaxPages: e.SYNC_MAX_PAGES,
    syncMaxSeconds: e.SYNC_MAX_SECONDS,
    narrativeMaxPerHour: e.NARRATIVE_MAX_PER_HOUR,
    allowedHosts: e.ALLOWED_HOSTS,
    trustProxy: e.TRUST_PROXY === 'true',
    logLevel: e.LOG_LEVEL,
  };
}

/** Loads `.env` when present, then the config; on invalid configuration prints the error and exits. */
export function readConfig(): Config {
  if (existsSync('.env')) process.loadEnvFile('.env');
  try {
    return loadConfig(process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
}
