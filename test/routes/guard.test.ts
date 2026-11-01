import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './harness.js';

const API = '/api/v1/repos/fastify/fastify/review-flow?from=2026-03-02&to=2026-03-16';

let h: Harness | undefined;

afterEach(async () => {
  await h?.close();
  h = undefined;
});

const get = (url: string, headers: Record<string, string> = {}) => h!.app.inject({ method: 'GET', url, headers });

function expectForbidden(res: Awaited<ReturnType<typeof get>>): void {
  expect(res.statusCode).toBe(403);
  expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
  expect(res.json()).toMatchObject({ status: 403, type: 'urn:tempo:problem:forbidden' });
}

describe('cross-site and DNS-rebinding guard', () => {
  it('accepts localhost and 127.0.0.1 on any port, in any case', async () => {
    h = await createHarness();
    for (const host of ['localhost:3000', '127.0.0.1:8080', 'LOCALHOST', '127.0.0.1']) {
      expect((await get(API, { host })).statusCode).toBe(200);
    }
  });

  it('refuses a Host header that is not allowed, on the API and on the probes', async () => {
    h = await createHarness();
    expectForbidden(await get(API, { host: 'evil.example:3000' }));
    expectForbidden(await get('/healthz', { host: 'evil.example' }));
    expect(h.sync.calls).toHaveLength(0);
  });

  it('reads the allowed hosts from ALLOWED_HOSTS', async () => {
    h = await createHarness({ config: { allowedHosts: ['tempo.internal'] } });
    expect((await get(API, { host: 'tempo.internal:8443' })).statusCode).toBe(200);
    expectForbidden(await get(API, { host: 'localhost:3000' }));
  });

  it('refuses cross-site API requests before any work or rate-limit spend', async () => {
    h = await createHarness();
    expectForbidden(await get(API, { 'sec-fetch-site': 'cross-site' }));
    expect(h.sync.calls).toHaveLength(0);
    for (const site of ['same-origin', 'same-site', 'none']) {
      expect((await get(API, { 'sec-fetch-site': site })).statusCode).toBe(200);
    }
    expect((await get(API)).headers['x-ratelimit-remaining']).toBe('116');
  });

  it('lets a cross-site navigation load the dashboard but refuses the API', async () => {
    h = await createHarness();
    const navigate = { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', accept: 'text/html' };
    expect((await get('/?repo=fastify/fastify', navigate)).statusCode).toBe(200);
    expectForbidden(await get(API, navigate));
    expectForbidden(await get('/api/v1/nothing', navigate));
  });

  it('lets cross-site requests reach the probes', async () => {
    h = await createHarness();
    expect((await get('/healthz', { 'sec-fetch-site': 'cross-site' })).statusCode).toBe(200);
  });
});

describe('server options', () => {
  it('sets the request deadline and leaves in-flight sockets without an inactivity limit', async () => {
    h = await createHarness();
    expect(h.app.initialConfig).toMatchObject({ requestTimeout: 180_000, connectionTimeout: 0 });
  });

  it('trusts X-Forwarded-For only from the configured proxy hops', async () => {
    h = await createHarness();
    h.app.get('/ip', async (request) => ({ ip: request.ip }));
    expect((await get('/ip', { 'x-forwarded-for': '203.0.113.7' })).json()).not.toEqual({ ip: '203.0.113.7' });
    await h.close();

    h = await createHarness({ config: { trustProxy: 1 } });
    h.app.get('/ip', async (request) => ({ ip: request.ip }));
    const twoHops = { 'x-forwarded-for': '198.51.100.1, 203.0.113.7' };
    expect((await get('/ip', twoHops)).json()).toEqual({ ip: '203.0.113.7' });
  });

  it('keeps one rate-limit key for a client that spoofs X-Forwarded-For when no proxy is trusted', async () => {
    h = await createHarness();
    await get(API, { 'x-forwarded-for': '198.51.100.1' });
    const second = await get(API, { 'x-forwarded-for': '198.51.100.2' });
    expect(second.headers['x-ratelimit-remaining']).toBe('118');
  });

  it('charges every address in one IPv6 /64 to one rate-limit key, and another /64 to its own', async () => {
    h = await createHarness();
    const from = (remoteAddress: string) => h!.app.inject({ method: 'GET', url: API, remoteAddress });
    await from('2001:db8:1:2::1');
    const sameHost = await from('2001:db8:1:2:ffff:ffff:ffff:ffff');
    const otherHost = await from('2001:db8:1:3::1');
    expect(sameHost.headers['x-ratelimit-remaining']).toBe('118');
    expect(otherHost.headers['x-ratelimit-remaining']).toBe('119');
  });

  it('ignores X-Forwarded-Host when no proxy is trusted: the raw Host decides', async () => {
    h = await createHarness();
    expect((await get(API, { host: 'localhost:3000', 'x-forwarded-host': 'evil.example' })).statusCode).toBe(200);
    expectForbidden(await get(API, { host: 'evil.example', 'x-forwarded-host': 'localhost' }));
  });

  it('checks both the raw Host and the forwarded host behind a trusted proxy', async () => {
    h = await createHarness({ config: { trustProxy: 1 } });
    expectForbidden(await get(API, { host: 'localhost:3000', 'x-forwarded-host': 'evil.example' }));
    expectForbidden(await get(API, { host: 'evil.example', 'x-forwarded-host': 'localhost' }));
    expect((await get(API, { host: 'localhost:3000', 'x-forwarded-host': '127.0.0.1:443' })).statusCode).toBe(200);
  });
});
