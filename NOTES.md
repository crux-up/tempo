# Notes

These notes cover how to run Tempo, how it is put together, the main decisions and their trade-offs, and what I would do with another day. The README has the API reference, metric definitions, error table and configuration table.

## How to run locally

### Prerequisites

- Node.js 24 or later (built and tested on Node 24.19 on Windows). `npm install` builds or downloads the native `better-sqlite3` module.
- A fine-grained GitHub personal access token with **Public repositories (read-only)** access and no other permissions.
- Optional: an Anthropic API key. Only the narrative endpoint and `npm run eval` need it. Without it the metrics and dashboard still work, and the narrative endpoint answers `503 not-configured`.

### Commands

```bash
cp .env.example .env        # then set GITHUB_TOKEN (and ANTHROPIC_API_KEY for narratives)
npm install
npm run build               # server to dist/, dashboard to web/dist/
npm start                   # http://127.0.0.1:3000
```

`cp` works in bash, zsh and PowerShell; in `cmd.exe` use `copy`. Variables already set in the shell take precedence over `.env`.

Development mode, with the API on port 3000 under `tsx watch` and the Vite dashboard on port 5173 proxying `/api` to `127.0.0.1:3000` (fixed in `web/vite.config.ts`, so keep `PORT=3000` in development):

```bash
npm run dev
```

Pre-sync a repository (and optionally pre-generate its narrative) so the first page load is fast. Pass the same `from`/`to` the dashboard sends: its default is the last 90 whole days, so `to` is today's date and `from` is 90 days earlier.

```bash
npm run warm -- fastify/fastify 2026-08-02 2026-10-31 --narrative
```

Checks:

```bash
npm test            # Vitest, no network: GitHub and Anthropic are mocked
npm run typecheck   # server and dashboard
npm run lint
npm run eval        # live model calls against 4 fixed fact sheets; costs money, needs ANTHROPIC_API_KEY
```

### Environment variables

| Variable | Default | Notes |
|---|---|---|
| `GITHUB_TOKEN` | required | Read-only, public repositories only. |
| `ANTHROPIC_API_KEY` | unset | Enables the narrative endpoint. |
| `ANTHROPIC_MODEL` | `claude-opus-5-5` | Part of the narrative cache key. |
| `HOST` / `PORT` | `127.0.0.1` / `3000` | Bind address. |
| `DATABASE_PATH` | `./data/tempo.db` | Directory is created on start. |
| `SYNC_TTL_MINUTES` | `15` | How stale stored data may get before a request re-syncs. |
| `SYNC_MAX_PAGES` / `SYNC_MAX_SECONDS` | `40` / `25` | Budget for one synchronous sync, checked after each page (so a sync can overrun slightly). |
| `NARRATIVE_MAX_PER_HOUR` / `NARRATIVE_MAX_PER_CLIENT_PER_HOUR` | `30` / `10` | Model-call budgets. Cache hits are free. |
| `ALLOWED_HOSTS` | `localhost,127.0.0.1` | Host-header allowlist (no ports). |
| `TRUST_PROXY` | `false` | `false`, a hop count, or proxy IPs/CIDRs. Never `true`. |
| `LOG_LEVEL` | `info` | pino level. |

Invalid configuration stops the process at start with a message that names the variables, never their values.

## Architecture tour

A request for `/api/v1/repos/:owner/:repo/review-flow` enters through **`routes/`** and **`http/`**: Zod schemas validate the path and query (the same schemas generate `/api/v1/openapi.json`), an `onRequest` guard checks the Host allowlist and refuses cross-site API calls, the rate limiter runs, and every failure leaves as an RFC 9457 problem from one error handler. The route calls `services/reviewFlowService`, which resolves the `[from, to)` window and asks **`sync/`** to make sure the store covers it. `SyncService` compares the window with the repository's stored markers (`syncedFrom`, `syncedAt` and the stored backfill page position) and runs only the passes it needs: a refresh of PRs updated since the last sync (once the TTL has passed), and a backfill further into the past when the window starts before the stored data. It pages through **`github/`**, a GraphQL client with a constant host, bounded retries, rate-limit mapping and a mapping layer that turns GitHub shapes into internal rows (and strips control and invisible characters from git author names). Each page is upserted into **`db/`** (SQLite via `better-sqlite3`, WAL mode, migrations, prepared statements) as it arrives, so a sync cut short by its budget still keeps what it fetched. Concurrent requests for one repository share a single in-flight sync.

The service then loads the window's rows, drops anything after `dataAsOf` so the report depends only on the snapshot, and hands them to **`metrics/reviewFlow.ts`**: a pure function from rows to the report, with all counting rules (self-reviews, bots, distinct-PR shares, awaiting-first-review) in one place and no I/O. The narrative endpoint reuses that report through **`narrative/`**: `factSheet.ts` flattens it into facts with stable ids and only numbers and charset-checked logins, `llmClient.ts` asks the model for a structured draft that cites fact ids, `verify.ts` replaces every citation with the server's own value and drops what does not resolve, and `narrativeService.ts` caches the verified result keyed by the fact-sheet hash and enforces the hourly budgets. **`web/`** is a single-screen React dashboard built by Vite and served as static files by the same Fastify process. It keeps its query in the URL and links each narrative evidence chip to the number it cites on screen.

## Main decisions

