import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { OperationAssignmentService } from '../../src/modules/operation/assignment.js';
import { resolveTestDbUrl } from './test-db-url.js';
import type { ActorContext } from '../../src/modules/organization/types.js';

// Real-PostgreSQL verification of the operation-access hardening — disposable
// target only (loopback :55432 / erp_test, enforced by resolveTestDbUrl).
const url = resolveTestDbUrl(process.env.TEST_DATABASE_URL);
const run = url === null ? it.skip : it;

const ACTOR: ActorContext = { actorId: '00000000-0000-4000-8000-0000000000aa', actorType: 'USER' };
const AUTHORIZER = { assertPermission: async () => undefined };

let prisma: PrismaClient;
let pool: pg.Pool;
let svc: OperationAssignmentService;

const IDS = {
  company: '',
  projectA: '',
  projectB: '',
  site1: '',
  deptProjA: '',
  deptSite1: '',
  deptProjB: '',
  deptCo: '',
  empLead: '',
  empMember: '',
  principalLead: '',
  principalMember: '',
  rolePd: '',
};

async function cleanup() {
  const cid = IDS.company;
  if (cid === '') return;
  await prisma.employeeOperation.deleteMany({ where: { companyId: cid } });
  await prisma.departmentOperation.deleteMany({ where: { companyId: cid } });
  await prisma.departmentMembership.deleteMany({ where: { companyId: cid } });
  await prisma.roleAssignment.deleteMany({ where: { companyId: cid } });
  await prisma.role.deleteMany({ where: { companyId: cid } });
  await prisma.department.deleteMany({ where: { companyId: cid } });
  await prisma.site.deleteMany({ where: { companyId: cid } });
  await prisma.project.deleteMany({ where: { companyId: cid } });
  await prisma.headOffice.deleteMany({ where: { companyId: cid } });
  await prisma.employee.deleteMany({ where: { companyId: cid } });
  await prisma.auditLog.deleteMany({ where: { companyId: cid } });
  await prisma.company.deleteMany({ where: { id: cid } });
  await prisma.principal.deleteMany({
    where: { id: { in: [IDS.principalLead, IDS.principalMember].filter((i) => i !== '') } },
  });
}

