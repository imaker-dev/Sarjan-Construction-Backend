import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { EmployeeService } from '../../src/modules/employee/service.js';
import { PrismaEmployeeUnitOfWork } from '../../src/modules/employee/repository.js';
import { resolveTestDbUrl } from './test-db-url.js';

// Real-PostgreSQL verification — dedicated disposable target only.
const url = resolveTestDbUrl(process.env.TEST_DATABASE_URL);
const run = url === null ? it.skip : it;

let prisma: PrismaClient | undefined;
let pool: pg.Pool | undefined;
let svc: EmployeeService | undefined;
const OWNER = { actorId: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d', actorType: 'USER' as const };
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

describe('department membership (real PG)', () => {
  run(
    'one active membership per emp/dept; primary demotion; end+history; cross-company rejection',
    async () => {
      if (prisma === undefined || svc === undefined) throw new Error('unreachable');
      const p = prisma;
      const company = await p.company.create({
        data: { code: `M1${Date.now() % 1e6}`, name: 'Co' },
      });
      const other = await p.company.create({
        data: { code: `M2${Date.now() % 1e6}`, name: 'Co2' },
      });
      const emp = await p.employee.create({
        data: {
          companyId: company.id,
          employeeCode: 'E1',
          displayName: 'Emp',
          engagementType: 'DIRECT_EMPLOYEE',
        },
      });
      const dept1 = await p.department.create({
        data: {
          companyId: company.id,
          scopeType: 'COMPANY',
          code: 'FIN',
          name: 'Finance',
          category: 'FINANCE',
          status: 'ACTIVE',
        },
      });
      const dept2 = await p.department.create({
        data: {
          companyId: company.id,
          scopeType: 'COMPANY',
          code: 'ADM',
          name: 'Admin',
          category: 'ADMINISTRATION',
          status: 'ACTIVE',
        },
      });
      const otherDept = await p.department.create({
        data: {
          companyId: other.id,
          scopeType: 'COMPANY',
          code: 'FIN',
          name: 'Finance',
          category: 'FINANCE',
          status: 'ACTIVE',
        },
      });
      try {
        // Cross-company dept -> composite FK rejects.
        await expect(
          svc.addMembership(OWNER, company.id, emp.id, { departmentId: otherDept.id }),
        ).rejects.toBeInstanceOf(Error);

        const m1 = await svc.addMembership(OWNER, company.id, emp.id, {
          departmentId: dept1.id,
          isPrimary: true,
        });
        // Duplicate active membership in same dept -> 409 class error.
        await expect(
          svc.addMembership(OWNER, company.id, emp.id, { departmentId: dept1.id }),
        ).rejects.toBeInstanceOf(Error);
        const m2 = await svc.addMembership(OWNER, company.id, emp.id, {
          departmentId: dept2.id,
          isPrimary: true,
        });
        // Primary demotion: only one active primary.
        const primaries = await p.departmentMembership.findMany({
          where: { companyId: company.id, employeeId: emp.id, endedAt: null, isPrimary: true },
        });
        expect(primaries).toHaveLength(1);
        expect(primaries[0]?.id).toBe(m2.id);
        const m1Now = await p.departmentMembership.findUniqueOrThrow({ where: { id: m1.id } });
        expect(m1Now.isPrimary).toBe(false);

        // End via server timestamp.
        const ended = await svc.endMembership(OWNER, company.id, emp.id, m2.id, m2.version);
        expect(ended?.endedAt).not.toBeNull();
        // History retained; can rejoin same dept with a NEW row.
        const m3 = await svc.addMembership(OWNER, company.id, emp.id, { departmentId: dept2.id });
        expect(m3.id).not.toBe(m2.id);
        const all = await svc.listMemberships(company.id, emp.id);
        expect(all.filter((m) => m.endedAt === null).length).toBe(2); // m1 + m3

        // Employee deactivation cascades: ends all active memberships.
        await svc.changeStatus(OWNER, company.id, emp.id, 'INACTIVE');
        const remaining = await p.departmentMembership.findMany({
          where: { companyId: company.id, employeeId: emp.id, endedAt: null },
        });
        expect(remaining).toHaveLength(0);
        const history = await p.departmentMembership.findMany({
          where: { companyId: company.id, employeeId: emp.id, endedAt: { not: null } },
        });
        expect(history.length).toBeGreaterThanOrEqual(2); // m2 + cascade(m1, m3)
      } finally {
        await p.departmentMembership.deleteMany({
          where: { companyId: { in: [company.id, other.id] } },
        });
        await p.employee.deleteMany({ where: { companyId: { in: [company.id, other.id] } } });
        await p.department.deleteMany({ where: { companyId: { in: [company.id, other.id] } } });
        await p.auditLog.deleteMany({ where: { companyId: { in: [company.id, other.id] } } });
        await p.company.deleteMany({ where: { id: { in: [company.id, other.id] } } });
      }
    },
  );
});
