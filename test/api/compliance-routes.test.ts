import { describe, it, expect, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import type { AuthService } from '../../src/modules/auth/service.js';
import type { AccessControlService } from '../../src/modules/access-control/service.js';
import type { PrincipalContext } from '../../src/plugins/authentication.js';
import type { ComplianceService } from '../../src/modules/compliance/service.js';
import { AccessDeniedError } from '../../src/modules/access-control/errors.js';
import { OrgValidationError } from '../../src/modules/organization/errors.js';

const env = {
  NODE_ENV: 'test',
  HOST: '127.0.0.1',
  PORT: '0',
  LOG_LEVEL: 'silent',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/testdb',
  REDIS_HOST: 'localhost',
  REDIS_PORT: '6379',
  JWT_SECRET: 'test-secret-test-secret-test-secret-1234',
};
const CID = '00000000-0000-4000-8000-0000000000c1';

let app: FastifyInstance | undefined;
afterAll(async () => {
  if (app !== undefined) await app.close();
});

async function makeApp(opts: { allow?: boolean } = {}) {
  const calls: string[] = [];
  const complianceService = {
    list: async (cid: string) => {
      calls.push(`list:${cid}`);
      return [{ id: 'rec1', category: 'GST' }];
    },
    create: async (_a: unknown, cid: string, input: unknown) => {
      calls.push(`create:${cid}`);
      const i = input as { category?: string; customLabel?: string };
      if (i.category === 'OTHER' && i.customLabel === undefined) {
        throw new OrgValidationError('customLabel', 'required when category = OTHER');
      }
      return { id: 'rec1', ...(input as object) };
    },
    update: async () => ({ id: 'rec1' }),
    transition: async () => ({ id: 'rec1', status: 'ACTIVE' }),
    verify: async () => ({ id: 'rec1' }),
  } as unknown as ComplianceService;
  const authService = {
    buildActorContext: async (claims: { sub?: string }) =>
      ({ actorId: claims.sub ?? 'u1', actorType: 'USER', sessionId: 's1' }) as PrincipalContext,
    verifyAccessToken: async () => ({ sub: 'admin1', sid: 's1' }),
  } as unknown as AuthService;
  const accessControl = {
    assertPermission: async () => {
      if (opts.allow === false) throw new AccessDeniedError();
    },
    hasPermission: async () => true,
  } as unknown as AccessControlService;
  app = await buildApp({
    env,
    services: {
      complianceService,
      authService,
      accessControl,
      platformCompanyId: null,
    },
  });
  return { app, calls };
}
const authed = (app: FastifyInstance) => ({
  authorization: `Bearer ${app.tokenService.signAccessToken('admin1', 's1')}`,
  'x-company-id': CID,
});

describe('compliance routes', () => {
  it('401 without token', async () => {
    const { app } = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/compliance-records' });
    expect(res.statusCode).toBe(401);
  });

  it('403 when authenticated without permission', async () => {
    const { app } = await makeApp({ allow: false });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/compliance-records',
      headers: authed(app),
    });
    expect(res.statusCode).toBe(403);
  });

  it('authorized list + create succeed with company scope from header', async () => {
    const { app, calls } = await makeApp();
    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/compliance-records',
      headers: authed(app),
    });
    expect(list.statusCode).toBe(200);
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/compliance-records',
      headers: authed(app),
      payload: { category: 'GST', identifier: '29ABCDE1234F1Z5' },
    });
    expect(create.statusCode).toBe(200);
    expect(calls).toEqual([`list:${CID}`, `create:${CID}`]); // scope = header, never body
  });

  it('OTHER category without customLabel → 400', async () => {
    const { app } = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/compliance-records',
      headers: authed(app),
      payload: { category: 'OTHER', identifier: 'X-1' },
    });
    expect(res.statusCode).toBe(422);
  });
});
