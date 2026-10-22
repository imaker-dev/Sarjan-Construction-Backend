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
  };

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
