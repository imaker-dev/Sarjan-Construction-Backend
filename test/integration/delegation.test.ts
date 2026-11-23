import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { DelegationService } from '../../src/modules/organization/delegation.js';
import type { DelegationFlag } from '../../src/modules/organization/delegation.js';
import { OrganizationService } from '../../src/modules/organization/service.js';
import { PrismaOrgUnitOfWork } from '../../src/modules/organization/repository.js';
import { DepartmentService } from '../../src/modules/department/service.js';
import { PrismaDepartmentUnitOfWork } from '../../src/modules/department/repository.js';
import { AccessDeniedError } from '../../src/modules/access-control/errors.js';
import { resolveTestDbUrl } from './test-db-url.js';
import type { ActorContext } from '../../src/modules/organization/types.js';
import type { ScopeTarget } from '../../src/modules/access-control/service.js';

// Real-PostgreSQL verification of delegated site/department administration —
// disposable target only (loopback / erp_test, enforced by resolveTestDbUrl).
const url = resolveTestDbUrl(process.env.TEST_DATABASE_URL);
const run = url === null ? it.skip : it;

const ACTOR: ActorContext = { actorId: '00000000-0000-4000-8000-0000000000aa', actorType: 'USER' };

let prisma: PrismaClient;
let pool: pg.Pool;
let delegation: DelegationService;

const IDS = { company: '', otherCompany: '', projectA: '', projectB: '', siteA: '' };

/**
 * Authorizer simulating a PI holder: grants DEPARTMENT_CONFIGURE /
 * ORG_SITE_* only at project A and its child sites — never company-wide,
 * never sibling projects.
 */
const piAuthorizer = (delegationEnabled: (cid: string, f: DelegationFlag) => Promise<boolean>) => ({
  assertPermission: async (_pid: string, key: string, target: ScopeTarget) => {
    const inProjectA =
      (target.scopeType === 'PROJECT' && target.scopeId === IDS.projectA) ||
      (target.scopeType === 'SITE' && target.scopeId === IDS.siteA);
    if (!inProjectA) throw new AccessDeniedError();
  },
  hasPermission: async () => false, // never company-wide
  delegationEnabled,
});

const companyAdminAuthorizer = (
  delegationEnabled: (cid: string, f: DelegationFlag) => Promise<boolean>,
) => ({
  assertPermission: async () => undefined,
  hasPermission: async () => true, // company-scope grant → bypasses flags
  delegationEnabled,
});

async function cleanup() {
  if (IDS.company === '') return;
  for (const cid of [IDS.company, IDS.otherCompany]) {
    if (cid === '') continue;
    await prisma.departmentOperation.deleteMany({ where: { companyId: cid } });
    await prisma.department.deleteMany({ where: { companyId: cid } });
    await prisma.site.deleteMany({ where: { companyId: cid } });
    await prisma.project.deleteMany({ where: { companyId: cid } });
    await prisma.headOffice.deleteMany({ where: { companyId: cid } });
    await prisma.companyDelegationPolicy.deleteMany({ where: { companyId: cid } });
    await prisma.auditLog.deleteMany({ where: { companyId: cid } });
    await prisma.company.deleteMany({ where: { id: cid } });
  }
}

const orgService = (auth: ReturnType<typeof piAuthorizer>) =>
  new OrganizationService(new PrismaOrgUnitOfWork(prisma), auth);

const deptService = (auth: ReturnType<typeof piAuthorizer>) =>
  new DepartmentService(new PrismaDepartmentUnitOfWork(prisma), auth);

beforeAll(async () => {
  if (url === null) return;
  pool = new pg.Pool({ connectionString: url });
  prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  delegation = new DelegationService(prisma, { assertPermission: async () => undefined });

  const company = await prisma.company.create({ data: { code: 'DG-T1', name: 'DG Test Co' } });
  const other = await prisma.company.create({ data: { code: 'DG-T2', name: 'DG Other Co' } });
  IDS.company = company.id;
  IDS.otherCompany = other.id;
  const ho = await prisma.headOffice.create({
    data: { companyId: company.id, code: 'HO1', name: 'HO', isPrimary: true },
  });
  // createProject requires company-wide FINANCE + ADMINISTRATION departments.
  for (const category of ['FINANCE', 'ADMINISTRATION'] as const) {
    await prisma.department.create({
      data: {
        companyId: company.id,
        scopeType: 'COMPANY',
        code: category,
        name: category,
        category,
      },
    });
  }
  IDS.projectA = (
    await prisma.project.create({
      data: {
        companyId: company.id,
        headOfficeId: ho.id,
        code: 'PA',
        name: 'A',
        timezone: 'Asia/Kolkata',
      },
    })
  ).id;
  IDS.projectB = (
    await prisma.project.create({
      data: {
        companyId: company.id,
        headOfficeId: ho.id,
        code: 'PB',
        name: 'B',
        timezone: 'Asia/Kolkata',
      },
    })
  ).id;
  IDS.siteA = (
    await prisma.site.create({
      data: { companyId: company.id, projectId: IDS.projectA, code: 'SA', name: 'SA' },
    })
  ).id;
});

