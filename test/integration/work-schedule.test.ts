// Disposable-database constraint checks for the dynamic work-schedule
// foundation (identity + immutable revisions + overrides + categories).
// Runs only against the guarded target (loopback :55432, db erp_test) — skips
// silently when TEST_DATABASE_URL is unset or points anywhere else.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { resolveTestDbUrl } from './test-db-url.js';

const url = resolveTestDbUrl(process.env.TEST_DATABASE_URL);
const run = url === null ? it.skip : it;
let prisma: PrismaClient | undefined;
let pool: pg.Pool | undefined;
let companyId = '';
let departmentId = '';
let calendarId = '';
let categoryId = '';

const SCHEDULE_BASE = {
  name: 's',
  effectiveFrom: new Date('2026-01-01T00:00:00Z'),
};

const REVISION_BASE = {
  revision: 1,
  effectiveFrom: new Date('2026-01-01T00:00:00Z'),
  timezone: 'Asia/Kolkata',
  workingWeekdays: [1, 2, 3, 4, 5],
};

beforeAll(async () => {
  if (url === null) return;
  pool = new pg.Pool({ connectionString: url });
  prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

  const company = await prisma.company.create({ data: { code: 'WS-TEST', name: 'WS Test Co' } });
  companyId = company.id;
  const dept = await prisma.department.create({
    data: {
      company: { connect: { id: companyId } },
      scopeType: 'COMPANY',
      code: 'FIN',
      name: 'Finance',
      status: 'ACTIVE',
    },
  });
  departmentId = dept.id;
  const calendar = await prisma.holidayCalendar.create({
    data: { company: { connect: { id: companyId } }, code: 'STD', name: 'Standard' },
  });
  calendarId = calendar.id;
  const category = await prisma.holidayCategory.create({
    data: {
      company: { connect: { id: companyId } },
      code: 'national',
      name: 'National',
    },
  });
  categoryId = category.id;
});

afterAll(async () => {
  if (prisma !== undefined && pool !== undefined) {
    await prisma.workScheduleOverride.deleteMany({ where: { companyId } });
    await prisma.workScheduleRevision.deleteMany({ where: { companyId } });
    await prisma.workSchedule.deleteMany({ where: { companyId } });
    await prisma.holiday.deleteMany({ where: { companyId } });
    await prisma.holidayCategory.deleteMany({ where: { companyId } });
    await prisma.holidayCalendar.deleteMany({ where: { companyId } });
    await prisma.department.deleteMany({ where: { companyId } });
    await prisma.auditLog.deleteMany({ where: { companyId } });
    await prisma.company.deleteMany({ where: { id: companyId } });
    await prisma.$disconnect();
    await pool.end();
  }
});

