import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { EmployeeService } from '../../src/modules/employee/service.js';
import { PrismaEmployeeUnitOfWork } from '../../src/modules/employee/repository.js';
import { makeAttendanceRepos } from '../../src/modules/attendance/repository.js';
import { AccessDeniedError } from '../../src/modules/access-control/errors.js';
import { resolveTestDbUrl } from './test-db-url.js';
import type { ScopeTarget } from '../../src/modules/access-control/service.js';

// Real-PostgreSQL verification of W4 site/project workforce lifecycle:
// suspend → exit → reinstate semantics, the append-only SiteWorkforceExit
// marker, supersededBy composite-FK safety, suspendUntil CHECK, exact-site
// punch eligibility, and sibling-scope preservation. Disposable target
// only — loopback erp_test enforced by resolveTestDbUrl.
const url = resolveTestDbUrl(process.env.TEST_DATABASE_URL);
const run = url === null ? it.skip : it;

let prisma: PrismaClient | undefined;
let pool: pg.Pool | undefined;
const ACTOR = { actorId: '00000000-0000-4000-8000-0000000000aa', actorType: 'USER' as const };

const authzFor = (opts: {
  companyWide?: boolean;
  scopes?: ReadonlySet<string>;
  flag?: boolean;
}) => ({
  assertPermission: async (_p: string, _k: string, t: ScopeTarget) => {
    const ok = opts.companyWide === true || opts.scopes?.has(t.scopeId) === true;
    if (!ok) throw new AccessDeniedError();
  },
  hasPermission: async (_p: string, _k: string, t: ScopeTarget) =>
    opts.companyWide === true || opts.scopes?.has(t.scopeId) === true,
  delegationEnabled: async () => opts.flag === true,
});

const svcFor = (authz: ReturnType<typeof authzFor>) => {
  if (prisma === undefined) throw new Error('unreachable');
  return new EmployeeService(new PrismaEmployeeUnitOfWork(prisma), authz);
};

beforeAll(async () => {
  if (url === null) return;
  pool = new pg.Pool({ connectionString: url });
  prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
});

afterAll(async () => {
  if (prisma !== undefined) await prisma.$disconnect();
  if (pool !== undefined) await pool.end();
});

