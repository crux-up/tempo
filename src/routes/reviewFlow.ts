import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { ReviewFlowQuerySchema, ReviewFlowReportSchema, RepoParams } from '../http/params.js';
import { jsonResponse, problemResponse } from '../http/problem.js';
import type { ReviewFlowService } from '../services/reviewFlowService.js';

export const reviewFlowRoutes: FastifyPluginAsyncZod<{ reviewFlow: ReviewFlowService }> = async (app, opts) => {
  app.get(
    '/api/v1/repos/:owner/:repo/review-flow',
    {
      schema: {
        summary: 'Review-flow metrics for a public GitHub repository',
        description:
          'Syncs pull requests, reviews and default-branch commits for the window on demand (cached for the sync ' +
          'TTL), then returns team, per-person and weekly review-flow metrics.',
        tags: ['metrics'],
        params: RepoParams,
        querystring: ReviewFlowQuerySchema,
        response: {
          200: jsonResponse('Review-flow report for the resolved window', ReviewFlowReportSchema),
          400: problemResponse('Invalid repository path or query parameters'),
          404: problemResponse('Repository not found or not accessible'),
          429: problemResponse('Client rate limit exceeded; see Retry-After'),
          502: problemResponse('GitHub returned an error'),
          503: problemResponse('GitHub rate limit reached (see Retry-After) or the GitHub token was rejected'),
        },
      },
    },
    async (request, reply) => {
      const { owner, repo } = request.params;
      const report = await opts.reviewFlow.getReport({ owner, name: repo }, request.query);
      return reply.header('cache-control', 'private, max-age=60').send(report);
    },
  );
};
