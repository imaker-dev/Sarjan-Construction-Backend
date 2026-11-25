// Scheduled-end auto clock-out on real PostgreSQL: due selection by pinned
// autoClockOutMode/scheduledEndAt, AFTER_GRACE window arithmetic, conditional
// close idempotency under repeated and concurrent worker ticks, and tenant
// isolation. Runs only against the guarded target (loopback :55432, db
// erp_test) — skips silently when TEST_DATABASE_URL is unset or points
// anywhere else.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { AttendanceService } from '../../src/modules/attendance/service.js';
import { PrismaAttendanceUnitOfWork } from '../../src/modules/attendance/repository.js';
import { resolveTestDbUrl } from './test-db-url.js';

const url = resolveTestDbUrl(process.env.TEST_DATABASE_URL);
const run = url === null ? it.skip : it;

let prisma: PrismaClient | undefined;
let pool: pg.Pool | undefined;
let service: AttendanceService | undefined;
let companyId = '';
let otherCompanyId = '';
let siteId = '';
let otherEmployeeId = '';
let policyId = '';
let otherPolicyId = '';
let otherHeadOfficeId = '';
let revisionId = '';
let empSeq = 0;

const MIN = 60_000;

const mkEmployee = async (cid: string) => {
  if (prisma === undefined) throw new Error('unreachable');
  empSeq += 1;
  const emp = await prisma.employee.create({
    data: { companyId: cid, employeeCode: `E${empSeq}`, displayName: `Worker ${empSeq}` },
  });
  return emp.id;
};

const mkSession = (over: Record<string, unknown> = {}) => {
  if (prisma === undefined) throw new Error('unreachable');
  const p = prisma;
  const now = Date.now();
  return mkEmployee(companyId).then((empId) =>
    p.attendanceSession.create({
      data: {
        companyId,
        employeeId: empId,
        siteId,
        policyId,
        businessDate: '2026-11-25',
        punchInAt: new Date(now - 10 * 60 * MIN),
        scheduledEndAt: new Date(now - 5 * MIN),
        autoClockOutMode: 'AT_SCHEDULED_END',
        scheduleRevisionId: revisionId,
        ...over,
      },
    }),
  );
};

beforeAll(async () => {
  if (url === null) return;
  pool = new pg.Pool({ connectionString: url });
  prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  service = new AttendanceService(new PrismaAttendanceUnitOfWork(prisma), {
    assertPermission: async () => undefined,
  });

  const company = await prisma.company.create({ data: { code: 'AC-T1', name: 'AC Test Co' } });
  companyId = company.id;
  const other = await prisma.company.create({ data: { code: 'AC-T2', name: 'AC Other Co' } });
  otherCompanyId = other.id;
  const ho = await prisma.headOffice.create({
    data: { companyId, code: 'HO1', name: 'HO', isPrimary: true },
  });
  const project = await prisma.project.create({
    data: { companyId, headOfficeId: ho.id, code: 'P1', name: 'P1', timezone: 'Asia/Kolkata' },
  });
  const site = await prisma.site.create({
    data: { companyId, projectId: project.id, code: 'S1', name: 'S1' },
  });
  siteId = site.id;
  otherEmployeeId = await mkEmployee(otherCompanyId);
  const policy = await prisma.attendancePolicy.create({
    data: { companyId, name: 'Default' },
  });
  policyId = policy.id;
  const otherPolicy = await prisma.attendancePolicy.create({
    data: { companyId: otherCompanyId, name: 'Default' },
  });
  otherPolicyId = otherPolicy.id;
  const otherHo = await prisma.headOffice.create({
    data: { companyId: otherCompanyId, code: 'HO2', name: 'HO2', isPrimary: true },
  });
  otherHeadOfficeId = otherHo.id;
  const schedule = await prisma.workSchedule.create({
    data: { companyId, name: 'site-8-17', effectiveFrom: new Date('2025-01-01T00:00:00Z') },
  });
  const revision = await prisma.workScheduleRevision.create({
    data: {
      scheduleId: schedule.id,
      companyId,
      revision: 1,
      effectiveFrom: new Date('2025-01-01T00:00:00Z'),
      timezone: 'Asia/Kolkata',
      workingWeekdays: [0, 1, 2, 3, 4, 5, 6],
      scheduledStartMins: 480,
      scheduledEndMins: 1020,
      breakWindowMode: 'FIXED_WINDOW',
      breakWindowStartMins: 780,
      breakWindowEndMins: 840,
      breakDurationMins: 60,
      autoClockOutMode: 'AT_SCHEDULED_END',
    },
  });
  revisionId = revision.id;
});

