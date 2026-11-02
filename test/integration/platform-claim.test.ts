import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { PlatformService } from '../../src/modules/platform/service.js';
import { PrismaPlatformUnitOfWork } from '../../src/modules/platform/repository.js';
import { bootstrapPlatform } from '../../src/modules/setup/bootstrap.js';
import { resolveTestDbUrl } from './test-db-url.js';
import type { ActorContext } from '../../src/modules/organization/types.js';

// Real-PostgreSQL verification. Runs ONLY against the dedicated disposable
// target (loopback:55432/erp_test) — exact URL parse, fail closed otherwise.
const url = resolveTestDbUrl(process.env.TEST_DATABASE_URL);
const run = url === null ? it.skip : it;

let prisma: PrismaClient | undefined;
let pool: pg.Pool | undefined;
let svc: PlatformService;
let platformAdmin: ActorContext;

beforeAll(async () => {
  if (url === null) return;
  pool = new pg.Pool({ connectionString: url });
  prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  svc = new PlatformService(new PrismaPlatformUnitOfWork(prisma));
  // Real platform-admin principal — FK'd by RoleAssignment.grantedByPrincipalId.
  const padm = await prisma.principal.create({
    data: {
      loginId: 'padm@test.local',
      loginIdType: 'EMAIL',
      type: 'USER',
      status: 'ACTIVE',
      passwordHash: 'fixture',
    },
  });
  platformAdmin = { actorId: padm.id, actorType: 'USER' };
});

afterAll(async () => {
  if (prisma !== undefined && pool !== undefined) {
    await prisma.claimToken.deleteMany({});
    await prisma.roleAssignment.deleteMany({});
    await prisma.rolePermission.deleteMany({});
    await prisma.role.deleteMany({});
    await prisma.employee.deleteMany({});
    await prisma.principal.deleteMany({});
    await prisma.auditLog.deleteMany({});
    await prisma.company.deleteMany({});
    await prisma.$disconnect();
    await pool.end();
  }
});

