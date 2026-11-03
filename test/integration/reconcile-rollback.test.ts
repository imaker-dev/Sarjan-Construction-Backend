import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { SYSTEM_PRINCIPAL_ID } from '../../src/modules/setup/bootstrap.js';
import { reconcileOwnerPermissions } from '../../src/modules/setup/reconcile.js';
import { resolveTestDbUrl } from './test-db-url.js';

// Real-PostgreSQL rollback proof. Runs ONLY against the dedicated disposable
// target (loopback:55432/erp_test) — exact URL parse, fail closed otherwise.
const url = resolveTestDbUrl(process.env.TEST_DATABASE_URL);
const run = url === null ? it.skip : it;

let prisma: PrismaClient | undefined;
let pool: pg.Pool;
const fixtureIds: { companyId?: string; roleId?: string } = {};

beforeAll(async () => {
  if (url === null) return;
  pool = new pg.Pool({ connectionString: url });
  prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
});

afterAll(async () => {
  if (
    prisma !== undefined &&
    fixtureIds.companyId !== undefined &&
    fixtureIds.roleId !== undefined
  ) {
    // clean only this test's fixtures — other integration files share the DB
    await prisma.rolePermission.deleteMany({ where: { roleId: fixtureIds.roleId } });
    await prisma.role.deleteMany({ where: { id: fixtureIds.roleId } });
    await prisma.company.deleteMany({ where: { id: fixtureIds.companyId } });
    await prisma.auditLog.deleteMany({
      where: {
        action: { in: ['SYSTEM_PERMISSION_RECONCILED', 'SYSTEM_ROLE_PROVISIONED'] },
        companyId: fixtureIds.companyId,
      },
    });
    await prisma.principal.deleteMany({ where: { id: SYSTEM_PRINCIPAL_ID } });
    await prisma.$disconnect();
    await pool.end();
  } else if (prisma !== undefined) {
    await prisma.$disconnect();
    await pool.end();
  }
});

describe('reconcileOwnerPermissions rollback (real PostgreSQL)', () => {
  run('a post-write failure rolls back grants and audit together', async () => {
    if (prisma === undefined) throw new Error('unreachable: guard passed but client missing');
    // Fixtures: SYSTEM actor + company + COMPANY_OWNER system role.
    const system = await prisma.principal.upsert({
      where: { id: SYSTEM_PRINCIPAL_ID },
      update: {},
      create: { id: SYSTEM_PRINCIPAL_ID, type: 'SYSTEM', status: 'ACTIVE' },
    });
    const company = await prisma.company.create({ data: { code: 'RB', name: 'Rollback Co' } });
    const role = await prisma.role.create({
      data: { companyId: company.id, key: 'COMPANY_OWNER', name: 'Owner', isSystem: true },
    });
    fixtureIds.companyId = company.id;
    fixtureIds.roleId = role.id;
    expect(system.id).toBeTruthy();

    await expect(
      prisma.$transaction(async (tx) => {
        const changed = await reconcileOwnerPermissions(tx);
        expect(changed).toBe(8);
        // Inside the tx the writes are visible — prove then abort.
        expect(await tx.rolePermission.count({ where: { roleId: role.id } })).toBe(8);
        expect(
          await tx.auditLog.count({
            where: { action: 'SYSTEM_PERMISSION_RECONCILED', entityId: role.id },
          }),
        ).toBe(8);
        throw new Error('force-rollback');
      }),
    ).rejects.toThrow('force-rollback');

    // Outside the tx: grants + audit rolled back. (Permission rows are global
    // catalogue data legitimately created by other test files — not asserted.)
    expect(await prisma.rolePermission.count({ where: { roleId: role.id } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { companyId: fixtureIds.companyId } })).toBe(0);
  });
});