beforeAll(async () => {
  if (url === null) return;
  pool = new pg.Pool({ connectionString: url });
  prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  svc = new OperationAssignmentService(prisma, AUTHORIZER);

  const company = await prisma.company.create({
    data: { code: 'OH-T1', name: 'Op Hardening Test Co' },
  });
  IDS.company = company.id;
  const ho = await prisma.headOffice.create({
    data: { companyId: company.id, code: 'HO1', name: 'Main HO', isPrimary: true },
  });
  const projectA = await prisma.project.create({
    data: {
      companyId: company.id,
      headOfficeId: ho.id,
      code: 'PA',
      name: 'Project A',
      timezone: 'Asia/Kolkata',
    },
  });
  const projectB = await prisma.project.create({
    data: {
      companyId: company.id,
      headOfficeId: ho.id,
      code: 'PB',
      name: 'Project B',
      timezone: 'Asia/Kolkata',
    },
  });
  const site1 = await prisma.site.create({
    data: { companyId: company.id, projectId: projectA.id, code: 'S1', name: 'Site 1' },
  });
  IDS.projectA = projectA.id;
  IDS.projectB = projectB.id;
  IDS.site1 = site1.id;

  const mkDept = (data: {
    scopeType: 'COMPANY' | 'PROJECT' | 'SITE';
    code: string;
    projectId?: string;
    siteId?: string;
  }) =>
    prisma.department.create({
      data: {
        companyId: company.id,
        scopeType: data.scopeType,
        code: data.code,
        name: data.code,
        status: 'ACTIVE',
        ...(data.projectId !== undefined ? { projectId: data.projectId } : {}),
        ...(data.siteId !== undefined ? { siteId: data.siteId } : {}),
      },
    });
  IDS.deptProjA = (await mkDept({ scopeType: 'PROJECT', code: 'DPA', projectId: projectA.id })).id;
  IDS.deptSite1 = (await mkDept({ scopeType: 'SITE', code: 'DS1', siteId: site1.id })).id;
  IDS.deptProjB = (await mkDept({ scopeType: 'PROJECT', code: 'DPB', projectId: projectB.id })).id;
  IDS.deptCo = (await mkDept({ scopeType: 'COMPANY', code: 'DCO' })).id;

  const mkPrincipal = (loginId: string) =>
    prisma.principal.create({
      data: {
        loginId,
        loginIdType: 'EMAIL',
        type: 'USER',
        status: 'ACTIVE',
        passwordHash: 'fixture',
      },
    });
  IDS.principalLead = (await mkPrincipal('oh-lead@oh.test')).id;
  IDS.principalMember = (await mkPrincipal('oh-member@oh.test')).id;
  IDS.empLead = (
    await prisma.employee.create({
      data: {
        companyId: company.id,
        principalId: IDS.principalLead,
        employeeCode: 'E-LEAD',
        displayName: 'Lead Emp',
      },
    })
  ).id;
  IDS.empMember = (
    await prisma.employee.create({
      data: {
        companyId: company.id,
        principalId: IDS.principalMember,
        employeeCode: 'E-MEM',
        displayName: 'Member Emp',
      },
    })
  ).id;

  await prisma.departmentMembership.createMany({
    data: [
      { companyId: company.id, employeeId: IDS.empLead, departmentId: IDS.deptProjA },
      { companyId: company.id, employeeId: IDS.empMember, departmentId: IDS.deptProjA },
    ],
  });

  // Dept enablements. WORK_PROGRESS_SUBMIT + DAILY_SITE_REPORT_SUBMIT are
  // leadership-inheritable; PETTY_CASH_REQUEST_APPROVE is not, and is
  // COMPANY/HEAD_OFFICE-scoped — inserted directly to emulate a stale row
  // that predates the appliesTo rule.
  await prisma.departmentOperation.createMany({
    data: [
      {
        companyId: company.id,
        departmentId: IDS.deptProjA,
        operationKey: 'WORK_PROGRESS_SUBMIT',
      },
      {
        companyId: company.id,
        departmentId: IDS.deptProjA,
        operationKey: 'PETTY_CASH_REQUEST_APPROVE',
      },
      {
        companyId: company.id,
        departmentId: IDS.deptSite1,
        operationKey: 'DAILY_SITE_REPORT_SUBMIT',
      },
      // Sibling project — must never leak into proj-a coverage.
      {
        companyId: company.id,
        departmentId: IDS.deptProjB,
        operationKey: 'LABOUR_ATTENDANCE_MARK',
      },
    ],
  });

  IDS.rolePd = (
    await prisma.role.create({
      data: { companyId: company.id, key: 'PROJECT_DIRECTOR', name: 'Project Director' },
    })
  ).id;
  await prisma.roleAssignment.create({
    data: {
      principalId: IDS.principalLead,
      roleId: IDS.rolePd,
      companyId: company.id,
      scopeType: 'PROJECT',
      projectId: projectA.id,
    },
  });
});

afterAll(async () => {
  if (url === null) return;
  await cleanup();
  await prisma.$disconnect();
  await pool.end();
});