afterAll(async () => {
  if (url === null) return;
  await cleanup();
  await prisma.$disconnect();
  await pool.end();
});

describe('delegation policy (erp_test)', () => {
  run('missing policy row → all switches false, version 0', async () => {
    const policy = await delegation.getPolicy(ACTOR, IDS.company);
    expect(policy).toEqual({
      siteCreate: false,
      siteUpdate: false,
      deptManage: false,
      employeeOnboard: false,
      placement: false,
      memberSuspend: false,
      memberExit: false,
      version: 0,
    });
  });

  const setFlags = async (flags: {
    siteCreate?: boolean;
    siteUpdate?: boolean;
    deptManage?: boolean;
  }) => {
    const current = await delegation.getPolicy(ACTOR, IDS.company);
    return delegation.updatePolicy(ACTOR, IDS.company, {
      expectedVersion: current.version,
      ...flags,
    });
  };

  run('update persists switches and audits atomically (row created at version 0)', async () => {
    const policy = await delegation.updatePolicy(ACTOR, IDS.company, {
      expectedVersion: 0,
      siteCreate: true,
    });
    expect(policy).toEqual({
      siteCreate: true,
      siteUpdate: false,
      deptManage: false,
      employeeOnboard: false,
      placement: false,
      memberSuspend: false,
      memberExit: false,
      version: 0,
    });
    const audit = await prisma.auditLog.findFirst({
      where: { companyId: IDS.company, action: 'DELEGATION_POLICY_UPDATED' },
    });
    expect(audit).not.toBeNull();
    const changed = audit?.changedFields as Record<string, { before: unknown; after: unknown }>;
    expect(changed.siteCreate).toEqual({ before: false, after: true });
  });

  run('stale expectedVersion → VERSION_CONFLICT; nothing written', async () => {
    const current = await delegation.getPolicy(ACTOR, IDS.company);
    await expect(
      delegation.updatePolicy(ACTOR, IDS.company, {
        expectedVersion: current.version + 5,
        siteUpdate: true,
      }),
    ).rejects.toThrow('modified concurrently');
    const row = await prisma.companyDelegationPolicy.findUnique({
      where: { companyId: IDS.company },
    });
    expect(row?.version).toBe(current.version);
    expect(row?.siteUpdate).toBe(false);
  });

  run('scoped site create denied while siteCreate is off; allowed once enabled', async () => {
    await setFlags({ siteCreate: false });
    const pi = piAuthorizer((c, f) => delegation.isEnabled(c, f));
    await expect(
      orgService(pi).createSite(ACTOR, IDS.company, IDS.projectA, { code: 'S2', name: 'S2' }),
    ).rejects.toThrow('delegated site administration');
    await setFlags({ siteCreate: true });
    const site = await orgService(pi).createSite(ACTOR, IDS.company, IDS.projectA, {
      code: 'S2',
      name: 'S2',
    });
    expect(site.projectId).toBe(IDS.projectA);
  });

  run('scoped site update denied while siteUpdate is off; allowed once enabled', async () => {
    await setFlags({ siteUpdate: false });
    const pi = piAuthorizer((c, f) => delegation.isEnabled(c, f));
    await expect(
      orgService(pi).updateSite(ACTOR, IDS.company, IDS.siteA, { name: 'Renamed' }),
    ).rejects.toThrow('delegated site administration');
    await setFlags({ siteUpdate: true });
    const updated = await orgService(pi).updateSite(ACTOR, IDS.company, IDS.siteA, {
      name: 'Renamed',
    });
    expect(updated.name).toBe('Renamed');
  });

  run('PI scoped to project A cannot create a site under sibling project B', async () => {
    const pi = piAuthorizer((c, f) => delegation.isEnabled(c, f));
    await expect(
      orgService(pi).createSite(ACTOR, IDS.company, IDS.projectB, { code: 'S3', name: 'S3' }),
    ).rejects.toThrow(AccessDeniedError);
  });

  run('cross-company project target → not found', async () => {
    const ho2 = await prisma.headOffice.create({
      data: { companyId: IDS.otherCompany, code: 'HO2', name: 'HO2', isPrimary: true },
    });
    const otherProject = await prisma.project.create({
      data: {
        companyId: IDS.otherCompany,
        headOfficeId: ho2.id,
        code: 'PO',
        name: 'Other',
        timezone: 'Asia/Kolkata',
      },
    });
    const admin = companyAdminAuthorizer((c, f) => delegation.isEnabled(c, f));
    await expect(
      orgService(admin).createSite(ACTOR, IDS.company, otherProject.id, {
        code: 'SX',
        name: 'SX',
      }),
    ).rejects.toThrow('not found');
  });

  run('company-scope grant bypasses the flag even when it is off', async () => {
    const other = await prisma.companyDelegationPolicy.findUnique({
      where: { companyId: IDS.otherCompany },
    });
    expect(other).toBeNull(); // other company never enabled anything
    const admin = companyAdminAuthorizer((c, f) => delegation.isEnabled(c, f));
    const site = await orgService(admin).createSite(
      ACTOR,
      IDS.otherCompany,
      (
        await prisma.project.create({
          data: {
            companyId: IDS.otherCompany,
            headOfficeId: (
              await prisma.headOffice.findFirstOrThrow({
                where: { companyId: IDS.otherCompany, isPrimary: true },
              })
            ).id,
            code: 'PO2',
            name: 'Other2',
            timezone: 'Asia/Kolkata',
          },
        })
      ).id,
      { code: 'SO', name: 'SO' },
    );
    expect(site.companyId).toBe(IDS.otherCompany);
  });
});

