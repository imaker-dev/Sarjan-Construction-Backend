import { describe, it, expect, beforeEach } from 'vitest';
import { FinanceService, type FinanceAuthorizer } from '../../../src/modules/finance/service.js';
import {
  emptyFinStore,
  fakeBudget,
  fakeDepartment,
  fakeEmployee,
  fakeHeadOffice,
  fakeLeaveBalance,
  fakeLeaveRequest,
  fakeMembership,
  fakeProject,
  fakeSession,
  fakeSite,
  FakeFinanceUoW,
  type FinStore,
} from './fakes.js';
import { FakeAuthorizer } from '../department/fakes.js';
import {
  OrgEntityNotFoundError,
  OrgValidationError,
} from '../../../src/modules/organization/errors.js';
import type { ActorContext } from '../../../src/modules/organization/types.js';

const actor: ActorContext = { actorId: 'p-fin', actorType: 'USER' };
const approver: ActorContext = { actorId: 'p-approver', actorType: 'USER' };

let store: FinStore;
let svc: FinanceService;
let auth: FakeAuthorizer;
let ops: Record<string, string[]>;

beforeEach(() => {
  store = emptyFinStore();
  auth = new FakeAuthorizer();
  ops = {};
  svc = new FinanceService(
    new FakeFinanceUoW(store),
    auth,
    async (_c, employeeId) => ops[employeeId] ?? [],
  );
  store.projects.push(fakeProject({ id: 'pr-1', companyId: 'c1' }));
});

const withOps = (principalId: string, keys: string[], employeeId = 'e-fin') => {
  store.employees.push(
    fakeEmployee({ id: employeeId, companyId: 'c1', principalId, status: 'ACTIVE' }),
  );
  ops[employeeId] = keys;
};

const BUDGET_OPS = ['PROJECT_BUDGET_CREATE', 'PROJECT_BUDGET_REVISE', 'PROJECT_BUDGET_VIEW'];
const APPROVER_OPS = ['PROJECT_BUDGET_APPROVE', 'PROJECT_BUDGET_VIEW'];

const revisionInput = () => ({
  notes: 'v1',
  lines: [
    { category: 'MATERIAL' as const, description: 'Cement', amount: '1000.50' },
    { category: 'LABOUR' as const, description: 'Mason', amount: '999.50' },
  ],
});

