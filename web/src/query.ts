/** The dashboard query, kept in the URL so a view can be shared. Dates are inclusive UTC calendar days. */
export type Query = { owner: string; repo: string; from: string; to: string; includeBots: boolean };

const DAY_MS = 86_400_000;
export const DEFAULT_REPO = 'fastify/fastify';
export const DEFAULT_DAYS = 90;
export const MAX_DAYS = 366;

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const dayMs = (date: string) => Date.parse(`${date}T00:00:00Z`);
const isDate = (value: string) => DATE.test(value) && !Number.isNaN(dayMs(value));

export const today = () => isoDay(Date.now());
export const addDays = (date: string, days: number) => isoDay(dayMs(date) + days * DAY_MS);
export const daysInclusive = (from: string, to: string) => Math.round((dayMs(to) - dayMs(from)) / DAY_MS) + 1;

/** Accepts `owner/name` or a github.com URL; returns null when it is not a valid repository path. */
export function parseRepo(input: string): { owner: string; repo: string } | null {
  const path = input
    .trim()
    .replace(/^https?:\/\/(www\.)?github\.com\//i, '')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '');
  const [owner, repo, ...rest] = path.split('/');
  if (!owner || !repo || rest.length > 0) return null;
  if (!OWNER.test(owner) || !NAME.test(repo) || repo === '.' || repo === '..') return null;
  return { owner, repo };
}

export function defaultQuery(): Query {
  const to = today();
  const [owner, repo] = DEFAULT_REPO.split('/') as [string, string];
  return { owner, repo, from: addDays(to, -(DEFAULT_DAYS - 1)), to, includeBots: false };
}

export function queryFromSearch(search: string): Query {
  const params = new URLSearchParams(search);
  const fallback = defaultQuery();
  const repo = parseRepo(params.get('repo') ?? '') ?? fallback;
  const toParam = params.get('to') ?? '';
  const fromParam = params.get('from') ?? '';
  const to = isDate(toParam) ? toParam : fallback.to;
  const from = isDate(fromParam) ? fromParam : addDays(to, -(DEFAULT_DAYS - 1));
  return { owner: repo.owner, repo: repo.repo, from, to, includeBots: params.get('bots') === '1' };
}

export function searchFromQuery(query: Query): string {
  const params = new URLSearchParams({ repo: `${query.owner}/${query.repo}`, from: query.from, to: query.to });
  if (query.includeBots) params.set('bots', '1');
  return `?${params.toString()}`;
}

/** A reason the window cannot be sent, or null. The server checks again; this only saves a round trip. */
export function validateWindow(from: string, to: string): string | null {
  if (!isDate(from) || !isDate(to)) return 'Enter both dates.';
  if (from > to) return 'The start date must not be after the end date.';
  if (daysInclusive(from, to) > MAX_DAYS) return `The window can be at most ${MAX_DAYS} days.`;
  return null;
}

/** API parameters: the end day is inclusive here and exclusive on the server, which also clamps it to now. */
export function apiParams(query: Query): URLSearchParams {
  return new URLSearchParams({
    from: query.from,
    to: addDays(query.to, 1),
    includeBots: String(query.includeBots),
  });
}
