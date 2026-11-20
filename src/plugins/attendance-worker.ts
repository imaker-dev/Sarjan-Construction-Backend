import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import type { AttendanceWorker } from '../modules/attendance/worker.js';

declare module 'fastify' {
  interface FastifyInstance {
    attendanceWorker?: AttendanceWorker;
  }
}

/**
 * Attendance stale session worker lifecycle — starts inside app process only
 * when NOTIFICATIONS_WORKER is 'on' or 'auto' in production.
 */
export default fp(
  async function attendanceWorkerPlugin(
    app: FastifyInstance,
    opts: { worker?: AttendanceWorker },
  ) {
    const mode = app.config.NOTIFICATIONS_WORKER;
    const enabled = mode === 'on' || (mode === 'auto' && app.config.NODE_ENV === 'production');
    if (!enabled) return;
    const worker = opts.worker;
    if (worker === undefined) {
      throw new Error('attendance worker is enabled but no worker was provided');
    }
    app.addHook('onReady', async () => {
      await worker.start();
      app.log.info('attendance sweep worker started');
    });
    app.addHook('onClose', async () => {
      await worker.close();
    });
    app.decorate('attendanceWorker', worker);
  },
  { name: 'attendance-worker', dependencies: ['config', 'redis'] },
);