describe('W4 workforce lifecycle (real PG)', () => {
  run('suspend → suspended-exit → blocked reinstate; marker + FK constraints', async () => {
    if (prisma === undefined) throw new Error('unreachable');
    const p = prisma;
    const tag = `WL${Date.now() % 1e6}`;
    const company = await p.company.create({ data: { code: `${tag}-A`, name: 'Co A' } });
    await p.principal.create({
      data: {
        id: ACTOR.actorId,
        loginId: `${tag.toLowerCase()}-actor@wl.test`,
        loginIdType: 'EMAIL',
        type: 'USER',
        status: 'ACTIVE',
        passwordHash: 'fixture',
      },
    });
    try {
      const ho = await p.headOffice.create({
        data: { companyId: company.id, code: 'HO', name: 'HO', isPrimary: true },
      });
      const proj = await p.project.create({
        data: {
          companyId: company.id,
          headOfficeId: ho.id,
          code: 'P',
          name: 'P',
          timezone: 'Asia/Kolkata',
        },
      });
      const siteA = await p.site.create({
        data: { companyId: company.id, projectId: proj.id, code: 'SA', name: 'SA' },
      });
      const siteB = await p.site.create({
        data: { companyId: company.id, projectId: proj.id, code: 'SB', name: 'SB' },
      });
      const deptA = await p.department.create({
        data: {
          companyId: company.id,
          scopeType: 'SITE',
          siteId: siteA.id,
          code: 'DA',
          name: 'DA',
          status: 'ACTIVE',
        },
      });
      const deptB = await p.department.create({
        data: {
          companyId: company.id,
          scopeType: 'SITE',
          siteId: siteB.id,
          code: 'DB',
          name: 'DB',
          status: 'ACTIVE',
        },
      });
      const worker = await p.employee.create({
        data: {
          companyId: company.id,
          employeeCode: 'W1',
          displayName: 'Worker',
          status: 'ACTIVE',
        },
      });
      const mSiteA = await p.departmentMembership.create({
        data: {
          companyId: company.id,
          employeeId: worker.id,
          departmentId: deptA.id,
          isPrimary: true,
          startedAt: new Date(),
        },
      });
      const mSiteB = await p.departmentMembership.create({
        data: {
          companyId: company.id,
          employeeId: worker.id,
          departmentId: deptB.id,
          isPrimary: false,
          startedAt: new Date(),
        },
      });

      const pi = svcFor(authzFor({ scopes: new Set([proj.id, siteA.id, siteB.id]), flag: true }));
      const siteAScope = { scopeType: 'SITE' as const, scopeId: siteA.id };

      // --- hasActiveAtSite before suspension --------------------------------
      const before = await p.$transaction((tx) =>
        makeAttendanceRepos(tx).memberships.hasActiveAtSite(company.id, worker.id, siteA.id),
      );
      expect(before).toBe(true);

      // --- Suspend at site A: ends only site-A rows -------------------------
      const sus = await pi.suspendWorkforce(ACTOR, company.id, siteAScope, worker.id, {
        reason: 'Safety hold',
        expectedReturnDate: new Date('2026-02-01'),
      });
      expect(sus.ended).toHaveLength(1);
      const afterSus = await p.departmentMembership.findUnique({ where: { id: mSiteA.id } });
      expect(afterSus?.endReason).toBe('SUSPENDED');
      expect(afterSus?.suspendUntil?.toISOString().slice(0, 10)).toBe('2026-02-01');
      // Sibling site B row untouched — punch still eligible there.
      const bAfter = await p.departmentMembership.findUnique({ where: { id: mSiteB.id } });
      expect(bAfter?.endedAt).toBeNull();
      const atSiteA = await p.$transaction((tx) =>
        makeAttendanceRepos(tx).memberships.hasActiveAtSite(company.id, worker.id, siteA.id),
      );
      const atSiteB = await p.$transaction((tx) =>
        makeAttendanceRepos(tx).memberships.hasActiveAtSite(company.id, worker.id, siteB.id),
      );
      expect(atSiteA).toBe(false); // suspended → cannot punch at site A
      expect(atSiteB).toBe(true); // active membership at site B still works

      // --- Suspend CHECK: suspendUntil on a non-SUSPENDED row is rejected ---
      await expect(
        p.$executeRaw`UPDATE "DepartmentMembership" SET "suspendUntil" = '2026-03-01' WHERE "id" = ${mSiteB.id}::uuid`,
      ).rejects.toThrow();

      // --- Exit while suspended: SUSPENDED rows preserved + marker ----------
      const ex = await pi.exitWorkforce(ACTOR, company.id, siteAScope, worker.id, {
        reason: 'Episode over',
      });
      expect(ex.ended).toHaveLength(0);
      const preserved = await p.departmentMembership.findUnique({ where: { id: mSiteA.id } });
      expect(preserved?.endReason).toBe('SUSPENDED'); // history never rewritten
      const marker = await p.siteWorkforceExit.findFirst({
        where: { companyId: company.id, employeeId: worker.id, siteId: siteA.id },
      });
      expect(marker).not.toBeNull();

      // --- Reinstatement of the exited episode is blocked --------------------
      await expect(
        pi.reinstateWorkforce(ACTOR, company.id, siteAScope, worker.id, {}),
      ).rejects.toMatchObject({ code: 'ALREADY_EXITED' });

      // --- Repeat exit → deliberate conflict --------------------------------
      await expect(
        pi.exitWorkforce(ACTOR, company.id, siteAScope, worker.id, { reason: 'again' }),
      ).rejects.toMatchObject({ code: 'ALREADY_EXITED' });

      // --- Fresh placement IS still possible (marker is not a hiring ban) ----
      const fresh = await p.departmentMembership.create({
        data: {
          companyId: company.id,
          employeeId: worker.id,
          departmentId: deptA.id,
          isPrimary: false,
          startedAt: new Date(),
        },
      });
      const atSiteAAfter = await p.$transaction((tx) =>
        makeAttendanceRepos(tx).memberships.hasActiveAtSite(company.id, worker.id, siteA.id),
      );
      expect(atSiteAAfter).toBe(true);
      await p.departmentMembership.delete({ where: { id: fresh.id } });

      // --- supersededBy FK: a replacement must share employee + company -----
      const suspendedRow = await p.departmentMembership.findUniqueOrThrow({
        where: { id: mSiteA.id },
      });
      const otherEmp = await p.employee.create({
        data: {
          companyId: company.id,
          employeeCode: 'W2',
          displayName: 'Other',
          status: 'ACTIVE',
        },
      });
      const otherM = await p.departmentMembership.create({
        data: {
          companyId: company.id,
          employeeId: otherEmp.id,
          departmentId: deptA.id,
          isPrimary: false,
          startedAt: new Date(),
        },
      });
      // Pointing the suspended row at ANOTHER employee's membership violates
      // the composite FK → raw FK error, never a silent cross-employee link.
      await expect(
        p.departmentMembership.update({
          where: { id: suspendedRow.id },
          data: { supersededBy: otherM.id },
        }),
      ).rejects.toThrow();

      // --- Reinstatement of an exited-scope worker at the project level -----
      // Site-B row was never suspended — project reinstate finds nothing.
      await expect(
        pi.reinstateWorkforce(
          ACTOR,
          company.id,
          { scopeType: 'PROJECT', scopeId: proj.id },
          worker.id,
          {},
        ),
      ).rejects.toMatchObject({ code: 'ALREADY_EXITED' });
    } finally {
      // Cleanup via deleteMany in FK-safe order — test data only.
      await p.auditLog.deleteMany({ where: { companyId: company.id } });
      await p.outboxEvent.deleteMany({ where: { companyId: company.id } });
      await p.siteWorkforceExit.deleteMany({ where: { companyId: company.id } });
      await p.departmentMembership.deleteMany({ where: { companyId: company.id } });
      await p.department.deleteMany({ where: { companyId: company.id } });
      await p.site.deleteMany({ where: { companyId: company.id } });
      await p.project.deleteMany({ where: { companyId: company.id } });
      await p.employee.deleteMany({ where: { companyId: company.id } });
      await p.headOffice.deleteMany({ where: { companyId: company.id } });
      await p.company.delete({ where: { id: company.id } });
      await p.principal.delete({ where: { id: ACTOR.actorId } });
    }
  });

  run('project suspend covers child sites; reinstate creates superseded new rows', async () => {
    if (prisma === undefined) throw new Error('unreachable');
    const p = prisma;
    const tag = `WR${Date.now() % 1e6}`;
    const company = await p.company.create({ data: { code: `${tag}-B`, name: 'Co B' } });
    try {
      const ho = await p.headOffice.create({
        data: { companyId: company.id, code: 'HO', name: 'HO', isPrimary: true },
      });
      const proj = await p.project.create({
        data: {
          companyId: company.id,
          headOfficeId: ho.id,
          code: 'P',
          name: 'P',
          timezone: 'Asia/Kolkata',
        },
      });
      const siteA = await p.site.create({
        data: { companyId: company.id, projectId: proj.id, code: 'SA', name: 'SA' },
      });
      const deptProj = await p.department.create({
        data: {
          companyId: company.id,
          scopeType: 'PROJECT',
          projectId: proj.id,
          code: 'DP',
          name: 'DP',
          status: 'ACTIVE',
        },
      });
      const deptSite = await p.department.create({
        data: {
          companyId: company.id,
          scopeType: 'SITE',
          siteId: siteA.id,
          code: 'DS',
          name: 'DS',
          status: 'ACTIVE',
        },
      });
      const worker = await p.employee.create({
        data: {
          companyId: company.id,
          employeeCode: 'W1',
          displayName: 'Worker',
          status: 'ACTIVE',
        },
      });
      await p.departmentMembership.create({
        data: {
          companyId: company.id,
          employeeId: worker.id,
          departmentId: deptProj.id,
          isPrimary: true,
          startedAt: new Date(),
        },
      });
      await p.departmentMembership.create({
        data: {
          companyId: company.id,
          employeeId: worker.id,
          departmentId: deptSite.id,
          isPrimary: false,
          startedAt: new Date(),
        },
      });

      const pi = svcFor(authzFor({ scopes: new Set([proj.id, siteA.id]), flag: true }));
      const projScope = { scopeType: 'PROJECT' as const, scopeId: proj.id };

      // Project action covers BOTH project depts and child-site depts.
      const sus = await pi.suspendWorkforce(ACTOR, company.id, projScope, worker.id, {
        reason: 'hold',
      });
      expect(sus.ended).toHaveLength(2);
      expect(
        (await p.departmentMembership.count({
          where: { companyId: company.id, employeeId: worker.id, endReason: 'SUSPENDED' },
        })) === 2,
      ).toBe(true);

      // Reinstate restores the whole set atomically with supersession links.
      const re = await pi.reinstateWorkforce(ACTOR, company.id, projScope, worker.id, {});
      expect(re.restored).toHaveLength(2);
      const primaries = re.restored.filter((r) => r.isPrimary);
      expect(primaries).toHaveLength(1);
      const oldRows = await p.departmentMembership.findMany({
        where: { companyId: company.id, employeeId: worker.id, endReason: 'SUSPENDED' },
      });
      expect(oldRows.every((r) => r.supersededBy !== null)).toBe(true);
      const newRows = await p.departmentMembership.findMany({
        where: { companyId: company.id, employeeId: worker.id, endedAt: null },
      });
      expect(newRows).toHaveLength(2);
      // The linked supersession points at the new rows (same employee+company
      // enforced by the composite FK — a mismatch is impossible to write).
      for (const old of oldRows) {
        expect(newRows.some((n) => n.id === old.supersededBy)).toBe(true);
      }
    } finally {
      await p.auditLog.deleteMany({ where: { companyId: company.id } });
      await p.outboxEvent.deleteMany({ where: { companyId: company.id } });
      await p.siteWorkforceExit.deleteMany({ where: { companyId: company.id } });
      await p.departmentMembership.deleteMany({ where: { companyId: company.id } });
      await p.department.deleteMany({ where: { companyId: company.id } });
      await p.site.deleteMany({ where: { companyId: company.id } });
      await p.project.deleteMany({ where: { companyId: company.id } });
      await p.employee.deleteMany({ where: { companyId: company.id } });
      await p.headOffice.deleteMany({ where: { companyId: company.id } });
      await p.company.delete({ where: { id: company.id } });
    }
  });
});
