// Finance slice (project budgets + cash-flow forecasts) against real
// PostgreSQL. Runs only on the guarded disposable target — loopback :55432,
// db erp_test; skips silently when TEST_DATABASE_URL is unset or off-target.
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { PrismaFinanceUnitOfWork } from '../../src/modules/finance/repository.js';
import { FinanceService } from '../../src/modules/finance/service.js';
import type { ActorContext } from '../../src/modules/organization/types.js';
import type { FinanceAuthorizer } from '../../src/modules/finance/service.js';
import { resolveTestDbUrl } from './test-db-url.js';

const url = resolveTestDbUrl(process.env.TEST_DATABASE_URL);
const run = url === null ? it.skip : it;
let prisma: PrismaClient | undefined;
let pool: pg.Pool | undefined;

let companyId = '';
let otherCompanyId = '';
let projectId = '';
let otherProjectId = '';
let ownerA = '';
let ownerB = '';
let outsider = '';
let siteId = '';
let employeeId = '';
let otherEmployeeId = '';

const OPS = [
  'PROJECT_BUDGET_VIEW',
  'PROJECT_BUDGET_CREATE',
  'PROJECT_BUDGET_REVISE',
  'PROJECT_BUDGET_REVIEW',
  'PROJECT_BUDGET_APPROVE',
  'PROJECT_CASH_FLOW_FORECAST_SUBMIT',
  'PROJECT_CASH_FLOW_FORECAST_REVISE',
  'PROJECT_CASH_FLOW_REVIEW',
  'PROJECT_DASHBOARD_VIEW',
  'FINANCE_EMPLOYEE_DIRECTORY_VIEW',
  'FINANCE_EMPLOYMENT_DETAILS_VIEW',
  'PAYROLL_INPUT_REVIEW',
];

const authorizer = {
  assertPermission: () => Promise.resolve(),
  hasPermission: () => Promise.resolve(true),
} as unknown as FinanceAuthorizer;
const allowAllOps = () => Promise.resolve(OPS);
const noOps = () => Promise.resolve([] as string[]);

const actor = (id: string): ActorContext => ({ actorId: id, actorType: 'USER' });

function svc() {
  if (prisma === undefined) throw new Error('unreachable');
  return new FinanceService(new PrismaFinanceUnitOfWork(prisma), authorizer, allowAllOps);
}
function svcNoOps() {
  if (prisma === undefined) throw new Error('unreachable');
  return new FinanceService(new PrismaFinanceUnitOfWork(prisma), authorizer, noOps);
}

// Authorizer that denies the sensitive permission while still asserting —
// models a caller holding FINANCE_* reads but not FINANCE_EMPLOYEE_SENSITIVE_READ.
const noSensitiveAuthorizer = {
  assertPermission: () => Promise.resolve(),
  hasPermission: (_pid: string, key: string) =>
    Promise.resolve(key !== 'FINANCE_EMPLOYEE_SENSITIVE_READ'),
} as unknown as FinanceAuthorizer;
function svcNoSensitive() {
  if (prisma === undefined) throw new Error('unreachable');
  return new FinanceService(
    new PrismaFinanceUnitOfWork(prisma),
    noSensitiveAuthorizer,
    allowAllOps,
  );
}