describe('createBudget', () => {
  const input = { code: 'b-1', name: 'Base', currency: 'inr' };

  it('creates a budget for an employee with PROJECT_BUDGET_CREATE', async () => {
    withOps('p-fin', BUDGET_OPS);
    const { budget, replayed } = await svc.createBudget(actor, 'c1', 'pr-1', input);
    expect(replayed).toBe(false);
    expect(budget.code).toBe('B-1');
    expect(budget.currency).toBe('INR');
    expect(store.auditLog.some((a) => a.action === 'FINANCE_BUDGET_CREATED')).toBe(true);
    expect(store.outbox.some((o) => o.eventType === 'FINANCE_BUDGET_CREATED')).toBe(true);
  });

  it('denies when the operation is not assigned and actor is not COMPANY_OWNER', async () => {
    withOps('p-fin', []);
    await expect(svc.createBudget(actor, 'c1', 'pr-1', input)).rejects.toMatchObject({
      statusCode: 403,
      code: 'OPERATION_NOT_ASSIGNED',
    });
  });

  it('allows COMPANY_OWNER without any operation assignment', async () => {
    store.roleAssignments.push({
      companyId: 'c1',
      principalId: 'p-fin',
      roleKey: 'COMPANY_OWNER',
      revokedAt: null,
      effectiveFrom: null,
      effectiveTo: null,
    });
    const { budget } = await svc.createBudget(actor, 'c1', 'pr-1', input);
    expect(budget.projectId).toBe('pr-1');
  });

  it('rejects cross-company project and bad currency', async () => {
    withOps('p-fin', BUDGET_OPS);
    await expect(svc.createBudget(actor, 'c1', 'other-pr', input)).rejects.toThrow(
      OrgEntityNotFoundError,
    );
    await expect(
      svc.createBudget(actor, 'c1', 'pr-1', { ...input, currency: 'TOOLONG' }),
    ).rejects.toThrow(OrgValidationError);
  });

  it('replays on identical idempotency key; conflicts on different body', async () => {
    withOps('p-fin', BUDGET_OPS);
    const first = await svc.createBudget(actor, 'c1', 'pr-1', { ...input, idempotencyKey: 'k1' });
    const again = await svc.createBudget(actor, 'c1', 'pr-1', { ...input, idempotencyKey: 'k1' });
    expect(again.replayed).toBe(true);
    expect(again.budget.id).toBe(first.budget.id);
    await expect(
      svc.createBudget(actor, 'c1', 'pr-1', { ...input, name: 'Different', idempotencyKey: 'k1' }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(store.budgets).toHaveLength(1);
  });
});

describe('budget revision lifecycle', () => {
  beforeEach(() => {
    withOps('p-fin', BUDGET_OPS);
    store.budgets.push(fakeBudget({ id: 'b-1', companyId: 'c1', projectId: 'pr-1' }));
  });

  it('creates revision 1 with summed total; blocks a second open revision', async () => {
    const { revision } = await svc.createRevision(actor, 'c1', 'b-1', revisionInput());
    expect(revision.revision).toBe(1);
    expect(String(revision.totalAmount)).toBe('2000.00');
    await expect(svc.createRevision(actor, 'c1', 'b-1', revisionInput())).rejects.toMatchObject({
      statusCode: 409,
      code: 'REVISION_IN_PROGRESS',
    });
  });

  it('submit moves DRAFT→SUBMITTED; retry by same submitter replays', async () => {
    const { revision } = await svc.createRevision(actor, 'c1', 'b-1', revisionInput());
    const submitted = await svc.submitRevision(actor, 'c1', 'b-1', revision.id);
    expect(submitted.revision.status).toBe('SUBMITTED');
    const replay = await svc.submitRevision(actor, 'c1', 'b-1', revision.id);
    expect(replay.replayed).toBe(true);
  });

  it('decide APPROVE promotes latestApprovedRevision and appends a decision', async () => {
    withOps('p-approver', APPROVER_OPS, 'e-approver');
    const { revision } = await svc.createRevision(actor, 'c1', 'b-1', revisionInput());
    await svc.submitRevision(actor, 'c1', 'b-1', revision.id);
    const result = await svc.decideRevision(approver, 'c1', 'b-1', revision.id, {
      action: 'APPROVE',
      reason: 'ok',
    });
    expect(result.revision.status).toBe('APPROVED');
    const budget = store.budgets.find((b) => b.id === 'b-1');
    expect(budget?.latestApprovedRevisionId).toBe(revision.id);
    expect(store.decisions).toHaveLength(1);
    expect(store.decisions[0]?.action).toBe('APPROVE');
    expect(store.auditLog.some((a) => a.action === 'FINANCE_BUDGET_REVISION_DECIDED')).toBe(true);
    const outbox = store.outbox.find((o) => o.eventType === 'FINANCE_BUDGET_REVISION_DECIDED');
    expect(outbox?.recipientPrincipalIds).toContain('p-fin');
  });

  it('blocks self-approval — submitter cannot decide', async () => {
    ops['e-fin'] = [...BUDGET_OPS, 'PROJECT_BUDGET_APPROVE'];
    const { revision } = await svc.createRevision(actor, 'c1', 'b-1', revisionInput());
    await svc.submitRevision(actor, 'c1', 'b-1', revision.id);
    await expect(
      svc.decideRevision(actor, 'c1', 'b-1', revision.id, { action: 'APPROVE' }),
    ).rejects.toMatchObject({ statusCode: 403, code: 'SELF_APPROVAL_FORBIDDEN' });
  });

  it('rejects decide on non-submitted revision and missing approve op', async () => {
    const { revision } = await svc.createRevision(actor, 'c1', 'b-1', revisionInput());
    await expect(
      svc.decideRevision(approver, 'c1', 'b-1', revision.id, { action: 'APPROVE' }),
    ).rejects.toThrow(); // DRAFT — invalid transition; also approver lacks employee
    withOps('p-approver', APPROVER_OPS, 'e-approver');
    await svc.submitRevision(actor, 'c1', 'b-1', revision.id);
    ops['e-approver'] = ['PROJECT_BUDGET_VIEW']; // no APPROVE op
    await expect(
      svc.decideRevision(approver, 'c1', 'b-1', revision.id, { action: 'REJECT' }),
    ).rejects.toMatchObject({ statusCode: 403, code: 'OPERATION_NOT_ASSIGNED' });
  });

  it('decide is idempotent — same key replays, different body conflicts', async () => {
    withOps('p-approver', APPROVER_OPS, 'e-approver');
    const { revision } = await svc.createRevision(actor, 'c1', 'b-1', revisionInput());
    await svc.submitRevision(actor, 'c1', 'b-1', revision.id);
    const d1 = await svc.decideRevision(approver, 'c1', 'b-1', revision.id, {
      action: 'RETURN',
      reason: 'needs work',
      idempotencyKey: 'd-1',
    });
    expect(d1.replayed).toBe(false);
    const d2 = await svc.decideRevision(approver, 'c1', 'b-1', revision.id, {
      action: 'RETURN',
      reason: 'needs work',
      idempotencyKey: 'd-1',
    });
    expect(d2.replayed).toBe(true);
    expect(store.decisions).toHaveLength(1);
    await expect(
      svc.decideRevision(approver, 'c1', 'b-1', revision.id, {
        action: 'REJECT',
        idempotencyKey: 'd-1',
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('cash-flow forecasts', () => {
  const forecastInput = () => ({
    name: 'Q1 plan',
    currency: 'INR',
    periodStart: '2026-01-01',
    periodEnd: '2026-03-31',
    lines: [
      {
        direction: 'INFLOW' as const,
        category: 'CLIENT_RECEIPT' as const,
        amount: '5000',
        expectedDate: '2026-02-01',
      },
      { direction: 'OUTFLOW' as const, category: 'MATERIAL' as const, amount: '1500' },
    ],
  });

  it('creates + validates period order; revise replaces lines and bumps revision', async () => {
    withOps('p-fin', [
      'PROJECT_CASH_FLOW_FORECAST_SUBMIT',
      'PROJECT_CASH_FLOW_FORECAST_REVISE',
      'PROJECT_CASH_FLOW_REVIEW',
    ]);
    await expect(
      svc.createForecast(actor, 'c1', 'pr-1', { ...forecastInput(), periodEnd: '2025-01-01' }),
    ).rejects.toThrow(OrgValidationError);
    const { forecast } = await svc.createForecast(actor, 'c1', 'pr-1', forecastInput());
    const revised = await svc.reviseForecast(actor, 'c1', forecast.id, {
      expectedVersion: forecast.version,
      reason: 'vendor updated',
      lines: [{ direction: 'OUTFLOW' as const, category: 'LABOUR' as const, amount: '2200' }],
    });
    expect(revised.replayed).toBe(false);
    expect(revised.forecast?.revision).toBe(2);
    const detail = await svc.getForecast(actor, 'c1', forecast.id);
    expect(detail.lines).toHaveLength(1);
    expect(String(detail.lines[0]?.amount)).toContain('2200');
  });

  it('stale expectedVersion conflicts; ops required for revise', async () => {
    withOps('p-fin', ['PROJECT_CASH_FLOW_FORECAST_SUBMIT']);
    const { forecast } = await svc.createForecast(actor, 'c1', 'pr-1', forecastInput());
    await expect(
      svc.reviseForecast(actor, 'c1', forecast.id, {
        expectedVersion: 99,
        lines: [{ direction: 'OUTFLOW' as const, category: 'TAX' as const, amount: '10' }],
      }),
    ).rejects.toThrow();
    ops['e-fin'] = ['PROJECT_CASH_FLOW_FORECAST_SUBMIT']; // no REVISE op
    await expect(
      svc.reviseForecast(actor, 'c1', forecast.id, {
        expectedVersion: forecast.version,
        reason: 'x',
      }),
    ).rejects.toMatchObject({ statusCode: 403, code: 'OPERATION_NOT_ASSIGNED' });
  });
});

describe('project costs read model', () => {
  it('reports approved budgets + forecast totals; actuals/commitments null', async () => {
    withOps('p-fin', [
      ...BUDGET_OPS,
      'PROJECT_CASH_FLOW_FORECAST_SUBMIT',
      'PROJECT_CASH_FLOW_REVIEW',
    ]);
    withOps('p-approver', APPROVER_OPS, 'e-approver');
    store.budgets.push(fakeBudget({ id: 'b-1', companyId: 'c1', projectId: 'pr-1' }));
    const { revision } = await svc.createRevision(actor, 'c1', 'b-1', revisionInput());
    await svc.submitRevision(actor, 'c1', 'b-1', revision.id);
    await svc.decideRevision(approver, 'c1', 'b-1', revision.id, { action: 'APPROVE' });
    await svc.createForecast(actor, 'c1', 'pr-1', {
      name: 'Q1',
      currency: 'INR',
      periodStart: '2026-01-01',
      periodEnd: '2026-03-31',
      lines: [
        { direction: 'INFLOW' as const, category: 'CLIENT_RECEIPT' as const, amount: '5000' },
        { direction: 'OUTFLOW' as const, category: 'MATERIAL' as const, amount: '1500' },
      ],
    });
    const costs = await svc.getProjectCosts(actor, 'c1', 'pr-1');
    expect(costs.budgets[0]?.approvedRevision?.revision).toBe(1);
    expect(costs.cashFlowForecasts.totalInflow).toBe('5000.00');
    expect(costs.cashFlowForecasts.totalOutflow).toBe('1500.00');
    expect(costs.cashFlowForecasts.net).toBe('3500.00');
    expect(costs.actuals).toBeNull();
    expect(costs.commitments).toBeNull();
  });
});

// --------------------------------------------------------------------------
// Read-only portfolio / workforce / dashboard slice
// --------------------------------------------------------------------------

const READ_OPS = ['PROJECT_DASHBOARD_VIEW'];
const DIRECTORY_OPS = ['FINANCE_EMPLOYEE_DIRECTORY_VIEW'];
const SENSITIVE_OPS = ['FINANCE_EMPLOYMENT_DETAILS_VIEW'];
const PAYROLL_OPS = ['PAYROLL_INPUT_REVIEW'];

/** Authorizer where hasPermission can be toggled per sensitive key. */
const selectiveAuth = (sensitiveAllowed: boolean): FinanceAuthorizer => ({
  assertPermission: () => Promise.resolve(),
  hasPermission: (_pid: string, key: string) =>
    Promise.resolve(key === 'FINANCE_EMPLOYEE_SENSITIVE_READ' ? sensitiveAllowed : true),
});

const svcWith = (auth: FinanceAuthorizer) =>
  new FinanceService(
    new FakeFinanceUoW(store),
    auth,
    async (_c, employeeId) => ops[employeeId] ?? [],
  );

describe('listProjects / listProjectSites', () => {
  it('lists company projects with embedded headOffice; filters and paginates', async () => {
    withOps('p-fin', READ_OPS);
    store.headOffices.push(fakeHeadOffice({ id: 'ho-1', companyId: 'c1', code: 'HQ' }));
    store.projects.length = 0;
    store.projects.push(
      fakeProject({ id: 'pr-a', companyId: 'c1', headOfficeId: 'ho-1', name: 'Alpha Tower' }),
      fakeProject({
        id: 'pr-b',
        companyId: 'c1',
        headOfficeId: 'ho-1',
        name: 'Beta Mall',
        status: 'COMPLETED',
      }),
      fakeProject({ id: 'pr-x', companyId: 'cX', headOfficeId: 'ho-1' }),
    );
    const page = await svc.listProjects(actor, 'c1', { status: 'ACTIVE', limit: 10 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.id).toBe('pr-a');
    expect(page.items[0]?.headOffice.code).toBe('HQ');

    const search = await svc.listProjects(actor, 'c1', { search: 'beta', limit: 10 });
    expect(search.items.map((p) => p.id)).toEqual(['pr-b']);
  });

  it('returns nextCursor while more rows exist', async () => {
    withOps('p-fin', READ_OPS);
    store.projects.length = 0;
    store.projects.push(
      fakeProject({ id: 'pr-1', companyId: 'c1' }),
      fakeProject({ id: 'pr-2', companyId: 'c1' }),
    );
    const page = await svc.listProjects(actor, 'c1', { limit: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBe('pr-1');
    const page2 = await svc.listProjects(actor, 'c1', {
      limit: 1,
      ...(page.nextCursor !== undefined ? { cursor: page.nextCursor } : {}),
    });
    expect(page2.items[0]?.id).toBe('pr-2');
    expect(page2.nextCursor).toBeUndefined();
  });

  it('requires PROJECT_DASHBOARD_VIEW for non-owners', async () => {
    withOps('p-fin', []);
    await expect(svc.listProjects(actor, 'c1', { limit: 10 })).rejects.toMatchObject({
      statusCode: 403,
      code: 'OPERATION_NOT_ASSIGNED',
    });
  });

  it('lists sites of a project without geo coordinates; 404 cross-company', async () => {
    withOps('p-fin', READ_OPS);
    store.sites.push(
      fakeSite({
        id: 'site-1',
        companyId: 'c1',
        projectId: 'pr-1',
        geoLatitude: '25.594' as never,
        geoLongitude: '85.137' as never,
        geoFenceRadiusM: 150,
        city: 'Patna',
      }),
    );
    const page = await svc.listProjectSites(actor, 'c1', 'pr-1', { limit: 10 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).not.toHaveProperty('geoLatitude');
    expect(page.items[0]).not.toHaveProperty('geoLongitude');
    expect(page.items[0]?.geoFenceRadiusM).toBe(150);
    expect(page.items[0]?.city).toBe('Patna');
    await expect(svc.listProjectSites(actor, 'c1', 'other-pr', { limit: 10 })).rejects.toThrow(
      OrgEntityNotFoundError,
    );
  });
});

describe('listEmployees / getEmployee', () => {
  const seedWorkforce = () => {
    store.sites.push(
      fakeSite({ id: 'site-1', companyId: 'c1', projectId: 'pr-1' }),
      fakeSite({ id: 'site-2', companyId: 'c1', projectId: 'pr-1' }),
    );
    store.departments.push(
      fakeDepartment({ id: 'd-fin', companyId: 'c1', code: 'FIN', scopeType: 'COMPANY' }),
      fakeDepartment({
        id: 'd-site',
        companyId: 'c1',
        code: 'SITE-OPS',
        scopeType: 'SITE',
        projectId: null, // SITE depts carry no projectId — reach via site.projectId
        siteId: 'site-1',
      }),
    );
    store.employees.push(
      fakeEmployee({ id: 'e-1', companyId: 'c1', displayName: 'Ramesh Kumar', principalId: null }),
      fakeEmployee({ id: 'e-2', companyId: 'c1', displayName: 'Suresh Yadav', status: 'INACTIVE' }),
      fakeEmployee({ id: 'e-x', companyId: 'cX' }),
    );
    store.memberships.push(
      fakeMembership({ employeeId: 'e-1', departmentId: 'd-site', isPrimary: true }),
      fakeMembership({ employeeId: 'e-2', departmentId: 'd-fin', isPrimary: true }),
      fakeMembership({
        employeeId: 'e-1',
        departmentId: 'd-fin',
        endedAt: new Date('2020-01-01'), // ended — must not match filters
      }),
    );
  };

  it('filters by site/project/department via ACTIVE memberships only', async () => {
    withOps('p-fin', DIRECTORY_OPS);
    seedWorkforce();
    const bySite = await svc.listEmployees(actor, 'c1', { siteId: 'site-1', limit: 10 });
    expect(bySite.items.map((e) => e.id)).toEqual(['e-1']);
    const byProject = await svc.listEmployees(actor, 'c1', { projectId: 'pr-1', limit: 10 });
    expect(byProject.items.map((e) => e.id)).toEqual(['e-1']);
    const byDept = await svc.listEmployees(actor, 'c1', { departmentId: 'd-fin', limit: 10 });
    // e-1's d-fin membership ended → only e-2
    expect(byDept.items.map((e) => e.id)).toEqual(['e-2']);
  });

  it('filters by status and search; embeds primaryMembership', async () => {
    withOps('p-fin', DIRECTORY_OPS);
    seedWorkforce();
    const inactive = await svc.listEmployees(actor, 'c1', { status: 'INACTIVE', limit: 10 });
    expect(inactive.items.map((e) => e.id)).toEqual(['e-2']);
    const found = await svc.listEmployees(actor, 'c1', { search: 'ramesh', limit: 10 });
    expect(found.items).toHaveLength(1);
    expect(found.items[0]?.primaryMembership?.department.code).toBe('SITE-OPS');
  });

  it('requires FINANCE_EMPLOYEE_DIRECTORY_VIEW for non-owners', async () => {
    withOps('p-fin', []);
    await expect(svc.listEmployees(actor, 'c1', { limit: 10 })).rejects.toMatchObject({
      code: 'OPERATION_NOT_ASSIGNED',
    });
    await expect(svc.getEmployee(actor, 'c1', 'e-fin')).rejects.toMatchObject({
      code: 'OPERATION_NOT_ASSIGNED',
    });
  });

  it('detail: memberships listed; employmentDetails null without sensitive grant', async () => {
    withOps('p-fin', DIRECTORY_OPS);
    seedWorkforce();
    svc = svcWith(selectiveAuth(false));
    const detail = await svc.getEmployee(actor, 'c1', 'e-1');
    expect(detail.displayName).toBe('Ramesh Kumar');
    expect(detail.memberships).toHaveLength(1); // ended d-fin membership excluded
    expect(detail.employmentDetails).toBeNull();
    expect(detail).not.toHaveProperty('contactPhone');
  });

  it('detail: employmentDetails requires sensitive perm AND op', async () => {
    withOps('p-fin', [...DIRECTORY_OPS, ...SENSITIVE_OPS]);
    seedWorkforce();
    // sensitive op held but sensitive permission denied → still null
    svc = svcWith(selectiveAuth(false));
    let detail = await svc.getEmployee(actor, 'c1', 'e-1');
    expect(detail.employmentDetails).toBeNull();
    // both held → populated
    svc = svcWith(selectiveAuth(true));
    detail = await svc.getEmployee(actor, 'c1', 'e-1');
    expect(detail.employmentDetails?.designation).toBeDefined();
    expect(detail.employmentDetails).toHaveProperty('contactPhone');
  });

  it('detail: sensitive perm alone without the op is not enough', async () => {
    withOps('p-fin', DIRECTORY_OPS); // no FINANCE_EMPLOYMENT_DETAILS_VIEW
    seedWorkforce();
    svc = svcWith(selectiveAuth(true));
    const detail = await svc.getEmployee(actor, 'c1', 'e-1');
    expect(detail.employmentDetails).toBeNull();
  });

  it('404 on cross-company employee', async () => {
    withOps('p-fin', DIRECTORY_OPS);
    seedWorkforce();
    await expect(svc.getEmployee(actor, 'c1', 'e-x')).rejects.toThrow(OrgEntityNotFoundError);
  });
});

describe('attendance/leave summaries', () => {
  it('attendance-summary aggregates units/hours — no GPS or remarks', async () => {
    withOps('p-fin', PAYROLL_OPS);
    store.employees.push(fakeEmployee({ id: 'e-1', companyId: 'c1' }));
    store.attendanceSessions.push(
      fakeSession({ businessDate: '2026-11-01', siteId: 'site-1' }),
      fakeSession({
        businessDate: '2026-11-02',
        siteId: 'site-2',
        presentUnits: '0.5' as never,
        overtimeHours: '1.50' as never,
        isFlagged: true,
      }),
      fakeSession({ businessDate: '2026-12-31' }), // outside range
      fakeSession({ employeeId: 'e-2' }), // other employee
    );
    const s = await svc.getAttendanceSummary(actor, 'c1', 'e-1', {
      from: '2026-11-01',
      to: '2026-11-30',
    });
    expect(s.sessions).toBe(2);
    expect(s.presentUnits).toBe('1.5');
    expect(s.overtimeHours).toBe('1.50');
    expect(s.flaggedSessions).toBe(1);
    expect(s.sitesWorked).toBe(2);
    expect(s).not.toHaveProperty('punchInLat');
    expect(s).not.toHaveProperty('flagReason');
  });

  it('attendance-summary requires PAYROLL_INPUT_REVIEW and validates range', async () => {
    withOps('p-fin', DIRECTORY_OPS); // wrong op
    store.employees.push(fakeEmployee({ id: 'e-1', companyId: 'c1' }));
    await expect(
      svc.getAttendanceSummary(actor, 'c1', 'e-1', { from: '2026-11-01', to: '2026-11-30' }),
    ).rejects.toMatchObject({ code: 'OPERATION_NOT_ASSIGNED' });
    ops['e-fin'] = PAYROLL_OPS;
    await expect(
      svc.getAttendanceSummary(actor, 'c1', 'e-1', { from: '2026-12-01', to: '2026-11-01' }),
    ).rejects.toThrow(OrgValidationError);
  });

  it('leave-summary returns balances + request stats without reasons', async () => {
    withOps('p-fin', SENSITIVE_OPS);
    store.employees.push(fakeEmployee({ id: 'e-1', companyId: 'c1' }));
    store.leaveBalances.push(
      fakeLeaveBalance({ employeeId: 'e-1', year: 2026 }),
      fakeLeaveBalance({ employeeId: 'e-1', year: 2025, leaveType: 'SICK' }),
    );
    store.leaveRequests.push(
      fakeLeaveRequest({ employeeId: 'e-1', status: 'APPROVED' }),
      fakeLeaveRequest({ employeeId: 'e-1', status: 'PENDING', totalDays: '1.0' as never }),
      fakeLeaveRequest({ employeeId: 'e-1', startDate: new Date('2025-06-01') }),
    );
    const s = await svc.getLeaveSummary(actor, 'c1', 'e-1', 2026);
    expect(s.balances).toHaveLength(1);
    expect(s.balances[0]?.availableDays).toBe('11.0'); // 12 + 2 - 3
    const approved = s.requests.find((r) => r.status === 'APPROVED');
    expect(approved?.count).toBe(1);
    expect(JSON.stringify(s)).not.toContain('family function');
  });
});

describe('dashboard', () => {
  it('aggregates existing data; unavailable sections declared, workforce gated', async () => {
    withOps('p-fin', [
      ...READ_OPS,
      ...DIRECTORY_OPS,
      'PROJECT_BUDGET_CREATE',
      'PROJECT_BUDGET_REVISE',
      'PROJECT_CASH_FLOW_FORECAST_SUBMIT',
    ]);
    store.sites.push(fakeSite({ companyId: 'c1', projectId: 'pr-1' }));
    store.employees.push(fakeEmployee({ id: 'e-1', companyId: 'c1' }));
    const { budget } = await svc.createBudget(actor, 'c1', 'pr-1', {
      code: 'd1',
      name: 'D',
      currency: 'INR',
    });
    const { revision } = await svc.createRevision(actor, 'c1', budget.id, {
      lines: [{ category: 'MATERIAL' as const, description: 'x', amount: '100' }],
    });
    await svc.submitRevision(actor, 'c1', budget.id, revision.id);
    withOps('p-approver', APPROVER_OPS, 'e-approver');
    await svc.decideRevision(approver, 'c1', budget.id, revision.id, { action: 'APPROVE' });
    await svc.createForecast(actor, 'c1', 'pr-1', {
      name: 'Q1',
      currency: 'INR',
      periodStart: '2026-01-01',
      periodEnd: '2026-03-31',
      lines: [
        { direction: 'INFLOW' as const, category: 'CLIENT_RECEIPT' as const, amount: '4000' },
        { direction: 'OUTFLOW' as const, category: 'LABOUR' as const, amount: '1500' },
      ],
    });

    const dash = await svc.getDashboard(actor, 'c1');
    expect(dash.projects.byStatus.ACTIVE).toBe(1);
    expect(dash.sites.total).toBe(1);
    expect(dash.budgets.total).toBe(1);
    expect(dash.budgets.approvedTotals).toEqual([{ currency: 'INR', totalAmount: '100.00' }]);
    expect(dash.pendingBudgetReviews).toBe(0);
    expect(dash.cashFlowForecasts.byCurrency[0]).toMatchObject({
      currency: 'INR',
      totalInflow: '4000.00',
      totalOutflow: '1500.00',
      net: '2500.00',
    });
    expect(dash.workforce?.total).toBe(3); // p-fin + p-approver + e-1
    const sections = dash.unavailable.map((u) => u.section);
    expect(sections).toEqual(
      expect.arrayContaining(['wallets', 'payroll', 'actualCosts', 'billing', 'quotations']),
    );
    expect(sections).not.toContain('workforce');
  });

  it('workforce is null and declared when the caller lacks the directory op', async () => {
    withOps('p-fin', READ_OPS); // PROJECT_DASHBOARD_VIEW only
    const dash = await svc.getDashboard(actor, 'c1');
    expect(dash.workforce).toBeNull();
    expect(dash.unavailable.map((u) => u.section)).toContain('workforce');
  });

  it('requires PROJECT_DASHBOARD_VIEW for non-owners', async () => {
    withOps('p-fin', []);
    await expect(svc.getDashboard(actor, 'c1')).rejects.toMatchObject({
      code: 'OPERATION_NOT_ASSIGNED',
    });
  });
});
