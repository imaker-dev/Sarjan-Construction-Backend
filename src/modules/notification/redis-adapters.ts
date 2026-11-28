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
    // Atomic get + del via Lua script — compatible with Redis 5.0+ (where GETDEL is absent).
    const value = await this.redis.eval(
      "local v = redis.call('GET', KEYS[1]); if v then redis.call('DEL', KEYS[1]); end; return v",
      1,
      `${TICKET_PREFIX}${jti}`,
    );
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