beforeAll(async () => {
  if (url === null) return;
  pool = new pg.Pool({ connectionString: url });
  const client = new PrismaClient({ adapter: new PrismaPg(pool) });
  prisma = client;

  const mk = async (code: string) => {
    const company = await client.company.create({
      data: { code, name: `Fin ${code}` },
    });
    const ho = await client.headOffice.create({
      data: { companyId: company.id, code: 'HQ', name: 'HQ', isPrimary: true },
    });
    const project = await client.project.create({
      data: {
        companyId: company.id,
        headOfficeId: ho.id,
        code: 'P1',
        name: 'Project One',
        timezone: 'UTC',
      },
    });
    const role = await client.role.create({
      data: { companyId: company.id, key: 'COMPANY_OWNER', name: 'Owner', isSystem: true },
    });
    return { company, ho, project, role };
  };

  const a = await mk('FIN-A');
  const b = await mk('FIN-B');
  companyId = a.company.id;
  otherCompanyId = b.company.id;
  projectId = a.project.id;
  otherProjectId = b.project.id;

  const mkPrincipal = async (loginId: string) =>
    client.principal.create({
      data: { loginId, loginIdType: 'EMAIL', passwordHash: 'test-only-not-a-real-hash' },
    });

  const pa = await mkPrincipal('fin-a@t.dev');
  const pb = await mkPrincipal('fin-b@t.dev');
  const px = await mkPrincipal('fin-x@t.dev');
  ownerA = pa.id;
  ownerB = pb.id;
  outsider = px.id;

  for (const pid of [ownerA, ownerB]) {
    await client.roleAssignment.create({
      data: {
        principal: { connect: { id: pid } },
        role: { connect: { id_companyId: { id: a.role.id, companyId } } },
        company: { connect: { id: companyId } },
        scopeType: 'COMPANY',
      },
    });
  }

  // Workforce/read-slice fixtures (company A only unless stated).
  const site = await client.site.create({
    data: {
      companyId,
      projectId,
      code: 'S1',
      name: 'Main Site',
      city: 'Patna',
      geoLatitude: '25.5941000',
      geoLongitude: '85.1376000',
      geoFenceRadiusM: 150,
    },
  });
  siteId = site.id;

  const dept = await client.department.create({
    data: { companyId, scopeType: 'COMPANY', code: 'FIN-DEPT', name: 'Finance', status: 'ACTIVE' },
  });
  const siteDept = await client.department.create({
    data: {
      companyId,
      scopeType: 'SITE',
      siteId: site.id,
      code: 'SITE-OPS',
      name: 'Site Ops',
      status: 'ACTIVE',
    },
  });

  const mkEmployee = async (cid: string, code: string, name: string, principalId?: string) =>
    client.employee.create({
      data: {
        companyId: cid,
        employeeCode: code,
        displayName: name,
        engagementType: 'DIRECT_EMPLOYEE',
        designation: 'Engineer',
        contactPhone: '9000000001',
        ...(principalId !== undefined ? { principalId } : {}),
      },
    });

  const emp = await mkEmployee(companyId, 'E-FIN-1', 'Ramesh Kumar', pa.id);
  employeeId = emp.id;
  const empB = await mkEmployee(otherCompanyId, 'E-FIN-B', 'Other Co Worker', pb.id);
  otherEmployeeId = empB.id;

  await client.departmentMembership.create({
    data: {
      companyId,
      employeeId: emp.id,
      departmentId: siteDept.id,
      isPrimary: true,
      startedAt: new Date('2026-01-01'),
    },
  });
  // Ended membership — must be invisible to active-scope filters.
  await client.departmentMembership.create({
    data: {
      companyId,
      employeeId: emp.id,
      departmentId: dept.id,
      startedAt: new Date('2025-01-01'),
      endedAt: new Date('2025-12-31'),
    },
  });

  const policy = await client.attendancePolicy.create({
    data: { companyId, name: 'Default Policy' },
  });
  await client.attendanceSession.createMany({
    data: [
      {
        companyId,
        employeeId: emp.id,
        siteId: site.id,
        policyId: policy.id,
        businessDate: '2026-11-01',
        status: 'COMPLETED',
        source: 'MOBILE_SELF',
        punchInAt: new Date('2026-11-01T08:00:00Z'),
        punchInLat: '25.5941',
        punchInLng: '85.1376',
        grossDurationMins: 540,
        breakDurationMins: 60,
        netDurationMins: 480,
        presentUnits: '1.0',
        totalPUnits: '1.0',
      },
      {
        companyId,
        employeeId: emp.id,
        siteId: site.id,
        policyId: policy.id,
        businessDate: '2026-11-02',
        status: 'COMPLETED',
        source: 'SUPERVISOR_KIOSK',
        punchInAt: new Date('2026-11-02T08:00:00Z'),
        punchOutAt: new Date('2026-11-02T19:00:00Z'),
        grossDurationMins: 660,
        netDurationMins: 600,
        presentUnits: '1.0',
        overtimePUnits: '0.5',
        totalPUnits: '1.5',
        overtimeHours: '2.00',
        isFlagged: true,
        flagReason: 'outside geofence',
      },
      // Outside the queried range.
      {
        companyId,
        employeeId: emp.id,
        siteId: site.id,
        policyId: policy.id,
        businessDate: '2026-12-31',
        status: 'COMPLETED',
        source: 'MOBILE_SELF',
        punchInAt: new Date('2026-12-31T08:00:00Z'),
        presentUnits: '1.0',
        totalPUnits: '1.0',
      },
    ],
  });

  await client.leaveBalance.create({
    data: {
      companyId,
      employeeId: emp.id,
      leaveType: 'CASUAL',
      year: 2026,
      allocatedDays: '12.0',
      usedDays: '3.0',
      carriedOverDays: '2.0',
    },
  });
  await client.leaveRequest.createMany({
    data: [
      {
        companyId,
        employeeId: emp.id,
        leaveType: 'CASUAL',
        startDate: new Date('2026-03-10'),
        endDate: new Date('2026-03-12'),
        totalDays: '3.0',
        reason: 'family function — must never surface in summary',
        status: 'APPROVED',
      },
      {
        companyId,
        employeeId: emp.id,
        leaveType: 'SICK',
        startDate: new Date('2026-06-01'),
        endDate: new Date('2026-06-01'),
        totalDays: '1.0',
        reason: 'medical',
        status: 'PENDING',
      },
    ],
  });
});

