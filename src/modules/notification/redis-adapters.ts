import type { Redis } from 'ioredis';
import type { NotificationPublisher, TicketStore } from './types.js';

const TICKET_PREFIX = 'notif:ticket:';

/** Redis SETEX + GETDEL — atomic single-use, TTL-bounded. */
export class RedisTicketStore implements TicketStore {
  constructor(private readonly redis: Redis) {}

  async issue(jti: string, ttlSeconds: number): Promise<void> {
    await this.redis.set(`${TICKET_PREFIX}${jti}`, '1', 'EX', ttlSeconds, 'NX');
  }

  async consume(jti: string): Promise<boolean> {
    // GETDEL is atomic — only the first consumer sees the value.
    const value = await this.redis.getdel(`${TICKET_PREFIX}${jti}`);
    return value !== null;
  }
}

/** Redis pub/sub publisher — a zero-subscriber publish still succeeds. */
export class RedisNotificationPublisher implements NotificationPublisher {
  constructor(private readonly redis: Redis) {}
  async publish(channel: string, message: string): Promise<void> {
    await this.redis.publish(channel, message);
  }
}