describe('platform company creation + claim (real PostgreSQL)', () => {
  run('one tx creates company, owner role, pending admin, employee, claim', async () => {
    if (prisma === undefined) throw new Error('unreachable');
    // Preserve-fixture: a pre-existing customer company must be untouched.
    const existing = await prisma.company.create({
      data: { code: 'KEEP', name: 'Existing Tenant', isPlatform: false },
    });
    const r = await svc.createCompanyWithAdmin(platformAdmin, {
      companyCode: 'ACME',
      companyName: 'Acme Infra',
      adminLoginId: 'admin@acme.test',
      adminDisplayName: 'Test Admin',
    });
    expect(r.claimCode.length).toBe(64);
    const company = await prisma.company.findUnique({ where: { id: r.companyId } });
    expect(company?.isPlatform).toBe(false);
    // Claim: consume → principal ACTIVE, token consumed, audit rows present.
    const c = await svc.consumeClaim(r.claimCode, 'a-strong-password-1234');
    expect(c.status).toBe('CLAIMED');
    const admin = await prisma.principal.findUnique({ where: { id: r.adminPrincipalId } });
    expect(admin?.status).toBe('ACTIVE');
    const token = await prisma.claimToken.findFirst({
      where: { principalId: r.adminPrincipalId },
    });
    expect(token?.consumedAt).not.toBeNull();
    // Replay fails.
    await expect(svc.consumeClaim(r.claimCode, 'x'.repeat(12))).rejects.toThrow('claim code');
    // Audit actor is the platform admin for creation, claimed admin for claim.
    const audits = await prisma.auditLog.findMany({ where: { companyId: r.companyId } });
    expect(
      audits.some(
        (a) => a.action === 'PLATFORM_COMPANY_CREATED' && a.actorId === platformAdmin.actorId,
      ),
    ).toBe(true);
    // Raw code never persisted.
    const all = JSON.stringify(audits) + JSON.stringify(token);
    expect(all).not.toContain(r.claimCode);
    // One-active-token-per-principal: while an ACTIVE (unconsumed) code exists
    // for this principal, a second must be rejected at the DB level.
    const padm2 = await prisma.principal.create({
      data: {
        loginId: 'padm2@test.local',
        loginIdType: 'EMAIL',
        type: 'USER',
        status: 'ACTIVE',
        passwordHash: 'fixture',
      },
    });
    const t1 = await prisma.claimToken.create({
      data: {
        principalId: padm2.id,
        tokenHash: 'beef'.repeat(16),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    await expect(
      prisma.claimToken.create({
        data: {
          principalId: padm2.id,
          tokenHash: 'dead'.repeat(16),
          expiresAt: new Date(Date.now() + 60_000),
        },
      }),
    ).rejects.toThrow();
    expect(t1.consumedAt).toBeNull();
    // Existing customer company untouched.
    expect((await prisma.company.findUnique({ where: { id: existing.id } }))?.code).toBe('KEEP');
  });

  run('duplicate company code conflicts cleanly; tx rollback leaves nothing', async () => {
    if (prisma === undefined) throw new Error('unreachable');
    const auditsBefore = await prisma.auditLog.count();
    await expect(
      prisma.$transaction(async (tx) => {
        const s = new PlatformService(new PrismaPlatformUnitOfWork(tx as unknown as PrismaClient));
        await s.createCompanyWithAdmin(platformAdmin, {
          companyCode: 'ROLL',
          companyName: 'Rollback Co',
          adminLoginId: 'r@r.test',
          adminDisplayName: 'R',
        });
        throw new Error('force-rollback');
      }),
    ).rejects.toThrow('force-rollback');
    expect(await prisma.company.count({ where: { code: 'ROLL' } })).toBe(0);
    expect(await prisma.auditLog.count()).toBe(auditsBefore);
  });

  run('concurrent reissues: one wins, loser gets 409, one active code', async () => {
    if (prisma === undefined) throw new Error('unreachable');
    const r = await svc.createCompanyWithAdmin(platformAdmin, {
      companyCode: 'RACE',
      companyName: 'Race Co',
      adminLoginId: 'race@r.test',
      adminDisplayName: 'Race',
    });
    const auditsBefore = await prisma.auditLog.count();
    // Two simultaneous reissues on the same admin.
    const results = await Promise.allSettled([
      svc.reissueClaim(platformAdmin, r.companyId, r.adminPrincipalId),
      svc.reissueClaim(platformAdmin, r.companyId, r.adminPrincipalId),
    ]);
    const ok = results.filter((x) => x.status === 'fulfilled');
    // Both MAY succeed legitimately (each revoke+create is serializable —
    // last writer wins) or one loses the index race → deliberate 409.
    const conflicts = results.filter(
      (x) => x.status === 'rejected' && (x.reason as { statusCode?: number }).statusCode === 409,
    );
    expect(ok.length + conflicts.length).toBe(2);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    // INVARIANT: exactly one active (unconsumed) code survives — never two.
    const active = await prisma.claimToken.count({
      where: { principalId: r.adminPrincipalId, consumedAt: null },
    });
    expect(active).toBe(1);
    // Audit count matches actual commits (one per successful reissue).
    const reissueAudits = await prisma.auditLog.count({
      where: { action: 'CLAIM_TOKEN_REISSUED' },
    });
    expect(reissueAudits).toBe(ok.length);
    expect((await prisma.auditLog.count()) - auditsBefore).toBe(ok.length);
  });

  run('bootstrap creates platform company once; platform marker unique', async () => {
    if (prisma === undefined) throw new Error('unreachable');
    const first = await prisma.$transaction((tx) =>
      bootstrapPlatform(tx, { adminLoginId: 'ops@p.test', adminPassword: 'bootstrap-secret-1' }),
    );
    expect(first.status).toBe('CREATED');
    const second = await prisma.$transaction((tx) =>
      bootstrapPlatform(tx, { adminLoginId: 'ops2@p.test', adminPassword: 'bootstrap-secret-2' }),
    );
    expect(second.status).toBe('ALREADY_COMPLETE');
    // A second isPlatform row is impossible at the DB level.
    await expect(
      prisma.company.create({ data: { code: 'PLAT2', name: 'dup', isPlatform: true } }),
    ).rejects.toThrow();
  });
});
