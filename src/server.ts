import { buildApp, createLogger } from './app.js';
import { readConfig } from './config.js';
import { openDatabase } from './db/database.js';
import { Store } from './db/store.js';
import { DAY_MS } from './domain/window.js';
import { createGitHubClient } from './github/client.js';
import { createAnthropicNarrativeModel } from './narrative/llmClient.js';
import { NarrativeService } from './narrative/narrativeService.js';
import { ReviewFlowService } from './services/reviewFlowService.js';
import { SyncService } from './sync/syncService.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;
/** Cached narratives older than this are deleted at startup, so the table does not grow without limit. */
const NARRATIVE_RETENTION_DAYS = 30;

async function main(): Promise<void> {
  const config = readConfig();
  const logger = createLogger(config);
  const db = openDatabase(config.databasePath);
  const store = new Store(db);
  const pruned = store.pruneNarratives(new Date(Date.now() - NARRATIVE_RETENTION_DAYS * DAY_MS));
  if (pruned > 0) logger.info({ pruned }, `Pruned cached narratives older than ${NARRATIVE_RETENTION_DAYS} days`);
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
  const narrative = config.anthropicApiKey
    ? new NarrativeService({
        model: createAnthropicNarrativeModel({ apiKey: config.anthropicApiKey, model: config.anthropicModel, logger }),
        modelName: config.anthropicModel,
        store,
        reviewFlow,
        logger,
        maxGenerationsPerHour: config.narrativeMaxPerHour,
        maxGenerationsPerClientPerHour: config.narrativeMaxPerClientPerHour,
      })
    : null;
  if (!narrative) logger.warn({}, 'ANTHROPIC_API_KEY is not set; the narrative endpoint will answer 503');
  const app = await buildApp({ config, store, reviewFlow, narrative, logger });

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