describe('work schedule constraints (real PostgreSQL)', () => {
  run('overlapping ACTIVE schedules at the same target are rejected', async () => {
    if (prisma === undefined) throw new Error('unreachable');
    await prisma.workSchedule.create({
      data: {
        ...SCHEDULE_BASE,
        company: { connect: { id: companyId } },
        department: { connect: { id_companyId: { id: departmentId, companyId } } },
        scopeType: 'DEPARTMENT',
        effectiveTo: new Date('2026-06-30T00:00:00Z'),
      },
    });
    // Overlapping range at same target → exclusion violation.
    await expect(
      prisma.workSchedule.create({
        data: {
          ...SCHEDULE_BASE,
          company: { connect: { id: companyId } },
          department: { connect: { id_companyId: { id: departmentId, companyId } } },
          scopeType: 'DEPARTMENT',
          effectiveFrom: new Date('2026-03-01T00:00:00Z'),
        },
      }),
    ).rejects.toThrow();
    // Non-overlapping range at same target → allowed.
    await prisma.workSchedule.create({
      data: {
        ...SCHEDULE_BASE,
        company: { connect: { id: companyId } },
        department: { connect: { id_companyId: { id: departmentId, companyId } } },
        scopeType: 'DEPARTMENT',
        effectiveFrom: new Date('2026-07-01T00:00:00Z'),
      },
    });
    expect(await prisma.workSchedule.count({ where: { companyId } })).toBe(2);
  });

  run('scope shape CHECK rejects mismatched refs', async () => {
    if (prisma === undefined) throw new Error('unreachable');
    // DEPARTMENT scope without departmentId → CHECK violation.
    await expect(
      prisma.workSchedule.create({
        data: {
          ...SCHEDULE_BASE,
          company: { connect: { id: companyId } },
          scopeType: 'DEPARTMENT',
        } as never,
      }),
    ).rejects.toThrow();
    // COMPANY scope with an employeeId → CHECK violation.
    const emp = await prisma.employee.create({
      data: {
        company: { connect: { id: companyId } },
        employeeCode: 'E1',
        displayName: 'E One',
      },
    });
    await expect(
      prisma.workSchedule.create({
        data: {
          ...SCHEDULE_BASE,
          company: { connect: { id: companyId } },
          scopeType: 'COMPANY',
          employee: { connect: { id_companyId: { id: emp.id, companyId } } },
        },
      }),
    ).rejects.toThrow();
    await prisma.employee.delete({ where: { id_companyId: { id: emp.id, companyId } } });
  });

  run('revision CHECKs: weekday range, working source, rotation all-or-nothing', async () => {
    if (prisma === undefined) throw new Error('unreachable');
    const parent = await prisma.workSchedule.create({
      data: {
        ...SCHEDULE_BASE,
        name: 'rev-parent',
        company: { connect: { id: companyId } },
        scopeType: 'COMPANY',
        effectiveTo: new Date('2026-01-31T00:00:00Z'),
      },
    });
    const db = prisma;
    const make = (data: Record<string, unknown>) =>
      db.workScheduleRevision.create({
        data: {
          ...REVISION_BASE,
          schedule: {
            connect: { id_companyId: { id: parent.id, companyId } },
          },
          company: { connect: { id: companyId } },
          ...data,
        } as never,
      });
    // Out-of-range weekday.
    await expect(make({ workingWeekdays: [1, 2, 7] })).rejects.toThrow();
    // No working source at all.
    await expect(make({ workingWeekdays: [] })).rejects.toThrow();
    // Rotation anchor without length → all-or-nothing violation.
    await expect(
      make({
        revision: 2,
        rotationAnchor: new Date('2026-01-10T00:00:00Z'),
      }),
    ).rejects.toThrow();
    // Valid anchored rotation: 14-day cycle, offset 0 forced off.
    const ok = await make({
      revision: 2,
      workingWeekdays: [1, 2, 3, 4, 5, 6],
      rotationAnchor: new Date('2026-01-10T00:00:00Z'),
      rotationLengthDays: 14,
      rotationOffOffsets: [0],
    });
    expect(ok.id).toBeDefined();
    await prisma.workScheduleRevision.deleteMany({ where: { scheduleId: parent.id } });
    await prisma.workSchedule.delete({ where: { id: parent.id } });
  });

  run('composite FK blocks a schedule pointing at another company target', async () => {
    if (prisma === undefined) throw new Error('unreachable');
    const other = await prisma.company.create({ data: { code: 'WS-OTHER', name: 'Other' } });
    const foreignDept = await prisma.department.create({
      data: {
        company: { connect: { id: other.id } },
        scopeType: 'COMPANY',
        code: 'X',
        name: 'Foreign',
        status: 'ACTIVE',
      },
    });
    // Composite connects can't express a mismatch (companyId is shared), so
    // prove the FK at the SQL level: (foreignDept.id, companyId) has no row.
    await expect(
      prisma.$executeRaw`
        INSERT INTO "WorkSchedule"
          (id, "companyId", "scopeType", "departmentId", name,
           "effectiveFrom", "updatedAt")
        VALUES
          (gen_random_uuid(), ${companyId}::uuid, 'DEPARTMENT'::"AttendancePolicyScope",
           ${foreignDept.id}::uuid, 'x', '2026-01-01'::date, now())
      `,
    ).rejects.toThrow();
    await prisma.department.delete({
      where: { id_companyId: { id: foreignDept.id, companyId: other.id } },
    });
    await prisma.company.delete({ where: { id: other.id } });
  });

  run('holiday: one ACTIVE per (calendar,date); cancelled rows coexist; category FK', async () => {
    if (prisma === undefined) throw new Error('unreachable');
    await prisma.holiday.create({
      data: {
        company: { connect: { id: companyId } },
        calendar: { connect: { id_companyId: { id: calendarId, companyId } } },
        category: { connect: { id_companyId: { id: categoryId, companyId } } },
        date: new Date('2026-01-26T00:00:00Z'),
        name: 'Republic Day',
      },
    });
    // Second ACTIVE holiday on the same date → partial-unique violation.
    await expect(
      prisma.holiday.create({
        data: {
          company: { connect: { id: companyId } },
          calendar: { connect: { id_companyId: { id: calendarId, companyId } } },
          category: { connect: { id_companyId: { id: categoryId, companyId } } },
          date: new Date('2026-01-26T00:00:00Z'),
          name: 'Duplicate',
        },
      }),
    ).rejects.toThrow();
    // A CANCELLED (ARCHIVED) row on the same date is allowed — audit retained.
    const cancelled = await prisma.holiday.create({
      data: {
        company: { connect: { id: companyId } },
        calendar: { connect: { id_companyId: { id: calendarId, companyId } } },
        category: { connect: { id_companyId: { id: categoryId, companyId } } },
        date: new Date('2026-01-26T00:00:00Z'),
        name: 'Old Mistake',
        status: 'ARCHIVED',
        cancelledAt: new Date(),
      },
    });
    expect(cancelled.status).toBe('ARCHIVED');
    // Category code unique per company.
    await expect(
      prisma.holidayCategory.create({
        data: {
          company: { connect: { id: companyId } },
          code: 'national',
          name: 'Dup',
        },
      }),
    ).rejects.toThrow();
    // Calendar code unique per company.
    await expect(
      prisma.holidayCalendar.create({
        data: { company: { connect: { id: companyId } }, code: 'STD', name: 'Dup Code' },
      }),
    ).rejects.toThrow();
    // Cross-company category reference → composite FK violation.
    const other = await prisma.company.create({ data: { code: 'WS-O2', name: 'Other2' } });
    const foreignCat = await prisma.holidayCategory.create({
      data: { company: { connect: { id: other.id } }, code: 'x', name: 'Foreign' },
    });
    await expect(
      prisma.$executeRaw`
        INSERT INTO "Holiday"
          (id, "companyId", "calendarId", "categoryId", date, name, "updatedAt")
        VALUES
          (gen_random_uuid(), ${companyId}::uuid, ${calendarId}::uuid,
           ${foreignCat.id}::uuid, '2026-05-01'::date, 'x', now())
      `,
    ).rejects.toThrow();
    // Different company may reuse the same calendar code.
    const ok = await prisma.holidayCalendar.create({
      data: { company: { connect: { id: other.id } }, code: 'STD', name: 'Other Std' },
    });
    await prisma.holidayCalendar.delete({
      where: { id_companyId: { id: ok.id, companyId: other.id } },
    });
    await prisma.holidayCategory.delete({
      where: { id_companyId: { id: foreignCat.id, companyId: other.id } },
    });
    await prisma.company.delete({ where: { id: other.id } });
  });

  run('override: one ACTIVE per (schedule,date); cancelled rows coexist', async () => {
    if (prisma === undefined) throw new Error('unreachable');
    const parent = await prisma.workSchedule.create({
      data: {
        ...SCHEDULE_BASE,
        name: 'ovr-parent',
        effectiveFrom: new Date('2026-02-01T00:00:00Z'),
        company: { connect: { id: companyId } },
        scopeType: 'COMPANY',
      },
    });
    const date = new Date('2026-03-17T00:00:00Z');
    await prisma.workScheduleOverride.create({
      data: {
        company: { connect: { id: companyId } },
        schedule: { connect: { id_companyId: { id: parent.id, companyId } } },
        date,
        disposition: 'OFF',
        name: 'Plant shutdown',
      },
    });
    await expect(
      prisma.workScheduleOverride.create({
        data: {
          company: { connect: { id: companyId } },
          schedule: { connect: { id_companyId: { id: parent.id, companyId } } },
          date,
          disposition: 'WORKING',
        },
      }),
    ).rejects.toThrow();
    const cancelled = await prisma.workScheduleOverride.create({
      data: {
        company: { connect: { id: companyId } },
        schedule: { connect: { id_companyId: { id: parent.id, companyId } } },
        date,
        disposition: 'WORKING',
        status: 'ARCHIVED',
        cancelledAt: new Date(),
      },
    });
    expect(cancelled.status).toBe('ARCHIVED');
    await prisma.workScheduleOverride.deleteMany({ where: { scheduleId: parent.id } });
    await prisma.workSchedule.delete({ where: { id: parent.id } });
  });

  run('archived schedules still resolve for dates before archivedAt', async () => {
    if (prisma === undefined) throw new Error('unreachable');
    const { PrismaScheduleUnitOfWork } = await import('../../src/modules/schedule/repository.js');
    const uow = new PrismaScheduleUnitOfWork(prisma);
    const emp = await prisma.employee.create({
      data: {
        company: { connect: { id: companyId } },
        employeeCode: 'RETRO1',
        displayName: 'Retro One',
      },
    });
    const sched = await prisma.workSchedule.create({
      data: {
        name: 'retro',
        company: { connect: { id: companyId } },
        employee: { connect: { id_companyId: { id: emp.id, companyId } } },
        scopeType: 'EMPLOYEE',
        effectiveFrom: new Date('2026-03-01T00:00:00Z'),
        effectiveTo: new Date('2026-03-31T00:00:00Z'),
        status: 'ARCHIVED',
        archivedAt: new Date('2026-03-20T00:00:00Z'),
      },
    });
    const scope = { scopeType: 'EMPLOYEE' as const, employeeId: emp.id };
    const found = await uow.run((repos) =>
      repos.schedules.findAtScope(companyId, scope, new Date('2026-03-10T00:00:00Z')),
    );
    expect(found?.id).toBe(sched.id);
    // After the archive timestamp the schedule no longer applies.
    const after = await uow.run((repos) =>
      repos.schedules.findAtScope(companyId, scope, new Date('2026-03-25T00:00:00Z')),
    );
    expect(after).toBeNull();
    await prisma.workSchedule.delete({ where: { id: sched.id } });
    await prisma.employee.delete({
      where: { id_companyId: { id: emp.id, companyId } },
    });
  });

  run('membership lookup is effective-dated: transfer, future start, ended window', async () => {
    if (prisma === undefined) throw new Error('unreachable');
    const { PrismaScheduleUnitOfWork } = await import('../../src/modules/schedule/repository.js');
    const uow = new PrismaScheduleUnitOfWork(prisma);
    const dept2 = await prisma.department.create({
      data: {
        company: { connect: { id: companyId } },
        scopeType: 'COMPANY',
        code: 'OPS',
        name: 'Operations',
        status: 'ACTIVE',
      },
    });
    const emp = await prisma.employee.create({
      data: {
        company: { connect: { id: companyId } },
        employeeCode: 'MEM1',
        displayName: 'Member One',
      },
    });
    // Membership A (ended) at dept; membership B (current) at dept2.
    await prisma.departmentMembership.createMany({
      data: [
        {
          companyId,
          employeeId: emp.id,
          departmentId,
          isPrimary: true,
          startedAt: new Date('2026-01-01T00:00:00Z'),
          endedAt: new Date('2026-04-30T00:00:00Z'),
        },
        {
          companyId,
          employeeId: emp.id,
          departmentId: dept2.id,
          isPrimary: true,
          startedAt: new Date('2026-05-01T00:00:00Z'),
        },
      ],
    });
    const find = (asOf: Date) =>
      uow.run((repos) => repos.memberships.findActiveByEmployee(companyId, emp.id, asOf));
    // Inside A's window → dept only; B has not started.
    expect(await find(new Date('2026-03-01T00:00:00Z'))).toEqual([
      { departmentId, isPrimary: true },
    ]);
    // Inside B's window → dept2 only; A has ended.
    expect(await find(new Date('2026-07-01T00:00:00Z'))).toEqual([
      { departmentId: dept2.id, isPrimary: true },
    ]);
    // In the gap between them → nothing.
    expect(await find(new Date('2026-04-30T12:00:00Z'))).toEqual([]);
    await prisma.departmentMembership.deleteMany({ where: { companyId } });
    await prisma.employee.delete({ where: { id_companyId: { id: emp.id, companyId } } });
    await prisma.department.delete({
      where: { id_companyId: { id: dept2.id, companyId } },
    });
  });

  run('DEPARTMENT scope guards: rejected on AttendancePolicy, valid on LeavePolicy', async () => {
    if (prisma === undefined) throw new Error('unreachable');
    // Both tables share the AttendancePolicyScope enum (which now includes
    // DEPARTMENT for WorkSchedule) but have no departmentId column.
    await expect(
      prisma.$executeRaw`
        INSERT INTO "AttendancePolicy" (id, "companyId", "scope", name, "updatedAt")
        VALUES (gen_random_uuid(), ${companyId}::uuid,
                'DEPARTMENT'::"AttendancePolicyScope", 'x', now())
      `,
    ).rejects.toThrow();
    // AttendancePolicy keeps its DEPARTMENT guard (no departmentId column).
    // LeavePolicy now VALIDLY supports DEPARTMENT scope — the guard was
    // dropped when departmentId was added — but the shape CHECK requires the
    // departmentId reference.
    await expect(
      prisma.$executeRaw`
        INSERT INTO "LeavePolicy" (id, "companyId", "scopeType", "leaveType", name, "updatedAt")
        VALUES (gen_random_uuid(), ${companyId}::uuid,
                'DEPARTMENT'::"AttendancePolicyScope", 'CASUAL'::"LeaveType", 'x', now())
      `,
    ).rejects.toThrow();
    // Sanity: the same inserts succeed with a valid scope.
    await prisma.attendancePolicy.create({
      data: { company: { connect: { id: companyId } }, scope: 'COMPANY', name: 'ok' },
    });
    await prisma.leavePolicy.create({
      data: {
        company: { connect: { id: companyId } },
        scopeType: 'COMPANY',
        leaveType: 'CASUAL',
        name: 'ok',
      },
    });
    // DEPARTMENT-scoped leave policy with the matching ref is valid.
    const deptPolicy = await prisma.leavePolicy.create({
      data: {
        company: { connect: { id: companyId } },
        scopeType: 'DEPARTMENT',
        department: { connect: { id_companyId: { id: departmentId, companyId } } },
        leaveType: 'CASUAL',
        name: 'dept-ok',
      },
    });
    expect(deptPolicy.scopeType).toBe('DEPARTMENT');
    await prisma.attendancePolicy.deleteMany({ where: { companyId } });
    await prisma.leavePolicy.deleteMany({ where: { companyId } });
  });
});
