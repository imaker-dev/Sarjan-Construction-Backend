import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { AuditService, recordCompanyAuditLog } from '../../src/modules/audit/service.js';
import { resolveTestDbUrl } from './test-db-url.js';
import type { ActorContext } from '../../src/modules/organization/types.js';

// Real-PostgreSQL verification of the project/site activity feed — disposable
// target only (loopback / erp_test, enforced by resolveTestDbUrl).
const url = resolveTestDbUrl(process.env.TEST_DATABASE_URL);
const run = url === null ? it.skip : it;

const ACTOR: ActorContext = { actorId: '00000000-0000-4000-8000-0000000000aa', actorType: 'USER' };
const AUTHORIZER = { assertPermission: async () => undefined };

let prisma: PrismaClient;
let pool: pg.Pool;
let svc: AuditService;

const IDS = {
  company: '',
  otherCompany: '',
  projectA: '',
  projectB: '',
  site1: '',
  siteB: '',
  deptSite1: '',
  deptProjB: '',
  membership: '',
  roleAssignment: '',
};

async function cleanup() {
  if (IDS.company === '') return;
  for (const cid of [IDS.company, IDS.otherCompany]) {
    if (cid === '') continue;
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
  }
  await prisma.principal.deleteMany({ where: { loginId: 'sa-fixture@sa.test' } });
}

const addLog = (
  entityType: string,
  entityId: string,
  companyId: string = IDS.company,
  extra: {
    action?: string;
    changedFields?: Record<string, { before: unknown; after: unknown }>;
  } = {},
) =>
  recordCompanyAuditLog(prisma, {
    companyId,
    actor: ACTOR,
    action: extra.action ?? `${entityType}_CHANGED`,
    entityType,
    entityId,
    ...(extra.changedFields !== undefined ? { changedFields: extra.changedFields } : {}),
  });

beforeAll(async () => {
  if (url === null) return;
  pool = new pg.Pool({ connectionString: url });
  prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  svc = new AuditService(prisma, AUTHORIZER);

  const company = await prisma.company.create({ data: { code: 'SA-T1', name: 'SA Test Co' } });
  const other = await prisma.company.create({ data: { code: 'SA-T2', name: 'SA Other Co' } });
  IDS.company = company.id;
  IDS.otherCompany = other.id;
  const ho = await prisma.headOffice.create({
    data: { companyId: company.id, code: 'HO1', name: 'Main HO', isPrimary: true },
  });
  const projectA = await prisma.project.create({
    data: {
      companyId: company.id,
      headOfficeId: ho.id,
      code: 'PA',
      name: 'A',
      timezone: 'Asia/Kolkata',
    },
  });
  const projectB = await prisma.project.create({
    data: {
      companyId: company.id,
      headOfficeId: ho.id,
      code: 'PB',
      name: 'B',
      timezone: 'Asia/Kolkata',
    },
  });
  const site1 = await prisma.site.create({
    data: { companyId: company.id, projectId: projectA.id, code: 'S1', name: 'S1' },
  });
  const siteB = await prisma.site.create({
    data: { companyId: company.id, projectId: projectB.id, code: 'SB', name: 'SB' },
  });
  IDS.projectA = projectA.id;
  IDS.projectB = projectB.id;
  IDS.site1 = site1.id;
  IDS.siteB = siteB.id;

  IDS.deptSite1 = (
    await prisma.department.create({
      data: {
        companyId: company.id,
        scopeType: 'SITE',
        siteId: site1.id,
        code: 'DS1',
        name: 'DS1',
      },
    })
  ).id;
  IDS.deptProjB = (
    await prisma.department.create({
      data: {
        companyId: company.id,
        scopeType: 'PROJECT',
        projectId: projectB.id,
        code: 'DPB',
        name: 'DPB',
      },
    })
  ).id;

  const principal = await prisma.principal.create({
    data: {
      loginId: 'sa-fixture@sa.test',
      loginIdType: 'EMAIL',
      type: 'USER',
      status: 'ACTIVE',
      passwordHash: 'fixture',
    },
  });
  const employee = await prisma.employee.create({
    data: {
      companyId: company.id,
      principalId: principal.id,
      employeeCode: 'E-SA',
      displayName: 'SA Emp',
    },
  });
  IDS.membership = (
    await prisma.departmentMembership.create({
      data: { companyId: company.id, employeeId: employee.id, departmentId: IDS.deptSite1 },
    })
  ).id;
  const role = await prisma.role.create({
    data: { companyId: company.id, key: 'PD-SA', name: 'PD SA' },
  });
  IDS.roleAssignment = (
    await prisma.roleAssignment.create({
      data: {
        principalId: principal.id,
        roleId: role.id,
        companyId: company.id,
        scopeType: 'PROJECT',
        projectId: projectA.id,
      },
    })
  ).id;
});

afterAll(async () => {
  if (url === null) return;
  await cleanup();
  await prisma.$disconnect();
  await pool.end();
});

