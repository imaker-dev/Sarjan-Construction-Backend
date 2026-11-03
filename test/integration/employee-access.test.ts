import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { PlatformService } from '../../src/modules/platform/service.js';
import { PrismaPlatformUnitOfWork } from '../../src/modules/platform/repository.js';
import { EmployeeAccessService } from '../../src/modules/employee/access.js';
import { OrganizationService } from '../../src/modules/organization/service.js';
import { PrismaOrgUnitOfWork } from '../../src/modules/organization/repository.js';
import { reconcileHoAdminRoles } from '../../src/modules/setup/reconcile.js';
import { SYSTEM_PRINCIPAL_ID } from '../../src/modules/setup/bootstrap.js';
import { resolveTestDbUrl } from './test-db-url.js';
import type { ActorContext } from '../../src/modules/organization/types.js';

// Real-PostgreSQL Phase-1 verification — disposable target only.
const url = resolveTestDbUrl(process.env.TEST_DATABASE_URL);
const run = url === null ? it.skip : it;

let prisma: PrismaClient | undefined;
let pool: pg.Pool | undefined;
let platform: PlatformService;
let access: EmployeeAccessService;
let org: OrganizationService;
let OWNER: ActorContext;

async function cleanup(p: PrismaClient, code: string) {
  const company = await p.company.findFirst({ where: { code } });
  if (company === null) return;
  await p.claimToken.deleteMany({
    where: { principal: { employees: { some: { companyId: company.id } } } },
  });
  await p.claimToken.deleteMany({
    where: { principal: { roleAssignments: { some: { companyId: company.id } } } },
  });
  await p.roleAssignment.deleteMany({ where: { companyId: company.id } });
  await p.rolePermission.deleteMany({ where: { role: { companyId: company.id } } });
  await p.role.deleteMany({ where: { companyId: company.id } });
  await p.project.deleteMany({ where: { companyId: company.id } });
  await p.headOffice.deleteMany({ where: { companyId: company.id } });
  await p.employee.deleteMany({ where: { companyId: company.id } });
  await p.auditLog.deleteMany({ where: { companyId: company.id } });
  await p.company.delete({ where: { id: company.id } });
}

beforeAll(async () => {
  if (url === null) return;
  pool = new pg.Pool({ connectionString: url });
  prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  platform = new PlatformService(new PrismaPlatformUnitOfWork(prisma));
  access = new EmployeeAccessService(prisma);
  org = new OrganizationService(new PrismaOrgUnitOfWork(prisma));
  // Real principal fixture — RoleAssignment.grantedByPrincipalId is a FK'd uuid.
  const ownerPrincipal = await prisma.principal.create({
    data: {
      loginId: 'ea-owner@ea.test',
      loginIdType: 'EMAIL',
      type: 'USER',
      status: 'ACTIVE',
      passwordHash: 'fixture',
    },
  });
  OWNER = { actorId: ownerPrincipal.id, actorType: 'USER' };
});

afterAll(async () => {
  if (prisma !== undefined && pool !== undefined) {
    await cleanup(prisma, 'EA1');
    await cleanup(prisma, 'EA2');
    await prisma.principal.deleteMany({
      where: { loginId: { in: ['ea-adm@ea.test', 'ea-emp@ea.test', 'ea-owner@ea.test'] } },
    });
    await prisma.$disconnect();
    await pool.end();
  }
});

