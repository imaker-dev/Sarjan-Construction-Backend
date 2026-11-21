// Disposable-database constraint checks for Milestone 2A — dynamic leave
// types + immutable policy versions. Runs only against the guarded target
// (loopback :55432, db erp_test) — skips silently when TEST_DATABASE_URL is
// unset or points anywhere else.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { PrismaLeaveUnitOfWork } from '../../src/modules/leave/repository.js';
import { resolveTestDbUrl } from './test-db-url.js';

const url = resolveTestDbUrl(process.env.TEST_DATABASE_URL);
const run = url === null ? it.skip : it;
let prisma: PrismaClient | undefined;
let pool: pg.Pool | undefined;
let companyId = '';
let otherCompanyId = '';
let departmentId = '';
let typeDefId = '';
let policyId = '';

beforeAll(async () => {
  if (url === null) return;
  pool = new pg.Pool({ connectionString: url });
  prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

  const company = await prisma.company.create({ data: { code: 'LP-TEST', name: 'LP Test Co' } });
  companyId = company.id;
  const other = await prisma.company.create({ data: { code: 'LP-OTHER', name: 'LP Other' } });
  otherCompanyId = other.id;
  const dept = await prisma.department.create({
    data: {
      company: { connect: { id: companyId } },
      scopeType: 'COMPANY',
      code: 'OPS',
      name: 'Operations',
      status: 'ACTIVE',
    },
  });
  departmentId = dept.id;
  const def = await prisma.leaveTypeDef.create({
    data: {
      company: { connect: { id: companyId } },
      code: 'CL',
      name: 'Casual Leave',
      leaveType: 'CASUAL',
    },
  });
  typeDefId = def.id;
  const policy = await prisma.leavePolicy.create({
    data: {
      company: { connect: { id: companyId } },
      scopeType: 'COMPANY',
      typeDef: { connect: { id_companyId: { id: typeDefId, companyId } } },
      name: 'Company CL',
    },
  });
  policyId = policy.id;
});

afterAll(async () => {
  if (prisma !== undefined && pool !== undefined) {
    await prisma.leavePolicyVersion.deleteMany({
      where: { companyId: { in: [companyId, otherCompanyId] } },
    });
    await prisma.leavePolicy.deleteMany({
      where: { companyId: { in: [companyId, otherCompanyId] } },
    });
    await prisma.leaveTypeDef.deleteMany({
      where: { companyId: { in: [companyId, otherCompanyId] } },
    });
    await prisma.department.deleteMany({ where: { companyId } });
    await prisma.auditLog.deleteMany({ where: { companyId: { in: [companyId, otherCompanyId] } } });
    await prisma.company.deleteMany({ where: { id: { in: [companyId, otherCompanyId] } } });
    await prisma.$disconnect();
    await pool.end();
  }
});

