import 'dotenv/config';
import { buildApp } from './app.js';

async function main() {
  const app = await buildApp();
  const { HOST, PORT } = app.config;

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutdown requested');
    const forceExit = setTimeout(() => {
      app.log.error('graceful shutdown timed out; forcing exit');
      process.exit(1);
    }, 10_000);
    forceExit.unref();

    try {
      await app.close();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  try {
    await app.listen({ host: HOST, port: PORT });
  } catch (err) {
    app.log.error({ err }, 'failed to start server');
    process.exit(1);
  }
}

void main();
