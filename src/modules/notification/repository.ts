import type {
  Notification,
  NotificationEmailDelivery,
  OutboxEvent,
  Prisma,
  PrismaClient,
} from '@prisma/client';
import { makeWorkflowInstanceRepos } from '../workflow-instance/repository.js';
import type { WorkflowInstanceRepos } from '../workflow-instance/repository.js';
import { scopedUpdate } from '../organization/repository.js';
import type { OutboxEmitInput } from './types.js';

type Tx = Prisma.TransactionClient;

export interface OutboxRepository {
  record(input: OutboxEmitInput): Promise<void>;
  /** Claim pending events — lease-safe for a single worker via row update. */
  claim(now: Date, leaseUntil: Date, limit: number): Promise<OutboxEvent[]>;
  markDone(ids: string[], processedAt: Date): Promise<void>;
  /** Per-event failure — separate tx so backoff persists after a delivery rollback. */
  recordFailure(
    id: string,
    data: { lastError: string; dead: boolean; nextAttemptAt?: Date },
  ): Promise<void>;
  reclaimExpiredLeases(now: Date): Promise<number>;
}

export interface NotificationRowRepository {
  createManySkipping(
    rows: {
      companyId: string;
      recipientPrincipalId: string;
      eventType: string;
      title: string;
      body?: string;
      resourceType: string;
      resourceId: string;
      eventKey: string;
    }[],
  ): Promise<void>;
  findUnpublished(eventKeys: string[], limit: number): Promise<Notification[]>;
  listUnpublishedAll(limit: number): Promise<Notification[]>;
  setPublished(ids: string[], at: Date): Promise<void>;
  listInbox(
    companyId: string,
    recipientPrincipalId: string,
    filter: { cursor?: { createdAt: Date; id: string }; unreadOnly?: boolean; limit: number },
  ): Promise<Notification[]>;
  markRead(
    companyId: string,
    id: string,
    recipientPrincipalId: string,
    at: Date,
    expectedVersion?: number,
  ): Promise<Notification>;
  findById(companyId: string, id: string): Promise<Notification | null>;
  /** Unread inbox count for the authenticated recipient only. */
  countUnread(companyId: string, recipientPrincipalId: string): Promise<number>;
}

export interface EmailDeliveryRepository {
  /** Idempotent — unique (company, recipient, eventKey) dedupes outbox replays. */
  createManySkipping(
    rows: {
      companyId: string;
      recipientPrincipalId: string;
      eventKey: string;
      toAddress: string | null;
      subject: string;
      bodyText: string;
      appPath: string | null;
      status: 'PENDING' | 'SKIPPED';
      skipReason: string | null;
    }[],
  ): Promise<void>;
  /** Claim due PENDING rows — lease-safe for a single worker via row update. */
  claim(now: Date, leaseUntil: Date, limit: number): Promise<NotificationEmailDelivery[]>;
  markSent(id: string, sentAt: Date): Promise<void>;
  /** Per-row failure — separate tx so backoff persists after a send rollback. */
  recordFailure(
    id: string,
    data: { lastError: string; dead: boolean; nextAttemptAt?: Date },
  ): Promise<void>;
  reclaimExpiredLeases(now: Date): Promise<number>;
}

export interface NotificationRepos extends WorkflowInstanceRepos {
  outbox: OutboxRepository;
  notifications: NotificationRowRepository;
  emailDeliveries: EmailDeliveryRepository;
  principals: {
    /** Verified sendable address = EMAIL-type loginId — login itself is OTP
     *  verified to that address. Returns principalId → loginId for ids only. */
    findVerifiedEmailAddresses(principalIds: string[]): Promise<Map<string, string>>;
  };
  assignments: {
    /** Active membership check — an un-revoked, in-window RoleAssignment. */
    countActive(principalId: string, companyId: string, now: Date): Promise<number>;
  };
}

