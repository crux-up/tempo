import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { NotConfiguredError } from '../errors.js';
import { clientKey } from '../http/clientKey.js';
import { NarrativeQuerySchema, RepoParams } from '../http/params.js';
import { jsonResponse, problemResponse } from '../http/problem.js';
import type { NarrativeService } from '../narrative/narrativeService.js';
import { NarrativeResponseSchema } from '../narrative/response.js';

/** Each uncached request costs a model call, so this route has a far smaller budget than the rest of the API. */
const NARRATIVE_RATE_LIMIT_PER_MINUTE = 10;

export const narrativeRoutes: FastifyPluginAsyncZod<{ narrative: NarrativeService | null }> = async (app, opts) => {
  app.get(
    '/api/v1/repos/:owner/:repo/review-flow/narrative',
    {
      config: { rateLimit: { max: NARRATIVE_RATE_LIMIT_PER_MINUTE, timeWindow: '1 minute' } },
      schema: {
        summary: 'Language-model narrative over the review-flow metrics',
        description:
          'Builds the review-flow report for the window, sends only its numbers and GitHub logins to a language ' +
          'model, and returns a summary, findings and a root-cause hypothesis. Every evidence entry is checked ' +
          'against the metrics and carries the metric value, not the model text; unknown citations are dropped and ' +
          'confidence is capped for small samples. Results are cached per window, fact sheet, prompt version and ' +
          'model. An open-ended window (no `to`, or `to` after the last sync) ends at the latest UTC midnight at or ' +
          'before `dataAsOf` and is measured at that instant, so the narrative stays the same, and cached, for the ' +
          'whole day; a defaulted `from` is 30 days before that end. An ' +
          'uncached request waits for the model and can take up to about 150 seconds before it succeeds or fails ' +
          `with 502. Limited to ${NARRATIVE_RATE_LIMIT_PER_MINUTE} requests per minute per client, and to ` +
          'NARRATIVE_MAX_PER_CLIENT_PER_HOUR new (uncached) narratives per hour per client and ' +
          'NARRATIVE_MAX_PER_HOUR across all clients. Explicit `from` and `to` are floored to UTC midnight, so a ' +
          'narrative covers whole days; a window without one whole day of synced data is rejected with 400.',
        tags: ['metrics'],
        params: RepoParams,
        querystring: NarrativeQuerySchema,
        response: {
          200: jsonResponse('Verified narrative for the resolved window', NarrativeResponseSchema),
          400: problemResponse('Invalid repository path or query parameters'),
          404: problemResponse('Repository not found or not accessible'),
          429: problemResponse(
            'Client rate limit exceeded, or the hourly budget of new narratives for this client ' +
              '(NARRATIVE_MAX_PER_CLIENT_PER_HOUR) or for the server (NARRATIVE_MAX_PER_HOUR) is used up; ' +
              'see Retry-After',
          ),
          502: problemResponse('GitHub or the language model returned an error, or the model declined'),
          503: problemResponse(
            'ANTHROPIC_API_KEY is not set or was rejected, the GitHub token was rejected, or an upstream rate limit ' +
              'was reached (see Retry-After)',
          ),
        },
      },
    },
    async (request, reply) => {
      if (!opts.narrative) {
        throw new NotConfiguredError('Narratives are disabled: set ANTHROPIC_API_KEY to enable them');
      }
      const { owner, repo } = request.params;
      const client = clientKey(request.ip);
      const narrative = await opts.narrative.getNarrative({ owner, name: repo }, request.query, client);
      return reply.header('cache-control', 'private, max-age=60').send(narrative);
    },
  );
};
