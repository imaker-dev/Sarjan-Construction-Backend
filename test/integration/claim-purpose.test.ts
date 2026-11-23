import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { PlatformService } from '../../src/modules/platform/service.js';
import { PrismaPlatformUnitOfWork } from '../../src/modules/platform/repository.js';
import { EmployeeAccessService } from '../../src/modules/employee/access.js';
import { resolveTestDbUrl } from './test-db-url.js';
import type { ActorContext } from '../../src/modules/organization/types.js';

// Slice A real-PostgreSQL verification — purpose/binding checks, triple FK,
// CHECK invariants, and the migration's classification block replayed inside
// a rolled-back transaction. Disposable target only (loopback:55432/erp_test).
const url = resolveTestDbUrl(process.env.TEST_DATABASE_URL);
const run = url === null ? it.skip : it;

let prisma: PrismaClient | undefined;
let pool: pg.Pool | undefined;
let platform: PlatformService;
let access: EmployeeAccessService;
let OWNER: ActorContext;

const FIXTURE_CODES = ['CPA', 'CPB', 'CPC'];

async function cleanup(p: PrismaClient) {
  const companies = await p.company.findMany({
    where: { code: { in: FIXTURE_CODES } },
    select: { id: true },
  });
  const cids = companies.map((c) => c.id);
  if (cids.length === 0) return;
  // Bound first — tokens now FK to company/employee directly.
  await p.claimToken.deleteMany({ where: { companyId: { in: cids } } });
  await p.claimToken.deleteMany({
    where: { principal: { employees: { some: { companyId: { in: cids } } } } },
  });
  await p.claimToken.deleteMany({
    where: { principal: { roleAssignments: { some: { companyId: { in: cids } } } } },
  });
  await p.roleAssignment.deleteMany({ where: { companyId: { in: cids } } });
  await p.rolePermission.deleteMany({ where: { role: { companyId: { in: cids } } } });
  await p.role.deleteMany({ where: { companyId: { in: cids } } });
  await p.employee.deleteMany({ where: { companyId: { in: cids } } });
  await p.headOffice.deleteMany({ where: { companyId: { in: cids } } });
  await p.auditLog.deleteMany({ where: { companyId: { in: cids } } });
  await p.company.deleteMany({ where: { id: { in: cids } } });
}

beforeAll(async () => {
  if (url === null) return;
  pool = new pg.Pool({ connectionString: url });
  prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  platform = new PlatformService(new PrismaPlatformUnitOfWork(prisma));
  access = new EmployeeAccessService(prisma);
  const p = await prisma.principal.upsert({
    where: { loginId: 'cp-owner@cp.test' },
    update: {},
    create: {
      loginId: 'cp-owner@cp.test',
      loginIdType: 'EMAIL',
      type: 'USER',
      status: 'ACTIVE',
      passwordHash: 'fixture',
    },
  });
  OWNER = { actorId: p.id, actorType: 'USER' };
});

afterAll(async () => {
  if (prisma !== undefined && pool !== undefined) {
    await cleanup(prisma);
    await prisma.claimToken.deleteMany({
      where: {
        principal: {
          loginId: {
            in: [
              'cp-owner@cp.test',
              'cp-adm@cp.test',
              'cp-b-adm@cp.test',
              'cp-p1@cp.test',
              'cp-w1@cp.test',
              'cp-w2@cp.test',
            ],
          },
        },
      },
    });
    await prisma.principal.deleteMany({
      where: {
        loginId: {
          in: [
            'cp-owner@cp.test',
            'cp-adm@cp.test',
            'cp-b-adm@cp.test',
            'cp-p1@cp.test',
            'cp-w1@cp.test',
            'cp-w2@cp.test',
          ],
        },
      },
    });
    await prisma.$disconnect();
    await pool.end();
  }
});

