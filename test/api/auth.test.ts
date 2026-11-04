import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import type { AuthService, AuthResult } from '../../src/modules/auth/service.js';
import { UnauthorizedError } from '../../src/common/errors/app-error.js';

const testEnv: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  HOST: '127.0.0.1',
  PORT: '0',
  LOG_LEVEL: 'silent',
  DATABASE_URL: 'postgresql://u:p@localhost:5432/t',
  JWT_SECRET: 'test-secret-test-secret-test-secret-1234',
  AUTH_RATE_LIMIT_MAX: '5',
};

const tokenPair: AuthResult = {
  accessToken: 'at',
  refreshToken: 'rt',
  tokenType: 'Bearer',
  expiresIn: 900,
};

function makeService(over: Partial<AuthService> = {}) {
  return {
    login: async () => tokenPair,
    refresh: async () => tokenPair,
    logout: async () => undefined,
    buildActorContext: async () => ({
      actorId: 'p1',
      actorType: 'USER' as const,
      sessionId: 's1',
    }),
    ...over,
  } as unknown as AuthService;
}

async function appWith(service: AuthService): Promise<FastifyInstance> {
  return buildApp({ env: testEnv, services: { authService: service } });
}

describe('auth routes', () => {
  describe('POST /api/v1/auth/login', () => {
    let app: FastifyInstance;
    beforeAll(async () => {
      app = await appWith(makeService());
    });
    afterAll(() => app.close());

    it('returns a token pair on success', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { loginId: 'a@b.com', password: 'pw' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<AuthResult>();
      expect(body.accessToken).toBe('at');
      expect(body.tokenType).toBe('Bearer');
      expect(body.expiresIn).toBe(900);
    });

    it('returns user profile and roles on success when available', async () => {
      const appUser = await appWith(
        makeService({
          login: async () => ({
            ...tokenPair,
            role: 'COMPANY_OWNER',
            roles: ['COMPANY_OWNER'],
            user: {
              id: 'p1',
              loginId: 'admin@acme.com',
              displayName: 'Acme Admin',
              companyId: 'c1',
              companyCode: 'ACME',
              companyName: 'Acme Infra',
              isPlatform: false,
              role: 'COMPANY_OWNER',
              roles: ['COMPANY_OWNER'],
            },
          }),
        }),
      );
      const res = await appUser.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { loginId: 'admin@acme.com', password: 'pw' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<AuthResult>();
      expect(body.role).toBe('COMPANY_OWNER');
      expect(body.roles).toEqual(['COMPANY_OWNER']);
      expect(body.user?.companyCode).toBe('ACME');
      await appUser.close();
    });

    it('rejects malformed bodies with a schema error', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { loginId: 'a@b.com' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('maps invalid credentials to a generic 401 shape', async () => {
      const app2 = await appWith(
        makeService({
          login: async () => {
            throw new UnauthorizedError('INVALID_CREDENTIALS', 'Invalid credentials');
          },
        }),
      );
      const res = await app2.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { loginId: 'a@b.com', password: 'bad' },
      });
      expect(res.statusCode).toBe(401);
      const body = res.json<{ error: { code: string; message: string } }>();
      expect(body.error.code).toBe('INVALID_CREDENTIALS');
      // Generic message — does not reveal whether the account exists.
      expect(body.error.message).toBe('Invalid credentials');
      await app2.close();
    });
  });

  describe('POST /api/v1/auth/refresh', () => {
    it('delegates and returns rotated tokens', async () => {
      const app = await appWith(makeService());
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        payload: { refreshToken: 'old-token' },
      });
      expect(res.statusCode).toBe(200);
      await app.close();
    });
  });

  describe('POST /api/v1/auth/logout', () => {
    it('requires authentication', async () => {
      const app = await appWith(makeService());
      const res = await app.inject({ method: 'POST', url: '/api/v1/auth/logout' });
      expect(res.statusCode).toBe(401);
      const body = res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe('TOKEN_MISSING');
      await app.close();
    });

    it('rejects a malformed bearer token', async () => {
      const app = await appWith(makeService());
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/logout',
        headers: { authorization: 'Bearer not-a-real-jwt' },
      });
      expect(res.statusCode).toBe(401);
      await app.close();
    });
  });
});
