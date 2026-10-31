import { existsSync } from 'node:fs';
import { buildApp, createLogger } from './app.js';
import { loadConfig, type Config } from './config.js';
import { openDatabase } from './db/database.js';
import { Store } from './db/store.js';
import { ConfigError } from './errors.js';
import { createGitHubClient } from './github/client.js';
import { ReviewFlowService } from './services/reviewFlowService.js';
import { SyncService } from './sync/syncService.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;

function readConfig(): Config {
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

async function main(): Promise<void> {
  const config = readConfig();
  const logger = createLogger(config);
  const db = openDatabase(config.databasePath);
  const store = new Store(db);
  const github = createGitHubClient({ token: config.githubToken, logger });
  const sync = new SyncService({
    github,
    store,
    ttlMinutes: config.syncTtlMinutes,
    maxPages: config.syncMaxPages,
    maxSeconds: config.syncMaxSeconds,
    logger,
  });
  const reviewFlow = new ReviewFlowService({ store, sync });
  const app = await buildApp({ config, store, reviewFlow, narrative: null, logger });

  let closing = false;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, 'Shutting down');
    // In-flight requests may be waiting on GitHub; do not let a hung close keep the process alive.
    setTimeout(() => {
      app.log.error('Shutdown timed out; exiting');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS).unref();
    try {
      await app.close();
      db.close();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'Shutdown failed');
      process.exit(1);
    }
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (err) {
    app.log.error({ err }, 'Failed to start');
    db.close();
    process.exit(1);
  }
}

await main();
