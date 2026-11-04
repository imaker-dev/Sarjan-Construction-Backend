import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import Fastify from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { AuthService, normalizeLoginId } from '../../../src/modules/auth/service.js';
import { createTokenService, type TokenService } from '../../../src/modules/auth/tokens.js';
import { passwordService } from '../../../src/modules/identity/password.js';
import { UnauthorizedError } from '../../../src/common/errors/app-error.js';
import { emptyAuthStore, fakePrincipal, FakeAuthUoW, type AuthStore } from './fakes.js';

const CFG = {
  issuer: 'sarjan-erp',
  audience: 'sarjan-erp-api',
  accessTokenTtlS: 900,
};

let tokens: TokenService;
let store: AuthStore;
let service: AuthService;

beforeAll(async () => {
  const app = Fastify();
  await app.register(fastifyJwt, { secret: 'x'.repeat(40) });
  tokens = createTokenService(
    {
      sign: (p, o) => app.jwt.sign(p, o),
      verify: (t: string, o?: Record<string, unknown>) =>
        app.jwt.verify<Record<string, unknown>>(t, o as never),
    },
    CFG,
  );
});

beforeEach(() => {
  store = emptyAuthStore();
  service = new AuthService(new FakeAuthUoW(store), tokens, {
    accessTokenTtlS: 900,
    refreshTokenTtlS: 1209600,
  });
});

async function seedPrincipal(over: Parameters<typeof fakePrincipal>[0] = {}) {
  const passwordHash = await passwordService.hash('secret-pw');
  const p = fakePrincipal({ passwordHash, ...over });
  store.principals.push(p);
  return p;
}

describe('login', () => {
  it('succeeds with valid credentials and audits the login', async () => {
    const p = await seedPrincipal({ loginId: 'a@b.com' });
    const res = await service.login({ loginId: 'A@b.com ', password: 'secret-pw' }, {});
    expect(res.tokenType).toBe('Bearer');
    expect(res.expiresIn).toBe(900);
    expect(res.refreshToken.length).toBeGreaterThanOrEqual(60);
    const claims = tokens.verifyAccessToken(res.accessToken);
    expect(claims.sub).toBe(p.id);
    expect(store.sessions).toHaveLength(1);
    expect(store.refreshTokens).toHaveLength(1);
    // Only the hash is stored, never the raw token.
    expect(store.refreshTokens[0]?.tokenHash).not.toBe(res.refreshToken);
    const audit = store.auditLog[0];
    expect(audit?.action).toBe('AUTH_LOGIN_SUCCEEDED');
    expect(audit?.actorId).toBe(p.id);
    expect(audit?.actorType).toBe('USER');
  });

  it('rejects unknown accounts, wrong passwords, suspended and non-human principals identically', async () => {
    const p = await seedPrincipal({ loginId: 'a@b.com' });
    const errs: string[] = [];
    const cases = [
      () => service.login({ loginId: 'nobody@x.com', password: 'x' }, {}),
      () => service.login({ loginId: 'a@b.com', password: 'wrong' }, {}),
      () => {
        p.status = 'SUSPENDED';
        return service.login({ loginId: 'a@b.com', password: 'secret-pw' }, {});
      },
      () => {
        p.status = 'ACTIVE';
        p.type = 'SERVICE';
        return service.login({ loginId: 'a@b.com', password: 'secret-pw' }, {});
      },
    ];
    for (const c of cases) {
      await expect(c()).rejects.toThrow(UnauthorizedError);
      await expect(c()).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
      errs.push('');
    }
    p.status = 'ACTIVE';
    p.type = 'USER';
    // No session or audit row was created for failures.
    expect(store.sessions).toHaveLength(0);
    expect(store.auditLog).toHaveLength(0);
  });
});

describe('refresh rotation and replay', () => {
  it('rotates the refresh token and consumes the old one', async () => {
    await seedPrincipal({ loginId: 'a@b.com' });
    const first = await service.login({ loginId: 'a@b.com', password: 'secret-pw' }, {});
    const second = await service.refresh({ refreshToken: first.refreshToken }, {});
    expect(second.refreshToken).not.toBe(first.refreshToken);
    const oldRow = store.refreshTokens.find((t) => t.consumedAt !== null);
    expect(oldRow).toBeDefined();
    expect(oldRow?.replacedById).toBe(store.refreshTokens.find((t) => t.consumedAt === null)?.id);
  });

  it('detects replay of a consumed token and revokes the family', async () => {
    await seedPrincipal({ loginId: 'a@b.com' });
    const first = await service.login({ loginId: 'a@b.com', password: 'secret-pw' }, {});
    await service.refresh({ refreshToken: first.refreshToken }, {});
    // Reuse the consumed token — replay.
    await expect(service.refresh({ refreshToken: first.refreshToken }, {})).rejects.toThrow(
      UnauthorizedError,
    );
    expect(store.sessions[0]?.status).toBe('REVOKED');
    expect(store.auditLog.some((a) => a.action === 'AUTH_REFRESH_REPLAY_DETECTED')).toBe(true);
  });

  it('rejects unknown refresh tokens without touching state', async () => {
    await expect(service.refresh({ refreshToken: 'does-not-exist' }, {})).rejects.toThrow(
      UnauthorizedError,
    );
    expect(store.sessions).toHaveLength(0);
  });
});