describe('scoped activity feed (erp_test)', () => {
  run(
    'project feed: project + child-site rows in; sibling/company/security/unresolvable out',
    async () => {
      await addLog('PROJECT', IDS.projectA);
      await addLog('SITE', IDS.site1);
      await addLog('DEPARTMENT', IDS.deptSite1);
      await addLog('DEPARTMENT_MEMBERSHIP', IDS.membership);
      await addLog('ROLE_ASSIGNMENT', IDS.roleAssignment);
      await addLog('SITE', IDS.siteB); // sibling project's site
      await addLog('DEPARTMENT', IDS.deptProjB); // sibling dept
      await addLog('COMPANY', IDS.company);
      await addLog('PRINCIPAL', '00000000-0000-4000-8000-0000000000aa');
      await addLog('UNMAPPED_TYPE', IDS.site1); // no resolver → fail closed
      await addLog('SITE', IDS.site1, IDS.otherCompany); // other company's row

      const res = await svc.listScopedActivity(
        ACTOR,
        IDS.company,
        { scopeType: 'PROJECT', scopeId: IDS.projectA },
        {},
      );
      const types = res.items.map((i) => i.entityType).sort();
      expect(types).toEqual(
        ['DEPARTMENT', 'DEPARTMENT_MEMBERSHIP', 'PROJECT', 'ROLE_ASSIGNMENT', 'SITE'].sort(),
      );
      expect(res.items.every((i) => i.scope.projectId === IDS.projectA)).toBe(true);
    },
  );

  run('site feed: only that site; project-scope rows excluded', async () => {
    const res = await svc.listScopedActivity(
      ACTOR,
      IDS.company,
      { scopeType: 'SITE', scopeId: IDS.site1 },
      {},
    );
    const types = res.items.map((i) => i.entityType).sort();
    expect(types).toEqual(['DEPARTMENT', 'DEPARTMENT_MEMBERSHIP', 'SITE'].sort());
    expect(res.items.every((i) => i.scope.siteId === IDS.site1)).toBe(true);
  });

  run('cross-company and missing scope ids → not found', async () => {
    const other = await prisma.project.create({
      data: {
        companyId: IDS.otherCompany,
        headOfficeId: (
          await prisma.headOffice.create({
            data: { companyId: IDS.otherCompany, code: 'HO2', name: 'HO2', isPrimary: true },
          })
        ).id,
        code: 'PO',
        name: 'Other',
        timezone: 'Asia/Kolkata',
      },
    });
    await expect(
      svc.listScopedActivity(ACTOR, IDS.company, { scopeType: 'PROJECT', scopeId: other.id }, {}),
    ).rejects.toThrow();
    await expect(
      svc.listScopedActivity(
        ACTOR,
        IDS.company,
        { scopeType: 'SITE', scopeId: '00000000-0000-4000-8000-0000000000ee' },
        {},
      ),
    ).rejects.toThrow();
  });

  run('keyset cursor walks all matching rows without duplication', async () => {
    const before = await svc.listScopedActivity(
      ACTOR,
      IDS.company,
      { scopeType: 'SITE', scopeId: IDS.site1 },
      {},
    );
    for (let i = 0; i < 4; i++) {
      await addLog('SITE', IDS.site1, IDS.company, { action: `PAGINATED_${i}` });
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 12; page++) {
      const res = await svc.listScopedActivity(
        ACTOR,
        IDS.company,
        { scopeType: 'SITE', scopeId: IDS.site1 },
        { limit: 2, ...(cursor !== undefined ? { cursor } : {}) },
      );
      seen.push(...res.items.map((i) => i.id));
      if (res.nextCursor === null) break;
      cursor = res.nextCursor;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBe(before.items.length + 4);
  });

  run('sensitive changedFields are redacted; metadata never returned', async () => {
    await addLog('SITE', IDS.site1, IDS.company, {
      action: 'SECRET_TOUCH',
      changedFields: {
        name: { before: 'a', after: 'b' },
        accessToken: { before: 'x', after: 'y' },
        bankIfsc: { before: 'i1', after: 'i2' },
      },
    });
    const res = await svc.listScopedActivity(
      ACTOR,
      IDS.company,
      { scopeType: 'SITE', scopeId: IDS.site1 },
      { action: 'SECRET_TOUCH' },
    );
    expect(res.items).toHaveLength(1);
    const item = res.items[0];
    expect(item).toBeDefined();
    expect(item?.changedFields?.name).toEqual({ before: 'a', after: 'b' });
    expect(item?.changedFields?.accessToken).toEqual({ before: '[REDACTED]', after: '[REDACTED]' });
    expect(item?.changedFields?.bankIfsc).toEqual({ before: '[REDACTED]', after: '[REDACTED]' });
    expect(item).not.toHaveProperty('metadata');
    expect(item).not.toHaveProperty('loginId');
    expect(item?.actor).not.toHaveProperty('loginId');
  });
});
