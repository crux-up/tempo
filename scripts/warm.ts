import { createLogger } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';
import { Store } from '../src/db/store.js';
import { parseWindow } from '../src/domain/window.js';
import { AppError } from '../src/errors.js';
import { createGitHubClient } from '../src/github/client.js';
import { RepoParams } from '../src/http/params.js';
import { createAnthropicNarrativeModel } from '../src/narrative/llmClient.js';
import { NarrativeService } from '../src/narrative/narrativeService.js';
import { ReviewFlowService } from '../src/services/reviewFlowService.js';
import { SyncService } from '../src/sync/syncService.js';

const USAGE = 'Usage: npm run warm -- <owner/name> [from] [to] [--narrative]';
const NARRATIVE_FLAG = '--narrative';

/**
 * Syncs a repository for a window, so the first dashboard request does not pay for it. With --narrative it also
 * generates the narrative for the same window (and so caches it); that needs ANTHROPIC_API_KEY. Pass the `from` and
 * `to` the dashboard sends, or neither, to warm the entry the dashboard will ask for.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const withNarrative = args.includes(NARRATIVE_FLAG);
  const [slug, from, to, ...extra] = args.filter((arg) => arg !== NARRATIVE_FLAG);
  const [owner, name, ...rest] = (slug ?? '').split('/');
  const repo = RepoParams.safeParse({ owner, repo: name });
  if (!repo.success || rest.length > 0 || extra.length > 0) {
    console.error(USAGE);
    process.exit(1);
  }

  const config = readConfig();
  if (withNarrative && !config.anthropicApiKey) {
    console.error('--narrative needs ANTHROPIC_API_KEY (environment or .env)');
    process.exit(1);
  }
  const logger = createLogger(config);
  const db = openDatabase(config.databasePath);
  try {
    const store = new Store(db);
    const sync = new SyncService({
      github: createGitHubClient({ token: config.githubToken, logger }),
      store,
      ttlMinutes: config.syncTtlMinutes,
      maxPages: config.syncMaxPages,
      maxSeconds: config.syncMaxSeconds,
      logger,
    });
    const ref = { owner: repo.data.owner, name: repo.data.repo };
    // With --narrative the narrative request does the one sync, over the window it needs; a separate sync first
    // would run a second, slightly different backfill.
    if (!withNarrative) {
      const window = parseWindow({ from, to }, new Date());
      const result = await sync.ensureSynced(ref, window);
      console.log(`${result.repo.owner}/${result.repo.name} synced as of ${result.dataAsOf}`);
      console.log(
        `window ${window.from.toISOString()} to ${window.to.toISOString()}; ` +
          `coverage ${result.coverage.from} to ${result.coverage.to}${result.coverage.partial ? ' (partial)' : ''}`,
      );
    }

    if (config.anthropicApiKey && withNarrative) {
      const narratives = new NarrativeService({
        model: createAnthropicNarrativeModel({ apiKey: config.anthropicApiKey, model: config.anthropicModel, logger }),
        modelName: config.anthropicModel,
        store,
        reviewFlow: new ReviewFlowService({ store, sync }),
        logger,
        maxGenerationsPerHour: config.narrativeMaxPerHour,
        maxGenerationsPerClientPerHour: config.narrativeMaxPerClientPerHour,
      });
      const startedAt = performance.now();
      const narrative = await narratives.getNarrative(ref, { from, to });
      const latency = ((performance.now() - startedAt) / 1000).toFixed(1);
      const confidence = narrative.hypothesis ? narrative.hypothesis.confidence.toFixed(2) : 'none';
      console.log(
        `${narrative.repo} synced as of ${narrative.dataAsOf}; coverage ${narrative.coverage.from} to ${narrative.coverage.to}` +
          `${narrative.coverage.partial ? ' (partial)' : ''}
` +
        `narrative ${narrative.cached ? 'cached' : 'new'} for ${narrative.window.from} to ${narrative.window.to}; ` +
          `model ${narrative.model}; confidence ${confidence}; latency ${latency}s`,
      );
    }
  } catch (err) {
    if (err instanceof AppError) {
      console.error(`${err.status} ${err.title}: ${err.message}`);
      process.exitCode = 1;
      return;
    }
    throw err;
  } finally {
    db.close();
  }
}

await main();
