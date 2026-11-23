import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { organizationRoutes } from '../../src/modules/organization/routes.js';
import errorHandlerPlugin from '../../src/plugins/error-handler.js';

// Route-boundary contract: each document/register route resolves the expected
// permission key AND the expected scope target (PROJECT/SITE scope so that
// project-scoped PD/PI grants and company-wide grants both cover).
const stubOrg = new Proxy({}, { get: () => async () => ({}) }) as never;

interface Captured {
  key: string;
  target: { scopeType: string; scopeId: string; companyId: string };
}
const captured: Captured[] = [];

let app: FastifyInstance;
beforeAll(async () => {
  app = Fastify();
  app.decorateRequest('principal', null);
  await app.register(errorHandlerPlugin);
  app.decorate('authenticate', async (req: FastifyRequest) => {
    req.principal = { actorId: 'a1' } as never;
  });
  app.decorate('tenantCompanyGuard', async () => undefined);
  app.decorate(
    'requirePermission',
    (key: string, resolveScope: (r: FastifyRequest) => Captured['target']) =>
      async (req: FastifyRequest) => {
        captured.push({ key, target: resolveScope(req) });
      },
  );
  await app.register(organizationRoutes(stubOrg), { prefix: '/api/v1' });
  await app.ready();
});
afterAll(async () => app.close());

const call = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) =>
  app.inject({
    method,
    url,
    headers: { 'x-company-id': 'c1' },
    ...(payload !== undefined ? { payload } : {}),
  });
const last = () => captured.at(-1);

describe('project document route gates use DOCUMENT_* keys at PROJECT scope', () => {
  const pid = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';

  it('POST link → DOCUMENT_LINK @ PROJECT', async () => {
    await call('POST', `/api/v1/org/projects/${pid}/documents`, {
      documentId: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d',
      documentType: 'DRAWING',
      title: 'GA Plan',
    });
    expect(last()).toEqual({
      key: 'DOCUMENT_LINK',
      target: { scopeType: 'PROJECT', scopeId: pid, companyId: 'c1' },
    });
  });

  it('GET register → DOCUMENT_READ @ PROJECT', async () => {
    await call('GET', `/api/v1/org/projects/${pid}/documents`);
    expect(last()).toEqual({
      key: 'DOCUMENT_READ',
      target: { scopeType: 'PROJECT', scopeId: pid, companyId: 'c1' },
    });
  });

  it('PATCH link → DOCUMENT_LINK @ PROJECT', async () => {
    await call('PATCH', `/api/v1/org/projects/${pid}/documents/l1`, { title: 'x' });
    expect(last()).toEqual({
      key: 'DOCUMENT_LINK',
      target: { scopeType: 'PROJECT', scopeId: pid, companyId: 'c1' },
    });
  });

  it('single read → ORG_PROJECT_READ @ PROJECT (PD/PI covered)', async () => {
    await call('GET', `/api/v1/org/projects/${pid}`);
    expect(last()).toEqual({
      key: 'ORG_PROJECT_READ',
      target: { scopeType: 'PROJECT', scopeId: pid, companyId: 'c1' },
    });
  });
});

describe('site document route gates use DOCUMENT_* keys at SITE scope', () => {
  const sid = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

  it('POST link → DOCUMENT_LINK @ SITE', async () => {
    await call('POST', `/api/v1/org/sites/${sid}/documents`, {
      documentId: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d',
      documentType: 'SURVEY',
      title: 'Topo survey',
    });
    expect(last()).toEqual({
      key: 'DOCUMENT_LINK',
      target: { scopeType: 'SITE', scopeId: sid, companyId: 'c1' },
    });
  });

  it('GET register → DOCUMENT_READ @ SITE', async () => {
    await call('GET', `/api/v1/org/sites/${sid}/documents`);
    expect(last()).toEqual({
      key: 'DOCUMENT_READ',
      target: { scopeType: 'SITE', scopeId: sid, companyId: 'c1' },
    });
  });

  it('PATCH link → DOCUMENT_LINK @ SITE', async () => {
    await call('PATCH', `/api/v1/org/sites/${sid}/documents/l1`, { title: 'x' });
    expect(last()).toEqual({
      key: 'DOCUMENT_LINK',
      target: { scopeType: 'SITE', scopeId: sid, companyId: 'c1' },
    });
  });

  it('single read → ORG_SITE_READ @ SITE (project leaders covered via chain)', async () => {
    await call('GET', `/api/v1/org/sites/${sid}`);
    expect(last()).toEqual({
      key: 'ORG_SITE_READ',
      target: { scopeType: 'SITE', scopeId: sid, companyId: 'c1' },
    });
  });
});
