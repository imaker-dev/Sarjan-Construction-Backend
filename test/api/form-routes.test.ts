import { describe, it, expect, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import type { AuthService } from '../../src/modules/auth/service.js';
import type { AccessControlService } from '../../src/modules/access-control/service.js';
import type { PrincipalContext } from '../../src/plugins/authentication.js';
import type { FormService } from '../../src/modules/form/service.js';
import { AccessDeniedError } from '../../src/modules/access-control/errors.js';

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
const OP_ID = '00000000-0000-4000-8000-000000000099';

let app: FastifyInstance | undefined;
afterAll(async () => {
  if (app !== undefined) await app.close();
});

async function makeApp(opts: { allow?: boolean } = {}) {
  const calls: string[] = [];
  const formService = {
    listForms: async (_actor: unknown, cid: string, filter: unknown) => {
      calls.push(`listForms:${cid}:${JSON.stringify(filter)}`);
      return [{ id: 'form-1', key: 'daily-log', name: 'Daily Site Log' }];
    },
    getForm: async (_actor: unknown, cid: string, id: string) => {
      calls.push(`getForm:${cid}:${id}`);
      return { id, key: 'daily-log', name: 'Daily Site Log', version: 1 };
    },
    createForm: async (_actor: unknown, cid: string, opId: string, input: unknown) => {
      calls.push(`createForm:${cid}:${opId}:${JSON.stringify(input)}`);
      return { id: 'form-1', companyId: cid, operationId: opId, ...(input as object), version: 1 };
    },
    updateForm: async (_actor: unknown, cid: string, id: string, patch: unknown, ev?: number) => {
      calls.push(`updateForm:${cid}:${id}:${JSON.stringify(patch)}:ev=${ev}`);
      return { id, ...(patch as object), version: (ev ?? 1) + 1 };
    },
    transitionFormStatus: async (_actor: unknown, cid: string, id: string, to: string, ev?: number) => {
      calls.push(`transition:${cid}:${id}:${to}:ev=${ev}`);
      return { id, status: to, version: (ev ?? 1) + 1 };
    },
    publishForm: async (_actor: unknown, cid: string, id: string, ev?: number) => {
      calls.push(`publish:${cid}:${id}:ev=${ev}`);
      return {
        form: { id, version: (ev ?? 1) + 1 },
        publishedRevision: 1,
      };
    },
    listVersions: async (_actor: unknown, cid: string, id: string) => {
      calls.push(`listVersions:${cid}:${id}`);
      return [{ id: 'fv-1', formId: id, revisionNumber: 1 }];
    },
  } as unknown as FormService;

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
      formService,
      authService,
      accessControl,
      platformCompanyId: null,
    },
  });

  return { app, calls };
}

const authed = (appInstance: FastifyInstance) => ({
  authorization: `Bearer ${appInstance.tokenService.signAccessToken('admin1', 's1')}`,
  'x-company-id': CID,
});

describe('form routes', () => {
  it('401 without token', async () => {
    const { app } = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/forms' });
    expect(res.statusCode).toBe(401);
  });

  it('401 without x-company-id header', async () => {
    const { app } = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/forms',
      headers: {
        authorization: `Bearer ${app.tokenService.signAccessToken('admin1', 's1')}`,
      },
    });
    expect(res.statusCode).toBe(401);
  });

  it('403 when authenticated without permission', async () => {
    const { app } = await makeApp({ allow: false });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/forms',
      headers: authed(app),
    });
    expect(res.statusCode).toBe(403);
  });

  it('GET /api/v1/forms lists forms with company scope and query filters', async () => {
    const { app, calls } = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/forms?status=ACTIVE&operationId=${OP_ID}`,
      headers: authed(app),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([{ id: 'form-1', key: 'daily-log', name: 'Daily Site Log' }]);
    expect(calls.some((c) => c.startsWith(`listForms:${CID}`))).toBe(true);
  });

  it('POST /api/v1/forms creates a draft form', async () => {
    const { app, calls } = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/forms',
      headers: authed(app),
      payload: {
        operationId: OP_ID,
        key: 'safety-inspection',
        name: 'Safety Inspection Checklist',
        description: 'Periodic safety audits on site',
        schema: {
          fields: [{ key: 'hazardFound', type: 'boolean', label: 'Hazard found?' }],
        },
      },
    });
    expect(res.statusCode).toBe(200);
    const body: { id: string; key: string } = res.json();
    expect(body.id).toBe('form-1');
    expect(body.key).toBe('safety-inspection');
    expect(calls.some((c) => c.startsWith(`createForm:${CID}:${OP_ID}`))).toBe(true);
  });

  it('GET /api/v1/forms/:id returns single form', async () => {
    const { app, calls } = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/forms/form-1',
      headers: authed(app),
    });
    expect(res.statusCode).toBe(200);
    const body: { id: string } = res.json();
    expect(body.id).toBe('form-1');
    expect(calls).toContain(`getForm:${CID}:form-1`);
  });

  it('PATCH /api/v1/forms/:id updates draft form with optimistic locking', async () => {
    const { app, calls } = await makeApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/forms/form-1',
      headers: authed(app),
      payload: {
        name: 'Updated Inspection Form',
        expectedVersion: 1,
      },
    });
    expect(res.statusCode).toBe(200);
    const body: { name: string } = res.json();
    expect(body.name).toBe('Updated Inspection Form');
    expect(calls.some((c) => c.includes('updateForm') && c.includes('ev=1'))).toBe(true);
  });

  it('POST /api/v1/forms/:id/status transitions status', async () => {
    const { app, calls } = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/forms/form-1/status',
      headers: authed(app),
      payload: {
        to: 'ACTIVE',
        expectedVersion: 2,
      },
    });
    expect(res.statusCode).toBe(200);
    const body: { status: string } = res.json();
    expect(body.status).toBe('ACTIVE');
    expect(calls).toContain(`transition:${CID}:form-1:ACTIVE:ev=2`);
  });

  it('POST /api/v1/forms/:id/publish publishes form revision', async () => {
    const { app, calls } = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/forms/form-1/publish',
      headers: authed(app),
      payload: {
        expectedVersion: 3,
      },
    });
    expect(res.statusCode).toBe(200);
    const body: { publishedRevision: number } = res.json();
    expect(body.publishedRevision).toBe(1);
    expect(calls).toContain(`publish:${CID}:form-1:ev=3`);
  });

  it('GET /api/v1/forms/:id/versions lists immutable published revisions', async () => {
    const { app, calls } = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/forms/form-1/versions',
      headers: authed(app),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([{ id: 'fv-1', formId: 'form-1', revisionNumber: 1 }]);
    expect(calls).toContain(`listVersions:${CID}:form-1`);
  });
});