afterAll(async () => {
  if (prisma !== undefined && pool !== undefined) {
    for (const cid of [companyId, otherCompanyId]) {
      await prisma.dailySiteReport.deleteMany({ where: { companyId: cid } });
      await prisma.attendanceSession.deleteMany({ where: { companyId: cid } });
      await prisma.workScheduleRevision.deleteMany({ where: { companyId: cid } });
      await prisma.workSchedule.deleteMany({ where: { companyId: cid } });
      await prisma.attendancePolicy.deleteMany({ where: { companyId: cid } });
      await prisma.employee.deleteMany({ where: { companyId: cid } });
      await prisma.site.deleteMany({ where: { companyId: cid } });
      await prisma.project.deleteMany({ where: { companyId: cid } });
      await prisma.headOffice.deleteMany({ where: { companyId: cid } });
      await prisma.auditLog.deleteMany({ where: { companyId: cid } });
      await prisma.company.deleteMany({ where: { id: cid } });
    }
    await prisma.$disconnect();
    await pool.end();
  }
});

describe('scheduled-end auto clock-out (real PostgreSQL)', () => {
  run('closes only due sessions; repeated and concurrent runs are idempotent', async () => {
    if (prisma === undefined || service === undefined) throw new Error('unreachable');
    const now = Date.now();
    const due = await mkSession();
    // Not yet at scheduled end.
    await mkSession({ scheduledEndAt: new Date(now + 2 * 60 * MIN) });
    // DISABLED mode never auto-closes even when past end.
    await mkSession({
      scheduledEndAt: new Date(now - 60 * MIN),
      autoClockOutMode: 'DISABLED',
    });
    // AFTER_GRACE: end passed but grace has not.
    await mkSession({
      scheduledEndAt: new Date(now - 5 * MIN),
      autoClockOutMode: 'AFTER_GRACE',
      autoClockOutGraceMins: 30,
    });
    // Cross-tenant: due in another company — untouched by a scoped sweep.
    const foreign = await prisma.attendanceSession.create({
      data: {
        companyId: otherCompanyId,
        employeeId: otherEmployeeId,
        policyId: otherPolicyId,
        headOfficeId: otherHeadOfficeId,
        businessDate: '2026-11-25',
        punchInAt: new Date(now - 10 * 60 * MIN),
        scheduledEndAt: new Date(now - 5 * MIN),
        autoClockOutMode: 'AT_SCHEDULED_END',
      },
    });

    const first = await service.closeSessionsAtScheduledEnd(companyId);
    expect(first.closed).toBe(1);

    // Repeat run must be a no-op.
    const second = await service.closeSessionsAtScheduledEnd(companyId);
    expect(second.closed).toBe(0);

    const closed = await prisma.attendanceSession.findFirstOrThrow({
      where: { id: due.id, companyId },
    });
    expect(closed.status).toBe('AUTO_CLOSED');
    expect(closed.autoClosedBy).toBe('SCHEDULED_END');
    expect(closed.punchOutAt?.getTime()).toBe(closed.scheduledEndAt?.getTime());
    expect(closed.isFlagged).toBe(true);
    expect(closed.flagReason).toContain('Auto-closed at scheduled shift end');

    const audit = await prisma.auditLog.findFirst({
      where: { companyId, action: 'ATTENDANCE_AUTO_CLOCK_OUT', entityId: due.id },
    });
    expect(audit).not.toBeNull();

    const survivors = await prisma.attendanceSession.findMany({
      where: { companyId, status: 'IN_PROGRESS' },
    });
    expect(survivors).toHaveLength(3);
    const foreignRow = await prisma.attendanceSession.findFirstOrThrow({
      where: { id: foreign.id, companyId: otherCompanyId },
    });
    expect(foreignRow.status).toBe('IN_PROGRESS');

    // Concurrent ticks over a fresh due session — exactly one wins the
    // conditional status update; the loser sees count 0.
    const race = await mkSession();
    const [r1, r2] = await Promise.all([
      service.closeSessionsAtScheduledEnd(companyId),
      service.closeSessionsAtScheduledEnd(companyId),
    ]);
    expect(r1.closed + r2.closed).toBe(1);
    const raceRow = await prisma.attendanceSession.findFirstOrThrow({
      where: { id: race.id, companyId },
    });
    expect(raceRow.status).toBe('AUTO_CLOSED');
    expect(raceRow.autoClosedBy).toBe('SCHEDULED_END');
  });

  run('AFTER_GRACE closes at scheduledEnd + grace, not at scheduledEnd', async () => {
    if (prisma === undefined || service === undefined) throw new Error('unreachable');
    const now = Date.now();
    const end = new Date(now - 20 * MIN);
    const session = await mkSession({
      scheduledEndAt: end,
      autoClockOutMode: 'AFTER_GRACE',
      autoClockOutGraceMins: 15,
      scheduleRevisionId: null,
    });
    const res = await service.closeSessionsAtScheduledEnd(companyId);
    expect(res.closed).toBe(1);
    const row = await prisma.attendanceSession.findFirstOrThrow({
      where: { id: session.id, companyId },
    });
    expect(row.status).toBe('AUTO_CLOSED');
    expect(row.autoClosedBy).toBe('SCHEDULED_END');
    expect(row.punchOutAt?.getTime()).toBe(end.getTime() + 15 * MIN);
  });
});

