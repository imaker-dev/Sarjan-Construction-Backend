import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { EmployeeService } from '../../src/modules/employee/service.js';
import { PrismaEmployeeUnitOfWork } from '../../src/modules/employee/repository.js';
import { OrgEntityNotFoundError } from '../../src/modules/organization/errors.js';
import { resolveTestDbUrl } from './test-db-url.js';

// Real-PostgreSQL verification of the W1 scoped workforce directory.
// Disposable target only (loopback / erp_test, enforced by resolveTestDbUrl).
const url = resolveTestDbUrl(process.env.TEST_DATABASE_URL);
const run = url === null ? it.skip : it;

let prisma: PrismaClient | undefined;
let pool: pg.Pool | undefined;
let svc: EmployeeService | undefined;
const ACTOR = { actorId: '00000000-0000-4000-8000-0000000000aa', actorType: 'USER' as const };
const authz = { assertPermission: async () => undefined };

beforeAll(async () => {
  if (url === null) return;
  pool = new pg.Pool({ connectionString: url });
  prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  svc = new EmployeeService(new PrismaEmployeeUnitOfWork(prisma), authz);
});

afterAll(async () => {
  if (prisma !== undefined) await prisma.$disconnect();
  if (pool !== undefined) await pool.end();
});

const RESTRICTED = [
  'contactPhone',
  'contactEmail',
  'emergencyContactName',
  'emergencyContactPhone',
  'principalId',
  'loginId',
  'SECRET',
];

