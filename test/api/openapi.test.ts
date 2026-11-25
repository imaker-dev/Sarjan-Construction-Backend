import { describe, it, expect, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import type { AuthService } from '../../src/modules/auth/service.js';
import type { AccessControlService } from '../../src/modules/access-control/service.js';
import type { PrincipalContext } from '../../src/plugins/authentication.js';
import type { PlatformService } from '../../src/modules/platform/service.js';
import type { ComplianceService } from '../../src/modules/compliance/service.js';
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
  NOTIFICATIONS_WORKER: 'off',
};

let apps: FastifyInstance[] = [];
afterAll(async () => {
  for (const a of apps) await a.close();
  apps = [];
});

const stubAuth = {
  buildActorContext: async (claims: { sub?: string }) =>
    ({ actorId: claims.sub ?? 'u1', actorType: 'USER', sessionId: 's1' }) as PrincipalContext,
  verifyAccessToken: async () => ({ sub: 'adm', sid: 's1' }),
} as unknown as AuthService;
const allowAll = {
  assertPermission: async () => undefined,
  hasPermission: async () => true,
} as unknown as AccessControlService;
const denyAll = {
  assertPermission: async () => {
    throw new AccessDeniedError();
  },
  hasPermission: async () => false,
} as unknown as AccessControlService;

async function makeApp(extra: Record<string, unknown> = {}) {
  const app = await buildApp({
    env: { ...env, ...extra },
    services: {
      authService: stubAuth,
      accessControl: allowAll,
      platformService: {} as PlatformService,
      complianceService: {} as ComplianceService,
      platformCompanyId: null,
    },
  });
  apps.push(app);
  return app;
}

