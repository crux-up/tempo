import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import swagger from '@fastify/swagger';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyLoggerOptions, FastifyReply, FastifyRequest } from 'fastify';
import {
  jsonSchemaTransform,
  jsonSchemaTransformObject,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import type { LoggerOptions } from 'pino';
import type { Config } from './config.js';
import type { Store } from './db/store.js';
import { TooManyRequestsError } from './errors.js';
import { registerProblemHandlers, requestPath, sendFrameworkError, sendNotFound } from './http/problem.js';
import { healthRoutes } from './routes/health.js';
import { reviewFlowRoutes } from './routes/reviewFlow.js';
import type { ReviewFlowService } from './services/reviewFlowService.js';

export type AppLoggerOptions = FastifyLoggerOptions & LoggerOptions;

export type AppDeps = {
  config: Config;
  store: Store;
  reviewFlow: ReviewFlowService;
  /** No narrative service exists yet, so no narrative route is registered. */
  narrative: null;
  /** `false` disables logging; otherwise these options are merged over the defaults (redaction always applies). */
  logger?: false | AppLoggerOptions;
  /** Built single-page app; served at `/` only when the directory exists. Defaults to `web/dist`. */
  webRoot?: string;
};

export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  '*.token',
  '*.apiKey',
  '*.githubToken',
  '*.anthropicApiKey',
  'GITHUB_TOKEN',
  'ANTHROPIC_API_KEY',
  '*.GITHUB_TOKEN',
  '*.ANTHROPIC_API_KEY',
];

const DEFAULT_WEB_ROOT = fileURLToPath(new URL('../web/dist', import.meta.url));
const RATE_LIMIT_PER_MINUTE = 120;

/** Logger options with redaction always applied; `server.ts` reuses them for the services' logger. */
export function loggerOptions(config: Config, overrides?: AppLoggerOptions): AppLoggerOptions {
  return {
    level: config.logLevel,
    ...overrides,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    serializers: {
      // Path only: query strings are client input and may carry secrets.
      req: (req: FastifyRequest) => ({ method: req.method, url: requestPath(req), remoteAddress: req.ip }),
    },
  };
}

type OpenApiDoc = ReturnType<typeof jsonSchemaTransformObject>;

/** The transform emits an `<id>Input` twin of every named schema; drop the twins no operation references. */
function withoutUnusedSchemas(doc: OpenApiDoc): OpenApiDoc {
  const schemas = 'components' in doc ? doc.components?.schemas : undefined;
  if (!schemas) return doc;
  const referenced = JSON.stringify({ ...doc, components: undefined });
  for (const name of Object.keys(schemas)) {
    if (!referenced.includes(`"#/components/schemas/${name}"`)) delete schemas[name];
  }
  return doc;
}

const acceptsHtml = (request: FastifyRequest) => request.headers.accept?.includes('text/html') ?? false;
const isApiPath = (path: string) => path === '/api' || path.startsWith('/api/');

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: deps.logger === false ? false : loggerOptions(deps.config, deps.logger),
    genReqId: () => randomUUID(),
    requestIdHeader: false,
    frameworkErrors: sendFrameworkError,
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });
  registerProblemHandlers(app);

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        // Served over plain HTTP on localhost; upgrading would break same-origin asset loads.
        upgradeInsecureRequests: null,
      },
    },
  });

  await app.register(rateLimit, {
    global: true,
    max: RATE_LIMIT_PER_MINUTE,
    timeWindow: '1 minute',
    errorResponseBuilder: (_request, context) => new TooManyRequestsError(Math.max(1, Math.ceil(context.ttl / 1000))),
  });

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Tempo API',
        version: '1.0.0',
        description: 'Review-flow metrics for public GitHub repositories. Errors are RFC 9457 problem documents.',
      },
      tags: [
        { name: 'metrics', description: 'Repository metrics' },
        { name: 'health', description: 'Probes' },
      ],
    },
    transform: jsonSchemaTransform,
    transformObject: (input) => withoutUnusedSchemas(jsonSchemaTransformObject(input)),
  });

  await app.register(healthRoutes, { store: deps.store });
  await app.register(reviewFlowRoutes, { reviewFlow: deps.reviewFlow });
  app.get('/api/v1/openapi.json', { schema: { hide: true } }, async () => app.swagger());

  const webRoot = deps.webRoot ?? DEFAULT_WEB_ROOT;
  const serveSpa = existsSync(join(webRoot, 'index.html'));
  if (serveSpa) await app.register(fastifyStatic, { root: webRoot, prefix: '/' });

  app.setNotFoundHandler({ preHandler: app.rateLimit() }, (request: FastifyRequest, reply: FastifyReply) => {
    // Client-side routes resolve to the SPA shell; API paths and asset requests get a problem.
    if (serveSpa && request.method === 'GET' && !isApiPath(requestPath(request)) && acceptsHtml(request)) {
      return reply.header('cache-control', 'no-cache').sendFile('index.html');
    }
    return sendNotFound(request, reply);
  });

  return app;
}
