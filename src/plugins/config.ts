import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { loadConfig, type AppConfig } from '../config/index.js';

declare module 'fastify' {
  interface FastifyInstance {
    config: AppConfig;
  }
}

export interface ConfigPluginOptions {
  env?: NodeJS.ProcessEnv;
}

export default fp<ConfigPluginOptions>(
  async function configPlugin(app: FastifyInstance, opts: ConfigPluginOptions) {
    app.decorate('config', loadConfig(opts.env));
  },
  { name: 'config' },
);