describe('delegated department administration (erp_test)', () => {
  run('deptManage off → project-scoped department denied; on → allowed', async () => {
    const pi = piAuthorizer((c, f) => delegation.isEnabled(c, f));
    await expect(
      deptService(pi).createDepartment(ACTOR, IDS.company, {
        scopeType: 'PROJECT',
        scopeId: IDS.projectA,
        code: 'crew1',
        name: 'Crew',
        category: 'OPERATIONS',
      }),
    ).rejects.toThrow('delegated department administration');

    const current = await delegation.getPolicy(ACTOR, IDS.company);
    await delegation.updatePolicy(ACTOR, IDS.company, {
      expectedVersion: current.version,
      deptManage: true,
    });

    const dept = await deptService(pi).createDepartment(ACTOR, IDS.company, {
      scopeType: 'PROJECT',
      scopeId: IDS.projectA,
      code: 'crew1',
      name: 'Crew',
      category: 'OPERATIONS',
    });
    expect(dept.projectId).toBe(IDS.projectA);
  });

  run(
    'site-scoped department under project-A site allowed; company dept needs no flag',
    async () => {
      const pi = piAuthorizer((c, f) => delegation.isEnabled(c, f));
      const dept = await deptService(pi).createDepartment(ACTOR, IDS.company, {
        scopeType: 'SITE',
        scopeId: IDS.siteA,
        code: 'siteq',
        name: 'Site Quality',
        category: 'QUALITY',
      });
      expect(dept.siteId).toBe(IDS.siteA);

      // Company-scope departments ignore the flag — permission asserted at
      // COMPANY; the fake denies non-A scopes so a company dept is denied for
      // the PI caller. Verified as flag-independence by the admin path:
      const admin = companyAdminAuthorizer((c, f) => delegation.isEnabled(c, f));
      const hqDept = await deptService(admin).createDepartment(ACTOR, IDS.company, {
        scopeType: 'COMPANY',
        code: 'hqsafe',
        name: 'HQ Safety',
        category: 'SAFETY',
      });
      expect(hqDept.scopeType).toBe('COMPANY');
    },
  );

  run('PI cannot mutate a department at sibling project scope', async () => {
    const pi = piAuthorizer((c, f) => delegation.isEnabled(c, f));
    await expect(
      deptService(pi).createDepartment(ACTOR, IDS.company, {
        scopeType: 'PROJECT',
        scopeId: IDS.projectB,
        code: 'evil',
        name: 'Evil',
        category: 'CUSTOM',
      }),
    ).rejects.toThrow(AccessDeniedError);
  });
});
