import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import type { NotificationWorker } from '../modules/notification/worker.js';

declare module 'fastify' {
  interface FastifyInstance {
    notificationWorker?: NotificationWorker;
  }
}

/**
 * Relay worker lifecycle — starts inside the app process only when the config
 * asks for it (production by default via 'auto'). Unit tests never reach this
 * because NOTIFICATIONS_WORKER resolves 'off' outside production unless 'on'.
 */
export default fp(
  async function notificationWorkerPlugin(
    app: FastifyInstance,
    opts: { worker?: NotificationWorker },
  ) {
    const mode = app.config.NOTIFICATIONS_WORKER;
    const enabled = mode === 'on' || (mode === 'auto' && app.config.NODE_ENV === 'production');
    if (!enabled) return;
    const worker = opts.worker;
    if (worker === undefined) {
      throw new Error('notification worker is enabled but no worker was provided');
    }
    app.addHook('onReady', async () => {
      await worker.start();
      app.log.info('notification relay worker started');
    });
    app.addHook('onClose', async () => {
      await worker.close();
    });
    app.decorate('notificationWorker', worker);
  },
  { name: 'notification-worker', dependencies: ['config', 'redis'] },
);
