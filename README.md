# Tempo

Tempo shows where review work collects in a public GitHub repository, and why.
It copies pull requests, reviews and commits from GitHub into a local SQLite database.
It then calculates review-flow metrics for a time window and gives them to you as JSON and in a dashboard.
A language model (Anthropic API) can write a short narrative over the metrics: a summary, findings and a root-cause hypothesis with a confidence value.
The model cites metric ids as evidence. The server attaches the values for these ids from its own metrics.
The server also limits the confidence value when the sample is small.

## Contents

- [60-second quickstart](#60-second-quickstart)
- [API examples](#api-examples)
- [Metric definitions](#metric-definitions)
- [How the narrative works](#how-the-narrative-works)
- [Errors](#errors)
- [Configuration](#configuration)
- [Security](#security)
- [Tests and evaluation](#tests-and-evaluation)
- [Known limitations](#known-limitations)

## 60-second quickstart

The steps take about 60 seconds after `npm install`. The native SQLite module and the first sync can add time.

### Prerequisites

- Node.js 24 or later, with npm. You do not need C++ build tools. The `.npmrc` file in the repository stops install scripts, and SQLite loads from a prebuilt binary.
- A fine-grained GitHub personal access token. Give it "Public repositories (read-only)" access. Give it no other permissions.
- Optional: an Anthropic API key. Tempo needs this key only for the narrative endpoint.

### Start the service

1. Copy the example configuration file. This command works in bash, zsh and PowerShell. In `cmd.exe`, use `copy`.

   ```bash
   cp .env.example .env
   ```

2. Open `.env` in an editor. Write your GitHub token after `GITHUB_TOKEN=`.
3. Optional: write your Anthropic key after `ANTHROPIC_API_KEY=`.
4. Install the dependencies.

   ```bash
   npm install
   ```

5. Build the server and the dashboard.

   ```bash
   npm run build
   ```

6. Start the server.

   ```bash
   npm start
   ```

7. Open http://127.0.0.1:3000 in a browser.

The dashboard shows `fastify/fastify` for the last 90 whole days.
The first request for a repository syncs data from GitHub. This request can take about `SYNC_MAX_SECONDS` (25 seconds by default) or a little more.
After a complete first sync, requests use the local database until `SYNC_TTL_MINUTES` passes.
A large repository can need more than one sync budget. Then the response has `coverage.partial: true`.
Each later request continues the backfill within the same budget.
You can also sync the repository before you open the dashboard with `npm run warm`. Refer to [Tests and evaluation](#tests-and-evaluation).

For development, use `npm run dev`. This command starts the API with file watch on port 3000 and the dashboard on http://localhost:5173.
The dashboard development server sends `/api` requests to `127.0.0.1:3000`. Keep `PORT=3000` for development.

## API examples

The API has two metric endpoints and two probes.
The OpenAPI 3.1 document is at `/api/v1/openapi.json`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/repos/{owner}/{repo}/review-flow` | Review-flow metrics for a window |
| GET | `/api/v1/repos/{owner}/{repo}/review-flow/narrative` | Verified narrative over the same metrics |
| GET | `/healthz` | Liveness probe |
| GET | `/readyz` | Readiness probe. It checks that the database answers. |

### Query parameters

| Parameter | Endpoints | Format | Default | Rule |
|---|---|---|---|---|
| `from` | both | `YYYY-MM-DD` (UTC midnight) or ISO-8601 datetime with offset | `to` minus 30 days | Inclusive. At most 2 years before now. |
| `to` | both | same as `from` | now | Exclusive. A value later than now changes to now. |
| `includeBots` | both | `true` or `false` | `false` | `true` counts bot accounts as people. |
| `refresh` | narrative | `true` or `false` | `false` | `true` makes a new narrative and ignores the cache. |

The window must be 366 days or shorter. `from` must be earlier than `to`.
The narrative endpoint has one more rule. Its window must contain at least one whole UTC day of synced data. If it does not, the endpoint answers 400.

Use `127.0.0.1` or `localhost` in the URL.
With the default `ALLOWED_HOSTS`, other host names such as `0.0.0.0` or `[::1]` get 403.

### Metrics

With curl:

```bash
curl "http://127.0.0.1:3000/api/v1/repos/fastify/fastify/review-flow?from=2026-08-02&to=2026-10-31"
```

With HTTPie:

```bash
http --timeout 180 GET :3000/api/v1/repos/fastify/fastify/review-flow from==2026-08-02 to==2026-10-31
```

HTTPie stops after 30 seconds by default. A first sync can take longer. Therefore, the examples use `--timeout 180`.

The response has these top-level fields: `repo`, `window`, `dataAsOf`, `coverage`, `includeBots`, `team`, `people`, `totals` and `weekly`.
`dataAsOf` is the time of the last sync.
`coverage.partial` is `true` when a sync budget stopped a sync before it got all the data for the window.

### Narrative

With curl:

```bash
curl "http://127.0.0.1:3000/api/v1/repos/fastify/fastify/review-flow/narrative?from=2026-08-02&to=2026-10-31"
```

With HTTPie:

```bash
http --timeout 180 GET :3000/api/v1/repos/fastify/fastify/review-flow/narrative from==2026-08-02 to==2026-10-31
```

A new narrative can take up to about 150 seconds.
Tempo stores each narrative. A second request for the same window and the same facts gets the stored narrative with `"cached": true`.

### Health

```bash
curl http://127.0.0.1:3000/healthz
curl http://127.0.0.1:3000/readyz
```

```bash
http :3000/healthz
http :3000/readyz
```

## Metric definitions

### Why review flow

Most contributor dashboards count output, such as commits and merged pull requests (PRs).
Review work is the other half of collaboration, and it is often not visible.
PRs wait in review. One person can become the only reviewer for most of the team.
Tempo puts the code load and the review load of each person next to each other.
You can check each number by hand against GitHub.

### General rules

- The window is `[from, to)` in UTC. Tempo counts an event when its timestamp is equal to or later than `from` and earlier than `to`.
- Tempo counts a review only when the reviewer is not the author of the PR. Tempo does not count self-reviews.
- Tempo ignores pending reviews. Pending reviews have no submit time.
- Tempo does not count bot accounts as people by default. Set `includeBots=true` to count bots.
- A bot account is a GitHub `Bot` actor or a login that ends in `[bot]`.
- With `includeBots=false`, Tempo removes PRs that a bot opened from the PR counts. A human review of a bot PR still counts as review work.
- A dismissed review counts as a review. It does not count as an approval.
- Tempo measures each report at `dataAsOf`. Tempo ignores PRs, merges, closes and commits after that time.
- Medians use the mean of the two middle values for an even count. The 90th percentile uses the nearest-rank method.
- Durations are in hours, with one decimal. Shares are fractions from 0 to 1, with three decimals.

### Team metrics (`team`)

| Field | What it counts |
|---|---|
| `prsOpened` | PRs created in the window. |
| `prsMerged` | PRs merged in the window. |
| `reviewsSubmitted` | Reviews submitted in the window. Each review record counts once. |
| `timeToFirstReview` | Hours from PR creation to the first review, for PRs created in the window. Tempo measures up to `dataAsOf`, not only up to `to`. Fields: `medianHours`, `p90Hours`, `sampleSize`. |
| `awaitingFirstReview` | PRs created in the window that have no review and are still open at `dataAsOf`. Fields: `count`, `medianAgeHours`. |
| `timeToMerge` | Hours from PR creation to merge, for PRs merged in the window. Fields: `medianHours`, `p90Hours`, `sampleSize`. |
| `mergedWithoutReview` | PRs merged in the window with no review before the merge. Fields: `count`, `share` of merged PRs. `share` is `null` when no PR merged. |
| `reviewConcentration.topReviewer` | The person with the most distinct PRs reviewed. |
| `reviewConcentration.topReviewerShare` | The share of distinct PR reviews that the top reviewer did. |
| `reviewConcentration.reviewersFor50Pct` | The smallest number of reviewers who together did at least half of the distinct PR reviews. |

A PR that closes without a review is not in `timeToFirstReview` and not in `awaitingFirstReview`.

### Person metrics (`people[]`)

| Field | What it counts |
|---|---|
| `login` | The GitHub login. For a commit with no linked GitHub account, this field holds the git author name. |
| `unlinked` | `true` when `login` is a git author name with no linked GitHub account. Tempo keeps these rows apart from GitHub accounts. The exception is a git name that equals a verified GitHub bot login in the same report: Tempo counts that name as the bot. |
| `commits` | Commits on the default branch in the window. Tempo uses the committer date. |
| `prsOpened` | PRs that the person created in the window. |
| `prsMerged` | PRs by the person that merged in the window. |
| `linesChanged` | Added lines plus removed lines in the PRs of `prsMerged`. |
| `reviewsSubmitted` | Review records that the person submitted in the window. |
| `prsReviewed` | Distinct PRs that the person reviewed in the window. |
| `approvals` | Reviews with the state `APPROVED`. |
| `changesRequested` | Reviews with the state `CHANGES_REQUESTED`. |
| `reviewComments` | Inline comments in the reviews of the person. |
| `reviewShare` | `prsReviewed` of the person divided by the sum of `prsReviewed` of all people. |
| `codeShare` | `prsMerged` of the person divided by the team `prsMerged`. |

`reviewShare` uses distinct PRs, not review records.
GitHub makes a new `COMMENTED` review record for each reply in a review thread.
Therefore, raw review counts give too much weight to long discussions.
The gap between `reviewShare` and `codeShare` shows who does more review work than code work.

`totals` is the sum of each field over all rows in `people`.
`weekly[]` has one row for each ISO week that overlaps the window.
Each row gives `prsOpened`, `prsMerged`, `reviewsSubmitted`, `medianFirstReviewHours` and `firstReviewSample`.
Tempo puts a first-review sample in the week of the PR creation date.

## How the narrative works

1. **Fact sheet.** The server changes the report into a list of facts. Each fact has a stable id, a label, a value and a unit. Examples of ids are `team.timeToFirstReview.median` and `person.alice.reviewShare`.
2. **Input limits.** The fact sheet contains numbers, ISO weeks, timestamps, GitHub logins and labels that the server writes. It also contains the repository name and the window. A login must match the GitHub login pattern. Tempo sends no PR titles, PR bodies, comments or git author names to the model.
3. **Model call.** The model must answer in a fixed JSON schema. The model writes the text, cites fact ids as evidence and gives a confidence value.
4. **Verification.** The server finds each cited id in the fact sheet. It attaches the label, value and unit from the fact sheet. Every evidence value comes from the server.
5. **Removal.** The server removes cited ids that are unknown or have a `null` value. It also removes an evidence list that cites only `meta.*` context facts. Then it removes each finding or hypothesis that has no evidence.
6. **Confidence cap.** The server keeps the confidence between 0 and 1. The sample size is the larger of PRs opened and PRs merged. With fewer than 10 PRs, the maximum confidence is 0.3. With fewer than 20 PRs, the maximum confidence is 0.5.
7. **Report of changes.** The `verification` object lists removed findings, removed ids and any confidence cap.

The server does not check the text of the summary, the claims or the reasoning.
The prompt tells the model not to write numbers in the text. No code makes sure that the model obeys.
`npm run eval` gives a warning when a text field contains digits.

### Windows and cache

A narrative covers whole UTC days.
The server changes an explicit `from` and `to` to UTC midnight.
An open window (no `to`) ends at the last UTC midnight at or before `dataAsOf`.
Therefore, the narrative excludes the current day. The cache key stays the same for the full day.

The cache key contains these items:

- the repository, the window and the bot setting
- a hash of the fact sheet
- the prompt version, the verifier version and the model name

When a sync changes the fact sheet, the cache key changes. Then Tempo makes a new narrative.
Tempo removes stored narratives that are older than 30 days when the server starts.

### Budgets and time limits

- Each attempt has a limit of 120 seconds. The full call has a limit of 150 seconds.
- When the model output does not match the schema, Tempo tries one more time if enough time remains.
- Each client can make 10 narrative requests each minute.
- Each client can cause `NARRATIVE_MAX_PER_CLIENT_PER_HOUR` new narratives each hour.
- All clients together can cause `NARRATIVE_MAX_PER_HOUR` new narratives each hour.
- A stored narrative does not use the hourly budgets. A failed model call uses them.

## Errors

All errors use RFC 9457 `application/problem+json`.
Each body has `type`, `title`, `status`, `detail`, `instance` and `requestId`.
A validation error also has an `errors` array with each field and its message.
When Tempo knows the retry time, the response has a `Retry-After` header.

Example:

```json
{
  "type": "urn:tempo:problem:invalid-request",
  "title": "Invalid request",
  "status": 400,
  "detail": "from must be YYYY-MM-DD or an ISO-8601 datetime with offset",
  "instance": "/api/v1/repos/fastify/fastify/review-flow",
  "requestId": "7b0c2d4e-6f1a-4c8e-9a3b-2d5e8f1c0a47"
}
```

| Status | Problem type | Meaning |
|---|---|---|
| 400 | `urn:tempo:problem:invalid-request` | The path, the query or the window is not valid. For a narrative, the window has no whole UTC day of synced data. |
| 403 | `urn:tempo:problem:forbidden` | The Host header is not in `ALLOWED_HOSTS`, or another site sent the API request. |
| 404 | `urn:tempo:problem:repo-not-found` | The repository does not exist or is private. |
| 404 | `urn:tempo:problem:not-found` | No route matches the path. |
| 429 | `urn:tempo:problem:rate-limited` | The client sent too many requests. |
| 429 | `urn:tempo:problem:narrative-budget-exhausted` | The hourly budget of new narratives for this client or for the server is empty. |
| 500 | `urn:tempo:problem:internal-error` | An unexpected error occurred. |
| 502 | `urn:tempo:problem:upstream-error` | GitHub returned an error. |
| 502 | `urn:tempo:problem:llm-error` | The language model failed, timed out, declined or returned output that is not valid. |
| 503 | `urn:tempo:problem:upstream-rate-limited` | GitHub or Anthropic stopped requests because of its rate limit. |
| 503 | `urn:tempo:problem:github-token-rejected` | GitHub rejected the token. |
| 503 | `urn:tempo:problem:not-configured` | `ANTHROPIC_API_KEY` is not set, or Anthropic rejected it. |
| 503 | `urn:tempo:problem:not-ready` | The database does not answer. |

Other 4xx errors from the framework use the type `about:blank`.

## Configuration

Tempo reads the configuration from environment variables.
When a `.env` file exists in the working directory, Tempo reads it.
A variable that is already set in the shell environment has priority over the same variable in `.env`.
An empty value means "not set". An invalid value stops the server at start, and the error names the variable.

| Variable | Default | Purpose |
|---|---|---|
| `GITHUB_TOKEN` | none (required) | GitHub token. Use a fine-grained token with read-only access to public repositories. |
| `ANTHROPIC_API_KEY` | not set | Anthropic API key. Without it, the narrative endpoint answers 503. |
| `ANTHROPIC_MODEL` | `claude-opus-5-5` | Model for the narrative. |
| `HOST` | `127.0.0.1` | Interface for the server. Use `0.0.0.0` for all interfaces. |
| `PORT` | `3000` | Port for the server. |
| `DATABASE_PATH` | `./data/tempo.db` | SQLite file. Tempo makes the directory if it does not exist. |
| `SYNC_TTL_MINUTES` | `15` | Time before Tempo syncs a repository again. |
| `SYNC_MAX_PAGES` | `40` | GitHub requests for one sync. Pages, review pages and retries all count. After this number, the sync starts no new page. |
| `SYNC_MAX_SECONDS` | `25` | Time for one sync. After this time, the sync starts no new page. |
| `NARRATIVE_MAX_PER_HOUR` | `30` | New narratives for all clients in a rolling hour. |
| `NARRATIVE_MAX_PER_CLIENT_PER_HOUR` | `10` | New narratives for one client address in a rolling hour. Tempo groups IPv6 addresses by /64. |
| `ALLOWED_HOSTS` | `localhost,127.0.0.1` | Host names that the server answers to, separated by commas. Do not include a port. |
| `TRUST_PROXY` | `false` | Proxies that can set `X-Forwarded-For` and `X-Forwarded-Host`: `false`, a hop count, or a list of addresses and CIDRs. |
| `LOG_LEVEL` | `info` | One of `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent`. |

When you set `HOST=0.0.0.0`, add the public host name to `ALLOWED_HOSTS`.
Health probes from a platform such as Kubernetes also need their host name in `ALLOWED_HOSTS`.
Do not set `TRUST_PROXY=true`. The proxy must replace both forwarded headers. It must not add to them.

## Security

- **Read-only token.** Tempo only reads from GitHub. Use a fine-grained token with "Public repositories (read-only)" access.
- **Public repositories only.** Tempo checks the repository at each sync. A private repository gets the same 404 as a missing repository.
- **Fixed upstream hosts.** The GitHub host and the Anthropic host are constants. No request input becomes part of a URL.
- **Input validation.** The owner and repository names must match the GitHub name patterns.
- **Local bind.** The server listens on `127.0.0.1` by default.
- **Host guard.** Tempo refuses a request when its Host is not in `ALLOWED_HOSTS`. This stops DNS rebinding.
- **Cross-site guard.** Tempo refuses an API request with `Sec-Fetch-Site: cross-site`. Current browsers send this header. Another site cannot use such a browser to start syncs or model calls. Pages on other localhost ports are a known gap.
- **Rate limits.** Each client can send 120 API requests each minute. The narrative endpoint has the lower limits in [Budgets and time limits](#budgets-and-time-limits).
- **GitHub quota floor.** A sync stops when fewer than 100 GitHub quota points remain.
- **No free text to the model.** The model gets no PR titles, PR bodies, comments or git author names. Refer to [How the narrative works](#how-the-narrative-works).
- **Secrets.** Logs redact tokens, keys and the `Authorization` header. Error responses never contain tokens or upstream bodies.
- **Headers.** Helmet sets a strict Content Security Policy and other security headers.

## Tests and evaluation

| Command | What it does |
|---|---|
| `npm test` | Runs the unit and route tests with Vitest. The tests use mocks for GitHub and Anthropic and make no network calls. |
| `npm run typecheck` | Checks the types of the server and the dashboard. |
| `npm run lint` | Runs ESLint. |
| `npm run eval` | Sends fixed fact sheets to the live model and checks the narratives. |

`npm run eval` costs money. It needs `ANTHROPIC_API_KEY`.
It sends four fact sheets from `scripts/evalCases/` to the model, one call for each sheet.
It checks the schema, the evidence ids, the confidence cap, the presence of a hypothesis and the minimum confidence.
It gives a warning when a text field contains digits.

The script `scripts/buildEvalCases.ts` contains the source reports for the eval cases.
To make the cases again, run `npx tsx scripts/buildEvalCases.ts`.

To sync a repository before you open the dashboard, run `npm run warm -- <owner/name> [from] [to]`.
Give the window that the dashboard sends: the last 90 whole days. For example, on 2026-10-31:

```bash
npm run warm -- fastify/fastify 2026-08-02 2026-10-31
```

`to` is the current UTC date. `from` is 90 days before it.
Without `from` and `to`, the script uses the API default of 30 days. Then the dashboard must sync the other 60 days.
Add `--narrative` to also make and store the narrative. This option needs `ANTHROPIC_API_KEY`.

## Known limitations

- **Committer date.** Tempo counts commits by committer date, because the GitHub history filter uses that date. A rebase can move a commit into a later window. A merge commit can add branch commits with older dates. Each refresh reads the commits again from 14 days before the last sync. Tempo does not count a branch commit that is more than 14 days older than the last sync.
- **Synchronous sync.** A request waits for its sync. A large repository can need several requests before `coverage.partial` becomes `false`. Each request continues the backfill from a stored page position.
- **Stuck refresh.** A refresh can stay incomplete when more PRs change in one TTL period than `SYNC_MAX_PAGES` pages can hold.
- **Narrative excludes today.** An open narrative window ends at the last UTC midnight. The dashboard default range ends yesterday for the same reason.
- **Explicit windows and the cache.** Tempo measures an explicit narrative window at the last sync time. A new sync can change its facts. Then Tempo makes a new narrative.
- **Default windows.** The API default window is 30 days. The dashboard default window is 90 days.
- **Failed calls use the budget.** A failed narrative generation counts against the hourly budgets.
- **Other localhost ports.** A page on another localhost port counts as same-site. The cross-site guard does not refuse it.
- **Probes and `ALLOWED_HOSTS`.** Health probes need their host name in `ALLOWED_HOSTS`.
- **Audit advisories.** `npm audit --omit=dev` reports three moderate advisories in `glob` and `minimatch` through `@fastify/static`. The affected code runs only with `wildcard: false`. Tempo uses the default `wildcard: true`.
- **In-memory budgets.** The narrative budgets and the rate limits are in process memory. A restart resets them. Two or more instances do not share them.
- **Unchecked narrative text.** The server checks evidence ids, evidence values and the confidence. It does not check that the text of a claim agrees with its evidence.
