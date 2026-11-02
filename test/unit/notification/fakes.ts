import type { Notification, OutboxEvent } from '@prisma/client';
import type {
  NotificationRepos,
  NotificationUnitOfWork,
} from '../../../src/modules/notification/repository.js';
import type {
  NotificationPublisher,
  TicketStore,
} from '../../../src/modules/notification/types.js';
import { emptyDocumentStore, makeDocumentTestRepos } from '../document/fakes.js';
import type { DocumentStore } from '../document/fakes.js';
import type { OutboxEmitInput } from '../../../src/modules/notification/types.js';

export interface NotificationStore extends DocumentStore {
  outboxEvents: OutboxEvent[];
  notifications: Notification[];
  roleAssignments: {
    principalId: string;
    companyId: string;
    revokedAt: Date | null;
    effectiveFrom: Date | null;
    effectiveTo: Date | null;
  }[];
}

export function emptyNotificationStore(): NotificationStore {
  return { ...emptyDocumentStore(), notifications: [], roleAssignments: [] };
}

let nextId = 0;
const genId = () => `00000000-0000-4000-8000-${String(++nextId).padStart(12, '0')}`;

export function fakeOutbox(over: Partial<OutboxEvent> = {}): OutboxEvent {
  return {
    id: genId(),
    companyId: 'c1',
    eventType: 'WORKFLOW_TRANSITIONED',
    aggregateType: 'WORKFLOW_INSTANCE',
    aggregateId: genId(),
    payload: { recipientPrincipalIds: ['p1'], summary: { action: 'EXECUTE' } },
    status: 'PENDING',
    attempts: 0,
    leaseUntil: null,
    nextAttemptAt: new Date(Date.now() - 1000),
    lastError: null,
    processedAt: null,
    eventKey: `evt:${genId()}:TEST`,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

export function fakeNotification(over: Partial<Notification> = {}): Notification {
  return {
    id: genId(),
    companyId: 'c1',
    recipientPrincipalId: 'p1',
    eventType: 'WORKFLOW_TRANSITIONED',
    title: 'Workflow EXECUTE → DONE',
    body: null,
    resourceType: 'WORKFLOW_INSTANCE',
    resourceId: genId(),
    eventKey: 'evt:x:TEST',
    readAt: null,
    publishedAt: null,
    version: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

export function makeNotificationTestRepos(store: NotificationStore): NotificationRepos {
  return {
    ...makeDocumentTestRepos(store),
    outbox: {
      record: async (input: OutboxEmitInput) => {
        store.outboxEvents.push(
          fakeOutbox({
            companyId: input.companyId,
            eventType: input.eventType,
            aggregateType: input.aggregateType,
            aggregateId: input.aggregateId,
            eventKey: input.eventKey,
            payload: {
              recipientPrincipalIds: input.recipientPrincipalIds,
              summary: input.summary,
            },
          }),
        );
      },
      claim: async (now, leaseUntil, limit) => {
        const rows = store.outboxEvents
          .filter((e) => e.status === 'PENDING' && e.nextAttemptAt <= now)
          .slice(0, limit);
        for (const r of rows) {
          r.status = 'PROCESSING';
          r.leaseUntil = leaseUntil;
        }
        return rows;
      },
      markDone: async (ids, at) => {
        for (const e of store.outboxEvents) {
          if (ids.includes(e.id)) {
            e.status = 'DONE';
            e.processedAt = at;
          }
        }
      },
      recordFailure: async (id, data) => {
        const e = store.outboxEvents.find((x) => x.id === id);
        if (!e) return;
        e.attempts += 1;
        e.lastError = data.lastError;
        e.leaseUntil = null;
        if (data.dead) e.status = 'DEAD';
        else {
          e.status = 'PENDING';
          e.nextAttemptAt = data.nextAttemptAt ?? new Date();
        }
      },
      reclaimExpiredLeases: async (now) => {
        let n = 0;
        for (const e of store.outboxEvents) {
          if (e.status === 'PROCESSING' && e.leaseUntil !== null && e.leaseUntil < now) {
            e.status = 'PENDING';
            e.leaseUntil = null;
            e.attempts += 1;
            n += 1;
          }
        }
        return n;
      },
    },
    notifications: {
      createManySkipping: async (rows) => {
        for (const r of rows) {
          const exists = store.notifications.some(
            (n) =>
              n.companyId === r.companyId &&
              n.recipientPrincipalId === r.recipientPrincipalId &&
              n.eventKey === r.eventKey,
          );
          if (!exists) {
            store.notifications.push(
              fakeNotification({
                companyId: r.companyId,
                recipientPrincipalId: r.recipientPrincipalId,
                eventType: r.eventType,
                title: r.title,
                body: r.body ?? null,
                resourceType: r.resourceType,
                resourceId: r.resourceId,
                eventKey: r.eventKey,
              }),
            );
          }
        }
      },
      findUnpublished: async (eventKeys, limit) =>
        store.notifications
          .filter((n) => eventKeys.includes(n.eventKey) && n.publishedAt === null)
          .slice(0, limit),
      listUnpublishedAll: async (limit) =>
        store.notifications.filter((n) => n.publishedAt === null).slice(0, limit),
      setPublished: async (ids, at) => {
        for (const n of store.notifications) {
          if (ids.includes(n.id)) n.publishedAt = at;
        }
      },
      listInbox: async (companyId, recipientPrincipalId, filter) => {
        let rows = store.notifications.filter(
          (n) =>
            n.companyId === companyId &&
            n.recipientPrincipalId === recipientPrincipalId &&
            (filter.unreadOnly !== true || n.readAt === null),
        );
        const cursor = filter.cursor;
        if (cursor !== undefined) {
          rows = rows.filter(
            (n) =>
              n.createdAt < cursor.createdAt ||
              (n.createdAt.getTime() === cursor.createdAt.getTime() && n.id < cursor.id),
          );
        }
        return rows
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id))
          .slice(0, filter.limit);
      },
      markRead: async (companyId, id, recipientPrincipalId, at) => {
        const n = store.notifications.find(
          (x) =>
            x.id === id &&
            x.companyId === companyId &&
            x.recipientPrincipalId === recipientPrincipalId,
        );
        if (!n) throw new Error('not found');
        n.readAt = at;
        return { ...n };
      },
      findById: async (companyId, id) =>
        store.notifications.find((n) => n.id === id && n.companyId === companyId) ?? null,
    },
    assignments: {
      countActive: async (principalId, companyId, now) =>
        store.roleAssignments.filter(
          (a) =>
            a.principalId === principalId &&
            a.companyId === companyId &&
            a.revokedAt === null &&
            (a.effectiveFrom === null || a.effectiveFrom <= now) &&
            (a.effectiveTo === null || a.effectiveTo >= now),
        ).length,
    },
  };
}

export class FakeNotificationUoW implements NotificationUnitOfWork {
  constructor(public readonly store: NotificationStore) {}
  async run<T>(fn: (repos: NotificationRepos) => Promise<T>): Promise<T> {
    const snapshot = structuredClone(this.store);
    try {
      return await fn(makeNotificationTestRepos(this.store));
    } catch (error) {
      Object.assign(this.store, structuredClone(snapshot));
      throw error;
    }
  }
}

export class FakeTicketStore implements TicketStore {
  issued = new Set<string>();
  async issue(jti: string): Promise<void> {
    this.issued.add(jti);
  }
  async consume(jti: string): Promise<boolean> {
    return this.issued.delete(jti);
  }
}

export class FakePublisher implements NotificationPublisher {
  published: { channel: string; message: string }[] = [];
  failNext: string | null = null;
  async publish(channel: string, message: string): Promise<void> {
    if (this.failNext !== null) {
      const err = this.failNext;
      this.failNext = null;
      throw new Error(err);
    }
    this.published.push({ channel, message });
  }
}