describe('operation hardening (erp_test)', () => {
  run('leadership coverage = inheritable ops on own project + child sites only', async () => {
    const keys = await svc.getLeadershipScopedOperationKeys(IDS.company, IDS.empLead);
    expect(keys).toContain('WORK_PROGRESS_SUBMIT'); // proj-a dept
    expect(keys).toContain('DAILY_SITE_REPORT_SUBMIT'); // child site s1
    expect(keys).not.toContain('LABOUR_ATTENDANCE_MARK'); // sibling proj-b
    expect(keys).not.toContain('PETTY_CASH_REQUEST_APPROVE'); // not inheritable
  });

  run('effective ops combine dept + role; membership end drops dept ops', async () => {
    const before = await svc.getEffectiveOperations(IDS.company, IDS.empMember);
    expect(before).toContain('WORK_PROGRESS_SUBMIT');
    expect(before).not.toContain('DAILY_SITE_REPORT_SUBMIT'); // not a site-dept member
    await prisma.departmentMembership.updateMany({
      where: { companyId: IDS.company, employeeId: IDS.empMember },
      data: { endedAt: new Date() },
    });
    const after = await svc.getEffectiveOperations(IDS.company, IDS.empMember);
    expect(after).not.toContain('WORK_PROGRESS_SUBMIT');
    // Restore for later tests.
    await prisma.departmentMembership.updateMany({
      where: { companyId: IDS.company, employeeId: IDS.empMember },
      data: { endedAt: null },
    });
  });

  run('direct grant allowed on enabled member dept, rejected elsewhere', async () => {
    const ok = await svc.assignEmployeeOperation(
      ACTOR,
      IDS.company,
      IDS.empMember,
      'WORK_PROGRESS_SUBMIT',
    );
    expect(ok?.status).toBe('ACTIVE');
    await expect(
      svc.assignEmployeeOperation(ACTOR, IDS.company, IDS.empMember, 'DAILY_SITE_REPORT_SUBMIT'),
    ).rejects.toThrow();
  });

  run('enabling a COMPANY/HO op on a PROJECT dept is rejected', async () => {
    await expect(
      svc.enableDeptOperation(ACTOR, IDS.company, IDS.deptProjA, 'PAYROLL_REVIEW'),
    ).rejects.toThrow();
  });

  run('project + site inspection with source attribution; cross-company fails', async () => {
    const proj = await svc.listEffectiveOperationsForScope(
      ACTOR,
      IDS.company,
      { scopeType: 'PROJECT', scopeId: IDS.projectA },
      {},
    );
    const keys = proj.items.map((i) => `${i.employeeId}|${i.operationKey}|${i.source}`);
    // empLead: dept member + PD role → dept row for WORK_PROGRESS_SUBMIT.
    expect(keys).toContain(`${IDS.empLead}|WORK_PROGRESS_SUBMIT|DEPARTMENT`);
    // empMember: explicit ACTIVE grant on dept-enabled op → DIRECT.
    expect(keys).toContain(`${IDS.empMember}|WORK_PROGRESS_SUBMIT|DIRECT`);
    // PD coverage on the site op (leadership-inheritable, site dept enabled).
    expect(keys).toContain(`${IDS.empLead}|DAILY_SITE_REPORT_SUBMIT|ROLE`);
    // Not inheritable → never appears for anyone.
    expect(keys.some((k) => k.includes('PETTY_CASH_REQUEST_APPROVE'))).toBe(false);
    expect(keys.some((k) => k.includes('LABOUR_ATTENDANCE_MARK'))).toBe(false);
    // Safe identity only — no contact fields on the items.
    const item = proj.items[0];
    expect(item).not.toHaveProperty('contactEmail');
    expect(item).not.toHaveProperty('contactPhone');

    const site = await svc.listEffectiveOperationsForScope(
      ACTOR,
      IDS.company,
      { scopeType: 'SITE', scopeId: IDS.site1 },
      {},
    );
    const siteKeys = site.items.map((i) => `${i.employeeId}|${i.operationKey}|${i.source}`);
    expect(siteKeys).toContain(`${IDS.empLead}|DAILY_SITE_REPORT_SUBMIT|ROLE`);
    expect(siteKeys.some((k) => k.includes('WORK_PROGRESS_SUBMIT'))).toBe(false);

    await expect(
      svc.listEffectiveOperationsForScope(
        ACTOR,
        IDS.company,
        { scopeType: 'SITE', scopeId: '00000000-0000-4000-8000-000000000099' },
        {},
      ),
    ).rejects.toThrow();
  });
});