describe('openapi document', () => {
  it('serves /openapi.json covering every registered route + security', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/documentation/json' });
    expect(res.statusCode).toBe(200);
    const doc: {
      openapi: string;
      paths: Record<string, unknown>;
      components: { securitySchemes: Record<string, unknown> };
    } = res.json();
    expect(doc.openapi.startsWith('3.')).toBe(true);
    for (const path of [
      '/api/v1/health',
      '/api/v1/auth/login',
      '/api/v1/auth/claim',
      '/api/v1/org/company',
      '/api/v1/departments',
      '/api/v1/employees',
      '/api/v1/platform/companies',
      '/api/v1/compliance-records',
      '/api/v1/notifications',
    ]) {
      expect(doc.paths[path], `missing ${path}`).toBeDefined();
    }
    expect(doc.components.securitySchemes.bearerAuth).toEqual({
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'JWT',
    });
  });

  it('platform create schema includes profile + adminDisplayName, no password', async () => {
    const app = await makeApp();
    const doc: {
      paths: Record<string, Record<string, Record<string, unknown>>>;
      components: Record<string, Record<string, Record<string, unknown>>>;
    } = (await app.inject({ method: 'GET', url: '/documentation/json' })).json();
    const body = doc.paths['/api/v1/platform/companies']?.post?.requestBody;
    const schema = JSON.stringify(body);
    expect(schema).toContain('adminDisplayName');
    expect(schema).toContain('pan');
    expect(schema).not.toContain('password');
  });

  it('security per operation: public empty, tenant header, platform no header', async () => {
    const app = await makeApp();
    const doc: {
      paths: Record<
        string,
        Record<string, { security?: unknown[]; parameters?: unknown[]; summary?: string }>
      >;
    } = (await app.inject({ method: 'GET', url: '/documentation/json' })).json();
    const hasCompanyHeader = (op?: { parameters?: unknown[] }) =>
      JSON.stringify(op?.parameters ?? []).includes('x-company-id');
    // Public operations explicitly unauthenticated.
    expect(doc.paths['/api/v1/health']?.get?.security).toEqual([]);
    expect(doc.paths['/api/v1/auth/login']?.post?.security).toEqual([]);
    expect(doc.paths['/api/v1/auth/claim']?.post?.security).toEqual([]);
    // Tenant operation: bearerAuth + required x-company-id header param.
    const companyGet = doc.paths['/api/v1/org/company']?.get;
    expect(companyGet?.security).toEqual([{ bearerAuth: [] }]);
    expect(hasCompanyHeader(companyGet)).toBe(true);
    // Platform operation: bearerAuth, NO x-company-id.
    const platPost = doc.paths['/api/v1/platform/companies']?.post;
    expect(platPost?.security).toEqual([{ bearerAuth: [] }]);
    expect(hasCompanyHeader(platPost)).toBe(false);
    // Summaries/permission documented.
    expect(platPost?.summary).toBeTruthy();
    expect(JSON.stringify(doc.paths['/api/v1/compliance-records'])).toContain('COMPLIANCE_');
  });

  it('completeness: every operation has metadata, security, responses', async () => {
    const app = await makeApp();
    const doc: {
      paths: Record<string, Record<string, Record<string, unknown>>>;
    } = (await app.inject({ method: 'GET', url: '/documentation/json' })).json();
    const operationIds = new Set<string>();
    const PUBLIC = new Set([
      'GET /api/v1/health',
      'GET /api/v1/ready',
      'POST /api/v1/auth/login',
      'POST /api/v1/auth/refresh',
      'POST /api/v1/auth/mfa/verify',
      'POST /api/v1/auth/mfa/send-otp',
      'POST /api/v1/auth/claim',
      'GET /api/v1/auth/claim/verify',
      'POST /api/v1/auth/claim/onboard',
    ]);
    const isTenant = (p: string) =>
      /^\/api\/v1\/(org|departments|employees|roles|compliance-records|notifications|forms)\b/.test(
        p,
      );
    const isPlatform = (p: string) => p.startsWith('/api/v1/platform/');
    for (const [path, item] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(item)) {
        const key = `${method.toUpperCase()} ${path}`;
        const failures: string[] = [];
        if (typeof op.operationId !== 'string' || op.operationId === '')
          failures.push('operationId');
        else if (operationIds.has(op.operationId))
          failures.push(`duplicate operationId ${op.operationId}`);
        operationIds.add(op.operationId as string);
        if (typeof op.summary !== 'string' || op.summary === '') failures.push('summary');
        if (op.responses === undefined || Object.keys(op.responses as object).length === 0)
          failures.push('responses');
        const security = op.security;
        const companyHdr =
          JSON.stringify(op.parameters ?? []) +
          JSON.stringify((op as { headers?: unknown }).headers ?? {});
        const hasHdr = companyHdr.includes('x-company-id');
        if (PUBLIC.has(key)) {
          if (!Array.isArray(security) || security.length !== 0)
            failures.push('public must have security:[]');
        } else if (!Array.isArray(security) || security.length === 0) {
          failures.push('protected must have security:[bearerAuth]');
        }
        if (isTenant(path) && !hasHdr) failures.push('tenant op missing x-company-id');
        if (isPlatform(path) && hasHdr) failures.push('platform op must not have x-company-id');
        expect(failures, `${key}: ${failures.join(', ')}`).toEqual([]);
      }
    }
    expect(operationIds.size).toBeGreaterThanOrEqual(30);
  });

  it('reconciles registered routes ↔ documented operations both ways', async () => {
    const app = await makeApp();
    await app.ready();
    const doc: { paths: Record<string, Record<string, Record<string, unknown>>> } = (
      await app.inject({ method: 'GET', url: '/documentation/json' })
    ).json();
    const documented = new Set<string>();
    for (const [path, item] of Object.entries(doc.paths)) {
      for (const method of Object.keys(item)) {
        if (method === 'head') continue;
        documented.add(`${method.toUpperCase()} ${path}`);
      }
    }
    // Authoritative list: every documented operation must be a real registered
    // route and vice versa (verified via printRoutes during reconciliation).
    const EXPECTED = [
      'GET /api/v1/health',
      'GET /api/v1/ready',
      'POST /api/v1/auth/login',
      'POST /api/v1/auth/refresh',
      'POST /api/v1/auth/logout',
      'POST /api/v1/auth/mfa/verify',
      'POST /api/v1/auth/mfa/send-otp',
      'GET /api/v1/auth/mfa/status',
      'POST /api/v1/auth/mfa/setup',
      'POST /api/v1/auth/mfa/enable',
      'POST /api/v1/auth/mfa/disable',
      'POST /api/v1/auth/change-password',
      'GET /api/v1/auth/me',
      'GET /api/v1/profile',
      'POST /api/v1/auth/claim',
      'GET /api/v1/auth/claim/verify',
      'POST /api/v1/auth/claim/onboard',
      'GET /api/v1/org/company',
      'PATCH /api/v1/org/company',
      'GET /api/v1/org/company/delegations',
      'PATCH /api/v1/org/company/delegations',
      'GET /api/v1/org/head-offices',
      'POST /api/v1/org/head-offices',
      'PATCH /api/v1/org/head-offices/{id}',
      'POST /api/v1/org/head-offices/{id}/status',
      'GET /api/v1/org/projects',
      'POST /api/v1/org/projects',
      'GET /api/v1/org/projects/{id}',
      'PATCH /api/v1/org/projects/{id}',
      'POST /api/v1/org/projects/{id}/status',
      'POST /api/v1/org/projects/{id}/parcels',
      'GET /api/v1/org/projects/{id}/parcels',
      'POST /api/v1/org/projects/{id}/documents',
      'GET /api/v1/org/projects/{id}/documents',
      'POST /api/v1/org/projects/{id}/documents/upload',
      'PATCH /api/v1/org/projects/{id}/documents/{linkId}',
      'POST /api/v1/org/projects/{id}/approvals',
      'GET /api/v1/org/projects/{id}/approvals',
      'PATCH /api/v1/org/projects/{id}/approvals/{approvalId}',
      'GET /api/v1/org/projects/{id}/effective-operations',
      'GET /api/v1/org/projects/{id}/activity',
      'GET /api/v1/org/projects/{id}/team',
      'GET /api/v1/org/sites',
      'POST /api/v1/org/sites',
      'GET /api/v1/org/sites/{id}',
      'PATCH /api/v1/org/sites/{id}',
      'POST /api/v1/org/sites/{id}/status',
      'POST /api/v1/org/sites/{id}/documents',
      'GET /api/v1/org/sites/{id}/documents',
      'POST /api/v1/org/sites/{id}/documents/upload',
      'PATCH /api/v1/org/sites/{id}/documents/{linkId}',
      'GET /api/v1/org/sites/{id}/effective-operations',
      'GET /api/v1/org/sites/{id}/activity',
      'GET /api/v1/org/sites/{id}/team',
      'POST /api/v1/org/sites/{id}/workforce/{employeeId}/suspend',
      'POST /api/v1/org/sites/{id}/workforce/{employeeId}/exit',
      'POST /api/v1/org/sites/{id}/workforce/{employeeId}/reinstate',
      'POST /api/v1/org/projects/{id}/workforce/{employeeId}/suspend',
      'POST /api/v1/org/projects/{id}/workforce/{employeeId}/exit',
      'POST /api/v1/org/projects/{id}/workforce/{employeeId}/reinstate',
      'GET /api/v1/departments',
      'POST /api/v1/departments',
      'GET /api/v1/departments/{id}',
      'PATCH /api/v1/departments/{id}',
      'POST /api/v1/departments/{id}/status',
      'GET /api/v1/departments/{id}/members',
      'POST /api/v1/departments/{id}/members',
      'GET /api/v1/departments/{id}/members/{mid}',
      'PATCH /api/v1/departments/{id}/members/{mid}',
      'POST /api/v1/departments/{id}/members/{mid}/end',
      'POST /api/v1/departments/{id}/members/{mid}/transfer',
      'POST /api/v1/departments/{id}/onboard',
      'GET /api/v1/employees',
      'POST /api/v1/employees',
      'GET /api/v1/employees/{id}',
      'PATCH /api/v1/employees/{id}',
      'POST /api/v1/employees/{id}/status',
      'GET /api/v1/employees/{id}/memberships',
      'POST /api/v1/employees/{id}/memberships',
      'PATCH /api/v1/employees/{id}/memberships/{membershipId}',
      'POST /api/v1/employees/{id}/memberships/{membershipId}/end',
      'GET /api/v1/operations',
      'GET /api/v1/departments/{id}/operations',
      'POST /api/v1/departments/{id}/operations',
      'DELETE /api/v1/departments/{id}/operations/{operationKey}',
      'POST /api/v1/departments/{id}/operations/{operationKey}/status',
      'PATCH /api/v1/departments/{id}/operations/{operationKey}',
      'PATCH /api/v1/departments/{id}/operations/{operationKey}/status',
      'GET /api/v1/employees/{id}/operations',
      'POST /api/v1/employees/{id}/operations',
      'DELETE /api/v1/employees/{id}/operations/{operationKey}',
      'POST /api/v1/employees/{id}/operations/{operationKey}/status',
      'PATCH /api/v1/employees/{id}/operations/{operationKey}',
      'PATCH /api/v1/employees/{id}/operations/{operationKey}/status',
      'POST /api/v1/employees/{id}/invite',
      'POST /api/v1/employees/{id}/invite/resend',
      'GET /api/v1/employees/{id}/assignments',
      'POST /api/v1/employees/{id}/assignments',
      'DELETE /api/v1/employees/{id}/assignments/{assignmentId}',
      'GET /api/v1/employees/documents/expiring',
      'POST /api/v1/employees/{id}/documents/upload',
      'POST /api/v1/employees/{id}/documents',
      'GET /api/v1/employees/{id}/documents',
      'GET /api/v1/employees/{id}/documents/{docId}',
      'PATCH /api/v1/employees/{id}/documents/{docId}',
      'DELETE /api/v1/employees/{id}/documents/{docId}',
      'GET /api/v1/employees/{id}/documents/{docId}/download',
      'POST /api/v1/employees/{id}/documents/{docId}/verify',
      'GET /api/v1/me/documents',
      'POST /api/v1/me/documents/upload',
      'GET /api/v1/me/documents/{docId}/download',
      'GET /api/v1/roles',
      'GET /api/v1/compliance-records',
      'POST /api/v1/compliance-records',
      'PATCH /api/v1/compliance-records/{id}',
      'POST /api/v1/compliance-records/{id}/status',
      'POST /api/v1/compliance-records/{id}/verify',
      'GET /api/v1/notifications',
      'POST /api/v1/notifications/ticket',
      'POST /api/v1/notifications/{id}/read',
      'POST /api/v1/platform/companies',
      'GET /api/v1/platform/companies',
      'POST /api/v1/platform/companies/{companyId}/claim-token',
      'GET /api/v1/platform/companies/{companyId}',
      'PATCH /api/v1/platform/companies/{companyId}',
      'POST /api/v1/platform/companies/{companyId}/status',
      'POST /api/v1/platform/companies/{companyId}/impersonate',
      'GET /api/v1/platform/operations',
      'POST /api/v1/platform/operations',
      'DELETE /api/v1/platform/operations/{key}',
      'GET /api/v1/forms',
      'POST /api/v1/forms',
      'GET /api/v1/forms/{id}',
      'PATCH /api/v1/forms/{id}',
      'POST /api/v1/forms/{id}/status',
      'POST /api/v1/forms/{id}/publish',
      'GET /api/v1/forms/{id}/versions',
      'GET /api/v1/attendance/policies',
      'POST /api/v1/attendance/policies',
      'GET /api/v1/attendance/policies/effective',
      'GET /api/v1/attendance/policies/{id}',
      'PATCH /api/v1/attendance/policies/{id}',
      'POST /api/v1/attendance/punch-in',
      'POST /api/v1/attendance/punch-out',
      'POST /api/v1/attendance/breaks/start',
      'POST /api/v1/attendance/breaks/end',
      'GET /api/v1/attendance/sessions/active',
      'GET /api/v1/attendance/sessions',
      'POST /api/v1/attendance/sessions',
      'GET /api/v1/attendance/sessions/{id}',
      'POST /api/v1/attendance/sessions/{id}/regularize',
      'GET /api/v1/attendance/daily-summary',
      'POST /api/v1/attendance/kiosk/batch-punch-in',
      'POST /api/v1/attendance/kiosk/batch-punch-out',
      'POST /api/v1/attendance/kiosk/sync',
      'POST /api/v1/attendance/tvt',
      'GET /api/v1/attendance/tvt',
      'GET /api/v1/attendance/tvt/{id}',
      'POST /api/v1/attendance/tvt/{id}/attendees',
      'GET /api/v1/attendance/muster-roll',
      'POST /api/v1/attendance/daily-reports/calculate',
      'GET /api/v1/attendance/daily-reports',
      'GET /api/v1/attendance/daily-reports/{id}',
      'PATCH /api/v1/attendance/daily-reports/{id}',
      'PATCH /api/v1/attendance/daily-reports/{id}/labour-summary/{summaryId}',
      'POST /api/v1/attendance/daily-reports/{id}/submit',
      'POST /api/v1/attendance/daily-reports/{id}/approve',
      'POST /api/v1/attendance/daily-reports/{id}/reject',
      'POST /api/v1/attendance/daily-reports/{id}/lock',
      'GET /api/v1/attendance/daily-reports/{id}/audit-trail',
      'POST /api/v1/attendance/reports/export',
      'GET /api/v1/attendance/daily-reports/{id}/export',
      'GET /api/v1/attendance/muster-roll/export',
      'POST /api/v1/leave/types',
      'GET /api/v1/leave/types',
      'PATCH /api/v1/leave/types/{id}',
      'POST /api/v1/leave/types/{id}/archive',
      'POST /api/v1/leave/policies',
      'GET /api/v1/leave/policies',
      'GET /api/v1/leave/policies/effective',
      'GET /api/v1/leave/policies/{id}',
      'PATCH /api/v1/leave/policies/{id}',
      'POST /api/v1/leave/policies/{id}/archive',
      'GET /api/v1/leave/policies/{id}/versions',
      'POST /api/v1/leave/policies/{id}/versions',
      'POST /api/v1/leave/policies/{id}/versions/{versionId}/cancel',
      'POST /api/v1/leave/allocations',
      'GET /api/v1/leave/balances',
      'GET /api/v1/leave/balances/{employeeId}',
      'POST /api/v1/leave/requests',
      'GET /api/v1/leave/requests',
      'GET /api/v1/leave/requests/{id}',
      'POST /api/v1/leave/requests/{id}/review',
      'POST /api/v1/leave/requests/{id}/cancel',
      'POST /api/v1/schedules',
      'GET /api/v1/schedules',
      'GET /api/v1/schedules/effective',
      'GET /api/v1/schedules/{id}',
      'PATCH /api/v1/schedules/{id}',
      'POST /api/v1/schedules/{id}/archive',
      'GET /api/v1/schedules/{id}/revisions',
      'POST /api/v1/schedules/{id}/revisions',
      'POST /api/v1/schedules/{id}/revisions/{revisionId}/cancel',
      'GET /api/v1/schedules/{id}/overrides',
      'POST /api/v1/schedules/{id}/overrides',
      'POST /api/v1/schedules/{id}/overrides/{overrideId}/cancel',
      'GET /api/v1/schedules/{id}/classify/{date}',
      'POST /api/v1/holiday-calendars',
      'GET /api/v1/holiday-calendars',
      'PATCH /api/v1/holiday-calendars/{id}',
      'POST /api/v1/holiday-calendars/{id}/archive',
      'POST /api/v1/holiday-categories',
      'GET /api/v1/holiday-categories',
      'POST /api/v1/holiday-categories/{id}/archive',
      'GET /api/v1/holiday-calendars/{calendarId}/holidays',
      'POST /api/v1/holiday-calendars/{calendarId}/holidays',
      'POST /api/v1/holiday-calendars/{calendarId}/holidays/bulk',
      'POST /api/v1/holiday-calendars/{calendarId}/holidays/{holidayId}/cancel',
      'GET /api/v1/approval-tasks',
      'GET /api/v1/approval-tasks/{id}',
      'GET /api/v1/approval-tasks/{id}/decisions',
      'POST /api/v1/approval-tasks/{id}/decisions',
      'POST /api/v1/finance/projects/{projectId}/budgets',
      'GET /api/v1/finance/projects/{projectId}/budgets',
      'GET /api/v1/finance/budgets/{id}',
      'PATCH /api/v1/finance/budgets/{id}',
      'POST /api/v1/finance/budgets/{id}/revisions',
      'GET /api/v1/finance/budgets/{id}/revisions',
      'GET /api/v1/finance/budgets/{id}/revisions/{revisionId}',
      'POST /api/v1/finance/budgets/{id}/revisions/{revisionId}/submit',
      'POST /api/v1/finance/budgets/{id}/revisions/{revisionId}/decisions',
      'GET /api/v1/finance/budgets/{id}/revisions/{revisionId}/decisions',
      'GET /api/v1/finance/projects/{projectId}/costs',
      'POST /api/v1/finance/projects/{projectId}/cash-flow-forecasts',
      'GET /api/v1/finance/projects/{projectId}/cash-flow-forecasts',
      'GET /api/v1/finance/cash-flow-forecasts/{id}',
      'PATCH /api/v1/finance/cash-flow-forecasts/{id}',
      'GET /api/v1/finance/projects',
      'GET /api/v1/finance/projects/{projectId}/sites',
      'GET /api/v1/finance/employees',
      'GET /api/v1/finance/employees/{employeeId}',
      'GET /api/v1/finance/employees/{employeeId}/attendance-summary',
      'GET /api/v1/finance/employees/{employeeId}/leave-summary',
      'GET /api/v1/finance/dashboard',
      'GET /api/v1/audit-logs',
      'GET /api/v1/audit-logs/{id}',
      'POST /api/v1/finance/sites/{siteId}/wallet',
      'GET /api/v1/sites/{siteId}/wallet',
      'GET /api/v1/finance/wallets',
      'GET /api/v1/finance/wallets/{walletId}',
      'GET /api/v1/sites/{siteId}/wallet/ledger',
      'GET /api/v1/finance/wallets/{walletId}/ledger',
      'GET /api/v1/sites/{siteId}/wallet/reports',
      'POST /api/v1/sites/{siteId}/wallet/funding-requests',
      'GET /api/v1/sites/{siteId}/wallet/funding-requests',
      'PATCH /api/v1/sites/{siteId}/wallet/funding-requests/{requestId}',
      'GET /api/v1/sites/{siteId}/wallet/funding-requests/{requestId}',
      'POST /api/v1/sites/{siteId}/wallet/funding-requests/{requestId}/submit',
      'POST /api/v1/sites/{siteId}/wallet/funding-requests/{requestId}/cancel',
      'GET /api/v1/sites/{siteId}/wallet/funding-requests/{requestId}/attempts',
      'GET /api/v1/finance/wallet-funding-requests',
      'GET /api/v1/finance/wallet-funding-requests/{requestId}',
      'POST /api/v1/finance/wallet-funding-requests/{requestId}/transfers',
      'GET /api/v1/finance/wallet-funding-requests/{requestId}/transfers',
      'POST /api/v1/sites/{siteId}/wallet/transfers/{transferId}/confirm',
      'GET /api/v1/sites/{siteId}/wallet/transfers/{transferId}',
      'POST /api/v1/finance/wallet-transfers/{transferId}/resolve-dispute',
      'POST /api/v1/finance/wallet-funding-requests/{requestId}/close-short',
      'GET /api/v1/sites/{siteId}/wallet/account-heads',
      'POST /api/v1/finance/wallet/account-heads',
      'GET /api/v1/finance/wallet/account-heads',
      'PATCH /api/v1/finance/wallet/account-heads/{accountHeadId}',
      'POST /api/v1/sites/{siteId}/wallet/expenses',
      'GET /api/v1/sites/{siteId}/wallet/expenses',
      'GET /api/v1/sites/{siteId}/wallet/expenses/{expenseId}',
      'GET /api/v1/sites/{siteId}/wallet/vouchers/{voucherId}',
      'GET /api/v1/sites/{siteId}/wallet/vouchers/{voucherId}/print',
      'POST /api/v1/sites/{siteId}/wallet/vouchers/{voucherId}/signed-document',
      'POST /api/v1/sites/{siteId}/wallet/ledger/{entryId}/documents',
      'POST /api/v1/sites/{siteId}/wallet/ledger/{entryId}/reversal-requests',
      'GET /api/v1/finance/wallet-reversal-requests',
      'POST /api/v1/finance/wallet/ledger/{entryId}/reverse',
      'GET /api/v1/mail/config',
      'POST /api/v1/mail/verify',
      'POST /api/v1/mail/send',
    ];
    const missing = EXPECTED.filter((r) => !documented.has(r));
    const extra = [...documented].filter(
      (r) => !EXPECTED.includes(r) && r !== 'GET /api/v1/notifications/stream',
    );
    expect(missing, 'registered routes missing from doc').toEqual([]);
    expect(extra, 'documented routes not registered').toEqual([]);
    // WebSocket upgrades aren't HTTP JSON ops — swagger correctly omits the
    // route; the contract is documented in info.description instead.
    expect(documented.has('GET /api/v1/notifications/stream')).toBe(false);
  });

  it('websocket stream documented in info, not as a JSON operation', async () => {
    const app = await makeApp();
    const doc: {
      paths: Record<string, Record<string, unknown>>;
      info: { description?: string };
    } = (await app.inject({ method: 'GET', url: '/documentation/json' })).json();
    expect(doc.paths['/api/v1/notifications/stream']).toBeUndefined();
    expect(doc.info.description).toContain('/notifications/stream');
    expect(doc.info.description).toContain('Sec-WebSocket-Protocol');
  });

  it('production exposure is impossible — docs and JSON both absent', async () => {
    const prod = await makeApp({ NODE_ENV: 'production', SWAGGER_UI: 'true' });
    expect((await prod.inject({ method: 'GET', url: '/docs' })).statusCode).toBe(404);
    expect((await prod.inject({ method: 'GET', url: '/documentation/json' })).statusCode).toBe(404);
  });

  it('swagger UI gated by SWAGGER_UI policy', async () => {
    const on = await makeApp({ SWAGGER_UI: 'true' });
    expect((await on.inject({ method: 'GET', url: '/docs' })).statusCode).not.toBe(404);
    const off = await makeApp({ SWAGGER_UI: 'false' });
    expect((await off.inject({ method: 'GET', url: '/docs' })).statusCode).toBe(404);
  });
});