describe('scoped workforce directory (real PG)', () => {
  run('project/site/department boundaries, dedupe, dates, projection, paging', async () => {
    if (prisma === undefined || svc === undefined) throw new Error('unreachable');
    const p = prisma;
    const tag = `SD${Date.now() % 1e6}`;
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
      await p.site.create({
        data: { companyId: company.id, projectId: projB.id, code: 'SB', name: 'SB' },
      });
      const mkDept = (data: {
        scopeType: 'COMPANY' | 'HEAD_OFFICE' | 'PROJECT' | 'SITE';
        code: string;
        projectId?: string;
        siteId?: string;
        headOfficeId?: string;
        inCompany?: string;
      }) =>
        p.department.create({
          data: {
            companyId: data.inCompany ?? company.id,
            scopeType: data.scopeType,
            code: data.code,
            name: data.code,
            ...(data.projectId !== undefined ? { projectId: data.projectId } : {}),
            ...(data.siteId !== undefined ? { siteId: data.siteId } : {}),
            ...(data.headOfficeId !== undefined ? { headOfficeId: data.headOfficeId } : {}),
          },
        });
      const deptProjA = await mkDept({ scopeType: 'PROJECT', projectId: projA.id, code: 'DPA' });
      const deptSiteA = await mkDept({ scopeType: 'SITE', siteId: siteA.id, code: 'DSA' });
      const deptProjB = await mkDept({ scopeType: 'PROJECT', projectId: projB.id, code: 'DPB' });
      const deptCompany = await mkDept({ scopeType: 'COMPANY', code: 'DCO' });
      const otherHo = await p.headOffice.create({
        data: { companyId: other.id, code: 'HO', name: 'HO', isPrimary: true },
      });
      const otherProj = await p.project.create({
        data: {
          companyId: other.id,
          headOfficeId: otherHo.id,
          code: 'OP',
          name: 'OP',
          timezone: 'Asia/Kolkata',
        },
      });
      const deptOtherCo = await mkDept({
        scopeType: 'PROJECT',
        projectId: otherProj.id,
        code: 'DOC',
        inCompany: other.id,
      });

      const mkEmp = (code: string, extra: Record<string, unknown> = {}) =>
        p.employee.create({
          data: {
            companyId: company.id,
            employeeCode: code,
            displayName: `Name ${code}`,
            designation: 'Mason',
            tradeCategory: 'CIVIL',
            contactPhone: `SECRET-${code}`,
            ...extra,
          },
        });
      const eProj = await mkEmp('EP');
      const eSite = await mkEmp('ES');
      const eBoth = await mkEmp('EB'); // two in-scope memberships → dedupe
      const eEnded = await mkEmp('EE');
      const eFuture = await mkEmp('EF');
      const eProjB = await mkEmp('EB2');
      const eCompany = await mkEmp('EC');
      const eOther = await mkEmp('EO', { companyId: other.id });

      const mkMem = (
        employeeId: string,
        departmentId: string,
        extra: {
          startedAt?: Date;
          endedAt?: Date | null;
          isPrimary?: boolean;
          companyId?: string;
        } = {},
      ) =>
        p.departmentMembership.create({
          data: {
            companyId: extra.companyId ?? company.id,
            employeeId,
            departmentId,
            isPrimary: extra.isPrimary ?? false,
            ...(extra.startedAt !== undefined ? { startedAt: extra.startedAt } : {}),
            ...(extra.endedAt !== undefined ? { endedAt: extra.endedAt } : {}),
          },
        });
      const past = new Date(Date.now() - 30 * 86_400_000);
      const future = new Date(Date.now() + 30 * 86_400_000);
      await mkMem(eProj.id, deptProjA.id, { isPrimary: true });
      await mkMem(eSite.id, deptSiteA.id, { isPrimary: true });
      await mkMem(eBoth.id, deptProjA.id, { isPrimary: true });
      await mkMem(eBoth.id, deptSiteA.id);
      await mkMem(eEnded.id, deptProjA.id, { startedAt: past, endedAt: new Date() });
      await mkMem(eFuture.id, deptProjA.id, { startedAt: future });
      await mkMem(eProjB.id, deptProjB.id);
      await mkMem(eCompany.id, deptCompany.id);
      await mkMem(eOther.id, deptOtherCo.id, { companyId: other.id });

      // Project A team: project dept + child-site dept members only.
      const teamA = await svc.listScopedTeam(
        ACTOR,
        company.id,
        { scopeType: 'PROJECT', scopeId: projA.id },
        {},
      );
      const idsA = teamA.items.map((i) => i.id).sort();
      expect(idsA).toEqual([eBoth.id, eProj.id, eSite.id].sort());
      // Deduped: eBoth once, with both in-scope memberships.
      const both = teamA.items.find((i) => i.id === eBoth.id);
      expect(both?.memberships.map((m) => m.departmentId).sort()).toEqual(
        [deptProjA.id, deptSiteA.id].sort(),
      );
      // Safe projection: no restricted keys anywhere in the payload.
      const json = JSON.stringify(teamA);
      for (const k of RESTRICTED) expect(json).not.toContain(k);
      expect(both?.employeeCode).toBe('EB');
      expect(both?.designation).toBe('Mason');

      // Sibling project excludes A's people.
      const teamB = await svc.listScopedTeam(
        ACTOR,
        company.id,
        { scopeType: 'PROJECT', scopeId: projB.id },
        {},
      );
      expect(teamB.items.map((i) => i.id)).toEqual([eProjB.id]);

      // Site team: only that exact site — project-dept members excluded.
      const siteTeam = await svc.listScopedTeam(
        ACTOR,
        company.id,
        { scopeType: 'SITE', scopeId: siteA.id },
        {},
      );
      expect(siteTeam.items.map((i) => i.id).sort()).toEqual([eBoth.id, eSite.id].sort());

      // Missing / cross-company targets → not-found, never leaked.
      await expect(
        svc.listScopedTeam(ACTOR, company.id, { scopeType: 'PROJECT', scopeId: 'nope' }, {}),
      ).rejects.toThrow(OrgEntityNotFoundError);
      await expect(
        svc.listScopedTeam(ACTOR, other.id, { scopeType: 'PROJECT', scopeId: projA.id }, {}),
      ).rejects.toThrow(OrgEntityNotFoundError);

      // Search by code/name.
      const found = await svc.listScopedTeam(
        ACTOR,
        company.id,
        { scopeType: 'PROJECT', scopeId: projA.id },
        { q: 'name es' },
      );
      expect(found.items.map((i) => i.id)).toEqual([eSite.id]);

      // Keyset pagination: stable, no dupes across pages.
      const page1 = await svc.listScopedTeam(
        ACTOR,
        company.id,
        { scopeType: 'PROJECT', scopeId: projA.id },
        { limit: 2 },
      );
      expect(page1.items).toHaveLength(2);
      expect(page1.nextCursor).not.toBeNull();
      const page2 = await svc.listScopedTeam(
        ACTOR,
        company.id,
        { scopeType: 'PROJECT', scopeId: projA.id },
        { limit: 2, ...(page1.nextCursor !== null ? { cursor: page1.nextCursor } : {}) },
      );
      const allIds = [...page1.items, ...page2.items].map((i) => i.id);
      expect(new Set(allIds).size).toBe(3);

      // Department members: current only by default; history with includeEnded.
      const current = await svc.listDepartmentMembers(ACTOR, company.id, deptProjA.id, {});
      expect(current.items.map((m) => m.employeeId).sort()).toEqual([eBoth.id, eProj.id].sort());
      const hist = await svc.listDepartmentMembers(ACTOR, company.id, deptProjA.id, {
        includeEnded: true,
      });
      expect(hist.items.map((m) => m.employeeId).sort()).toEqual(
        [eBoth.id, eEnded.id, eProj.id].sort(),
      );
      // Future membership never surfaces, even in history.
      expect(hist.items.some((m) => m.employeeId === eFuture.id)).toBe(false);
      const memberJson = JSON.stringify(hist);
      for (const k of RESTRICTED) expect(memberJson).not.toContain(k);
      // Cross-company department id → not found.
      await expect(
        svc.listDepartmentMembers(ACTOR, company.id, deptOtherCo.id, {}),
      ).rejects.toThrow(OrgEntityNotFoundError);
    } finally {
      for (const cid of [company.id, other.id]) {
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
});
