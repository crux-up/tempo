import { existsSync } from 'node:fs';
import { pino } from 'pino';
import { buildApp, loggerOptions } from './app.js';
import { loadConfig, type Config } from './config.js';
import { openDatabase } from './db/database.js';
import { Store } from './db/store.js';
import { ConfigError } from './errors.js';
import { createGitHubClient } from './github/client.js';
import { ReviewFlowService } from './services/reviewFlowService.js';
import { SyncService } from './sync/syncService.js';

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
  const logger = pino(loggerOptions(config));
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
  const app = await buildApp({ config, store, reviewFlow, narrative: null });

  let closing = false;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, 'Shutting down');
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
    await app.listen({ host: '0.0.0.0', port: config.port });
  } catch (err) {
    app.log.error({ err }, 'Failed to start');
    db.close();
    process.exit(1);
  }
}

await main();