describe('leave policy constraints (real PostgreSQL)', () => {
  run('lpv_mode_fields enforces mode-specific columns', async () => {
    if (prisma === undefined) throw new Error('unreachable');

    // MONTHLY_CREDIT without the credit amount — rejected.
    await expect(
      prisma.$executeRaw`
        INSERT INTO "LeavePolicyVersion"
          (id, "policyId", "companyId", version, "effectiveFrom", mode, "createdAt")
        VALUES (gen_random_uuid(), ${policyId}::uuid, ${companyId}::uuid,
                90, '2030-01-01', 'MONTHLY_CREDIT'::"LeaveAccrualMode", now())
      `,
    ).rejects.toThrow();

    // MONTHLY_CREDIT carrying ratio fields — contradictory, rejected.
    await expect(
      prisma.$executeRaw`
        INSERT INTO "LeavePolicyVersion"
          (id, "policyId", "companyId", version, "effectiveFrom", mode,
           "monthlyCreditAmount", "ratioThresholdDays", "ratioEarnedAmount", "createdAt")
        VALUES (gen_random_uuid(), ${policyId}::uuid, ${companyId}::uuid,
                91, '2030-01-01', 'MONTHLY_CREDIT'::"LeaveAccrualMode", 4, 20, 1, now())
      `,
    ).rejects.toThrow();

    // WORKED_DAYS_RATIO missing the earned amount — rejected.
    await expect(
      prisma.$executeRaw`
        INSERT INTO "LeavePolicyVersion"
          (id, "policyId", "companyId", version, "effectiveFrom", mode,
           "ratioThresholdDays", "createdAt")
        VALUES (gen_random_uuid(), ${policyId}::uuid, ${companyId}::uuid,
                92, '2030-01-01', 'WORKED_DAYS_RATIO'::"LeaveAccrualMode", 20, now())
      `,
    ).rejects.toThrow();

    // NONE carrying an accrual parameter — rejected.
    await expect(
      prisma.$executeRaw`
        INSERT INTO "LeavePolicyVersion"
          (id, "policyId", "companyId", version, "effectiveFrom", mode,
           "monthlyCreditAmount", "createdAt")
        VALUES (gen_random_uuid(), ${policyId}::uuid, ${companyId}::uuid,
                93, '2030-01-01', 'NONE'::"LeaveAccrualMode", 1, now())
      `,
    ).rejects.toThrow();

    // Valid rows — one per mode.
    await prisma.leavePolicyVersion.create({
      data: {
        policy: { connect: { id_companyId: { id: policyId, companyId } } },
        company: { connect: { id: companyId } },
        version: 1,
        effectiveFrom: new Date('2026-01-01T00:00:00Z'),
        mode: 'NONE',
      },
    });
    await prisma.leavePolicyVersion.create({
      data: {
        policy: { connect: { id_companyId: { id: policyId, companyId } } },
        company: { connect: { id: companyId } },
        version: 2,
        effectiveFrom: new Date('2026-06-01T00:00:00Z'),
        mode: 'MONTHLY_CREDIT',
        monthlyCreditAmount: 4,
      },
    });
    await prisma.leavePolicyVersion.create({
      data: {
        policy: { connect: { id_companyId: { id: policyId, companyId } } },
        company: { connect: { id: companyId } },
        version: 3,
        effectiveFrom: new Date('2026-09-01T00:00:00Z'),
        mode: 'WORKED_DAYS_RATIO',
        ratioThresholdDays: 20,
        ratioEarnedAmount: 1,
      },
    });
  });

  run('(policyId, version) is unique across ACTIVE and ARCHIVED rows', async () => {
    if (prisma === undefined) throw new Error('unreachable');
    // Version 1 already exists from the previous test (and even archived
    // versions must keep their slot — history is immutable).
    await expect(
      prisma.leavePolicyVersion.create({
        data: {
          policy: { connect: { id_companyId: { id: policyId, companyId } } },
          company: { connect: { id: companyId } },
          version: 1,
          effectiveFrom: new Date('2026-02-01T00:00:00Z'),
          mode: 'NONE',
          status: 'ARCHIVED',
        },
      }),
    ).rejects.toThrow();
  });

  run('one ACTIVE typed policy per (typeDef, scope target)', async () => {
    if (prisma === undefined) throw new Error('unreachable');
    // The beforeAll COMPANY policy is ACTIVE — a second ACTIVE COMPANY policy
    // on the same typeDef is rejected.
    await expect(
      prisma.leavePolicy.create({
        data: {
          company: { connect: { id: companyId } },
          scopeType: 'COMPANY',
          typeDef: { connect: { id_companyId: { id: typeDefId, companyId } } },
          name: 'duplicate',
        },
      }),
    ).rejects.toThrow();

    // An inactive one coexists (superseded config is retained, not deleted).
    const inactive = await prisma.leavePolicy.create({
      data: {
        company: { connect: { id: companyId } },
        scopeType: 'COMPANY',
        typeDef: { connect: { id_companyId: { id: typeDefId, companyId } } },
        name: 'superseded',
        isActive: false,
      },
    });
    // A different scope target on the same type is fine.
    const deptPolicy = await prisma.leavePolicy.create({
      data: {
        company: { connect: { id: companyId } },
        scopeType: 'DEPARTMENT',
        department: { connect: { id_companyId: { id: departmentId, companyId } } },
        typeDef: { connect: { id_companyId: { id: typeDefId, companyId } } },
        name: 'dept CL',
      },
    });
    expect(deptPolicy.scopeType).toBe('DEPARTMENT');
    await prisma.leavePolicy.delete({ where: { id: inactive.id } });
    await prisma.leavePolicy.delete({ where: { id: deptPolicy.id } });
  });

  run('LeaveTypeDef (companyId, code) and (companyId, leaveType) are unique', async () => {
    if (prisma === undefined) throw new Error('unreachable');
    await expect(
      prisma.leaveTypeDef.create({
        data: { company: { connect: { id: companyId } }, code: 'CL', name: 'dup code' },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.leaveTypeDef.create({
        data: {
          company: { connect: { id: companyId } },
          code: 'CAS2',
          name: 'dup enum',
          leaveType: 'CASUAL',
        },
      }),
    ).rejects.toThrow();
    // A custom type with no enum mapping is fine (and can repeat).
    const custom = await prisma.leaveTypeDef.create({
      data: { company: { connect: { id: companyId } }, code: 'MIL', name: 'Milestone' },
    });
    await prisma.leaveTypeDef.delete({ where: { id: custom.id } });
  });

  run('composite same-company FKs reject cross-company references', async () => {
    if (prisma === undefined) throw new Error('unreachable');
    // Policy → typeDef from another company.
    const foreignDef = await prisma.leaveTypeDef.create({
      data: { company: { connect: { id: otherCompanyId } }, code: 'X1', name: 'Foreign' },
    });
    await expect(
      prisma.$executeRaw`
        INSERT INTO "LeavePolicy" (id, "companyId", "scopeType", "typeDefId", name, "updatedAt")
        VALUES (gen_random_uuid(), ${companyId}::uuid,
                'COMPANY'::"AttendancePolicyScope", ${foreignDef.id}::uuid, 'x', now())
      `,
    ).rejects.toThrow();

    // Policy → department from another company.
    const foreignDept = await prisma.department.create({
      data: {
        company: { connect: { id: otherCompanyId } },
        scopeType: 'COMPANY',
        code: 'FD',
        name: 'Foreign Dept',
        status: 'ACTIVE',
      },
    });
    await expect(
      prisma.$executeRaw`
        INSERT INTO "LeavePolicy" (id, "companyId", "scopeType", "departmentId", name, "updatedAt")
        VALUES (gen_random_uuid(), ${companyId}::uuid,
                'DEPARTMENT'::"AttendancePolicyScope", ${foreignDept.id}::uuid, 'x', now())
      `,
    ).rejects.toThrow();

    // Version → policy from another company.
    const foreignPolicy = await prisma.leavePolicy.create({
      data: {
        company: { connect: { id: otherCompanyId } },
        scopeType: 'COMPANY',
        name: 'foreign',
      },
    });
    await expect(
      prisma.$executeRaw`
        INSERT INTO "LeavePolicyVersion"
          (id, "policyId", "companyId", version, "effectiveFrom", mode, "createdAt")
        VALUES (gen_random_uuid(), ${foreignPolicy.id}::uuid, ${companyId}::uuid,
                1, '2030-01-01', 'NONE'::"LeaveAccrualMode", now())
      `,
    ).rejects.toThrow();

    await prisma.department.delete({ where: { id: foreignDept.id } });
    await prisma.leavePolicy.delete({ where: { id: foreignPolicy.id } });
  });

  run('scope shape: DEPARTMENT needs departmentId, COMPANY forbids refs', async () => {
    if (prisma === undefined) throw new Error('unreachable');
    await expect(
      prisma.$executeRaw`
        INSERT INTO "LeavePolicy" (id, "companyId", "scopeType", name, "updatedAt")
        VALUES (gen_random_uuid(), ${companyId}::uuid,
                'DEPARTMENT'::"AttendancePolicyScope", 'x', now())
      `,
    ).rejects.toThrow();
    await expect(
      prisma.$executeRaw`
        INSERT INTO "LeavePolicy" (id, "companyId", "scopeType", "departmentId", name, "updatedAt")
        VALUES (gen_random_uuid(), ${companyId}::uuid,
                'COMPANY'::"AttendancePolicyScope", ${departmentId}::uuid, 'x', now())
      `,
    ).rejects.toThrow();
  });

  run('DEPARTMENT policies resolve for request gating; no dept context fails closed', async () => {
    if (prisma === undefined) throw new Error('unreachable');
    const uow = new PrismaLeaveUnitOfWork(prisma);
    // Mirror what the service does: an enum-mapped typeDef copies leaveType
    // onto the policy row so the request flow can gate on it.
    const deptPolicy = await prisma.leavePolicy.create({
      data: {
        company: { connect: { id: companyId } },
        scopeType: 'DEPARTMENT',
        department: { connect: { id_companyId: { id: departmentId, companyId } } },
        typeDef: { connect: { id_companyId: { id: typeDefId, companyId } } },
        leaveType: 'CASUAL',
        name: 'dept CL gate',
      },
    });

    const employeeId = '00000000-0000-4000-8000-0000000000ee';
    const resolved = await uow.run((repos) =>
      repos.policies.resolveEffective(companyId, 'CASUAL', {
        employeeId,
        departmentId,
      }),
    );
    expect(resolved.id).toBe(deptPolicy.id);

    // Same query without a department context must NOT pick the dept policy —
    // departments are isolated; absent membership context fails closed.
    await expect(
      uow.run((repos) => repos.policies.resolveEffective(companyId, 'CASUAL', { employeeId })),
    ).rejects.toThrow();

    await prisma.leavePolicy.delete({ where: { id: deptPolicy.id } });
  });

  run('two ACTIVE versions cannot share effectiveFrom; cancelled versions do', async () => {
    if (prisma === undefined) throw new Error('unreachable');
    // Versions 1–3 exist (earlier test). Add another ACTIVE row reusing an
    // existing effectiveFrom — ambiguous effective-date match, rejected.
    await expect(
      prisma.leavePolicyVersion.create({
        data: {
          policy: { connect: { id_companyId: { id: policyId, companyId } } },
          company: { connect: { id: companyId } },
          version: 4,
          effectiveFrom: new Date('2026-06-01T00:00:00Z'),
          mode: 'NONE',
        },
      }),
    ).rejects.toThrow();
    // The same date is free once the earlier row is cancelled — archive v2
    // then re-add a version on 2026-06-01.
    const v2 = await prisma.leavePolicyVersion.findFirstOrThrow({
      where: { policyId, version: 2 },
    });
    await prisma.leavePolicyVersion.update({
      where: { id: v2.id },
      data: { status: 'ARCHIVED' },
    });
    const replacement = await prisma.leavePolicyVersion.create({
      data: {
        policy: { connect: { id_companyId: { id: policyId, companyId } } },
        company: { connect: { id: companyId } },
        version: 5,
        effectiveFrom: new Date('2026-06-01T00:00:00Z'),
        mode: 'NONE',
      },
    });
    expect(replacement.status).toBe('ACTIVE');
    // History is preserved: the cancelled row is still there.
    const archived = await prisma.leavePolicyVersion.findUnique({ where: { id: v2.id } });
    expect(archived?.status).toBe('ARCHIVED');
  });

  run('membership resolution is effective-dated (asOf + window covering)', async () => {
    if (prisma === undefined) throw new Error('unreachable');
    const uow = new PrismaLeaveUnitOfWork(prisma);
    const emp = await prisma.employee.create({
      data: { company: { connect: { id: companyId } }, employeeCode: 'MLV1', displayName: 'M Lv' },
    });
    const dept2 = await prisma.department.create({
      data: {
        company: { connect: { id: companyId } },
        scopeType: 'COMPANY',
        code: 'HR',
        name: 'HR',
        status: 'ACTIVE',
      },
    });
    // Membership in dept1 Jan→Jun, dept2 from Jul (a mid-year transfer).
    await prisma.departmentMembership.create({
      data: {
        company: { connect: { id: companyId } },
        employee: { connect: { id_companyId: { id: emp.id, companyId } } },
        department: { connect: { id_companyId: { id: departmentId, companyId } } },
        isPrimary: true,
        startedAt: new Date('2026-01-01T00:00:00Z'),
        endedAt: new Date('2026-06-30T00:00:00Z'),
      },
    });
    await prisma.departmentMembership.create({
      data: {
        company: { connect: { id: companyId } },
        employee: { connect: { id_companyId: { id: emp.id, companyId } } },
        department: { connect: { id_companyId: { id: dept2.id, companyId } } },
        isPrimary: true,
        startedAt: new Date('2026-07-01T00:00:00Z'),
      },
    });

    // asOf in the first window → dept1; in the second → dept2.
    const march = await uow.run((r) =>
      r.memberships.findActiveByEmployee(companyId, emp.id, new Date('2026-03-15T00:00:00Z')),
    );
    expect(march.map((m) => m.departmentId)).toEqual([departmentId]);
    const august = await uow.run((r) =>
      r.memberships.findActiveByEmployee(companyId, emp.id, new Date('2026-08-15T00:00:00Z')),
    );
    expect(august.map((m) => m.departmentId)).toEqual([dept2.id]);

    // No single membership covers a window spanning the transfer.
    const spanning = await uow.run((r) =>
      r.memberships.findCoveringByEmployee(
        companyId,
        emp.id,
        new Date('2026-05-01T00:00:00Z'),
        new Date('2026-08-01T00:00:00Z'),
      ),
    );
    expect(spanning).toEqual([]);
    // A window inside the first stint is covered by dept1 only.
    const inside = await uow.run((r) =>
      r.memberships.findCoveringByEmployee(
        companyId,
        emp.id,
        new Date('2026-02-01T00:00:00Z'),
        new Date('2026-05-01T00:00:00Z'),
      ),
    );
    expect(inside.map((m) => m.departmentId)).toEqual([departmentId]);

    await prisma.departmentMembership.deleteMany({ where: { employeeId: emp.id } });
    await prisma.employee.delete({ where: { id_companyId: { id: emp.id, companyId } } });
    await prisma.department.delete({ where: { id_companyId: { id: dept2.id, companyId } } });
  });
});
