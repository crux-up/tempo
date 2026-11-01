import { request } from 'node:http';
import { connect } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './harness.js';

const PATH = '/api/v1/repos/fastify/fastify/review-flow?from=2026-03-02&to=2026-03-16';
const SHORT = { connectionMs: 200, headersMs: 200 };

let h: Harness | undefined;

afterEach(async () => {
  await h?.close();
  h = undefined;
});

function get(base: URL, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: base.hostname, port: base.port, path, method: 'GET' }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('server timeouts', () => {
  it('keeps the short receive limit and the keep-alive limit in production', async () => {
    h = await createHarness();
    expect(h.app.server.headersTimeout).toBe(10_000);
    expect(h.app.server.keepAliveTimeout).toBe(5_000);
    expect(h.app.server.headersTimeout).toBeLessThanOrEqual(h.app.server.requestTimeout);
  });

  it('lets a routed long request outlive the receive-phase socket limit', async () => {
    h = await createHarness({ timeouts: SHORT });
    h.sync.delayMs = 500;
    const base = new URL(await h.app.listen({ host: '127.0.0.1', port: 0 }));
    expect(await get(base, PATH)).toBe(200);
  });

  it('disconnects a client that sends incomplete headers after the short limit', async () => {
    h = await createHarness({ timeouts: SHORT });
    const base = new URL(await h.app.listen({ host: '127.0.0.1', port: 0 }));
    const started = Date.now();
    await new Promise<void>((resolve, reject) => {
      const socket = connect({ host: base.hostname, port: Number(base.port) }, () => {
        socket.write('GET /healthz HTTP/1.1\r\nHost: 127.0.0.1\r\n');
      });
      socket.on('close', () => resolve());
      socket.on('error', () => undefined);
      setTimeout(() => {
        socket.destroy();
        reject(new Error('socket was not closed by the server'));
      }, 3_000).unref();
    });
    expect(Date.now() - started).toBeLessThan(2_500);
  });
});
