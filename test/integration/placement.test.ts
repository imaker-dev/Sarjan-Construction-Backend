import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { EmployeeService } from '../../src/modules/employee/service.js';
import { PrismaEmployeeUnitOfWork } from '../../src/modules/employee/repository.js';
import {
  ActiveMembershipExistsError,
  AmbiguousPrimaryError,
  OrgEntityNotFoundError,
  OrgValidationError,
  PrimaryOutOfScopeError,
  VersionConflictError,
} from '../../src/modules/organization/errors.js';
import { AppError, ConflictError, ForbiddenError } from '../../src/common/errors/app-error.js';
import { AccessDeniedError } from '../../src/modules/access-control/errors.js';
import { resolveTestDbUrl } from './test-db-url.js';
import type { ScopeTarget } from '../../src/modules/access-control/service.js';

// Real-PostgreSQL verification of delegated membership placement (M3/W2):
// atomic transfer, primary-boundary safety, unique-index conflict mapping,
// head clearing, and effective-time semantics. Disposable target only —
// loopback erp_test enforced by resolveTestDbUrl.
const url = resolveTestDbUrl(process.env.TEST_DATABASE_URL);
const run = url === null ? it.skip : it;

let prisma: PrismaClient | undefined;
let pool: pg.Pool | undefined;
const ACTOR = { actorId: '00000000-0000-4000-8000-0000000000aa', actorType: 'USER' as const };

// Mimics AccessControlService: a company-wide grant covers every scope via
// the scope chain; scoped grants match by id. Plus the placement flag.
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

