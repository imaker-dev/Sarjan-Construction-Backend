import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { EmployeeService } from '../../src/modules/employee/service.js';
import { PrismaEmployeeUnitOfWork } from '../../src/modules/employee/repository.js';
import {
  OrgEntityNotFoundError,
  OrgValidationError,
} from '../../src/modules/organization/errors.js';
import { ForbiddenError } from '../../src/common/errors/app-error.js';
import { AccessDeniedError } from '../../src/modules/access-control/errors.js';
import { resolveTestDbUrl } from './test-db-url.js';
import type { ScopeTarget } from '../../src/modules/access-control/service.js';

// Real-PostgreSQL verification of delegated workforce onboarding (W3):
// atomic profile + initial primary membership + document links, delegation
// gating, duplicate-code 409, and scope-boundary denial. Disposable target
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

describe('delegated workforce onboarding (real PG)', () => {
  run('atomic onboard, delegation gating, documents, read-back', async () => {
    if (prisma === undefined) throw new Error('unreachable');
    const p = prisma;
    const tag = `ON${Date.now() % 1e6}`;
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
      const deptA = await p.department.create({
        data: {
          companyId: company.id,
          scopeType: 'PROJECT',
          projectId: projA.id,
          code: 'DPA',
          name: 'DPA',
          status: 'ACTIVE',
        },
      });
      const deptB = await p.department.create({
        data: {
          companyId: company.id,
          scopeType: 'PROJECT',
          projectId: projB.id,
          code: 'DPB',
          name: 'DPB',
          status: 'ACTIVE',
        },
      });
      const deptSite = await p.department.create({
        data: {
          companyId: company.id,
          scopeType: 'SITE',
          siteId: siteA.id,
          code: 'DSA',
          name: 'DSA',
          status: 'ACTIVE',
        },
      });
      const deptCo = await p.department.create({
        data: {
          companyId: company.id,
          scopeType: 'COMPANY',
          code: 'DCO',
          name: 'DCO',
          status: 'ACTIVE',
        },
      });
      const doc = await p.document.create({
        data: {
          companyId: company.id,
          storageKey: `${tag}/id-photo.jpg`,
          originalFileName: 'id-photo.jpg',
          status: 'AVAILABLE',
          scopeType: 'PROJECT',
          projectId: projA.id,
        },
      });
      const foreignDoc = await p.document.create({
        data: {
          companyId: other.id,
          storageKey: `${tag}/other.jpg`,
          originalFileName: 'other.jpg',
          status: 'AVAILABLE',
          scopeType: 'COMPANY',
        },
      });

      const pi = svcFor(authzFor({ scopes: new Set([projA.id, siteA.id]), flag: true }));
      const BODY = {
        employeeCode: `${tag}-W1`,
        displayName: 'Ramesh Kumar',
        engagementType: 'DAILY_WAGE',
      };

      // --- Flag off → DELEGATION_DISABLED, nothing persisted -----------------
      const noFlag = svcFor(authzFor({ scopes: new Set([projA.id, siteA.id]) }));
      await expect(noFlag.onboardScopedMember(ACTOR, company.id, deptA.id, BODY)).rejects.toThrow(
        ForbiddenError,
      );

      // --- Company/HO dept never delegated; sibling denied --------------------
      await expect(
        pi.onboardScopedMember(ACTOR, company.id, deptCo.id, BODY),
      ).rejects.toMatchObject({ code: 'DELEGATION_NEVER' });
      await expect(pi.onboardScopedMember(ACTOR, company.id, deptB.id, BODY)).rejects.toThrow(
        AccessDeniedError,
      );
      expect(await p.employee.count({ where: { companyId: company.id } })).toBe(0);

      // --- Onboard with delegation on ---------------------------------------
      const delegated = svcFor(authzFor({ scopes: new Set([projA.id, siteA.id]), flag: true }));
      // The PI's flag check uses the company policy row — create it enabled.
      await p.companyDelegationPolicy.create({
        data: { companyId: company.id, employeeOnboard: true },
      });
      // delegationEnabled in the stub ignores the DB; the real policy table
      // is exercised by the delegation service — here we verify the column
      // exists and round-trips.
      const policy = await p.companyDelegationPolicy.findUniqueOrThrow({
        where: { companyId: company.id },
      });
      expect(policy.employeeOnboard).toBe(true);

      const onboarded = await delegated.onboardScopedMember(ACTOR, company.id, deptA.id, {
        ...BODY,
        designation: 'Mason',
        contactPhone: '9000000001',
        emergencyContactName: 'Sita',
        emergencyContactPhone: '9000000002',
        joiningDate: new Date('2024-01-10'),
        documents: [{ documentId: doc.id, documentType: 'PHOTO', title: 'ID photo' }],
      });
      expect(onboarded.employee.principalId).toBeNull();
      expect(onboarded.membership.isPrimary).toBe(true);
      expect(onboarded.documentsLinked).toBe(1);

      const emp = await p.employee.findUniqueOrThrow({ where: { id: onboarded.employee.id } });
      expect(emp.principalId).toBeNull();
      expect(emp.employeeCode).toBe(`${tag}-W1`.toUpperCase());
      const mem = await p.departmentMembership.findFirstOrThrow({
        where: { companyId: company.id, employeeId: emp.id, departmentId: deptA.id },
      });
      expect(mem.isPrimary).toBe(true);
      expect(mem.endedAt).toBeNull();
      // joiningDate does not backdate the membership.
      expect(mem.startedAt.getTime()).toBeGreaterThan(new Date('2024-01-10').getTime());
      const links = await p.employeeDocument.findMany({
        where: { companyId: company.id, employeeId: emp.id },
      });
      expect(links).toHaveLength(1);
      expect(links[0]?.documentId).toBe(doc.id);
      const audit = await p.auditLog.findFirst({
        where: { companyId: company.id, action: 'EMPLOYEE_ONBOARDED' },
      });
      expect(audit).not.toBeNull();

      // --- Scoped read-back of contact fields via member detail --------------
      const detail = await pi.getScopedMember(ACTOR, company.id, deptA.id, mem.id);
      expect(detail.employee?.contactPhone).toBe('9000000001');
      expect(detail.employee?.emergencyContactPhone).toBe('9000000002');
      await expect(pi.getScopedMember(ACTOR, company.id, deptB.id, mem.id)).rejects.toThrow(
        AccessDeniedError,
      );
      await expect(pi.getScopedMember(ACTOR, company.id, deptSite.id, mem.id)).rejects.toThrow(
        OrgEntityNotFoundError,
      );

      // --- Duplicate code → 409 ----------------------------------------------
      await expect(pi.onboardScopedMember(ACTOR, company.id, deptA.id, BODY)).rejects.toMatchObject(
        { statusCode: 409 },
      );
      expect(await p.employee.count({ where: { companyId: company.id } })).toBe(1);

      // --- Foreign document → rollback, no partial employee ------------------
      await expect(
        pi.onboardScopedMember(ACTOR, company.id, deptSite.id, {
          employeeCode: `${tag}-W2`,
          displayName: 'W2',
          engagementType: 'CONTRACTOR_WORKER',
          documents: [{ documentId: foreignDoc.id, documentType: 'PHOTO', title: 'x' }],
        }),
      ).rejects.toThrow(OrgValidationError);
      expect(
        await p.employee.count({ where: { companyId: company.id, employeeCode: `${tag}-W2` } }),
      ).toBe(0);
    } finally {
      for (const cid of [company.id, other.id]) {
        await p.auditLog.deleteMany({ where: { companyId: cid } });
        await p.employeeDocument.deleteMany({ where: { companyId: cid } });
        await p.departmentMembership.deleteMany({ where: { companyId: cid } });
        await p.department.deleteMany({ where: { companyId: cid } });
        await p.document.deleteMany({ where: { companyId: cid } });
        await p.companyDelegationPolicy.deleteMany({ where: { companyId: cid } });
        await p.site.deleteMany({ where: { companyId: cid } });
        await p.project.deleteMany({ where: { companyId: cid } });
        await p.headOffice.deleteMany({ where: { companyId: cid } });
        await p.employee.deleteMany({ where: { companyId: cid } });
        await p.company.deleteMany({ where: { id: cid } });
      }
    }
  });
});
