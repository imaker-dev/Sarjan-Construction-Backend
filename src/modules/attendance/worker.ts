import { Queue, Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import type { AttendanceService } from './service.js';

export const ATTENDANCE_QUEUE = 'attendance-sweep';
export const SWEEP_JOB = 'sweep-stale-sessions';
export const SWEEP_INTERVAL_MS = 60_000;

/**
 * BullMQ background worker for sweeping stale attendance sessions (>24h without punch out).
 * Owns job scheduling only; business logic resides entirely in AttendanceService.
 */
export class AttendanceWorker {
  private queue: Queue | null = null;
  private worker: Worker | null = null;
  private started = false;

  constructor(
    private readonly service: AttendanceService,
    private readonly connection: Redis,
    private readonly log: (msg: string, meta?: Record<string, unknown>) => void = () => undefined,
  ) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.queue = new Queue(ATTENDANCE_QUEUE, { connection: this.connection });
    this.worker = new Worker(
      ATTENDANCE_QUEUE,
      async (job) => {
        if (job.name === SWEEP_JOB) {
          const autoClosedCount = await this.service.sweepStaleSessions();
          this.log('attendance stale sessions sweep tick', { autoClosedCount });
        }
      },
      { connection: this.connection, concurrency: 1 },
    );
    await this.queue.add(
      SWEEP_JOB,
      {},
      { repeat: { every: SWEEP_INTERVAL_MS }, jobId: SWEEP_JOB },
    );
    this.started = true;
  }

  isReady(): boolean {
    return this.started;
  }

  async close(): Promise<void> {
    if (this.worker !== null) await this.worker.close();
    if (this.queue !== null) await this.queue.close();
    this.connection.disconnect();
    this.worker = null;
    this.queue = null;
    this.started = false;
  }
}
