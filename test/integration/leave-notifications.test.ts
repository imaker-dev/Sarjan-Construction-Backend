// End-to-end leave notification flow on real PostgreSQL: submit emits a
// durable OutboxEvent in the SAME transaction as the request + audit row;
// the relay then materializes inbox rows, realtime publishes, and durable
// email deliveries — with eventKey dedupe and verified-address skipping.
// Runs only against the guarded disposable target (loopback :55432, db
// erp_test) — skips silently when TEST_DATABASE_URL is unset or points
// anywhere else.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { PrismaLeaveUnitOfWork } from '../../src/modules/leave/repository.js';
import { LeaveService } from '../../src/modules/leave/service.js';
import { PrismaNotificationUnitOfWork } from '../../src/modules/notification/repository.js';
import { NotificationService } from '../../src/modules/notification/service.js';
import type { ActorContext } from '../../src/modules/organization/types.js';
import { resolveTestDbUrl } from './test-db-url.js';

const url = resolveTestDbUrl(process.env.TEST_DATABASE_URL);
const run = url === null ? it.skip : it;

let prisma: PrismaClient | undefined;
let pool: pg.Pool | undefined;
let companyId = '';
let requesterId = '';
let approverId = '';
let employeeId = '';
let departmentId = '';

const emails: { to: string; subject: string; text?: string }[] = [];

beforeAll(async () => {
  if (url === null) return;
  pool = new pg.Pool({ connectionString: url });
  prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  const p = prisma;

  const company = await p.company.create({ data: { code: 'LN-TEST', name: 'LN Test Co' } });
  companyId = company.id;

  // Requester: verified EMAIL login (OTP-verified at login) → gets email.
  const requester = await p.principal.create({
    data: { loginId: 'ln-requester@test.local', loginIdType: 'EMAIL' },
  });
  requesterId = requester.id;
  // Approver: PHONE login only → delivery must be recorded SKIPPED.
  const approver = await p.principal.create({
    data: { loginId: '+910000000001', loginIdType: 'PHONE' },
  });
  approverId = approver.id;

  const dept = await p.department.create({
    data: {
      company: { connect: { id: companyId } },
      scopeType: 'COMPANY',
      code: 'HO',
      name: 'Head Office',
      status: 'ACTIVE',
    },
  });
  departmentId = dept.id;

  const emp = await p.employee.create({
    data: {
      company: { connect: { id: companyId } },
      employeeCode: 'LN-E1',
      displayName: 'LN Worker',
      principal: { connect: { id: requesterId } },
      contactEmail: 'unverified-profile@test.local',
    },
  });
  employeeId = emp.id;

  await p.departmentMembership.create({
    data: {
      company: { connect: { id: companyId } },
      department: { connect: { id_companyId: { id: departmentId, companyId } } },
      employee: { connect: { id_companyId: { id: employeeId, companyId } } },
      isPrimary: true,
      startedAt: new Date('2026-01-01T00:00:00Z'),
    },
  });

  const role = await p.role.create({
    data: { companyId, key: 'HO_ADMIN', name: 'HO Admin' },
  });
  await p.roleAssignment.create({
    data: {
      principal: { connect: { id: approverId } },
      role: { connect: { id_companyId: { id: role.id, companyId } } },
      company: { connect: { id: companyId } },
      scopeType: 'COMPANY',
    },
  });

  const typeDef = await p.leaveTypeDef.create({
    data: {
      company: { connect: { id: companyId } },
      code: 'CL',
      name: 'Casual Leave',
      leaveType: 'CASUAL',
    },
  });
  const policy = await p.leavePolicy.create({
    data: {
      company: { connect: { id: companyId } },
      scopeType: 'COMPANY',
      typeDef: { connect: { id_companyId: { id: typeDef.id, companyId } } },
      name: 'Company CL',
    },
  });
  await p.leavePolicyVersion.create({
    data: {
      company: { connect: { id: companyId } },
      policy: { connect: { id_companyId: { id: policy.id, companyId } } },
      version: 1,
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
      mode: 'NONE',
      status: 'ACTIVE',
      createdByPrincipalId: requesterId,
    },
  });
  await p.leaveBalance.create({
    data: {
      company: { connect: { id: companyId } },
      employee: { connect: { id_companyId: { id: employeeId, companyId } } },
      leaveType: 'CASUAL',
      year: 2026,
      allocatedDays: 12,
    },
  });
});

afterAll(async () => {
  if (prisma === undefined || pool === undefined) return;
  const p = prisma;
  await p.notificationEmailDelivery.deleteMany({ where: { companyId } });
  await p.notification.deleteMany({ where: { companyId } });
  await p.outboxEvent.deleteMany({ where: { companyId } });
  await p.leaveBalance.deleteMany({ where: { companyId } });
  await p.leaveRequest.deleteMany({ where: { companyId } });
  await p.leavePolicyVersion.deleteMany({ where: { companyId } });
  await p.leavePolicy.deleteMany({ where: { companyId } });
  await p.leaveTypeDef.deleteMany({ where: { companyId } });
  await p.roleAssignment.deleteMany({ where: { companyId } });
  await p.role.deleteMany({ where: { companyId } });
  await p.departmentMembership.deleteMany({ where: { companyId } });
  await p.employee.deleteMany({ where: { companyId } });
  await p.department.deleteMany({ where: { companyId } });
  await p.auditLog.deleteMany({ where: { companyId } });
  await p.principal.deleteMany({ where: { id: { in: [requesterId, approverId] } } });
  await p.company.deleteMany({ where: { id: companyId } });
  await p.$disconnect();
  await pool.end();
});

const passThroughAuth = {
  assertPermission: vi.fn().mockResolvedValue(undefined),
  hasPermission: vi.fn().mockResolvedValue(false),
};