afterAll(async () => {
  if (prisma !== undefined && pool !== undefined) {
    for (const cid of [companyId, otherCompanyId]) {
      await prisma.attendanceSession.deleteMany({ where: { companyId: cid } });
      await prisma.leaveRequest.deleteMany({ where: { companyId: cid } });
      await prisma.leaveBalance.deleteMany({ where: { companyId: cid } });
      await prisma.departmentMembership.deleteMany({ where: { companyId: cid } });
      await prisma.attendancePolicy.deleteMany({ where: { companyId: cid } });
      await prisma.department.deleteMany({ where: { companyId: cid } });
      await prisma.employee.deleteMany({ where: { companyId: cid } });
      await prisma.site.deleteMany({ where: { companyId: cid } });
      await prisma.budgetReviewDecision.deleteMany({ where: { companyId: cid } });
      await prisma.budgetRevisionLine.deleteMany({ where: { companyId: cid } });
      // latestApprovedRevisionId is a same-budget composite FK — clear first.
      await prisma.projectBudget.updateMany({
        where: { companyId: cid },
        data: { latestApprovedRevisionId: null },
      });
      await prisma.budgetRevision.deleteMany({ where: { companyId: cid } });
      await prisma.projectBudget.deleteMany({ where: { companyId: cid } });
      await prisma.cashFlowForecastLine.deleteMany({ where: { companyId: cid } });
      await prisma.cashFlowForecast.deleteMany({ where: { companyId: cid } });
      await prisma.outboxEvent.deleteMany({ where: { companyId: cid } });
      await prisma.auditLog.deleteMany({ where: { companyId: cid } });
      await prisma.roleAssignment.deleteMany({ where: { companyId: cid } });
      await prisma.role.deleteMany({ where: { companyId: cid } });
      await prisma.project.deleteMany({ where: { companyId: cid } });
      await prisma.headOffice.deleteMany({ where: { companyId: cid } });
      await prisma.company.deleteMany({ where: { id: cid } });
    }
    const seeded = [ownerA, ownerB, outsider].filter((id) => id !== '');
    if (seeded.length > 0) {
      await prisma.principal.deleteMany({ where: { id: { in: seeded } } });
    }
    await prisma.$disconnect();
    await pool.end();
  }
});

