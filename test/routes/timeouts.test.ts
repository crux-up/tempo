import { request } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './harness.js';

const PATH = '/api/v1/repos/fastify/fastify/review-flow?from=2026-03-02&to=2026-03-16';
const OLD_LIMIT_MS = 10_000;

let h: Harness | undefined;

afterEach(async () => {
  await h?.close();
  h = undefined;
});

function get(base: URL): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: base.hostname, port: base.port, path: PATH, method: 'GET' }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('server timeouts', () => {
  it('does not cut a silent in-flight socket before a slow request can finish', async () => {
    h = await createHarness();
    // Node closes a socket that stays silent for `server.timeout` ms; 0 means never.
    expect(h.app.server.timeout === 0 || h.app.server.timeout > OLD_LIMIT_MS).toBe(true);
    expect(h.app.server.keepAliveTimeout).toBeLessThanOrEqual(5_000);
  });

  it('returns a slow sync result over a real socket', async () => {
    h = await createHarness();
    h.sync.delayMs = 300;
    const base = new URL(await h.app.listen({ host: '127.0.0.1', port: 0 }));
    expect(await get(base)).toBe(200);
  });
});
