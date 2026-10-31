import { createLogger } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';
import { Store } from '../src/db/store.js';
import { parseWindow } from '../src/domain/window.js';
import { AppError } from '../src/errors.js';
import { createGitHubClient } from '../src/github/client.js';
import { RepoParams } from '../src/http/params.js';
import { SyncService } from '../src/sync/syncService.js';

const USAGE = 'Usage: npm run warm -- <owner/name> [from] [to]';

async function main(): Promise<void> {
  const [slug, from, to] = process.argv.slice(2);
  const [owner, name, ...rest] = (slug ?? '').split('/');
  const repo = RepoParams.safeParse({ owner, repo: name });
  if (!repo.success || rest.length > 0) {
    console.error(USAGE);
    process.exit(1);
  }

  const config = readConfig();
  const logger = createLogger(config);
  const db = openDatabase(config.databasePath);
  try {
    const sync = new SyncService({
      github: createGitHubClient({ token: config.githubToken, logger }),
      store: new Store(db),
      ttlMinutes: config.syncTtlMinutes,
      maxPages: config.syncMaxPages,
      maxSeconds: config.syncMaxSeconds,
      logger,
    });
    const window = parseWindow({ from, to }, new Date());
    const result = await sync.ensureSynced({ owner: repo.data.owner, name: repo.data.repo }, window);
    console.log(`${result.repo.owner}/${result.repo.name} synced as of ${result.dataAsOf}`);
    console.log(
      `window ${window.from.toISOString()} to ${window.to.toISOString()}; ` +
        `coverage ${result.coverage.from} to ${result.coverage.to}${result.coverage.partial ? ' (partial)' : ''}`,
    );
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