describe('finance budgets — service lifecycle on real DB', () => {
  run('owner path: create → revise → submit → approve promotes latestApproved', async () => {
    if (prisma === undefined) throw new Error('unreachable');
    const s = svc();

    const { budget } = await s.createBudget(actor(ownerA), companyId, projectId, {
      code: 'b1',
      name: 'Baseline',
      currency: 'INR',
      idempotencyKey: 'bud-1',
    });
    expect(budget.projectId).toBe(projectId);

    const { revision } = await s.createRevision(actor(ownerA), companyId, budget.id, {
      lines: [
        { category: 'MATERIAL', description: 'cement', amount: '1500.50' },
        { category: 'LABOUR', description: 'masons', amount: '499.50' },
      ],
    });
    expect(revision.totalAmount.toFixed(2)).toBe('2000.00');
    expect(revision.revision).toBe(1);

    const { revision: submitted } = await s.submitRevision(
      actor(ownerA),
      companyId,
      budget.id,
      revision.id,
    );
    expect(submitted.status).toBe('SUBMITTED');

    // self-approval is forbidden even for an owner
    await expect(
      s.decideRevision(actor(ownerA), companyId, budget.id, revision.id, { action: 'APPROVE' }),
    ).rejects.toMatchObject({ statusCode: 403 });

    const { revision: decided, decision } = await s.decideRevision(
      actor(ownerB),
      companyId,
      budget.id,
      revision.id,
      { action: 'APPROVE', reason: 'ok', idempotencyKey: 'dec-1' },
    );
    expect(decided.status).toBe('APPROVED');
    expect(decision.action).toBe('APPROVE');

    const after = await prisma.projectBudget.findUniqueOrThrow({ where: { id: budget.id } });
    expect(after.latestApprovedRevisionId).toBe(revision.id);

    // audit + outbox were written in the same transactions
    const audits = await prisma.auditLog.findMany({
      where: { companyId, entityType: 'BUDGET_REVISION', entityId: revision.id },
    });
    expect(audits.map((x) => x.action)).toEqual(
      expect.arrayContaining([
        'FINANCE_BUDGET_REVISION_CREATED',
        'FINANCE_BUDGET_REVISION_SUBMITTED',
        'FINANCE_BUDGET_REVISION_DECIDED',
      ]),
    );
    const outbox = await prisma.outboxEvent.findMany({
      where: { companyId, aggregateType: 'BUDGET_REVISION', aggregateId: revision.id },
    });
    expect(outbox.length).toBeGreaterThanOrEqual(3);
    const decidedEvt = outbox.find((e) => e.eventType === 'FINANCE_BUDGET_REVISION_DECIDED');
    const payload = decidedEvt?.payload as { recipientPrincipalIds?: string[] };
    expect(payload.recipientPrincipalIds).toEqual([ownerA]);
  });

  run('idempotency: replay returns recorded row; conflicting body rejects', async () => {
    const s = svc();
    const input = { code: 'b2', name: 'Second', currency: 'INR', idempotencyKey: 'bud-2' };
    const first = await s.createBudget(actor(ownerA), companyId, projectId, input);
    const replay = await s.createBudget(actor(ownerA), companyId, projectId, input);
    expect(replay.replayed).toBe(true);
    expect(replay.budget.id).toBe(first.budget.id);
    await expect(
      s.createBudget(actor(ownerA), companyId, projectId, {
        code: 'b3',
        name: 'Different',
        currency: 'INR',
        idempotencyKey: 'bud-2',
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  run('op gate: non-owner without employee/ops is denied', async () => {
    await expect(
      svcNoOps().createBudget(actor(outsider), companyId, projectId, {
        code: 'bx',
        name: 'Nope',
        currency: 'INR',
      }),
    ).rejects.toMatchObject({ statusCode: 403, code: 'OPERATION_NOT_ASSIGNED' });
  });

  run('tenant isolation: cross-company reads/writes miss', async () => {
    const s = svc();
    const { budget } = await s.createBudget(actor(ownerA), companyId, projectId, {
      code: 'iso',
      name: 'Isolated',
      currency: 'INR',
    });
    await expect(s.getBudget(actor(ownerA), otherCompanyId, budget.id)).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(
      s.createBudget(actor(ownerA), companyId, otherProjectId, {
        code: 'x',
        name: 'x',
        currency: 'INR',
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  run('optimistic concurrency: stale expectedVersion on submit rejects', async () => {
    const s = svc();
    const { budget } = await s.createBudget(actor(ownerA), companyId, projectId, {
      code: 'oc',
      name: 'OC',
      currency: 'INR',
    });
    const { revision } = await s.createRevision(actor(ownerA), companyId, budget.id, {
      lines: [{ category: 'MATERIAL', description: 'x', amount: '10.00' }],
    });
    await expect(
      s.submitRevision(actor(ownerA), companyId, budget.id, revision.id, 99),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  run('costs read model: actuals/commitments null until transactions exist', async () => {
    const s = svc();
    const costs = await s.getProjectCosts(actor(ownerA), companyId, projectId);
    expect(costs.actuals).toBeNull();
    expect(costs.commitments).toBeNull();
    expect(costs.budgets.length).toBeGreaterThan(0);
  });
});

describe('finance forecasts — service on real DB', () => {
  run('create + revise with effective period and categories', async () => {
    const s = svc();
    const { forecast } = await s.createForecast(actor(ownerA), companyId, projectId, {
      name: 'Q1',
      currency: 'INR',
      periodStart: '2026-01-01',
      periodEnd: '2026-03-31',
      lines: [
        { direction: 'INFLOW', category: 'CLIENT_RECEIPT', amount: '9000.00' },
        { direction: 'OUTFLOW', category: 'SUBCONTRACT', amount: '3000.00' },
      ],
      idempotencyKey: 'fcf-1',
    });
    expect(forecast.revision).toBe(1);
    const { forecast: revised } = await s.reviseForecast(actor(ownerA), companyId, forecast.id, {
      expectedVersion: forecast.version,
      reason: 're-plan',
      lines: [{ direction: 'OUTFLOW', category: 'MATERIAL', amount: '1200.00' }],
    });
    expect(revised?.revision).toBe(2);
    const detail = await s.getForecast(actor(ownerA), companyId, forecast.id);
    expect(detail.lines).toHaveLength(1);
  });
});

describe('finance constraints — raw DB', () => {
  run('composite FKs reject cross-company references', async () => {
    if (prisma === undefined) throw new Error('unreachable');
    // budget pointing at another company's project
    await expect(
      prisma.projectBudget.create({
        data: {
          companyId,
          projectId: otherProjectId,
          code: 'bad',
          name: 'Bad',
          currency: 'INR',
        },
      }),
    ).rejects.toThrow();
    // forecast pointing at another company's project
    await expect(
      prisma.cashFlowForecast.create({
        data: {
          companyId,
          projectId: otherProjectId,
          name: 'bad',
          currency: 'INR',
          periodStart: new Date('2026-01-01'),
          periodEnd: new Date('2026-02-01'),
        },
      }),
    ).rejects.toThrow();
  });

  run('partial unique idempotency indexes', async () => {
    if (prisma === undefined) throw new Error('unreachable');
    const b1 = await prisma.projectBudget.create({
      data: {
        companyId,
        projectId,
        code: 'idem1',
        name: 'A',
        currency: 'INR',
        idempotencyKey: 'dup-key',
      },
    });
    await expect(
      prisma.projectBudget.create({
        data: {
          companyId,
          projectId,
          code: 'idem2',
          name: 'B',
          currency: 'INR',
          idempotencyKey: 'dup-key',
        },
      }),
    ).rejects.toThrow();
    // NULL keys are exempt — multiple NULLs allowed
    for (const code of ['null1', 'null2']) {
      await prisma.projectBudget.create({
        data: {
          companyId,
          projectId,
          code,
          name: code,
          currency: 'INR',
        },
      });
    }
    // decision uniqueness: (revisionId, idempotencyKey)
    const rev = await prisma.budgetRevision.create({
      data: {
        companyId,
        budgetId: b1.id,
        revision: 1,
        totalAmount: '0.00',
      },
    });
    await prisma.budgetReviewDecision.create({
      data: {
        companyId,
        revisionId: rev.id,
        action: 'RETURN',
        actorType: 'USER',
        eventKey: randomUUID(),
        idempotencyKey: 'd-dup',
      },
    });
    await expect(
      prisma.budgetReviewDecision.create({
        data: {
          companyId,
          revisionId: rev.id,
          action: 'RETURN',
          actorType: 'USER',
          eventKey: randomUUID(),
          idempotencyKey: 'd-dup',
        },
      }),
    ).rejects.toThrow();
  });

  run("latestApproved composite FK: cannot point at another budget's revision", async () => {
    if (prisma === undefined) throw new Error('unreachable');
    const bA = await prisma.projectBudget.create({
      data: {
        companyId,
        projectId,
        code: 'la-a',
        name: 'A',
        currency: 'INR',
      },
    });
    const bB = await prisma.projectBudget.create({
      data: {
        companyId,
        projectId,
        code: 'la-b',
        name: 'B',
        currency: 'INR',
      },
    });
    const revA = await prisma.budgetRevision.create({
      data: {
        companyId,
        budgetId: bA.id,
        revision: 1,
        totalAmount: '1.00',
      },
    });
    await expect(
      prisma.projectBudget.update({
        where: { id: bB.id },
        data: { latestApprovedRevisionId: revA.id },
      }),
    ).rejects.toThrow();
  });

  run('decimal precision roundtrips', async () => {
    if (prisma === undefined) throw new Error('unreachable');
    const f = await prisma.cashFlowForecast.create({
      data: {
        companyId,
        projectId,
        name: 'dec',
        currency: 'INR',
        periodStart: new Date('2026-01-01'),
        periodEnd: new Date('2026-12-31'),
        lines: {
          create: [
            {
              direction: 'OUTFLOW',
              category: 'MATERIAL',
              amount: '12345678.99',
              sortOrder: 0,
            },
          ],
        },
      },
      include: { lines: true },
    });
    expect(String(f.lines[0]?.amount)).toBe('12345678.99');
  });
});

describe('finance read-only portfolio/workforce — real DB', () => {
  run('listProjects embeds headOffice; search+status filter; tenant-isolated', async () => {
    const s = svc();
    const page = await s.listProjects(actor(ownerA), companyId, { limit: 10 });
    const found = page.items.find((p) => p.id === projectId);
    expect(found).toBeDefined();
    expect(found?.headOffice.code).toBe('HQ');
    expect(page.items.every((p) => p.id !== otherProjectId)).toBe(true);

    const filtered = await s.listProjects(actor(ownerA), companyId, {
      search: 'no-match-xyz',
      limit: 10,
    });
    expect(filtered.items).toHaveLength(0);
  });

  run('listProjectSites strips geo coords; cross-company project 404s', async () => {
    const s = svc();
    const page = await s.listProjectSites(actor(ownerA), companyId, projectId, { limit: 10 });
    const site = page.items.find((x) => x.id === siteId);
    expect(site).toBeDefined();
    expect(site).not.toHaveProperty('geoLatitude');
    expect(site).not.toHaveProperty('geoLongitude');
    expect(site?.geoFenceRadiusM).toBe(150);
    expect(site?.city).toBe('Patna');
    await expect(
      s.listProjectSites(actor(ownerA), companyId, otherProjectId, { limit: 10 }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  run(
    'listEmployees filters by site via ACTIVE membership only; search; tenant-isolated',
    async () => {
      const s = svc();
      const bySite = await s.listEmployees(actor(ownerA), companyId, {
        siteId,
        limit: 10,
      });
      expect(bySite.items.map((e) => e.id)).toEqual([employeeId]);
      const found = await s.listEmployees(actor(ownerA), companyId, {
        search: 'ramesh',
        limit: 10,
      });
      expect(found.items).toHaveLength(1);
      expect(found.items[0]?.primaryMembership?.department.code).toBe('SITE-OPS');
      // Cross-company employee never appears.
      const all = await s.listEmployees(actor(ownerA), companyId, { limit: 50 });
      expect(all.items.some((e) => e.id === otherEmployeeId)).toBe(false);
    },
  );

  run(
    'getEmployee: active memberships only; employmentDetails gated by sensitive perm',
    async () => {
      const s = svc();
      const detail = await s.getEmployee(actor(ownerA), companyId, employeeId);
      expect(detail.memberships).toHaveLength(1); // ended FIN-DEPT membership excluded
      expect(detail.memberships[0]?.departmentCode).toBe('SITE-OPS');
      expect(detail.employmentDetails?.contactPhone).toBe('9000000001');

      const denied = await svcNoSensitive().getEmployee(actor(ownerA), companyId, employeeId);
      expect(denied.employmentDetails).toBeNull();
      expect(denied.memberships).toHaveLength(1);

      await expect(s.getEmployee(actor(ownerA), companyId, otherEmployeeId)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    },
  );

  run('attendance-summary aggregates; no GPS/remarks surface; tenant-isolated', async () => {
    const s = svc();
    const sum = await s.getAttendanceSummary(actor(ownerA), companyId, employeeId, {
      from: '2026-11-01',
      to: '2026-11-30',
    });
    expect(sum.sessions).toBe(2);
    expect(Number(sum.presentUnits)).toBe(2);
    expect(Number(sum.overtimeHours)).toBe(2);
    expect(sum.flaggedSessions).toBe(1);
    expect(sum.sitesWorked).toBe(1);
    expect(JSON.stringify(sum)).not.toContain('geofence');
    expect(JSON.stringify(sum)).not.toContain('25.594');

    await expect(
      s.getAttendanceSummary(actor(ownerA), companyId, otherEmployeeId, {
        from: '2026-11-01',
        to: '2026-11-30',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  run('leave-summary returns balances + status rollups without reasons', async () => {
    const s = svc();
    const sum = await s.getLeaveSummary(actor(ownerA), companyId, employeeId, 2026);
    expect(sum.balances).toHaveLength(1);
    expect(sum.balances[0]?.leaveType).toBe('CASUAL');
    expect(Number(sum.balances[0]?.availableDays)).toBe(11); // 12 + 2 - 3
    const statuses = Object.fromEntries(sum.requests.map((r) => [r.status, r]));
    expect(statuses.APPROVED?.count).toBe(1);
    expect(statuses.PENDING?.count).toBe(1);
    expect(JSON.stringify(sum)).not.toContain('family function');
    expect(JSON.stringify(sum)).not.toContain('medical');
  });

  run(
    'dashboard aggregates real rows; declares unavailable sections; workforce gated by op',
    async () => {
      const s = svc();
      const dash = await s.getDashboard(actor(ownerA), companyId);
      expect(dash.projects.total).toBeGreaterThanOrEqual(1);
      expect(dash.sites.total).toBeGreaterThanOrEqual(1);
      expect(dash.workforce?.total).toBe(1);
      expect(dash.workforce?.byStatus.ACTIVE).toBe(1);
      expect(Array.isArray(dash.budgets.approvedTotals)).toBe(true);
      const sections = dash.unavailable.map((u) => u.section);
      expect(sections).toEqual(
        expect.arrayContaining(['wallets', 'payroll', 'actualCosts', 'billing', 'quotations']),
      );
      expect(sections).not.toContain('workforce');
      expect(sections).not.toContain('projects');

      // Non-owner without a matching operation assignment is refused
      // (ownerA above succeeded via the COMPANY_OWNER exemption).
      await expect(s.getDashboard(actor(outsider), companyId)).rejects.toMatchObject({
        code: 'OPERATION_NOT_ASSIGNED',
      });
    },
  );
});