// ── PI/PD field-operation catalogue + auto-enable (20261206000000) ────────────
describe('PI/PD operation catalogue + dept auto-enable (erp_test)', () => {
  const SPEC_KEYS = [
    'SITE_ATTENDANCE_VIEW',
    'SITE_ATTENDANCE_CORRECTION_APPROVE',
    'TASK_CREATE',
    'TASK_APPROVE',
    'MILESTONE_APPROVE',
    'EMPLOYEE_ONBOARD',
    'EMPLOYEE_SUSPEND',
    'SITE_LEAVE_APPROVE',
    'SELF_ATTENDANCE_PUNCH',
    'SITE_STOCK_ISSUE',
    'SITE_EXPENSE_REPORT_VIEW',
    'PROJECT_PROFIT_LOSS_SUMMARY_VIEW',
    'SITE_AUDIT_VIEW',
  ];

  run('spec keys exist — non-sensitive, leadership-inheritable, field-scoped', async () => {
    const rows = await prisma.operationCatalogueEntry.findMany({
      where: { key: { in: SPEC_KEYS } },
      select: { key: true, sensitive: true, leadershipInheritable: true, appliesTo: true },
    });
    expect(rows).toHaveLength(SPEC_KEYS.length);
    for (const r of rows) {
      expect(r.sensitive).toBe(false);
      expect(r.leadershipInheritable).toBe(true);
      expect(r.appliesTo).toContain('SITE');
      expect(r.appliesTo).toContain('PROJECT');
    }
  });

  run('finance-only row stays sensitive and company-scoped', async () => {
    const r = await prisma.operationCatalogueEntry.findUnique({
      where: { key: 'FINANCE_EMPLOYEE_SENSITIVE_READ' },
    });
    expect(r?.sensitive).toBe(true);
    expect(r?.leadershipInheritable).toBe(false);
    expect(r?.appliesTo).not.toContain('SITE');
    expect(r?.appliesTo).not.toContain('PROJECT');
  });

  run('spec-listed existing keys are now field-scope inheritable', async () => {
    const rows = await prisma.operationCatalogueEntry.findMany({
      where: {
        key: {
          in: [
            'PURCHASE_REQUEST_SUBMIT',
            'PROJECT_QUOTATION_REVISE',
            'PROJECT_QUOTATION_APPROVE',
            'PROJECT_WALLET_RECONCILE',
            'VENDOR_INVOICE_SUBMIT',
          ],
        },
      },
      select: { key: true, leadershipInheritable: true, appliesTo: true },
    });
    expect(rows).toHaveLength(5);
    for (const r of rows) {
      expect(r.leadershipInheritable).toBe(true);
      expect(r.appliesTo).toContain('SITE');
    }
  });

  run('createDepartment seeds the inheritable set on SITE depts; PD coverage flows', async () => {
    const { DepartmentService } = await import('../../src/modules/department/service.js');
    const { PrismaDepartmentUnitOfWork } =
      await import('../../src/modules/department/repository.js');
    const deptSvc = new DepartmentService(new PrismaDepartmentUnitOfWork(prisma), {
      assertPermission: async () => undefined,
      hasPermission: async () => true,
    });
    const dept = await deptSvc.createDepartment(ACTOR, IDS.company, {
      scopeType: 'SITE',
      scopeId: IDS.site1,
      code: 'SEED1',
      name: 'Seeded Ops Dept',
    });
    const enabled = await prisma.departmentOperation.findMany({
      where: { companyId: IDS.company, departmentId: dept.id },
      select: { operationKey: true },
    });
    const keys = enabled.map((e) => e.operationKey);
    // Spec ops seeded.
    for (const k of [
      'SITE_ATTENDANCE_VIEW',
      'TASK_CREATE',
      'EMPLOYEE_ONBOARD',
      'SITE_STOCK_ISSUE',
    ]) {
      expect(keys).toContain(k);
    }
    // Sensitive + non-inheritable ops never seeded.
    expect(keys).not.toContain('FINANCE_EMPLOYEE_SENSITIVE_READ');
    expect(keys).not.toContain('PETTY_CASH_REQUEST_APPROVE');
    expect(keys).not.toContain('SITE_CLOSE');
    // Coverage only flows through ACTIVE departments — new depts start DRAFT.
    await prisma.department.update({ where: { id: dept.id }, data: { status: 'ACTIVE' } });
    // PD@projectA covers the seeded ops via the site dept under the project.
    const leadership = await svc.getLeadershipScopedOperationKeys(IDS.company, IDS.empLead);
    expect(leadership).toContain('SITE_ATTENDANCE_VIEW');
    expect(leadership).toContain('TASK_CREATE');
    const effective = await svc.getEffectiveOperations(IDS.company, IDS.empLead);
    expect(effective).toContain('EMPLOYEE_ONBOARD');
  });

  run('COMPANY-scope departments get no seeded ops', async () => {
    const { DepartmentService } = await import('../../src/modules/department/service.js');
    const { PrismaDepartmentUnitOfWork } =
      await import('../../src/modules/department/repository.js');
    const deptSvc = new DepartmentService(new PrismaDepartmentUnitOfWork(prisma), {
      assertPermission: async () => undefined,
      hasPermission: async () => true,
    });
    const dept = await deptSvc.createDepartment(ACTOR, IDS.company, {
      scopeType: 'COMPANY',
      code: 'NOSEED',
      name: 'No Seed Dept',
    });
    const count = await prisma.departmentOperation.count({
      where: { companyId: IDS.company, departmentId: dept.id },
    });
    expect(count).toBe(0);
  });
});