function makeServices(published: { channel: string; message: string }[]) {
  if (prisma === undefined) throw new Error('unreachable');
  const leave = new LeaveService(new PrismaLeaveUnitOfWork(prisma), passThroughAuth);
  const notification = new NotificationService({
    uow: new PrismaNotificationUnitOfWork(prisma),
    ticketStore: { issue: async () => undefined, consume: async () => true },
    publisher: {
      publish: async (channel: string, message: string) => {
        published.push({ channel, message });
      },
    },
    signTicket: () => 'tk.test',
    buildActorContext: async (claims) => ({
      actorId: claims.sub,
      actorType: 'USER',
      sessionId: claims.sid,
    }),
    mailService: {
      sendMail: async (o: { to: string; subject: string; text?: string }) => {
        emails.push(o);
        return { success: true };
      },
    },
    appBaseUrl: 'https://erp.test.local',
  });
  return { leave, notification };
}

describe('leave notifications — durable outbox + relay (real PostgreSQL)', () => {
  run(
    'submit emits an in-transaction outbox event; relay materializes inbox + email deliveries',
    async () => {
      if (prisma === undefined) throw new Error('unreachable');
      const published: { channel: string; message: string }[] = [];
      const { leave, notification } = makeServices(published);
      const actor: ActorContext = { actorId: requesterId, actorType: 'USER' };

      const request = await leave.submitRequest(actor, companyId, {
        employeeId,
        leaveType: 'CASUAL',
        startDate: '2026-11-20',
        endDate: '2026-11-21',
        reason: 'private medical reason — must never appear in payloads',
      });
      expect(request.status).toBe('PENDING');

      // Outbox row committed atomically with the request — delivery not yet done.
      const events = await prisma.outboxEvent.findMany({
        where: { companyId, aggregateId: request.id },
      });
      expect(events).toHaveLength(1);
      expect(events[0]?.eventType).toBe('LEAVE_REQUEST_SUBMITTED');
      expect(await prisma.notification.count({ where: { companyId } })).toBe(0);
      expect(await prisma.notificationEmailDelivery.count({ where: { companyId } })).toBe(0);

      // Relay: durable inbox rows + email intents + realtime publishes.
      const batch = await notification.processBatch();
      expect(batch.delivered).toBe(1);
      const notes = await prisma.notification.findMany({ where: { companyId } });
      expect(new Set(notes.map((n) => n.recipientPrincipalId))).toEqual(
        new Set([requesterId, approverId]),
      );
      expect(published).toHaveLength(2);
      expect(new Set(published.map((m) => m.channel))).toEqual(
        new Set([`notif:${companyId}:${requesterId}`, `notif:${companyId}:${approverId}`]),
      );
      const payloadText = JSON.stringify(events[0]?.payload ?? {});
      expect(payloadText).not.toContain('private medical reason');

      // Email deliveries: requester PENDING (verified EMAIL loginId),
      // approver SKIPPED (PHONE login — no verified address).
      const deliveries = await prisma.notificationEmailDelivery.findMany({
        where: { companyId },
      });
      expect(deliveries).toHaveLength(2);
      const reqD = deliveries.find((d) => d.recipientPrincipalId === requesterId);
      const appD = deliveries.find((d) => d.recipientPrincipalId === approverId);
      if (reqD === undefined || appD === undefined) throw new Error('missing delivery rows');
      expect(reqD.status).toBe('PENDING');
      expect(reqD.toAddress).toBe('ln-requester@test.local');
      expect(reqD.toAddress).not.toBe('unverified-profile@test.local');
      expect(appD.status).toBe('SKIPPED');
      expect(appD.skipReason).toBe('NO_VERIFIED_ADDRESS');

      // Send pass: only the verified delivery is mailed — with trusted app link.
      const send = await notification.processEmailBatch();
      expect(send.sent).toBe(1);
      expect(emails).toHaveLength(1);
      expect(emails[0]?.to).toBe('ln-requester@test.local');
      expect(emails[0]?.text).toContain('https://erp.test.local/leave/requests/');
      expect(emails[0]?.text).not.toContain('private medical reason');
      expect(
        (await prisma.notificationEmailDelivery.findUnique({ where: { id: reqD.id } }))?.status,
      ).toBe('SENT');

      // Replay: reprocessing produces no duplicate rows and no second email.
      const before = await prisma.notification.count({ where: { companyId } });
      const ev = events[0];
      if (ev === undefined) throw new Error('missing outbox event');
      await prisma.outboxEvent.update({
        where: { id: ev.id },
        data: { status: 'PENDING', nextAttemptAt: new Date(Date.now() - 1000), processedAt: null },
      });
      await notification.processBatch();
      await notification.processEmailBatch();
      expect(await prisma.notification.count({ where: { companyId } })).toBe(before);
      expect(await prisma.notificationEmailDelivery.count({ where: { companyId } })).toBe(2);
      expect(emails).toHaveLength(1);
    },
  );

  run('a rolled-back transaction leaves no outbox event behind', async () => {
    if (prisma === undefined) throw new Error('unreachable');
    const uow = new PrismaLeaveUnitOfWork(prisma);
    const eventKey = `evt:leave:rollback:${Date.now()}`;
    await expect(
      uow.run(async (repos) => {
        await repos.outbox.record({
          companyId,
          eventType: 'LEAVE_REQUEST_SUBMITTED',
          aggregateType: 'LEAVE_REQUEST',
          aggregateId: '00000000-0000-4000-8000-0000000000ff',
          eventKey,
          recipientPrincipalIds: [requesterId],
          summary: {},
        });
        throw new Error('forced rollback');
      }),
    ).rejects.toThrow('forced rollback');
    expect(await prisma.outboxEvent.count({ where: { eventKey } })).toBe(0);
  });
});