- **GraphQL over REST.** One paginated GraphQL query returns PRs with their first 50 reviews, ordered by `UPDATED_AT DESC`. REST would need one extra call per PR for reviews, and the update ordering makes incremental sync a matter of walking back to the last sync time. The cost is a second query for the rare PR with more than 50 reviews, which counts against the sync budget.
- **SQLite, TTL and a budgeted backfill with a stored page position.** Data is fetched on demand and reused until the TTL passes. A sync stops at `SYNC_MAX_PAGES` requests or `SYNC_MAX_SECONDS`, records the GraphQL page position where the backfill stopped, and reports `coverage.partial` so the dashboard says how much of the window is real. The next request resumes from that position instead of re-reading the newest pages. SQLite needs no extra process, which keeps the reviewer's setup to `npm install`.
- **Pure metrics module.** Every counting rule lives in `src/metrics/reviewFlow.ts` with no database or network access. The tests feed it hand-built rows with hand-computed expected values, and `totals` equal the sum of the per-person rows so anyone can check the arithmetic.
- **Fact-id evidence verification.** Every evidence value comes from the server's fact sheet. The model supplies fact ids, the wording and a confidence. The server attaches the label, value and unit for each id. It drops unknown ids, null-valued facts and evidence lists that cite only `meta.*` context, and removes a finding or hypothesis left without evidence. It clamps confidence to [0, 1] and caps it by sample size (0.3 under 10 PRs, 0.5 under 20). The response says exactly what was dropped or capped. The prose itself is not machine-checked: the prompt forbids numbers in it, and `npm run eval` warns when a prose field contains digits, but nothing verifies that a claim agrees with its evidence. The evidence chain is checkable; the wording is still model output.
- **Day-aligned narrative windows.** Narratives cover whole UTC days and an open-ended window ends at the last midnight at or before `dataAsOf`. The fact sheet, and so the cache key, then stays identical all day, so repeat requests are free. The dashboard's default range ends yesterday for the same reason, which also makes the narrative's evidence values equal the numbers on screen.
- **Synchronous sync with a budget instead of a background job.** A request that needs data waits for a bounded sync. This keeps the system to one process with no queue, scheduler or job state, and the response is always honest about coverage. The price is a slow first request and several requests to fully backfill a busy repository.
- **No Dockerfile yet.** I could not verify a container build on the build machine, and I preferred not to ship an untested one. It is the first item under next steps.
- **Problem types as URNs.** `urn:tempo:problem:<slug>` identifies each error without implying a documentation domain the project would have to own.

## Trade-offs and things deliberately not done

- **Review records vs distinct PRs.** GitHub records a `COMMENTED` review for each thread reply, so raw review counts reward long discussions. Shares and concentration use distinct PRs reviewed. Raw counts are still reported (`reviewsSubmitted`) for comparison.
- **Bot PRs.** With bots excluded, PRs opened by bots leave the PR counts, but human reviews of them still count: reviewing a dependency bump is real work.
- **Committer date for commits.** GitHub's history `since`/`until` filter uses committer date, so Tempo counts by it too. A rebased commit can land in a later window than when it was written.
- **Synchronous aggregation.** Metrics are computed on the request thread. The 366-day window cap, the two-year lookback cap and per-client rate limits bound the cost, but a very busy repository over a full year is still a noticeable amount of work per request.
- **Stuck refresh.** If more PRs are updated within one TTL gap than one sync budget can page through, the refresh does not reach the previous sync time and repeats on the next request. Coverage stays marked partial at the top until it catches up.
- **Explicit narrative windows** are measured at the last sync time so they match the metrics endpoint. A re-sync can therefore change their facts and produce a new narrative.
- **Failed generations count against the narrative budget.** The budget protects spend, and a failed call still costs money.
- **Same-site localhost.** The cross-site guard relies on `Sec-Fetch-Site`, so a page on another localhost port counts as same-site and is not refused. The Host allowlist still blocks DNS rebinding.
- **In-memory limits.** Rate limits and narrative budgets live in process memory. That is right for one local instance and wrong for several.
- **Dependency advisories.** `npm audit --omit=dev` reports three moderate advisories in `glob`/`minimatch` through `@fastify/static`. The affected code runs only with `wildcard: false`; Tempo uses the default `wildcard: true`. `npm audit fix --force` would downgrade `@fastify/static` to v6, so I left it.
- **Not built:** private repositories, OAuth or per-user auth, other providers, issue metrics, background workers, Postgres, Docker.

## What I would do next with another day

1. **Dockerfile and compose file**, verified on a machine with Docker, with the SQLite file on a volume and the health probes wired up (their host added to `ALLOWED_HOSTS`).
2. **Background sync worker and Postgres.** Move syncing to a worker that keeps watched repositories fresh, so requests only read. Postgres would then hold shared state for more than one API instance, and rate limits and narrative budgets would move there or to Redis.
3. **Issue and close signals.** Add issues, closed-without-merge PRs and review-request events, so the narrative can tell "nobody was asked to review" apart from "reviewers were asked and did not respond".
4. **More providers behind the GitHub interface.** `GitHubSource` is already the only thing the sync layer knows. A GitLab source would map merge requests and approvals into the same rows.
5. **Eval in CI with multiple runs.** Run `npm run eval` on a schedule or on prompt changes, several runs per case, and track pass rates and confidence spread instead of a single sample.
6. **Per-user auth.** Let each user bring their own GitHub token (or a GitHub App installation), which also unlocks private repositories with proper access checks.
