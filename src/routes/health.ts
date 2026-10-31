import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Store } from '../db/store.js';
import { NotReadyError } from '../errors.js';
import { HealthSchema, ReadySchema } from '../http/params.js';
import { jsonResponse, problemResponse } from '../http/problem.js';

/** Probes live outside /api, so the client rate limit never applies to them. */
export const healthRoutes: FastifyPluginAsyncZod<{ store: Store }> = async (app, opts) => {
  app.get(
    '/healthz',
    {
      schema: {
        summary: 'Liveness probe',
        tags: ['health'],
        response: { 200: jsonResponse('The process is up', HealthSchema) },
      },
    },
    async () => ({ status: 'ok' as const }),
  );

  app.get(
    '/readyz',
    {
      schema: {
        summary: 'Readiness probe: checks that the database answers',
        tags: ['health'],
        response: {
          200: jsonResponse('The database answers', ReadySchema),
          503: problemResponse('Database unavailable'),
        },
      },
    },
    async (request) => {
      try {
        opts.store.ping();
      } catch (err) {
        request.log.error({ err }, 'Readiness check failed');
        throw new NotReadyError();
      }
      return { status: 'ready' as const };
    },
  );
};