describe('EOD settlement boundary (real Postgres)', () => {
  run('overnight session inside pinned window survives EOD settlement', async () => {
    if (prisma === undefined || service === undefined) throw new Error('unreachable');
    // Overnight stray: businessDate is long past but the pinned scheduled end
    // has NOT arrived — settlement must leave it for the worker tick.
    const running = await mkSession({
      businessDate: '2026-11-20',
      scheduledEndAt: new Date(Date.now() + 3 * 60 * MIN),
      autoClockOutMode: 'AT_SCHEDULED_END',
    });
    const due = await mkSession({
      businessDate: '2026-11-20',
      scheduledEndAt: new Date(Date.now() - 5 * MIN),
      autoClockOutMode: 'AT_SCHEDULED_END',
    });
    const unscheduled = await mkSession({
      businessDate: '2026-11-20',
      scheduledEndAt: null,
      autoClockOutMode: null,
      scheduleRevisionId: null,
    });

    await service.settleAllActiveSites(companyId);

    const [r, d, u] = await prisma.attendanceSession
      .findMany({
        where: { id: { in: [running.id, due.id, unscheduled.id] }, companyId },
      })
      .then((rows) => [
        rows.find((x) => x.id === running.id),
        rows.find((x) => x.id === due.id),
        rows.find((x) => x.id === unscheduled.id),
      ]);

    expect(r?.status).toBe('IN_PROGRESS');
    expect(r?.autoClosedBy).toBeNull();
    expect(d?.status).toBe('AUTO_CLOSED');
    expect(d?.autoClosedBy).toBe('EOD_SETTLEMENT');
    expect(u?.status).toBe('AUTO_CLOSED');
    expect(u?.autoClosedBy).toBe('EOD_SETTLEMENT');
  });
});