export function makeNotificationRepos(tx: Tx): NotificationRepos {
  return {
    ...makeWorkflowInstanceRepos(tx),
    outbox: {
      record: async (input) => {
        await tx.outboxEvent.create({
          data: {
            companyId: input.companyId,
            eventType: input.eventType,
            aggregateType: input.aggregateType,
            aggregateId: input.aggregateId,
            eventKey: input.eventKey,
            payload: {
              recipientPrincipalIds: input.recipientPrincipalIds,
              summary: input.summary,
              ...(input.titles !== undefined ? { titles: input.titles } : {}),
              ...(input.emails !== undefined ? { emails: input.emails } : {}),
            },
          },
        });
      },
      claim: async (now, leaseUntil, limit) => {
        const candidates = await tx.outboxEvent.findMany({
          where: { status: 'PENDING', nextAttemptAt: { lte: now } },
          orderBy: { id: 'asc' },
          take: limit,
        });
        if (candidates.length === 0) return [];
        const ids = candidates.map((c) => c.id);
        await tx.outboxEvent.updateMany({
          where: { id: { in: ids }, status: 'PENDING' },
          data: { status: 'PROCESSING', leaseUntil },
        });
        return tx.outboxEvent.findMany({
          where: { id: { in: ids }, status: 'PROCESSING', leaseUntil },
        });
      },
      markDone: (ids, processedAt) =>
        tx.outboxEvent
          .updateMany({
            where: { id: { in: ids } },
            data: { status: 'DONE', processedAt },
          })
          .then(() => undefined),
      recordFailure: (id, data) =>
        tx.outboxEvent
          .update({
            where: { id },
            data: {
              attempts: { increment: 1 },
              lastError: data.lastError,
              leaseUntil: null,
              ...(data.dead
                ? { status: 'DEAD' }
                : { status: 'PENDING', nextAttemptAt: data.nextAttemptAt ?? new Date() }),
            },
          })
          .then(() => undefined),
      reclaimExpiredLeases: async (now) => {
        const r = await tx.outboxEvent.updateMany({
          where: { status: 'PROCESSING', leaseUntil: { lt: now } },
          data: { status: 'PENDING', leaseUntil: null, attempts: { increment: 1 } },
        });
        return r.count;
      },
    },
    notifications: {
      createManySkipping: async (rows) => {
        if (rows.length === 0) return;
        await tx.notification.createMany({
          data: rows.map((r) => ({ ...r, body: r.body ?? null })),
          skipDuplicates: true,
        });
      },
      findUnpublished: (eventKeys, limit) =>
        tx.notification.findMany({
          where: { eventKey: { in: eventKeys }, publishedAt: null },
          take: limit,
        }),
      listUnpublishedAll: (limit) =>
        tx.notification.findMany({ where: { publishedAt: null }, take: limit }),
      setPublished: (ids, at) =>
        tx.notification
          .updateMany({ where: { id: { in: ids } }, data: { publishedAt: at } })
          .then(() => undefined),
      listInbox: (companyId, recipientPrincipalId, filter) =>
        tx.notification.findMany({
          where: {
            companyId,
            recipientPrincipalId,
            ...(filter.unreadOnly === true ? { readAt: null } : {}),
            ...(filter.cursor !== undefined
              ? {
                  OR: [
                    { createdAt: { lt: filter.cursor.createdAt } },
                    { createdAt: filter.cursor.createdAt, id: { lt: filter.cursor.id } },
                  ],
                }
              : {}),
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: filter.limit,
        }),
      markRead: (companyId, id, recipientPrincipalId, at, expectedVersion) =>
        scopedUpdate<Notification>(
          'NOTIFICATION',
          { id, companyId },
          { readAt: at },
          expectedVersion,
          (args) =>
            tx.notification.updateMany({
              ...args,
              where: { ...args.where, recipientPrincipalId },
            }),
          () => tx.notification.findFirst({ where: { id, companyId, recipientPrincipalId } }),
        ),
      findById: (companyId, id) => tx.notification.findFirst({ where: { id, companyId } }),
      countUnread: (companyId, recipientPrincipalId) =>
        tx.notification.count({ where: { companyId, recipientPrincipalId, readAt: null } }),
    },
    emailDeliveries: {
      createManySkipping: async (rows) => {
        if (rows.length === 0) return;
        await tx.notificationEmailDelivery.createMany({ data: rows, skipDuplicates: true });
      },
      claim: async (now, leaseUntil, limit) => {
        const candidates = await tx.notificationEmailDelivery.findMany({
          where: { status: 'PENDING', nextAttemptAt: { lte: now } },
          orderBy: { id: 'asc' },
          take: limit,
        });
        if (candidates.length === 0) return [];
        const ids = candidates.map((c) => c.id);
        await tx.notificationEmailDelivery.updateMany({
          where: { id: { in: ids }, status: 'PENDING' },
          data: { status: 'SENDING', leaseUntil },
        });
        return tx.notificationEmailDelivery.findMany({
          where: { id: { in: ids }, status: 'SENDING', leaseUntil },
        });
      },
      markSent: (id, sentAt) =>
        tx.notificationEmailDelivery
          .update({ where: { id }, data: { status: 'SENT', sentAt, leaseUntil: null } })
          .then(() => undefined),
      recordFailure: (id, data) =>
        tx.notificationEmailDelivery
          .update({
            where: { id },
            data: {
              attempts: { increment: 1 },
              lastError: data.lastError,
              leaseUntil: null,
              ...(data.dead
                ? { status: 'DEAD' }
                : { status: 'PENDING', nextAttemptAt: data.nextAttemptAt ?? new Date() }),
            },
          })
          .then(() => undefined),
      reclaimExpiredLeases: async (now) => {
        const r = await tx.notificationEmailDelivery.updateMany({
          where: { status: 'SENDING', leaseUntil: { lt: now } },
          data: { status: 'PENDING', leaseUntil: null, attempts: { increment: 1 } },
        });
        return r.count;
      },
    },
    principals: {
      findVerifiedEmailAddresses: async (principalIds) => {
        if (principalIds.length === 0) return new Map();
        const rows = await tx.principal.findMany({
          where: { id: { in: principalIds }, loginIdType: 'EMAIL', loginId: { not: null } },
          select: { id: true, loginId: true },
        });
        const map = new Map<string, string>();
        for (const r of rows) {
          if (r.loginId !== null) map.set(r.id, r.loginId);
        }
        return map;
      },
    },
    assignments: {
      countActive: (principalId, companyId, now) =>
        tx.roleAssignment.count({
          where: {
            principalId,
            companyId,
            revokedAt: null,
            OR: [{ effectiveFrom: null }, { effectiveFrom: { lte: now } }],
            AND: [{ OR: [{ effectiveTo: null }, { effectiveTo: { gte: now } }] }],
          },
        }),
    },
  };
}

export interface NotificationUnitOfWork {
  run<T>(fn: (repos: NotificationRepos) => Promise<T>): Promise<T>;
}

export class PrismaNotificationUnitOfWork implements NotificationUnitOfWork {
  constructor(private readonly prisma: PrismaClient) {}
  run<T>(fn: (repos: NotificationRepos) => Promise<T>): Promise<T> {
    return this.prisma.$transaction((tx) => fn(makeNotificationRepos(tx)));
  }
}
