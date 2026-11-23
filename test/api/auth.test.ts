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
    getMe: async () => ({
      id: '00000000-0000-0000-0000-000000000001',
      loginId: 'user@example.com',
      loginIdType: 'EMAIL',
      status: 'ACTIVE',
      displayName: 'Test User',
      employeeId: '00000000-0000-0000-0000-000000000003',
      employeeCode: 'EMP-001',
      designation: 'Engineer',
      tradeCategory: null,
      contactPhone: null,
      contactEmail: null,
      joiningDate: null,
      company: {
        id: '00000000-0000-0000-0000-000000000002',
        code: 'ACME',
        name: 'Acme Corp',
        isPlatform: false,
      },
      role: 'COMPANY_OWNER',
      roles: ['COMPANY_OWNER'],
      permissions: ['ORG_COMPANY_READ'],
      operations: ['PROJECT_DASHBOARD_VIEW'],
      assignments: [],
      departments: [],
      documents: [],
    }),
    getProfile: async () => ({
      principal: {
        id: '00000000-0000-0000-0000-000000000001',
        loginId: 'user@example.com',
        loginIdType: 'EMAIL',
        status: 'ACTIVE',
        mfaEnabled: false,
        mfaType: null,
      },
      employee: {
        id: '00000000-0000-0000-0000-000000000003',
        companyId: '00000000-0000-0000-0000-000000000002',
        employeeCode: 'EMP-001',
        displayName: 'Test User',
        engagementType: 'DIRECT_EMPLOYEE',
        designation: 'Engineer',
        tradeCategory: 'CIVIL',
        joiningDate: '2024-01-15',
        contactPhone: '+919876543210',
        contactEmail: 'user@example.com',
        emergencyContactName: 'Parent',
        emergencyContactPhone: '+919876543211',
        status: 'ACTIVE',
      },
      company: {
        id: '00000000-0000-0000-0000-000000000002',
        code: 'ACME',
        name: 'Acme Corp',
        isPlatform: false,
      },
      primaryRole: 'COMPANY_OWNER',
      roles: ['COMPANY_OWNER'],
      permissions: ['ORG_COMPANY_READ'],
      assignments: [],
      departments: [],
      attendance: {
        hasActiveSession: false,
        activeSession: null,
      },
      leaveBalances: [
        {
          leaveType: 'CASUAL',
          year: 2026,
          allocatedDays: 12,
          usedDays: 2,
          pendingDays: 1,
          carriedOverDays: 0,
          availableDays: 9,
        },
      ],
      documents: [],
    }),
    changePassword: async () => ({
      success: true,
      message: 'Password changed successfully',
    }),
    requestMfaSetup: async () => ({
      mfaRequired: true as const,
      mfaToken: 'setup-token',
      mfaType: 'EMAIL_OTP' as const,
      maskedEmail: 'u***@example.com',
      expiresInSeconds: 300,
    }),
    confirmMfaSetup: async () => ({
      success: true,
      mfaEnabled: true,
      mfaType: 'EMAIL_OTP',
    }),
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

  describe('GET /api/v1/auth/me', () => {
    it('requires authentication', async () => {
      const app = await appWith(makeService());
      const res = await app.inject({ method: 'GET', url: '/api/v1/auth/me' });
      expect(res.statusCode).toBe(401);
      const body = res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe('TOKEN_MISSING');
      await app.close();
    });

    it('returns user profile, roles, and permissions when authenticated', async () => {
      const app = await appWith(makeService());
      const token = app.tokenService.signAccessToken('p1', 's1');
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{
        id: string;
        loginId: string;
        role: string;
        roles: string[];
        permissions: string[];
        company: { code: string };
      }>();
      expect(body.loginId).toBe('user@example.com');
      expect(body.role).toBe('COMPANY_OWNER');
      expect(body.roles).toContain('COMPANY_OWNER');
      expect(body.permissions).toContain('ORG_COMPANY_READ');
      expect(body.company.code).toBe('ACME');
      await app.close();
    });
  });

  describe('GET /api/v1/profile', () => {
    it('requires authentication', async () => {
      const app = await appWith(makeService());
      const res = await app.inject({ method: 'GET', url: '/api/v1/profile' });
      expect(res.statusCode).toBe(401);
      const body = res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe('TOKEN_MISSING');
      await app.close();
    });

    it('returns aggregated profile with principal, employee, attendance, and leave details', async () => {
      const app = await appWith(makeService());
      const token = app.tokenService.signAccessToken('p1', 's1');
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/profile',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{
        principal: { loginId: string; mfaEnabled: boolean };
        employee: { employeeCode: string; displayName: string; designation: string };
        company: { code: string };
        attendance: { hasActiveSession: boolean };
        leaveBalances: { leaveType: string; availableDays: number }[];
      }>();
      expect(body.principal.loginId).toBe('user@example.com');
      expect(body.principal.mfaEnabled).toBe(false);
      expect(body.employee.displayName).toBe('Test User');
      expect(body.employee.employeeCode).toBe('EMP-001');
      expect(body.employee.designation).toBe('Engineer');
      expect(body.company.code).toBe('ACME');
      expect(body.attendance.hasActiveSession).toBe(false);
      expect(body.leaveBalances).toHaveLength(1);
      expect(body.leaveBalances[0]?.availableDays).toBe(9);
      await app.close();
    });
  });

  describe('POST /api/v1/auth/change-password', () => {
    it('requires authentication', async () => {
      const app = await appWith(makeService());
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/change-password',
        payload: { currentPassword: 'old', newPassword: 'new-secure-password' },
      });
      expect(res.statusCode).toBe(401);
      await app.close();
    });

    it('successfully changes password when authenticated', async () => {
      const app = await appWith(makeService());
      const token = app.tokenService.signAccessToken('p1', 's1');
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/change-password',
        headers: { authorization: `Bearer ${token}` },
        payload: { currentPassword: 'secret-pw', newPassword: 'brand-new-password-123' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ success: boolean; message: string }>();
      expect(body.success).toBe(true);
      await app.close();
    });
  });

  describe('POST /api/v1/auth/mfa/setup', () => {
    it('requires authentication', async () => {
      const app = await appWith(makeService());
      const res = await app.inject({ method: 'POST', url: '/api/v1/auth/mfa/setup' });
      expect(res.statusCode).toBe(401);
      await app.close();
    });

    it('returns challenge with masked email and mfaToken', async () => {
      const app = await appWith(makeService());
      const token = app.tokenService.signAccessToken('p1', 's1');
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/mfa/setup',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ mfaRequired: boolean; mfaToken: string; maskedEmail: string }>();
      expect(body.mfaRequired).toBe(true);
      expect(body.mfaToken).toBe('setup-token');
      expect(body.maskedEmail).toBe('u***@example.com');
      await app.close();
    });
  });
});
