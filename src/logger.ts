/** Minimal structural logger; pino and Fastify loggers satisfy it. */
export interface Logger {
  debug(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
}
