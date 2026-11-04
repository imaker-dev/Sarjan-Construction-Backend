import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { organizationRoutes } from '../../src/modules/organization/routes.js';
import { departmentRoutes } from '../../src/modules/department/routes.js';
import { platformRoutes } from '../../src/modules/platform/routes.js';
import errorHandlerPlugin from '../../src/plugins/error-handler.js';

// Route-level validation only — stub services, real TypeBox schemas.
const stubOrg = new Proxy({}, { get: () => async () => ({}) }) as never;
const stubDept = new Proxy({}, { get: () => async () => ({}) }) as never;

let app: FastifyInstance;
beforeAll(async () => {
  app = Fastify();
  app.decorateRequest('principal', null);
  await app.register(errorHandlerPlugin);
  app.decorate('authenticate', async (req: FastifyRequest) => {
    req.principal = { actorId: 'a1' } as never;
  });
  app.decorate('tenantCompanyGuard', async () => undefined);
  app.decorate('requirePermission', () => async () => undefined);
  await app.register(organizationRoutes(stubOrg), { prefix: '/api/v1' });
  await app.register(departmentRoutes(stubDept), { prefix: '/api/v1' });
  await app.register(
    platformRoutes(new Proxy({}, { get: () => async () => ({}) }) as never, async () => 'p1'),
    { prefix: '/api/v1' },
  );
  await app.ready();
});
afterAll(async () => app.close());
const post = (url: string, payload: object) =>
  app.inject({ method: 'POST', url, headers: { 'x-company-id': 'c1' }, payload });

describe('route validation: org setup 1A', () => {
  it('project create rejects client-supplied headOfficeId field? schema ignores it', async () => {
    const res = await post('/api/v1/org/projects', {
      code: 'P1',
      name: 'P1',
      timezone: 'UTC',
      projectType: 'RESIDENTIAL',
      clientName: 'ACME',
    });
    expect(res.statusCode).not.toBe(400);
  });
  it('project create rejects bad projectType enum', async () => {
    const res = await post('/api/v1/org/projects', {
      code: 'P1',
      name: 'P1',
      timezone: 'UTC',
      projectType: 'BOGUS',
    });
    expect(res.statusCode).toBe(400);
  });
  it('site create accepts structured address + paired coords', async () => {
    const res = await post('/api/v1/org/sites', {
      projectId: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d',
      code: 'S1',
      name: 'S1',
      addressLine1: '1 Main',
      city: 'Pune',
      state: 'MH',
      pinCode: '411001',
      geoLatitude: 18.5,
      geoLongitude: 73.8,
      geoFenceRadiusM: 100,
    });
    expect(res.statusCode).not.toBe(400);
  });
  it('site create rejects out-of-range coordinates at schema', async () => {
    const res = await post('/api/v1/org/sites', {
      projectId: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d',
      code: 'S1',
      name: 'S1',
      geoLatitude: 91,
      geoLongitude: 73.8,
    });
    expect(res.statusCode).toBe(400);
  });
  it('head office create accepts structured address + contact', async () => {
    const res = await post('/api/v1/org/head-offices', {
      code: 'HO1',
      name: 'HO',
      isPrimary: true,
      addressLine1: '10 Corporate Rd',
      city: 'Pune',
      state: 'MH',
      pinCode: '411001',
      country: 'IN',
      contactName: 'Front Desk',
      contactEmail: 'front@example.test',
    });
    expect(res.statusCode).not.toBe(400);
  });
  it('head office create rejects invalid contactEmail', async () => {
    const res = await post('/api/v1/org/head-offices', {
      code: 'HO1',
      name: 'HO',
      contactEmail: 'not-an-email',
    });
    expect(res.statusCode).toBe(400);
  });
  it('department create accepts category + categoryLabel for CUSTOM', async () => {
    const res = await post('/api/v1/departments', {
      scopeType: 'COMPANY',
      code: 'OPS',
      name: 'Ops',
      category: 'CUSTOM',
      categoryLabel: 'Mining',
    });
    expect(res.statusCode).not.toBe(400);
  });
  it('department create rejects unknown category', async () => {
    const res = await post('/api/v1/departments', {
      scopeType: 'COMPANY',
      code: 'OPS',
      name: 'Ops',
      category: 'BOGUS',
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('route validation: /auth/claim/onboard headOffice', () => {
  it('accepts the shared Head Office contract (structured address + contact)', async () => {
    const res = await post('/api/v1/auth/claim/onboard', {
      token: 't',
      password: 'a-secure-password-1',
      headOffice: {
        code: 'HQ',
        name: 'HO',
        legalName: 'Corp HO Pvt Ltd',
        addressLine1: '10 Corporate Rd',
        city: 'Pune',
        state: 'MH',
        pinCode: '411001',
        country: 'IN',
        contactName: 'Front Desk',
        contactPhone: '+91-20-0000-0000',
        contactEmail: 'front@example.test',
      },
    });
    expect(res.statusCode).not.toBe(400);
  });
  it('rejects an invalid headOffice contactEmail', async () => {
    const res = await post('/api/v1/auth/claim/onboard', {
      token: 't',
      password: 'a-secure-password-1',
      headOffice: { code: 'HQ', name: 'HO', contactEmail: 'not-an-email' },
    });
    expect(res.statusCode).toBe(400);
  });
});
