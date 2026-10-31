import { STATUS_CODES } from 'node:http';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AppError, PROBLEM_BASE, RouteNotFoundError } from '../errors.js';

export const PROBLEM_CONTENT_TYPE = 'application/problem+json; charset=utf-8';

export const ProblemSchema = z
  .object({
    type: z.string().describe('URI identifying the problem type: urn:tempo:problem:<slug>, or about:blank'),
    title: z.string(),
    status: z.number().int(),
    detail: z.string(),
    instance: z.string().describe('Request path, without the query string'),
    requestId: z.string().describe('Also returned as the x-request-id header; quote it when reporting a problem'),
    errors: z
      .array(z.object({ path: z.string(), message: z.string() }))
      .optional()
      .describe('Field-level validation failures'),
  })
  .meta({ id: 'Problem' });

type Problem = z.infer<typeof ProblemSchema>;

/** OpenAPI response entry for a problem: documented under its real media type. */
export const problemResponse = (description: string) => ({
  description,
  content: { 'application/problem+json': { schema: ProblemSchema } },
});

export const jsonResponse = <T extends z.ZodType>(description: string, schema: T) => ({
  description,
  content: { 'application/json': { schema } },
});
type FieldError = { path: string; message: string };

type ProblemInput = {
  status: number;
  type: string;
  title: string;
  detail: string;
  errors?: FieldError[];
  retryAfterSeconds?: number;
};

const INTERNAL_DETAIL = 'An unexpected error occurred';

/** The request path only: query strings may carry values that must not be echoed back. */
export function requestPath(request: FastifyRequest): string {
  const queryStart = request.url.indexOf('?');
  return queryStart === -1 ? request.url : request.url.slice(0, queryStart);
}

export function sendProblem(request: FastifyRequest, reply: FastifyReply, input: ProblemInput): FastifyReply {
  const body: Problem = {
    type: input.type,
    title: input.title,
    status: input.status,
    detail: input.detail,
    instance: requestPath(request),
    requestId: request.id,
    ...(input.errors ? { errors: input.errors } : {}),
  };
  // Set here as well as in onRequest: framework errors (such as a malformed URL) are answered before any hook runs.
  reply.header('x-request-id', request.id);
  if (input.retryAfterSeconds !== undefined) reply.header('retry-after', String(input.retryAfterSeconds));
  // Serialised here rather than by a route schema, so every problem has the same shape whichever route failed.
  return reply
    .code(input.status)
    .header('cache-control', 'no-store')
    .type(PROBLEM_CONTENT_TYPE)
    .send(JSON.stringify(body));
}

export function sendAppError(request: FastifyRequest, reply: FastifyReply, error: AppError): FastifyReply {
  return sendProblem(request, reply, {
    status: error.status,
    type: error.type,
    title: error.title,
    detail: error.message,
    retryAfterSeconds: error.retryAfterSeconds,
  });
}

function fieldErrors(error: FastifyError & { validation: Array<{ instancePath: string; message?: string }> }) {
  const context = error.validationContext ?? 'request';
  return error.validation.map((issue) => ({
    path: [context, ...issue.instancePath.split('/').filter(Boolean)].join('.'),
    message: issue.message ?? 'is invalid',
  }));
}

/** Maps every error to an RFC 9457 problem; only AppError and Fastify 4xx messages reach the client. */
export function registerProblemHandlers(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof AppError) {
      if (error.status >= 500) request.log.warn({ err: error }, 'Request failed');
      return sendAppError(request, reply, error);
    }
    if (hasZodFastifySchemaValidationErrors(error)) {
      const errors = fieldErrors(error);
      return sendProblem(request, reply, {
        status: 400,
        type: `${PROBLEM_BASE}invalid-request`,
        title: 'Invalid request',
        detail: `The request does not match the schema: ${errors.map((e) => e.path).join(', ')}`,
        errors,
      });
    }
    const status = error.statusCode;
    if (status !== undefined && status >= 400 && status < 500) {
      return sendProblem(request, reply, {
        status,
        type: 'about:blank',
        title: STATUS_CODES[status] ?? 'Client error',
        // Fastify's own messages are written for clients; anything else may carry upstream text.
        detail: error.code?.startsWith('FST_') ? error.message : (STATUS_CODES[status] ?? 'Client error'),
      });
    }
    request.log.error({ err: error }, 'Unhandled error');
    return sendProblem(request, reply, {
      status: 500,
      type: `${PROBLEM_BASE}internal-error`,
      title: 'Internal server error',
      detail: INTERNAL_DETAIL,
    });
  });
}

/** Errors Fastify raises before routing, such as an undecodable URL. */
export function sendFrameworkError(error: FastifyError, request: FastifyRequest, reply: FastifyReply): FastifyReply {
  return sendProblem(request, reply, {
    status: 400,
    type: `${PROBLEM_BASE}invalid-request`,
    title: 'Invalid request',
    detail: error.code === 'FST_ERR_BAD_URL' ? 'The request URL is malformed' : 'The request could not be routed',
  });
}

export function sendNotFound(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  return sendAppError(request, reply, new RouteNotFoundError(request.method));
}