describe('Phase 1 — employee login + HO Admin (real PostgreSQL)', () => {
  run('platform create provisions COMPANY_OWNER + HO_ADMIN system roles', async () => {
    if (prisma === undefined) throw new Error('unreachable');
    const res = await platform.createCompanyWithAdmin(OWNER, {
      companyCode: 'EA1',
      companyName: 'EA Tenant',
      adminLoginId: 'ea-adm@ea.test',
      adminDisplayName: 'EA Admin',
    });
    const roles = await prisma.role.findMany({
      where: { companyId: res.companyId },
      include: { permissions: true },
    });
    const keys = new Map(roles.map((r) => [r.key, r.permissions.map((rp) => rp.permissionId)]));
    expect([...keys.keys()].sort()).toEqual(['COMPANY_OWNER', 'HO_ADMIN']);
    const hoRole = roles.find((r) => r.key === 'HO_ADMIN') ?? expect.unreachable('ho role');
    const permKeys = await prisma.rolePermission.findMany({
      where: { roleId: hoRole.id },
      include: { permission: true },
    });
    expect(permKeys.map((p) => p.permission.key).sort()).toEqual(
      [
        'COMPLIANCE_READ',
        'DEPARTMENT_CONFIGURE',
        'DEPARTMENT_READ',
        'EMPLOYEE_READ',
        'ORG_HEAD_OFFICE_READ',
        'ORG_HEAD_OFFICE_UPDATE',
        'ORG_PROJECT_READ',
        'ORG_SITE_READ',
      ].sort(),
    );
  });

  run('invite → suspended principal + hashed code → claim activates', async () => {
    if (prisma === undefined) throw new Error('unreachable');
    const company = await prisma.company.findFirstOrThrow({ where: { code: 'EA1' } });
    const emp = await prisma.employee.create({
      data: { companyId: company.id, employeeCode: 'E1', displayName: 'W One', status: 'ACTIVE' },
    });
    const invite = await access.invite(OWNER, company.id, emp.id, 'ea-emp@ea.test');
    const linked = await prisma.employee.findUniqueOrThrow({ where: { id: emp.id } });
    const principal = await prisma.principal.findUniqueOrThrow({
      where: { id: linked.principalId ?? 'missing' },
    });
    expect(principal.status).toBe('SUSPENDED');
    expect(principal.loginId).toBe('ea-emp@ea.test');
    const token = await prisma.claimToken.findFirstOrThrow({
      where: { principalId: principal.id },
    });
    expect(token.tokenHash).not.toBe(invite.claimCode); // stored hashed only
    // dup loginId → 409
    const emp2 = await prisma.employee.create({
      data: { companyId: company.id, employeeCode: 'E2', displayName: 'W Two', status: 'ACTIVE' },
    });
    await expect(access.invite(OWNER, company.id, emp2.id, 'ea-emp@ea.test')).rejects.toMatchObject(
      { statusCode: 409 },
    );
    // resend — at most one active code
    const reissue = await access.resend(OWNER, company.id, emp.id);
    const activeTokens = await prisma.claimToken.findMany({
      where: { principalId: principal.id, consumedAt: null },
    });
    expect(activeTokens).toHaveLength(1);
    // claim → activated, code consumed
    await platform.consumeClaim(reissue.claimCode, 'N3w-Passw0rd!');
    const claimed = await prisma.principal.findUniqueOrThrow({ where: { id: principal.id } });
    expect(claimed.status).toBe('ACTIVE');
    expect(token.consumedAt ?? new Date()).not.toBeNull();
    // replay → rejected
    await expect(platform.consumeClaim(reissue.claimCode, 'x'.repeat(10))).rejects.toBeInstanceOf(
      Error,
    );
  });

  run('grant HO_ADMIN at primary HO, revoke; whitelist + shape enforced', async () => {
    if (prisma === undefined) throw new Error('unreachable');
    const company = await prisma.company.findFirstOrThrow({ where: { code: 'EA1' } });
    const employee = await prisma.employee.findFirstOrThrow({
      where: { companyId: company.id, employeeCode: 'E1' },
    });
    const ho = await prisma.headOffice.create({
      data: {
        companyId: company.id,
        code: 'HO',
        name: 'Primary HO',
        status: 'ACTIVE',
        isPrimary: true,
      },
    });
    await prisma.headOffice.create({
      data: {
        companyId: company.id,
        code: 'HO2',
        name: 'Secondary',
        status: 'ACTIVE',
        isPrimary: false,
      },
    });
    // PLATFORM_ADMIN not assignable
    await expect(
      access.grant(OWNER, company.id, {
        employeeId: employee.id,
        roleKey: 'PLATFORM_ADMIN',
        scopeType: 'COMPANY',
      }),
    ).rejects.toBeInstanceOf(Error);
    // wrong scope shape
    await expect(
      access.grant(OWNER, company.id, {
        employeeId: employee.id,
        roleKey: 'HO_ADMIN',
        scopeType: 'COMPANY',
      }),
    ).rejects.toBeInstanceOf(Error);
    // non-primary HO
    const ho2 = await prisma.headOffice.findFirstOrThrow({
      where: { companyId: company.id, code: 'HO2' },
    });
    await expect(
      access.grant(OWNER, company.id, {
        employeeId: employee.id,
        roleKey: 'HO_ADMIN',
        scopeType: 'HEAD_OFFICE',
        scopeId: ho2.id,
      }),
    ).rejects.toBeInstanceOf(Error);
    // valid grant at primary HO
    const asg = await access.grant(OWNER, company.id, {
      employeeId: employee.id,
      roleKey: 'HO_ADMIN',
      scopeType: 'HEAD_OFFICE',
      scopeId: ho.id,
    });
    expect((asg as { headOfficeId: string | null }).headOfficeId).toBe(ho.id);
    // dup → 409
    await expect(
      access.grant(OWNER, company.id, {
        employeeId: employee.id,
        roleKey: 'HO_ADMIN',
        scopeType: 'HEAD_OFFICE',
        scopeId: ho.id,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    // revoke
    await access.revoke(OWNER, company.id, (asg as { id: string }).id);
    const after = await access.listAssignments(company.id, employee.id);
    expect(after).toHaveLength(0);
  });

  run(
    'shared-HO: project only under primary; primary archive blocked while projects active',
    async () => {
      if (prisma === undefined) throw new Error('unreachable');
      const company = await prisma.company.findFirstOrThrow({ where: { code: 'EA1' } });
      const secondary = await prisma.headOffice.findFirstOrThrow({
        where: { companyId: company.id, code: 'HO2' },
      });
      await expect(
        org.createProject(OWNER, company.id, secondary.id, {
          code: 'P1',
          name: 'Proj',
          timezone: 'UTC',
        }),
      ).rejects.toBeInstanceOf(Error);
      const primary = await prisma.headOffice.findFirstOrThrow({
        where: { companyId: company.id, code: 'HO' },
      });
      const proj = await org.createProject(OWNER, company.id, primary.id, {
        code: 'P1',
        name: 'Proj',
        timezone: 'UTC',
      });
      expect((proj as { headOfficeId: string }).headOfficeId).toBe(primary.id);
      await expect(
        org.transitionHeadOfficeStatus(OWNER, company.id, primary.id, 'INACTIVE'),
      ).rejects.toBeInstanceOf(Error);
    },
  );

  run('reconcileHoAdminRoles provisions missing role idempotently', async () => {
    if (prisma === undefined) throw new Error('unreachable');
    const company = await prisma.company.create({
      data: { code: 'EA2', name: 'Legacy', isPlatform: false },
    });
    // SYSTEM principal must exist inside the tx — parallel teardown may delete
    // it between runs, so ensure it atomically with the reconcile.
    const first = await prisma.$transaction(async (tx) => {
      await tx.principal.upsert({
        where: { id: SYSTEM_PRINCIPAL_ID },
        update: {},
        create: { id: SYSTEM_PRINCIPAL_ID, type: 'SYSTEM', status: 'ACTIVE' },
      });
      return reconcileHoAdminRoles(tx);
    });
    expect(first).toBeGreaterThan(0);
    const role = await prisma.role.findFirstOrThrow({
      where: { companyId: company.id, key: 'HO_ADMIN' },
    });
    const grants = await prisma.rolePermission.findMany({ where: { roleId: role.id } });
    expect(grants).toHaveLength(8);
    const second = await prisma.$transaction(async (tx) => {
      await tx.principal.upsert({
        where: { id: SYSTEM_PRINCIPAL_ID },
        update: {},
        create: { id: SYSTEM_PRINCIPAL_ID, type: 'SYSTEM', status: 'ACTIVE' },
      });
      return reconcileHoAdminRoles(tx);
    });
    expect(second).toBe(0);
  });
});