describe('delegated membership placement (real PG)', () => {
  run('boundary, primary safety, atomic transfer, head clearing', async () => {
    if (prisma === undefined) throw new Error('unreachable');
    const p = prisma;
    const tag = `PL${Date.now() % 1e6}`;
    const company = await p.company.create({ data: { code: `${tag}-A`, name: 'Co A' } });
    const other = await p.company.create({ data: { code: `${tag}-B`, name: 'Co B' } });
    try {
      const ho = await p.headOffice.create({
        data: { companyId: company.id, code: 'HO', name: 'HO', isPrimary: true },
      });
      const projA = await p.project.create({
        data: {
          companyId: company.id,
          headOfficeId: ho.id,
          code: 'PA',
          name: 'A',
          timezone: 'Asia/Kolkata',
        },
      });
      const projB = await p.project.create({
        data: {
          companyId: company.id,
          headOfficeId: ho.id,
          code: 'PB',
          name: 'B',
          timezone: 'Asia/Kolkata',
        },
      });
      const siteA = await p.site.create({
        data: { companyId: company.id, projectId: projA.id, code: 'SA', name: 'SA' },
      });
      const mkDept = (data: {
        scopeType: 'COMPANY' | 'PROJECT' | 'SITE';
        code: string;
        projectId?: string;
        siteId?: string;
        headEmployeeId?: string;
        inCompany?: string;
      }) =>
        p.department.create({
          data: {
            companyId: data.inCompany ?? company.id,
            scopeType: data.scopeType,
            code: data.code,
            name: data.code,
            status: 'ACTIVE',
            ...(data.projectId !== undefined ? { projectId: data.projectId } : {}),
            ...(data.siteId !== undefined ? { siteId: data.siteId } : {}),
            ...(data.headEmployeeId !== undefined ? { headEmployeeId: data.headEmployeeId } : {}),
          },
        });
      const deptA = await mkDept({ scopeType: 'PROJECT', projectId: projA.id, code: 'DPA' });
      const deptB = await mkDept({ scopeType: 'PROJECT', projectId: projB.id, code: 'DPB' });
      const deptSite = await mkDept({ scopeType: 'SITE', siteId: siteA.id, code: 'DSA' });
      const deptCo = await mkDept({ scopeType: 'COMPANY', code: 'DCO' });

      const mkEmp = (code: string, inCompany = company.id) =>
        p.employee.create({
          data: {
            companyId: inCompany,
            employeeCode: code,
            displayName: `Name ${code}`,
            designation: 'Mason',
            tradeCategory: 'CIVIL',
            status: 'ACTIVE',
          },
        });
      const worker = await mkEmp('W1');
      const head = await mkEmp('WH');
      const otherEmp = await mkEmp('WO', other.id);

      // PI of project A (covers child site A via the scope chain); flag on.
      const pi = svcFor(authzFor({ scopes: new Set([projA.id, siteA.id]), flag: true }));

      // --- Flag off → DELEGATION_DISABLED -----------------------------------
      const noFlag = svcFor(authzFor({ scopes: new Set([projA.id, siteA.id]) }));
      await expect(
        noFlag.addScopedMember(ACTOR, company.id, deptA.id, { employeeId: worker.id }),
      ).rejects.toThrow(ForbiddenError);
      await expect(
        noFlag.addScopedMember(ACTOR, company.id, deptA.id, { employeeId: worker.id }),
      ).rejects.toMatchObject({ code: 'DELEGATION_DISABLED' });

      // --- Company/HO departments are never delegated ------------------------
      await expect(
        pi.addScopedMember(ACTOR, company.id, deptCo.id, { employeeId: worker.id }),
      ).rejects.toMatchObject({ code: 'DELEGATION_NEVER', statusCode: 403 });

      // --- Sibling project denied; cross-company rows not found --------------
      await expect(
        pi.addScopedMember(ACTOR, company.id, deptB.id, { employeeId: worker.id }),
      ).rejects.toThrow(AccessDeniedError);
      await expect(
        pi.addScopedMember(ACTOR, company.id, deptA.id, { employeeId: otherEmp.id }),
      ).rejects.toThrow(OrgEntityNotFoundError);

      // --- Add inside the boundary -------------------------------------------
      const first = await pi.addScopedMember(ACTOR, company.id, deptA.id, {
        employeeId: worker.id,
        isPrimary: true,
      });
      expect(first.isPrimary).toBe(true);
      expect(first.departmentId).toBe(deptA.id);

      // --- Duplicate active membership → deliberate 409 ----------------------
      await expect(
        pi.addScopedMember(ACTOR, company.id, deptA.id, { employeeId: worker.id }),
      ).rejects.toThrow(ActiveMembershipExistsError);

      // --- Second non-primary without a demotable primary → ambiguous -------
      // (worker HAS a primary, so this specific employee is fine; use `head`.)
      await p.departmentMembership.create({
        data: {
          companyId: company.id,
          employeeId: head.id,
          departmentId: deptA.id,
          isPrimary: false,
          startedAt: new Date(),
        },
      });
      await expect(
        pi.addScopedMember(ACTOR, company.id, deptSite.id, { employeeId: head.id }),
      ).rejects.toThrow(AmbiguousPrimaryError);

      // --- Out-of-scope primary → opaque 409, no writes ----------------------
      const parked = await p.departmentMembership.create({
        data: {
          companyId: company.id,
          employeeId: worker.id,
          departmentId: deptB.id,
          isPrimary: false,
          startedAt: new Date(),
        },
      });
      await p.departmentMembership.update({
        where: { id: first.membershipId },
        data: { isPrimary: false },
      });
      await p.departmentMembership.update({ where: { id: parked.id }, data: { isPrimary: true } });
      const parkedBefore = await p.departmentMembership.findUniqueOrThrow({
        where: { id: parked.id },
      });
      await expect(
        pi.addScopedMember(ACTOR, company.id, deptSite.id, {
          employeeId: worker.id,
          isPrimary: true,
        }),
      ).rejects.toThrow(PrimaryOutOfScopeError);
      const parkedAfter = await p.departmentMembership.findUniqueOrThrow({
        where: { id: parked.id },
      });
      expect(parkedAfter.isPrimary).toBe(parkedBefore.isPrimary);
      expect(parkedAfter.version).toBe(parkedBefore.version);
      // Non-primary placement is still allowed — placement not blocked.
      const nonPrimary = await pi.addScopedMember(ACTOR, company.id, deptSite.id, {
        employeeId: worker.id,
      });
      expect(nonPrimary.isPrimary).toBe(false);

      // --- In-scope primary demotion updates both rows -----------------------
      // Restore deptA's membership as primary (company admin path — its
      // company-wide grant covers deptB's scope, so demoting the parked
      // primary is inside the admin boundary and updates both rows).
      const admin = svcFor(authzFor({ companyWide: true }));
      const firstRow = await p.departmentMembership.findUniqueOrThrow({
        where: { id: first.membershipId },
      });
      const restored = await admin.updateScopedMember(ACTOR, company.id, deptA.id, firstRow.id, {
        isPrimary: true,
        expectedVersion: firstRow.version,
      });
      expect(restored.isPrimary).toBe(true);
      const parkedDemoted = await p.departmentMembership.findUniqueOrThrow({
        where: { id: parked.id },
      });
      expect(parkedDemoted.isPrimary).toBe(false);
      // Now primary sits in deptA (in-scope for PI). Setting deptSite's
      // membership as primary demotes deptA's row inside the boundary.
      const siteRow = await p.departmentMembership.findUniqueOrThrow({
        where: { id: nonPrimary.membershipId },
      });
      const promoted = await pi.updateScopedMember(
        ACTOR,
        company.id,
        deptSite.id,
        nonPrimary.membershipId,
        { isPrimary: true, expectedVersion: siteRow.version },
      );
      expect(promoted.isPrimary).toBe(true);
      const demoted = await p.departmentMembership.findUniqueOrThrow({
        where: { id: first.membershipId },
      });
      expect(demoted.isPrimary).toBe(false);
      expect(
        await p.departmentMembership.count({
          where: { companyId: company.id, employeeId: worker.id, isPrimary: true, endedAt: null },
        }),
      ).toBe(1);

      // --- Stale version → 409 -----------------------------------------------
      // isPrimary:true re-asserts the existing flag — a stale version still
      // surfaces as 409 (setting false here is blocked by the ambiguous
      // guard, correctly, since two other non-primary rows would remain).
      await expect(
        pi.updateScopedMember(ACTOR, company.id, deptSite.id, nonPrimary.membershipId, {
          isPrimary: true,
          expectedVersion: 999,
        }),
      ).rejects.toThrow(VersionConflictError);

      // --- Head membership end clears the head atomically --------------------
      await p.department.update({
        where: { id: deptA.id },
        data: { headEmployeeId: head.id },
      });
      const headMem = await p.departmentMembership.findFirstOrThrow({
        where: { companyId: company.id, employeeId: head.id, departmentId: deptA.id },
      });
      await pi.endScopedMember(ACTOR, company.id, deptA.id, headMem.id, {
        expectedVersion: headMem.version,
      });
      const deptAfterHead = await p.department.findUniqueOrThrow({ where: { id: deptA.id } });
      expect(deptAfterHead.headEmployeeId).toBeNull();
      const headCleared = await p.auditLog.findFirst({
        where: { companyId: company.id, action: 'DEPT_HEAD_CLEARED', entityId: deptA.id },
      });
      expect(headCleared).not.toBeNull();

      // --- Atomic transfer: end source + create dest + one audit --------------
      // The source row is now the worker's primary — carrying isPrimary into
      // the destination keeps exactly-one-primary true through the transfer.
      const deptSite2 = await mkDept({ scopeType: 'SITE', siteId: siteA.id, code: 'DS2' });
      const siteMem = await p.departmentMembership.findUniqueOrThrow({
        where: { id: nonPrimary.membershipId },
      });
      const transferred = await pi.transferScopedMember(
        ACTOR,
        company.id,
        deptSite.id,
        siteMem.id,
        { toDepartmentId: deptSite2.id, expectedVersion: siteMem.version, isPrimary: true },
      );
      expect(transferred.departmentId).toBe(deptSite2.id);
      expect(transferred.isPrimary).toBe(true);
      const source = await p.departmentMembership.findUniqueOrThrow({
        where: { id: siteMem.id },
      });
      expect(source.endedAt).not.toBeNull();
      const transferAudits = await p.auditLog.findMany({
        where: { companyId: company.id, action: 'MEMBERSHIP_TRANSFERRED' },
      });
      expect(transferAudits).toHaveLength(1);
      // Exactly one active primary still.
      expect(
        await p.departmentMembership.count({
          where: { companyId: company.id, employeeId: worker.id, isPrimary: true, endedAt: null },
        }),
      ).toBe(1);

      // --- Company admin keeps the EMPLOYEE_MANAGE path on company depts -----
      const adminAdd = await admin.addScopedMember(ACTOR, company.id, deptCo.id, {
        employeeId: head.id,
      });
      expect(adminAdd.departmentId).toBe(deptCo.id);

      // --- Ended membership no longer resolves in the W1 team ----------------
      await p.departmentMembership.updateMany({
        where: { companyId: company.id, employeeId: worker.id, endedAt: null },
        data: { endedAt: new Date() },
      });
      const team = await pi.listScopedTeam(
        ACTOR,
        company.id,
        { scopeType: 'PROJECT', scopeId: projA.id },
        {},
      );
      expect(team.items.some((i) => i.id === worker.id)).toBe(false);
    } finally {
      for (const cid of [company.id, other.id]) {
        await p.auditLog.deleteMany({ where: { companyId: cid } });
        await p.departmentMembership.deleteMany({ where: { companyId: cid } });
        await p.department.deleteMany({ where: { companyId: cid } });
        await p.site.deleteMany({ where: { companyId: cid } });
        await p.project.deleteMany({ where: { companyId: cid } });
        await p.headOffice.deleteMany({ where: { companyId: cid } });
        await p.employee.deleteMany({ where: { companyId: cid } });
        await p.company.deleteMany({ where: { id: cid } });
      }
    }
  });

  run('competing primary changes serialize; future transfer rejected', async () => {
    if (prisma === undefined) throw new Error('unreachable');
    const p = prisma;
    const tag = `PC${Date.now() % 1e6}`;
    const company = await p.company.create({ data: { code: `${tag}-A`, name: 'Co A' } });
    try {
      const ho = await p.headOffice.create({
        data: { companyId: company.id, code: 'HO', name: 'HO', isPrimary: true },
      });
      const proj = await p.project.create({
        data: {
          companyId: company.id,
          headOfficeId: ho.id,
          code: 'PA',
          name: 'A',
          timezone: 'Asia/Kolkata',
        },
      });
      const site = await p.site.create({
        data: { companyId: company.id, projectId: proj.id, code: 'SA', name: 'SA' },
      });
      const mkDept = (code: string, siteId?: string) =>
        p.department.create({
          data: {
            companyId: company.id,
            scopeType: siteId === undefined ? 'PROJECT' : 'SITE',
            code,
            name: code,
            status: 'ACTIVE',
            ...(siteId !== undefined ? { siteId } : { projectId: proj.id }),
          },
        });
      const deptA = await mkDept('DPA');
      const deptS1 = await mkDept('DS1', site.id);
      const deptS2 = await mkDept('DS2', site.id);
      const worker = await p.employee.create({
        data: {
          companyId: company.id,
          employeeCode: 'W1',
          displayName: 'W1',
          designation: 'Mason',
          tradeCategory: 'CIVIL',
          status: 'ACTIVE',
        },
      });
      const pi = svcFor(authzFor({ scopes: new Set([proj.id, site.id]), flag: true }));
      const mA = await pi.addScopedMember(ACTOR, company.id, deptA.id, {
        employeeId: worker.id,
        isPrimary: true,
      });
      const m1 = await pi.addScopedMember(ACTOR, company.id, deptS1.id, {
        employeeId: worker.id,
      });
      const m2 = await pi.addScopedMember(ACTOR, company.id, deptS2.id, {
        employeeId: worker.id,
      });

      // Two competing primary promotions on the same employee, fired
      // concurrently. Serialization guarantees the index never sees two
      // actives; any residual race must surface as a deliberate 409.
      const settle = async (deptId: string, mid: string) => {
        const row = await p.departmentMembership.findUniqueOrThrow({ where: { id: mid } });
        return pi
          .updateScopedMember(ACTOR, company.id, deptId, mid, {
            isPrimary: true,
            expectedVersion: row.version,
          })
          .then(() => 'ok' as const)
          .catch((e: unknown) => {
            expect(e).toBeInstanceOf(AppError);
            expect(e).toBeInstanceOf(ConflictError);
            return 'conflict' as const;
          });
      };
      const [r1, r2] = await Promise.all([
        settle(deptS1.id, m1.membershipId),
        settle(deptS2.id, m2.membershipId),
      ]);
      expect([r1, r2]).toContain('ok');
      const primaries = await p.departmentMembership.count({
        where: { companyId: company.id, employeeId: worker.id, isPrimary: true, endedAt: null },
      });
      expect(primaries).toBe(1);
      // The serialized loser either won cleanly or was rejected whole — its
      // row is never partially written.
      const loser = r1 === 'conflict' ? m1 : r2 === 'conflict' ? m2 : null;
      if (loser !== null) {
        const loserRow = await p.departmentMembership.findUniqueOrThrow({
          where: { id: loser.membershipId },
        });
        expect(loserRow.isPrimary).toBe(false);
        expect(loserRow.endedAt).toBeNull();
      }

      // Future-dated transfer is rejected outright — nothing ends, nothing
      // is created, no audit row is written.
      const m1Row = await p.departmentMembership.findUniqueOrThrow({
        where: { id: m1.membershipId },
      });
      const auditsBefore = await p.auditLog.count({ where: { companyId: company.id } });
      await expect(
        pi.transferScopedMember(ACTOR, company.id, deptS1.id, m1.membershipId, {
          toDepartmentId: deptA.id,
          expectedVersion: m1Row.version,
          startedAt: new Date(Date.now() + 86_400_000),
        }),
      ).rejects.toThrow(OrgValidationError);
      const after = await p.departmentMembership.findUniqueOrThrow({
        where: { id: m1.membershipId },
      });
      expect(after.endedAt).toBeNull();
      expect(after.version).toBe(m1Row.version);
      expect(await p.auditLog.count({ where: { companyId: company.id } })).toBe(auditsBefore);
      expect(mA.isPrimary).toBe(true);
    } finally {
      await p.auditLog.deleteMany({ where: { companyId: company.id } });
      await p.departmentMembership.deleteMany({ where: { companyId: company.id } });
      await p.department.deleteMany({ where: { companyId: company.id } });
      await p.site.deleteMany({ where: { companyId: company.id } });
      await p.project.deleteMany({ where: { companyId: company.id } });
      await p.headOffice.deleteMany({ where: { companyId: company.id } });
      await p.employee.deleteMany({ where: { companyId: company.id } });
      await p.company.deleteMany({ where: { id: company.id } });
    }
  });
});
