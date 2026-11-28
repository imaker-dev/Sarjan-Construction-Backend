import { describe, it, expect, vi } from 'vitest';
import { buildApp } from '../../src/app.js';
import type { AuthService } from '../../src/modules/auth/service.js';
import type { NotificationService } from '../../src/modules/notification/service.js';
import type { PrincipalContext } from '../../src/plugins/authentication.js';

// Route-level checks for the notification inbox boundary: the recipient is
// always the authenticated principal derived from the verified token — never
// a client-supplied principal or company id beyond the tenant guard. The
// real auth + tenant-guard pipeline runs; only the service is substituted.

const env: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  HOST: '127.0.0.1',
  PORT: '0',
  LOG_LEVEL: 'silent',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/testdb',
  REDIS_HOST: 'localhost',
  REDIS_PORT: '6379',
  JWT_SECRET: 'test-secret-test-secret-test-secret-1234',
};

const CID = '00000000-0000-4000-8000-0000000000c0';
const OTHER_CID = '00000000-0000-4000-8000-000000000099';

const authHeaders = (app: {
  tokenService: { signAccessToken: (s: string, sid: string) => string };
}) => ({
  authorization: `Bearer ${app.tokenService.signAccessToken('p1', 's1')}`,
  'x-company-id': CID,
});

async function makeApp() {
  const list = vi.fn().mockResolvedValue({ notifications: [], nextCursor: null });
  const markRead = vi.fn().mockResolvedValue({ id: 'n1', readAt: new Date().toISOString() });
  const markAllRead = vi.fn().mockResolvedValue({ updatedCount: 4, readAt: new Date('2026-11-28T10:00:00Z') });
  const unreadCount = vi.fn().mockResolvedValue(3);
  const issueTicket = vi.fn().mockResolvedValue({ ticket: 'tk.1', expiresInSeconds: 30 });
  const notificationService = {
    list,
    markRead,
    markAllRead,
    unreadCount,
    issueTicket,
    revalidate: vi.fn().mockResolvedValue(true),
  } as unknown as NotificationService;
  const authService = {
    buildActorContext: async () =>
      ({ actorId: 'p1', actorType: 'USER', sessionId: 's1' }) as unknown as PrincipalContext,
    verifyAccessToken: async () => ({ sub: 'p1', sid: 's1' }),
  } as unknown as AuthService;
  const app = await buildApp({
    env,
    services: { authService, notificationService, platformCompanyId: null },
  });
  return { app, list, markRead, markAllRead, unreadCount };
}

describe('notification inbox routes', () => {
  it('401 without authentication; company header required', async () => {
    const { app } = await makeApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/api/v1/notifications' });
      expect(res.statusCode).toBe(401);
      const count = await app.inject({
        method: 'GET',
        url: '/api/v1/notifications/unread-count',
      });
      expect(count.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('list is invoked with the authenticated principal — never a client-supplied id', async () => {
    const { app, list } = await makeApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/notifications?limit=10',
        headers: authHeaders(app),
      });
      expect(res.statusCode).toBe(200);
      expect(list).toHaveBeenCalledWith(
        expect.objectContaining({ actorId: 'p1' }),
        CID,
        expect.objectContaining({ limit: 10 }),
      );
      // a foreign principal/company id in the query can never widen the scope
      const spoof = await app.inject({
        method: 'GET',
        url: '/api/v1/notifications?recipientPrincipalId=other&companyId=' + OTHER_CID,
        headers: authHeaders(app),
      });
      expect(spoof.statusCode).toBe(200);
      expect(list).toHaveBeenLastCalledWith(
        expect.objectContaining({ actorId: 'p1' }),
        CID,
        expect.anything(),
      );
    } finally {
      await app.close();
    }
  });

  it('unread-count is strictly scoped to the authenticated recipient', async () => {
    const { app, unreadCount } = await makeApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/notifications/unread-count',
        headers: authHeaders(app),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ unreadCount: 3 });
      expect(unreadCount).toHaveBeenCalledWith(expect.objectContaining({ actorId: 'p1' }), CID);
    } finally {
      await app.close();
    }
  });

  it('mark-read binds the authenticated principal to the service call', async () => {
    const { app, markRead } = await makeApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/notifications/00000000-0000-4000-8000-0000000000a1/read',
        headers: authHeaders(app),
      });
      expect(res.statusCode).toBe(200);
      expect(markRead).toHaveBeenCalledWith(
        expect.objectContaining({ actorId: 'p1' }),
        CID,
        '00000000-0000-4000-8000-0000000000a1',
      );
    } finally {
      await app.close();
    }
  });

  it('mark-all-read binds the authenticated principal and returns updatedCount', async () => {
    const { app, markAllRead } = await makeApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/notifications/read-all',
        headers: authHeaders(app),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        updatedCount: 4,
        readAt: '2026-11-28T10:00:00.000Z',
      });
      expect(markAllRead).toHaveBeenCalledWith(expect.objectContaining({ actorId: 'p1' }), CID);
    } finally {
      await app.close();
    }
  });
});
