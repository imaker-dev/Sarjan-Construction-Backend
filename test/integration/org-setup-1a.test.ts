import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { OrganizationService } from '../../src/modules/organization/service.js';
import { PrismaOrgUnitOfWork } from '../../src/modules/organization/repository.js';
import { resolveTestDbUrl } from './test-db-url.js';

// Real-PostgreSQL verification — dedicated disposable target only.
const url = resolveTestDbUrl(process.env.TEST_DATABASE_URL);
const run = url === null ? it.skip : it;

let prisma: PrismaClient | undefined;
let pool: pg.Pool | undefined;
const OWNER = { actorId: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d', actorType: 'USER' as const };

async function makeCompany(code: string) {
  if (prisma === undefined) throw new Error('unreachable');
  return prisma.company.create({ data: { code, name: 'Co ' + code } });
}

beforeAll(async () => {
  if (url === null) return;
  pool = new pg.Pool({ connectionString: url });
  prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
});

afterAll(async () => {
  if (prisma !== undefined) await prisma.$disconnect();
  if (pool !== undefined) await pool.end();
});

describe('org setup 1A constraints (real PG)', () => {
  run('department code uniqueness is scope-aware', async () => {
    if (prisma === undefined) throw new Error('unreachable');
    const company = await makeCompany(`C1A${Date.now() % 1e5}`);
    const other = await makeCompany(`C1B${Date.now() % 1e5}`);
    const ho = await prisma.headOffice.create({
      data: { companyId: company.id, code: 'HO', name: 'HO', isPrimary: true },
    });
    const oho = await prisma.headOffice.create({
      data: { companyId: other.id, code: 'HO', name: 'HO', isPrimary: true },
    });
    const proj1 = await prisma.project.create({
      data: { companyId: company.id, headOfficeId: ho.id, code: 'P1', name: 'P1', timezone: 'UTC' },
    });
    const proj2 = await prisma.project.create({
      data: { companyId: company.id, headOfficeId: ho.id, code: 'P2', name: 'P2', timezone: 'UTC' },
    });
    const otherProj = await prisma.project.create({
      data: { companyId: other.id, headOfficeId: oho.id, code: 'PX', name: 'PX', timezone: 'UTC' },
    });
    const dept = (d: object) => ({
      companyId: company.id,
      scopeType: 'COMPANY' as const,
      code: 'FIN',
      name: 'Finance',
      category: 'FINANCE' as const,
      ...d,
    });
    try {
      await prisma.department.create({ data: dept({}) });
      // Company-wide code is unique:
      await expect(prisma.department.create({ data: dept({}) })).rejects.toThrow();
      // Same code allowed in two different project scopes:
      await prisma.department.create({
        data: { ...dept({}), scopeType: 'PROJECT', projectId: proj1.id },
      });
      await prisma.department.create({
        data: { ...dept({}), scopeType: 'PROJECT', projectId: proj2.id },
      });
      // Not twice in the same project:
      await expect(
        prisma.department.create({
          data: { ...dept({}), scopeType: 'PROJECT', projectId: proj1.id },
        }),
      ).rejects.toThrow();
      // Site-scoped code may repeat across different sites:
      const s1 = await prisma.site.create({
        data: { companyId: company.id, projectId: proj1.id, code: 'S1', name: 'S1' },
      });
      const s2 = await prisma.site.create({
        data: { companyId: company.id, projectId: proj1.id, code: 'S2', name: 'S2' },
      });
      await prisma.department.create({ data: { ...dept({}), scopeType: 'SITE', siteId: s1.id } });
      await prisma.department.create({ data: { ...dept({}), scopeType: 'SITE', siteId: s2.id } });
      await expect(
        prisma.department.create({ data: { ...dept({}), scopeType: 'SITE', siteId: s1.id } }),
      ).rejects.toThrow();
      // Composite FK: cannot attach a project from another company:
      await expect(
        prisma.department.create({
          data: { ...dept({}), scopeType: 'PROJECT', projectId: otherProj.id },
        }),
      ).rejects.toThrow();
    } finally {
      await prisma.department.deleteMany({ where: { companyId: { in: [company.id, other.id] } } });
      await prisma.site.deleteMany({ where: { companyId: { in: [company.id, other.id] } } });
      await prisma.project.deleteMany({ where: { companyId: { in: [company.id, other.id] } } });
      await prisma.headOffice.deleteMany({ where: { companyId: { in: [company.id, other.id] } } });
      await prisma.company.deleteMany({ where: { id: { in: [company.id, other.id] } } });
    }
  });

  run('createProject derives primary HO and enforces dept prerequisites', async () => {
    if (prisma === undefined) throw new Error('unreachable');
    const company = await makeCompany(`C1C${Date.now() % 1e5}`);
    const org = new OrganizationService(new PrismaOrgUnitOfWork(prisma));
    try {
      // No primary HO yet -> rejected.
      await expect(
        org.createProject(OWNER, company.id, { code: 'P1', name: 'P1', timezone: 'UTC' }),
      ).rejects.toBeInstanceOf(Error);
      // HO exists but no FINANCE/ADMINISTRATION depts -> rejected.
      const ho = await prisma.headOffice.create({
        data: { companyId: company.id, code: 'HO', name: 'HO', isPrimary: true },
      });
      await expect(
        org.createProject(OWNER, company.id, { code: 'P1', name: 'P1', timezone: 'UTC' }),
      ).rejects.toBeInstanceOf(Error);
      await prisma.department.createMany({
        data: [
          {
            companyId: company.id,
            scopeType: 'COMPANY',
            code: 'FIN',
            name: 'Finance',
            category: 'FINANCE',
          },
          {
            companyId: company.id,
            scopeType: 'COMPANY',
            code: 'ADM',
            name: 'Admin',
            category: 'ADMINISTRATION',
          },
        ],
      });
      const proj = await org.createProject(OWNER, company.id, {
        code: 'P1',
        name: 'P1',
        timezone: 'UTC',
        projectType: 'RESIDENTIAL',
      });
      expect(proj.headOfficeId).toBe(ho.id);
      await prisma.auditLog.deleteMany({ where: { companyId: company.id } });
      await prisma.department.deleteMany({ where: { companyId: company.id } });
      await prisma.project.deleteMany({ where: { companyId: company.id } });
      await prisma.headOffice.deleteMany({ where: { companyId: company.id } });
      await prisma.company.delete({ where: { id: company.id } });
    } finally {
      // fixture teardown
    }
  });
});