describe('logout', () => {
  it('revokes the session and its token family', async () => {
    const p = await seedPrincipal({ loginId: 'a@b.com' });
    const res = await service.login({ loginId: 'a@b.com', password: 'secret-pw' }, {});
    const claims = tokens.verifyAccessToken(res.accessToken);
    await service.logout({
      actorId: p.id,
      actorType: 'USER',
      sessionId: claims.sid,
    });
    expect(store.sessions[0]?.status).toBe('REVOKED');
    expect(store.refreshTokens[0]?.revokedAt).not.toBeNull();
    expect(store.auditLog.some((a) => a.action === 'AUTH_LOGOUT')).toBe(true);
  });

  it('rejects logout for a foreign session', async () => {
    await seedPrincipal({ loginId: 'a@b.com' });
    const res = await service.login({ loginId: 'a@b.com', password: 'secret-pw' }, {});
    const claims = tokens.verifyAccessToken(res.accessToken);
    await expect(
      service.logout({ actorId: 'someone-else', actorType: 'USER', sessionId: claims.sid }),
    ).rejects.toThrow(UnauthorizedError);
  });
});

describe('buildActorContext', () => {
  it('returns actor context for a live session and rejects revoked/suspended', async () => {
    const p = await seedPrincipal({ loginId: 'a@b.com' });
    const res = await service.login({ loginId: 'a@b.com', password: 'secret-pw' }, {});
    const claims = tokens.verifyAccessToken(res.accessToken);

    const ctx = await service.buildActorContext(claims);
    expect(ctx.actorId).toBe(p.id);
    expect(ctx.actorType).toBe('USER');
    expect(ctx.sessionId).toBe(claims.sid);

    // Suspension denies immediately — even with a valid token.
    p.status = 'SUSPENDED';
    await expect(service.buildActorContext(claims)).rejects.toThrow(UnauthorizedError);
    p.status = 'ACTIVE';

    // Revoked session denies.
    await service.logout({ actorId: p.id, actorType: 'USER', sessionId: claims.sid });
    await expect(service.buildActorContext(claims)).rejects.toThrow(UnauthorizedError);
  });
});

describe('normalizeLoginId', () => {
  it('trims and lowercases', () => {
    expect(normalizeLoginId('  USER@Example.COM ')).toBe('user@example.com');
  });
});

describe('getMe', () => {
  it('loads profile from DB, caches it, and invalidation triggers fresh fetch', async () => {
    const p = await seedPrincipal({ loginId: 'cached@example.com' });
    const res1 = await service.getMe(p.id);
    expect(res1.loginId).toBe('cached@example.com');

    // Simulate DB change
    p.loginId = 'changed@example.com';

    // Second call returns cached value
    const res2 = await service.getMe(p.id);
    expect(res2.loginId).toBe('cached@example.com');

    // Invalidate cache
    await service.userCache.invalidate(p.id);

    // Fresh fetch returns updated value
    const res3 = await service.getMe(p.id);
    expect(res3.loginId).toBe('changed@example.com');
  });
});

describe('login operations resolver', () => {
  it('includes effective operations when the resolver returns them', async () => {
    const opsSvc = new AuthService(
      new FakeAuthUoW(store),
      tokens,
      { accessTokenTtlS: 900, refreshTokenTtlS: 1209600 },
      () => new Date(),
      async () => ['PETTY_CASH_REQUEST_APPROVE', 'EMPLOYEE_PAYROLL_PREPARE'],
    );
    const passwordHash = await passwordService.hash('secret-pw');
    const p = fakePrincipal({ passwordHash, loginId: 'ops@t.test', status: 'ACTIVE', type: 'USER' });
    store.principals.push(p);
    store.employees.push({
      id: 'emp-ops',
      principalId: p.id,
      companyId: 'c1',
      displayName: 'Ops Emp',
      employeeCode: 'E-OPS',
      company: { id: 'c1', code: 'C1', name: 'Co', isPlatform: false },
    });
    const result = await opsSvc.login({ loginId: 'ops@t.test', password: 'secret-pw' }, {});
    expect(result.user?.operations).toEqual([
      'PETTY_CASH_REQUEST_APPROVE',
      'EMPLOYEE_PAYROLL_PREPARE',
    ]);
  });
});
