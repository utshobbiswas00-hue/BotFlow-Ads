import pino from 'pino';
import { env, isProd } from './env';

const redactPaths = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-telegram-init-data"]',
  '*.password',
  '*.token',
  '*.secret',
  '*.accountDetails',
  // PII that would otherwise land in application logs via error objects.
  '*.email',
  '*.initData',
  '*.passwordHash',
  '*.emailVerifyToken',
  '*.TELEGRAM_BOT_TOKEN',
  '*.DATABASE_URL',
  '*.REDIS_URL',
  '*.TRON_TRONGRID_API_KEY',
];

export const logger = pino({
  level: env.LOG_LEVEL,
  redact: { paths: redactPaths, censor: '[REDACTED]' },
  base: { service: 'botflow-api', env: env.NODE_ENV },
  timestamp: pino.stdTimeFunctions.isoTime,
  ...(isProd
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'HH:MM:ss.l',
            ignore: 'pid,hostname,service,env',
            singleLine: false,
          },
        },
      }),
});

/** Logger with a fixed context tag: `const log = childLogger('delivery')`. */
export function childLogger(name: string) {
  return logger.child({ ctx: name });
}

export type Logger = typeof logger;
