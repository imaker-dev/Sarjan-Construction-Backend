import type { Redis } from 'ioredis';
import { channelFor } from './service.js';

export interface NotificationSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  on(event: 'pong' | 'close' | 'error', cb: () => void): void;
  ping(): void;
}

interface Binding {
  principalId: string;
  companyId: string;
  sessionId: string;
}

export interface GatewayDeps {
  /** Dedicated subscriber connection — a subscribed client can't multiplex. */
  subscriber: Redis;
  /** Re-validates session+principal every `revalidateMs`; false → close 4403. */
  revalidate: (sub: string, sid: string) => Promise<boolean>;
  pingMs?: number;
  revalidateMs?: number;
}

/**
 * Per-instance realtime gateway: principal→sockets registry, one Redis
 * subscription per (company,principal) shared across that instance's sockets.
 * Transport-agnostic — the Fastify plugin adapts @fastify/websocket sockets
 * to NotificationSocket; tests drive this class with fakes.
 */
export class NotificationGateway {
  private readonly sockets = new Map<string, Set<NotificationSocket>>(); // `${companyId}:${principalId}`
  private readonly subscribed = new Map<string, number>(); // key → socket count

  constructor(private readonly deps: GatewayDeps) {
    this.deps.subscriber.on('message', (channel: string, message: string) => {
      const key = channel.slice('notif:'.length);
      for (const socket of this.sockets.get(key) ?? []) {
        try {
          socket.send(message);
        } catch {
          /* drop broken socket on next cleanup */
        }
      }
    });
  }

  /** Bind a verified session — caller supplies principal/company from auth, never client ids. */
  attach(binding: Binding, socket: NotificationSocket): () => void {
    const key = `${binding.companyId}:${binding.principalId}`;
    const set = this.sockets.get(key) ?? new Set<NotificationSocket>();
    set.add(socket);
    this.sockets.set(key, set);
    const count = (this.subscribed.get(key) ?? 0) + 1;
    this.subscribed.set(key, count);
    if (count === 1) {
      void this.deps.subscriber.subscribe(channelFor(binding.companyId, binding.principalId));
    }

    let alive = true;
    const pingTimer = setInterval(() => {
      if (!alive) {
        socket.terminate();
        detach();
        return;
      }
      alive = false;
      socket.ping();
    }, this.deps.pingMs ?? 30_000);
    const revalTimer = setInterval(() => {
      void this.deps.revalidate(binding.principalId, binding.sessionId).then((ok) => {
        if (!ok) {
          socket.close(4403, 'session revoked');
          detach();
        }
      });
    }, this.deps.revalidateMs ?? 60_000);

    const detach = () => {
      clearInterval(pingTimer);
      clearInterval(revalTimer);
      const current = this.sockets.get(key);
      if (current === undefined) return;
      current.delete(socket);
      const remaining = (this.subscribed.get(key) ?? 1) - 1;
      this.subscribed.set(key, remaining);
      if (remaining <= 0) {
        this.sockets.delete(key);
        this.subscribed.delete(key);
        void this.deps.subscriber.unsubscribe(channelFor(binding.companyId, binding.principalId));
      }
    };

    socket.on('pong', () => {
      alive = true;
    });
    socket.on('close', detach);
    socket.on('error', detach);
    return detach;
  }

  connectionCount(): number {
    let n = 0;
    for (const set of this.sockets.values()) n += set.size;
    return n;
  }

  async closeAll(): Promise<void> {
    for (const set of this.sockets.values()) {
      for (const socket of set) socket.close(1001, 'server shutdown');
    }
    this.sockets.clear();
    this.subscribed.clear();
    // A lazily-connected subscriber may never have opened — quit only if live.
    const status = (this.deps.subscriber as { status?: string }).status;
    if (status === 'ready' || status === 'connect' || status === 'connecting') {
      await this.deps.subscriber.quit().catch(() => undefined);
    }
  }
}
