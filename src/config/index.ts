import { isAbsolute, resolve, sep } from 'node:path';

const NODE_ENVS = ['development', 'test', 'production'] as const;
type NodeEnv = (typeof NODE_ENVS)[number];

export interface AppConfig {
  NODE_ENV: NodeEnv;
  HOST: string;
  PORT: number;
  LOG_LEVEL: string;
  DATABASE_URL: string;
  REDIS_HOST: string;
  REDIS_PORT: number;
  REDIS_PASSWORD?: string;
  REDIS_DB: number;
  JWT_SECRET: string;
  JWT_ISSUER: string;
  JWT_AUDIENCE: string;
  ACCESS_TOKEN_TTL_S: number;
  REFRESH_TOKEN_TTL_S: number;
  AUTH_RATE_LIMIT_MAX: number;
  AUTH_RATE_LIMIT_WINDOW_MS: number;
  DOCUMENT_STORAGE_DIR?: string;
  DOCUMENT_MAX_BYTES: number;
  DOCUMENT_UPLOADING_STALE_MINUTES: number;
  // 'auto' starts the relay worker in production only; 'on'/'off' override.
  NOTIFICATIONS_WORKER: 'auto' | 'on' | 'off';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const errors: string[] = [];

  // Never log raw env values; report only which variables failed validation.
  const str = (name: string, fallback?: string): string => {
    const value = env[name];
    if (value === undefined || value === '') {
      if (fallback === undefined) errors.push(`${name} is required`);
      return fallback ?? '';
    }
    return value;
  };

  const num = (name: string, fallback: number): number => {
    const value = env[name];
    if (value === undefined || value === '') return fallback;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      errors.push(`${name} must be a number`);
      return fallback;
    }
    return parsed;
  };

  const nodeEnv = str('NODE_ENV', 'development');
  if (!NODE_ENVS.includes(nodeEnv as NodeEnv)) {
    errors.push(`NODE_ENV must be one of: ${NODE_ENVS.join(', ')}`);
  }

  const config: AppConfig = {
    NODE_ENV: nodeEnv as NodeEnv,
    HOST: str('HOST', '0.0.0.0'),
    PORT: num('PORT', 3000),
    LOG_LEVEL: str('LOG_LEVEL', 'info'),
    DATABASE_URL: str('DATABASE_URL'),
    REDIS_HOST: str('REDIS_HOST', 'localhost'),
    REDIS_PORT: num('REDIS_PORT', 6379),
    REDIS_DB: num('REDIS_DB', 0),
    // Required: a random high-entropy secret. The placeholder value from
    // .env.example is rejected to prevent shipping a known signing key.
    JWT_SECRET: str('JWT_SECRET'),
    JWT_ISSUER: str('JWT_ISSUER', 'sarjan-erp'),
    JWT_AUDIENCE: str('JWT_AUDIENCE', 'sarjan-erp-api'),
    ACCESS_TOKEN_TTL_S: num('ACCESS_TOKEN_TTL_S', 900),
    REFRESH_TOKEN_TTL_S: num('REFRESH_TOKEN_TTL_S', 1_209_600),
    AUTH_RATE_LIMIT_MAX: num('AUTH_RATE_LIMIT_MAX', 10),
    AUTH_RATE_LIMIT_WINDOW_MS: num('AUTH_RATE_LIMIT_WINDOW_MS', 60_000),
    DOCUMENT_MAX_BYTES: num('DOCUMENT_MAX_BYTES', 10 * 1024 * 1024),
    DOCUMENT_UPLOADING_STALE_MINUTES: num('DOCUMENT_UPLOADING_STALE_MINUTES', 60),
    NOTIFICATIONS_WORKER: ((): 'auto' | 'on' | 'off' => {
      const v = env.NOTIFICATIONS_WORKER ?? 'auto';
      if (v !== 'auto' && v !== 'on' && v !== 'off') {
        errors.push('NOTIFICATIONS_WORKER must be auto|on|off');
        return 'auto';
      }
      return v;
    })(),
  };

  // Document storage: optional in dev; when set it must be an absolute path
  // OUTSIDE the repository checkout (uploads never live in the source tree).
  const docDir = env.DOCUMENT_STORAGE_DIR;
  if (docDir !== undefined && docDir !== '') {
    if (!isAbsolute(docDir)) {
      errors.push('DOCUMENT_STORAGE_DIR must be an absolute path');
    } else {
      const resolved = resolve(docDir);
      if (resolved === process.cwd() || resolved.startsWith(`${process.cwd()}${sep}`)) {
        errors.push('DOCUMENT_STORAGE_DIR must be outside the repository');
      } else {
        config.DOCUMENT_STORAGE_DIR = resolved;
      }
    }
  }

  if (config.JWT_SECRET === 'change-me' || config.JWT_SECRET.length < 32) {
    errors.push('JWT_SECRET must be set to a random secret of at least 32 characters');
  }

  const redisPassword = env.REDIS_PASSWORD;
  if (redisPassword !== undefined && redisPassword !== '') {
    config.REDIS_PASSWORD = redisPassword;
  }

  if (errors.length > 0) {
    throw new Error(
      `Invalid environment configuration:\n${errors.map((m) => `  - ${m}`).join('\n')}`,
    );
  }

  return config;
}
