import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './harness.js';

let h: Harness | undefined;

afterEach(async () => {
  await h?.close();
  h = undefined;
});

describe('health routes', () => {
  it('GET /healthz reports ok', async () => {
    h = await createHarness();
    const res = await h.app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('GET /readyz reports ready when the database answers', async () => {
    h = await createHarness();
    const res = await h.app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ready' });
  });

  it('GET /readyz returns a 503 problem when the database is unavailable', async () => {
    h = await createHarness();
    h.db.close();
    const res = await h.app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(503);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(res.json()).toMatchObject({ status: 503, type: 'https://tempo.dev/problems/not-ready' });
  });
});

describe('OpenAPI document', () => {
  it('lists the review-flow path with its parameters and problem responses', async () => {
    h = await createHarness();
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/openapi.json' });
    expect(res.statusCode).toBe(200);
    const doc = res.json<{
      openapi: string;
      paths: Record<string, { get?: { parameters?: Array<{ name: string }>; responses?: Record<string, unknown> } }>;
    }>();
    expect(doc.openapi).toMatch(/^3\.1/);
    const op = doc.paths['/api/v1/repos/{owner}/{repo}/review-flow']?.get;
    expect(op).toBeDefined();
    expect(op!.parameters!.map((p) => p.name).sort()).toEqual(['from', 'includeBots', 'owner', 'repo', 'to']);
    expect(Object.keys(op!.responses!)).toEqual(expect.arrayContaining(['200', '400', '404', '429', '502', '503']));
    expect(doc.paths['/healthz']).toBeDefined();
    expect(doc.paths['/api/v1/openapi.json']).toBeUndefined();
  });
});

describe('single-page app', () => {
  let webRoot: string | undefined;

  afterEach(() => {
    if (webRoot) rmSync(webRoot, { recursive: true, force: true });
    webRoot = undefined;
  });

  it('serves index.html for browser navigation and keeps unknown API routes as problems', async () => {
    webRoot = mkdtempSync(join(tmpdir(), 'tempo-web-'));
    writeFileSync(join(webRoot, 'index.html'), '<!doctype html><title>Tempo</title>');
    mkdirSync(join(webRoot, 'assets'));
    writeFileSync(join(webRoot, 'assets', 'app.js'), 'console.log(1)');
    h = await createHarness({ webRoot });

    const root = await h.app.inject({ method: 'GET', url: '/' });
    expect(root.statusCode).toBe(200);
    expect(root.body).toContain('<title>Tempo</title>');

    const asset = await h.app.inject({ method: 'GET', url: '/assets/app.js' });
    expect(asset.statusCode).toBe(200);

    const deepLink = await h.app.inject({
      method: 'GET',
      url: '/repos/fastify/fastify',
      headers: { accept: 'text/html,application/xhtml+xml' },
    });
    expect(deepLink.statusCode).toBe(200);
    expect(deepLink.headers['content-type']).toMatch(/^text\/html/);
    expect(deepLink.body).toContain('<title>Tempo</title>');

    const api = await h.app.inject({ method: 'GET', url: '/api/v1/nope', headers: { accept: 'text/html' } });
    expect(api.statusCode).toBe(404);
    expect(api.headers['content-type']).toMatch(/^application\/problem\+json/);

    const missingAsset = await h.app.inject({ method: 'GET', url: '/assets/missing.js', headers: { accept: '*/*' } });
    expect(missingAsset.statusCode).toBe(404);
    expect(missingAsset.headers['content-type']).toMatch(/^application\/problem\+json/);
  });

  it('does not spend the API rate limit on static and page requests', async () => {
    webRoot = mkdtempSync(join(tmpdir(), 'tempo-web-'));
    writeFileSync(join(webRoot, 'index.html'), '<!doctype html><title>Tempo</title>');
    writeFileSync(join(webRoot, 'app.js'), 'console.log(1)');
    h = await createHarness({ webRoot });

    for (let i = 0; i < 130; i++) {
      const url = i % 3 === 0 ? '/app.js' : i % 3 === 1 ? '/' : '/repos/fastify/fastify';
      const res = await h.app.inject({ method: 'GET', url, headers: { accept: 'text/html' } });
      expect(res.statusCode).toBe(200);
    }
    const api = await h.app.inject({ method: 'GET', url: '/api/v1/nope' });
    expect(api.headers['x-ratelimit-remaining']).toBe('119');
    const encoded = await h.app.inject({ method: 'GET', url: '/%61pi/v1/nope', headers: { accept: 'text/html' } });
    expect(encoded.statusCode).toBe(404);
    expect(encoded.headers['x-ratelimit-remaining']).toBe('118');
  });

  it('returns 404 problems at / when there is no built web app', async () => {
    h = await createHarness({ webRoot: join(tmpdir(), 'tempo-web-does-not-exist') });
    const res = await h.app.inject({ method: 'GET', url: '/', headers: { accept: 'text/html' } });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
  });
});
