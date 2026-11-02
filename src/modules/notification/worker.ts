import { Queue, Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import type { NotificationService } from './service.js';

export const RELAY_QUEUE = 'notifications-relay';
export const RELAY_JOB = 'relay';
export const RELAY_INTERVAL_MS = 500;
export const SWEEP_JOB = 'sweep';
export const SWEEP_INTERVAL_MS = 60_000;

/**
 * BullMQ transport around NotificationService — owns job scheduling only;
 * all delivery semantics live in the service so tests run without Redis.
 */
export class NotificationWorker {
  private queue: Queue | null = null;
  private worker: Worker | null = null;
  private started = false;

  constructor(
    private readonly service: NotificationService,
    private readonly connection: Redis,
    private readonly log: (msg: string, meta?: Record<string, unknown>) => void = () => undefined,
  ) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.queue = new Queue(RELAY_QUEUE, { connection: this.connection });
    this.worker = new Worker(
      RELAY_QUEUE,
      async (job) => {
        const result =
          job.name === SWEEP_JOB ? await this.service.sweep() : await this.service.processBatch();
        this.log('notification relay tick', { job: job.name, ...result });
      },
      { connection: this.connection, concurrency: 1 },
    );
    await this.queue.add(RELAY_JOB, {}, { repeat: { every: RELAY_INTERVAL_MS }, jobId: RELAY_JOB });
    await this.queue.add(SWEEP_JOB, {}, { repeat: { every: SWEEP_INTERVAL_MS }, jobId: SWEEP_JOB });
    this.started = true;
  }

  isReady(): boolean {
    return this.started;
  }

  /** Graceful shutdown — in-flight batch completes, then connections close. */
  async close(): Promise<void> {
    if (this.worker !== null) await this.worker.close();
    if (this.queue !== null) await this.queue.close();
    this.connection.disconnect(); // the dedicated duplicate — never leaks
    this.worker = null;
    this.queue = null;
    this.started = false;
  }
}
