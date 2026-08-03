import pino from 'pino';
import { env } from './env.js';

/**
 * Structured application logger.
 * Redacts sensitive fields so we never log passwords, tokens, or API keys (§26).
 */
export const logger = pino({
  // LOG_LEVEL overrides the default so tests can silence output and operators
  // can raise verbosity without a code change. Accepts pino levels or 'silent'.
  level: process.env.LOG_LEVEL || (env.isProd ? 'info' : 'debug'),
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'password',
      'passwordHash',
      '*.password',
      '*.token',
      '*.accessToken',
      '*.refreshToken',
      '*.apiKey',
      'authorization',
    ],
    censor: '[REDACTED]',
  },
  transport: env.isProd
    ? undefined
    : {
        target: 'pino/file',
        options: { destination: 1 },
      },
});

export default logger;