describe('platform create route', () => {
  it('creates with profile fields; claimCode only in response', async () => {
    const calls: unknown[] = [];
    const platformService = {
      createCompanyWithAdmin: async (actor: unknown, input: unknown) => {
        calls.push(input);
        return { companyId: 'c1', claimCode: 'raw-claim-code-once', claimExpiresAt: new Date() };
      },
    } as unknown as PlatformService;
    const app = await buildApp({
      env,
      services: {
        authService: stubAuth,
        accessControl: allowAll,
        platformService,
        platformCompanyId: null,
      },
    });
    apps.push(app);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/platform/companies',
      headers: { authorization: `Bearer ${app.tokenService.signAccessToken('admin1', 's1')}` },
      payload: {
        companyCode: 'acme',
        companyName: 'Acme',
        adminLoginId: 'a@a.test',
        adminDisplayName: 'Admin One',
        pan: 'ABCDE1234F',
        entityType: 'PRIVATE_LIMITED',
        contactEmail: 'x@y.z',
      },
    });
    expect(res.statusCode).toBe(200);
    const body: { claimCode?: string } = res.json();
    expect(body.claimCode).toBe('raw-claim-code-once');
    expect(JSON.stringify(calls)).toContain('adminDisplayName');
    expect(JSON.stringify(calls)).toContain('pan');
    // 403 when permission denied
    const appDeny = await buildApp({
      env,
      services: {
        authService: stubAuth,
        accessControl: denyAll,
        platformService,
        platformCompanyId: null,
      },
    });
    apps.push(appDeny);
    const denied = await appDeny.inject({
      method: 'POST',
      url: '/api/v1/platform/companies',
      headers: { authorization: `Bearer ${app.tokenService.signAccessToken('admin1', 's1')}` },
      payload: {
        companyCode: 'acme',
        companyName: 'Acme',
        adminLoginId: 'a@a.test',
        adminDisplayName: 'Admin One',
      },
    });
    expect(denied.statusCode).toBe(403);
  });
});