describe('Slice A — purpose binding + onboarding gate (real PostgreSQL)', () => {
  run(
    'COMPANY_ONBOARD tokens bind the company; EMPLOYEE_INVITE binds company+employee',
    async () => {
      if (prisma === undefined) throw new Error('unreachable');
      const created = await platform.createCompanyWithAdmin(OWNER, {
        companyCode: 'CPA',
        companyName: 'Purpose Co',
        adminLoginId: 'cp-adm@cp.test',
        adminDisplayName: 'Admin',
      });
      const onboardTok = await prisma.claimToken.findFirstOrThrow({
        where: { principalId: created.adminPrincipalId },
      });
      expect(onboardTok.purpose).toBe('COMPANY_ONBOARD');
      expect(onboardTok.companyId).toBe(created.companyId);
      expect(onboardTok.employeeId).toBeNull();

      const emp = await prisma.employee.create({
        data: { companyId: created.companyId, employeeCode: 'W1', displayName: 'Worker' },
      });
      const invite = await access.invite(OWNER, created.companyId, emp.id, 'cp-w1@cp.test');
      const invTok = await prisma.claimToken.findFirstOrThrow({
        where: { principalId: { not: created.adminPrincipalId }, companyId: created.companyId },
        orderBy: { createdAt: 'desc' },
      });
      expect(invTok.purpose).toBe('EMPLOYEE_INVITE');
      expect(invTok.companyId).toBe(created.companyId);
      expect(invTok.employeeId).toBe(emp.id);
      expect(invite.claimUrl).toContain('/verify-employee?token=');
      expect(invite.delivery).toBe('NOT_ATTEMPTED'); // no mail wired in test

      // The invite code must NOT reach onboarding — and stays live for /claim.
      await expect(
        platform.consumeClaimAndOnboard(invite.claimCode, { password: 'worker-pass-1234' }),
      ).rejects.toThrow('claim code');
      const still = await prisma.claimToken.findUniqueOrThrow({ where: { id: invTok.id } });
      expect(still.consumedAt).toBeNull();

      // It claims fine at /auth/claim.
      const claimed = await platform.consumeClaim(invite.claimCode, 'worker-pass-1234');
      expect(claimed.status).toBe('CLAIMED');
      const claimAudit = await prisma.auditLog.findFirstOrThrow({
        where: { action: 'ACCOUNT_CLAIM_COMPLETED', companyId: created.companyId },
      });
      expect(claimAudit.entityId).toBe(invTok.principalId);
    },
  );

  run('EMPLOYEE_INVITE claim fails closed when the bound employee is deactivated', async () => {
    if (prisma === undefined) throw new Error('unreachable');
    const company = await prisma.company.findFirstOrThrow({ where: { code: 'CPA' } });
    const emp = await prisma.employee.create({
      data: { companyId: company.id, employeeCode: 'W2', displayName: 'W2' },
    });
    const invite = await access.invite(OWNER, company.id, emp.id, 'cp-w2@cp.test');
    await prisma.employee.update({ where: { id: emp.id }, data: { status: 'INACTIVE' } });
    await expect(platform.consumeClaim(invite.claimCode, 'w2-password-123')).rejects.toThrow(
      'claim code',
    );
    const tok = await prisma.claimToken.findFirstOrThrow({
      where: { employeeId: emp.id },
    });
    // Binding failure never burns the code — resend after reactivation works.
    expect(tok.consumedAt).toBeNull();
    await prisma.employee.update({ where: { id: emp.id }, data: { status: 'ACTIVE' } });
    const r = await platform.consumeClaim(invite.claimCode, 'w2-password-123');
    expect(r.status).toBe('CLAIMED');
  });

  run('CHECK + triple FK invariants reject bad bindings at the DB level', async () => {
    if (prisma === undefined) throw new Error('unreachable');
    const company = await prisma.company.findFirstOrThrow({ where: { code: 'CPA' } });
    const p1 = await prisma.principal.create({
      data: {
        loginId: 'cp-p1@cp.test',
        loginIdType: 'EMAIL',
        type: 'USER',
        status: 'SUSPENDED',
        passwordHash: 'fixture',
      },
    });
    const otherEmp = await prisma.employee.create({
      data: { companyId: company.id, employeeCode: 'W3', displayName: 'W3' },
    });
    // EMPLOYEE_INVITE without employeeId → CHECK violation.
    await expect(
      prisma.claimToken.create({
        data: {
          principalId: p1.id,
          tokenHash: 'aa'.repeat(32),
          expiresAt: new Date(Date.now() + 60_000),
          purpose: 'EMPLOYEE_INVITE',
          companyId: company.id,
        },
      }),
    ).rejects.toThrow();
    // COMPANY_ONBOARD carrying an employee binding → CHECK violation.
    await expect(
      prisma.claimToken.create({
        data: {
          principalId: p1.id,
          tokenHash: 'bb'.repeat(32),
          expiresAt: new Date(Date.now() + 60_000),
          purpose: 'COMPANY_ONBOARD',
          companyId: company.id,
          employeeId: otherEmp.id,
        },
      }),
    ).rejects.toThrow();
    // Unclassified live token → CHECK violation (only consumed rows may be null-purpose).
    await expect(
      prisma.claimToken.create({
        data: {
          principalId: p1.id,
          tokenHash: 'cc'.repeat(32),
          expiresAt: new Date(Date.now() + 60_000),
        },
      }),
    ).rejects.toThrow();
    // Triple FK: employeeId+companyId+principalId must all agree — binding to
    // an employee the token's principal is NOT linked to is impossible.
    await expect(
      prisma.claimToken.create({
        data: {
          principalId: p1.id, // p1 is not otherEmp.principalId
          tokenHash: 'dd'.repeat(32),
          expiresAt: new Date(Date.now() + 60_000),
          purpose: 'EMPLOYEE_INVITE',
          companyId: company.id,
          employeeId: otherEmp.id,
        },
      }),
    ).rejects.toThrow();
    await prisma.principal.delete({ where: { id: p1.id } });
    await prisma.employee.delete({ where: { id: otherEmp.id } });
  });

  run('concurrent claims on one code: exactly one wins', async () => {
    if (prisma === undefined) throw new Error('unreachable');
    const created = await platform.createCompanyWithAdmin(OWNER, {
      companyCode: 'CPB',
      companyName: 'Race Claim Co',
      adminLoginId: 'cp-b-adm@cp.test',
      adminDisplayName: 'B Admin',
    });
    const results = await Promise.allSettled([
      platform.consumeClaim(created.claimCode, 'race-password-111'),
      platform.consumeClaim(created.claimCode, 'race-password-222'),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    expect(ok).toHaveLength(1);
    const admin = await prisma.principal.findUniqueOrThrow({
      where: { id: created.adminPrincipalId },
    });
    expect(admin.status).toBe('ACTIVE');
    // Teardown via afterAll cleanup (company → bound tokens → employees →
    // audit → company, then principals) preserves FK order.
  });
});

describe('Slice A — migration classification replay (rolled-back fixtures)', () => {
  run(
    'classifies provable tokens, preserves consumed history, closes ambiguous/contradictory',
    async () => {
      if (prisma === undefined || pool === undefined) throw new Error('unreachable');
      // Replay the EXACT classification block from the migration file — the
      // markers guarantee the tested SQL is the shipped SQL.
      const migrationSql = readFileSync(
        'prisma/migrations/20261205000000_claim_token_purpose/migration.sql',
        'utf8',
      );
      const block =
        />>> claim-token-classification >>>([\s\S]*?)<<< claim-token-classification <<</.exec(
          migrationSql,
        )?.[1];
      expect(block).toBeDefined();
      const statements = (block ?? '')
        .split(';')
        .map((s) =>
          s
            .split('\n')
            .filter((l) => !l.trim().startsWith('--'))
            .join('\n')
            .trim(),
        )
        .filter((s) => s.length > 0);

      const one = <T>(rows: T[], ctx: string): T => {
        const r = rows[0];
        if (r === undefined) throw new Error(`fixture row missing: ${ctx}`);
        return r;
      };
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // The CHECK is dropped inside the tx so legacy-shaped rows can be
        // seeded; rollback restores it — committed schema is untouched.
        await client.query(
          `ALTER TABLE "ClaimToken" DROP CONSTRAINT "ClaimToken_purpose_binding_ck"`,
        );
        const mk = async (loginId: string) =>
          one(
            (
              await client.query<{ id: string }>(
                `INSERT INTO "Principal" (id,"loginId","loginIdType","type","status","passwordHash","updatedAt")
                 VALUES (gen_random_uuid(),$1,'EMAIL','USER','SUSPENDED','fixture',now()) RETURNING id`,
                [loginId],
              )
            ).rows,
            'principal',
          ).id;
        const mkCo = async (code: string, isPlatform = false) =>
          one(
            (
              await client.query<{ id: string }>(
                `INSERT INTO "Company" (id, code, name, "isPlatform","updatedAt") VALUES (gen_random_uuid(),$1,$2,$3,now()) RETURNING id`,
                [code, code, isPlatform],
              )
            ).rows,
            'company',
          ).id;
        const mkEmp = async (companyId: string, principalId: string, empCode: string) =>
          one(
            (
              await client.query<{ id: string }>(
                `INSERT INTO "Employee" (id,"companyId","principalId","employeeCode","displayName","updatedAt")
                 VALUES (gen_random_uuid(),$1,$2,$3,$4,now()) RETURNING id`,
                [companyId, principalId, empCode, empCode],
              )
            ).rows,
            'employee',
          ).id;
        const mkTok = async (
          principalId: string,
          hash: string,
          opts: { consumed?: boolean; expired?: boolean },
        ) =>
          one(
            (
              await client.query<{ id: string }>(
                `INSERT INTO "ClaimToken" (id,"principalId","tokenHash","expiresAt","consumedAt")
                 VALUES (gen_random_uuid(),$1,$2,$3,$4) RETURNING id`,
                [
                  principalId,
                  hash,
                  opts.expired === true
                    ? new Date(Date.now() - 60_000)
                    : new Date(Date.now() + 3_600_000),
                  opts.consumed === true ? new Date() : null,
                ],
              )
            ).rows,
            'token',
          ).id;
        const audit = async (
          action: string,
          entityType: string,
          entityId: string,
          companyId: string | null,
          changedFields?: Record<string, unknown>,
        ) =>
          client.query(
            `INSERT INTO "AuditLog" (id,"eventKey","action","entityType","entityId","companyId","actorId","actorType","changedFields")
             VALUES (gen_random_uuid(),gen_random_uuid()::text,$1,$2,$3::uuid,$4::uuid,'mig-fixture','SYSTEM',$5::jsonb)`,
            [
              action,
              entityType,
              entityId,
              companyId,
              changedFields === undefined ? null : JSON.stringify(changedFields),
            ],
          );

        const tok = async (id: string) =>
          one(
            (
              await client.query<{
                purpose: string | null;
                companyId: string | null;
                employeeId: string | null;
                consumedAt: Date | null;
              }>(
                `SELECT purpose,"companyId","employeeId","consumedAt" FROM "ClaimToken" WHERE id=$1`,
                [id],
              )
            ).rows,
            'token-read',
          );

        // --- Fixtures -------------------------------------------------------
        const coA = await mkCo('MIG-A');
        const coB = await mkCo('MIG-B');
        const coPlat = await mkCo('MIG-PLAT', true);

        // T1: consumed legacy — history must be preserved untouched.
        const p1 = await mk('mig-t1@mig.test');
        const e1 = await mkEmp(coA, p1, 'MT1');
        const t1 = await mkTok(p1, 'f1'.repeat(32), { consumed: true });
        await audit('EMPLOYEE_INVITED', 'EMPLOYEE', e1, coA);

        // T2: expired live, no evidence → closed.
        const p2 = await mk('mig-t2@mig.test');
        await mkEmp(coA, p2, 'MT2');
        const t2 = await mkTok(p2, 'f2'.repeat(32), { expired: true });

        // T3: live invite — EMPLOYEE_INVITED evidence on THIS employee/company.
        const p3 = await mk('mig-t3@mig.test');
        const e3 = await mkEmp(coA, p3, 'MT3');
        const t3 = await mkTok(p3, 'f3'.repeat(32), {});
        await audit('EMPLOYEE_INVITED', 'EMPLOYEE', e3, coA);

        // T4: live onboard — CLAIM_TOKEN_REISSUED evidence on THIS principal/company.
        const p4 = await mk('mig-t4@mig.test');
        await mkEmp(coB, p4, 'MT4');
        const t4 = await mkTok(p4, 'f4'.repeat(32), {});
        await audit('CLAIM_TOKEN_REISSUED', 'PRINCIPAL', p4, coB);

        // T5: ambiguous live — single employee, zero evidence → closed.
        const p5 = await mk('mig-t5@mig.test');
        await mkEmp(coA, p5, 'MT5');
        const t5 = await mkTok(p5, 'f5'.repeat(32), {});

        // T6: contradictory — BOTH invite and onboard evidence → closed.
        const p6 = await mk('mig-t6@mig.test');
        const e6 = await mkEmp(coA, p6, 'MT6');
        const t6 = await mkTok(p6, 'f6'.repeat(32), {});
        await audit('EMPLOYEE_INVITED', 'EMPLOYEE', e6, coA);
        await audit('CLAIM_TOKEN_REISSUED', 'PRINCIPAL', p6, coA);

        // T7: multi-company principal — ambiguous by definition → closed even
        // though invite evidence exists on one of its employees.
        const p7 = await mk('mig-t7@mig.test');
        const e7a = await mkEmp(coA, p7, 'MT7A');
        await mkEmp(coB, p7, 'MT7B');
        const t7 = await mkTok(p7, 'f7'.repeat(32), {});
        await audit('EMPLOYEE_INVITED', 'EMPLOYEE', e7a, coA);

        // T8: unrelated evidence — EMPLOYEE_INVITED exists but for a DIFFERENT
        // employee/principal; must NOT classify this token.
        const p8 = await mk('mig-t8@mig.test');
        await mkEmp(coA, p8, 'MT8');
        const t8 = await mkTok(p8, 'f8'.repeat(32), {});
        // (e3's invite audit above is the unrelated evidence for p8's token)

        // T9: platform-company employee — never a tenant token → closed.
        const p9 = await mk('mig-t9@mig.test');
        const e9 = await mkEmp(coPlat, p9, 'MT9');
        const t9 = await mkTok(p9, 'f9'.repeat(32), {});
        await audit('EMPLOYEE_INVITED', 'EMPLOYEE', e9, coPlat);

        // --- Replay the migration's classification block --------------------
        for (const stmt of statements) {
          await client.query(stmt);
        }

        // --- Assertions -----------------------------------------------------
        const r1 = await tok(t1);
        expect(r1.purpose).toBeNull(); // consumed history untouched
        expect(r1.consumedAt).not.toBeNull();

        const r2 = await tok(t2);
        expect(r2.purpose).toBeNull();
        expect(r2.consumedAt).not.toBeNull(); // closed

        const r3 = await tok(t3);
        expect(r3.purpose).toBe('EMPLOYEE_INVITE');
        expect(r3.companyId).toBe(coA);
        expect(r3.employeeId).toBe(e3);
        expect(r3.consumedAt).toBeNull(); // still usable

        const r4 = await tok(t4);
        expect(r4.purpose).toBe('COMPANY_ONBOARD');
        expect(r4.companyId).toBe(coB);
        expect(r4.employeeId).toBeNull();
        expect(r4.consumedAt).toBeNull();

        for (const [id, tag] of [
          [t5, 'T5 no-evidence'],
          [t6, 'T6 contradictory'],
          [t7, 'T7 multi-company'],
          [t8, 'T8 unrelated-evidence'],
          [t9, 'T9 platform-company'],
        ] as const) {
          const r = await tok(id);
          expect(r.purpose, tag).toBeNull();
          expect(r.consumedAt, tag).not.toBeNull();
        }

        // Invariant: zero unclassified unconsumed rows remain.
        const left = await client.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM "ClaimToken" WHERE "consumedAt" IS NULL AND purpose IS NULL`,
        );
        expect(one(left.rows, 'count').n).toBe('0');
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }
    },
  );
});
