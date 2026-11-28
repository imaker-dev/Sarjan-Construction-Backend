import { randomUUID } from 'node:crypto';
import type { ActorContext } from '../organization/types.js';
import { OrgEntityNotFoundError } from '../organization/errors.js';
import { AccessDeniedError } from '../access-control/errors.js';
import { NotCompanyMemberError, NotificationTicketError } from './errors.js';
import type { NotificationUnitOfWork } from './repository.js';
import type {
  InboxListFilter,
  InboxCursor,
  NotificationEmailDelivery,
  NotificationPublisher,
  NotificationTicket,
  TicketStore,
} from './types.js';
import type { Notification } from './types.js';

export const NOTIFICATION_READ = 'NOTIFICATION_READ';
export const OUTBOX_ADMIN = 'OUTBOX_ADMIN';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 60_000;

export const TICKET_TTL_SECONDS = 30;
export const TICKET_TYPE = 'NOTIF_TICKET';

const EMAIL_MAX_ATTEMPTS = 5;
const EMAIL_BASE_BACKOFF_MS = 60_000;
export const SKIP_NO_VERIFIED_ADDRESS = 'NO_VERIFIED_ADDRESS';

/** Narrow mail boundary — the worker only needs sendMail. */
export interface MailSender {
  sendMail(options: {
    to: string;
    subject: string;
    text?: string;
  }): Promise<{ success: boolean; error?: string | undefined }>;
}

export function channelFor(companyId: string, principalId: string): string {
  return `notif:${companyId}:${principalId}`;
}

export interface NotificationServiceDeps {
  uow: NotificationUnitOfWork;
  ticketStore: TicketStore;
  publisher: NotificationPublisher;
  /** Signer for the 30s single-use WS ticket (app.jwt.sign-equivalent). */
  signTicket: (claims: {
    sub: string;
    sid: string;
    companyId: string;
    jti: string;
    typ: string;
  }) => string;
  /** Re-validates session + principal status — same check REST auth runs. */
  buildActorContext: (
    claims: { sub: string; sid: string },
    opts?: { correlationId?: string },
  ) => Promise<ActorContext & { sessionId: string }>;
  /** Optional SMTP sender — absent means email deliveries are never claimed. */
  mailService?: MailSender;
  /** Trusted application origin (APP_BASE_URL) — email links are built from
   *  config, never from an incoming Host header. */
  appBaseUrl?: string;
  batchSize?: number;
  leaseMs?: number;
  now?: () => Date;
}

/** Safe realtime message — stable id for client dedupe, no sensitive values. */
export function realtimeMessage(n: Notification): string {
  return JSON.stringify({
    notificationId: n.id,
    eventType: n.eventType,
    title: n.title,
    resourceType: n.resourceType,
    resourceId: n.resourceId,
    createdAt: n.createdAt.toISOString(),
  });
}

export function encodeCursor(n: Notification): string {
  return Buffer.from(JSON.stringify({ createdAt: n.createdAt.toISOString(), id: n.id })).toString(
    'base64url',
  );
}

export function decodeCursor(cursor: string): InboxCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as InboxCursor;
    if (typeof parsed.createdAt !== 'string' || typeof parsed.id !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

const TITLES: Record<string, (s: Record<string, string>) => string> = {
  WORKFLOW_TRANSITIONED: (s) => `Workflow ${s.action ?? 'moved'} → ${s.toState ?? '?'}`,
  APPROVAL_TASK_OPENED: (s) => `Approval stage ${s.stageKey ?? ''} opened`.trim(),
  APPROVAL_TASK_DECIDED: (s) => `Approval ${s.outcome ?? 'decided'}`,
  DOCUMENT_APPROVED: () => 'Document approved',
  DOCUMENT_REJECTED: () => 'Document rejected',
  LEAVE_REQUEST_SUBMITTED: (s) => `New leave request: ${s.leaveType ?? 'leave'}`,
  LEAVE_REQUEST_RESUBMITTED: (s) => `Leave request resubmitted: ${s.leaveType ?? 'leave'}`,
  LEAVE_REQUEST_APPROVED: (s) => `Leave request approved: ${s.leaveType ?? 'leave'}`,
  LEAVE_REQUEST_REJECTED: (s) => `Leave request rejected: ${s.leaveType ?? 'leave'}`,
  LEAVE_REQUEST_RETURNED: (s) => `Leave request returned for correction: ${s.leaveType ?? 'leave'}`,
  LEAVE_REQUEST_CANCELLED: (s) => `Leave request cancelled: ${s.leaveType ?? 'leave'}`,
  SITE_WALLET_CREATED: () => 'Site wallet created',
  WALLET_FUNDING_SUBMITTED: (s) => `Funding request submitted (attempt ${s.attemptNo ?? '?'})`,
  WALLET_FUNDING_APPROVED: () => 'Funding request approved',
  WALLET_FUNDING_REJECTED: () => 'Funding request rejected',
  WALLET_FUNDING_RETURNED: () => 'Funding request returned for correction',
  WALLET_FUNDING_CANCELLED: () => 'Funding request cancelled',
  WALLET_FUNDING_REDUCED: () => 'Funding approved amount reduced',
  WALLET_TRANSFER_RECORDED: () => 'Wallet transfer recorded',
  WALLET_TRANSFER_CANCELLED: () => 'Wallet transfer cancelled',
  WALLET_RECEIPT_CONFIRMED: () => 'Wallet receipt confirmed',
  WALLET_RECEIPT_DISPUTED: () => 'Wallet receipt discrepancy',
  WALLET_DISPUTE_RESOLVED: () => 'Wallet dispute resolved',
  WALLET_REQUEST_CLOSED_SHORT: () => 'Funding request closed short',
  WALLET_EXPENSE_POSTED: () => 'Wallet expense posted',
  WALLET_VOUCHER_CREATED: () => 'Cash voucher generated',
  WALLET_VOUCHER_SIGNED: () => 'Signed voucher attached',
  WALLET_DOCUMENT_LINKED: () => 'Wallet evidence linked',
  WALLET_REVERSAL_REQUESTED: () => 'Reversal requested',
  WALLET_ENTRY_REVERSED: () => 'Ledger entry reversed',
};

function titleFor(eventType: string, summary: Record<string, string>): string {
  return (TITLES[eventType] ?? (() => eventType))(summary);
}

export class NotificationService {
  private readonly now: () => Date;
  private readonly batchSize: number;
  private readonly leaseMs: number;

  constructor(private readonly deps: NotificationServiceDeps) {
    this.now = deps.now ?? (() => new Date());
    this.batchSize = deps.batchSize ?? 50;
    this.leaseMs = deps.leaseMs ?? 5 * 60_000;
  }

  // ------------------------------------------------------------ REST surface

  /** Company membership = ≥1 active RoleAssignment in that company. */
  async verifyMembership(principalId: string, companyId: string): Promise<void> {
    await this.deps.uow.run(async (repos) => {
      const count = await repos.assignments.countActive(principalId, companyId, this.now());
      if (count === 0) throw new NotCompanyMemberError();
    });
  }

  private async assertMembership(
    repos: { assignments: { countActive(p: string, c: string, n: Date): Promise<number> } },
    actor: ActorContext,
    companyId: string,
  ): Promise<void> {
    if (actor.actorType !== 'USER') throw new AccessDeniedError('user actor required');
    const count = await repos.assignments.countActive(actor.actorId, companyId, this.now());
    if (count === 0) throw new NotCompanyMemberError();
  }

  /** Session revalidation for socket auth — same live check as REST. */
  async revalidateActor(sub: string, sid: string): Promise<ActorContext & { sessionId: string }> {
    return this.deps.buildActorContext({ sub, sid });
  }

  async list(
    actor: ActorContext,
    companyId: string,
    filter?: InboxListFilter,
  ): Promise<{ notifications: Notification[]; nextCursor: string | null }> {
    const limit = Math.min(filter?.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    const rows = await this.deps.uow.run(async (repos) => {
      await this.assertMembership(repos, actor, companyId);
      const decoded = filter?.cursor !== undefined ? decodeCursor(filter.cursor) : null;
      return repos.notifications.listInbox(companyId, actor.actorId, {
        ...(decoded !== null
          ? { cursor: { createdAt: new Date(decoded.createdAt), id: decoded.id } }
          : {}),
        ...(filter?.unreadOnly !== undefined ? { unreadOnly: filter.unreadOnly } : {}),
        limit: limit + 1,
      });
    });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      notifications: page,
      nextCursor: rows.length > limit && last !== undefined ? encodeCursor(last) : null,
    };
  }

  async markRead(actor: ActorContext, companyId: string, id: string): Promise<Notification> {
    return this.deps.uow.run(async (repos) => {
      await this.assertMembership(repos, actor, companyId);
      const row = await repos.notifications.findById(companyId, id);
      if (row?.recipientPrincipalId !== actor.actorId) {
        throw new OrgEntityNotFoundError('NOTIFICATION');
      }
      return repos.notifications.markRead(companyId, id, actor.actorId, this.now(), row.version);
    });
  }

  /** Unread count for the authenticated recipient only — the app badge. */
  async unreadCount(actor: ActorContext, companyId: string): Promise<number> {
    return this.deps.uow.run(async (repos) => {
      await this.assertMembership(repos, actor, companyId);
      return repos.notifications.countUnread(companyId, actor.actorId);
    });
  }

  // ------------------------------------------------------------ ticket flow

  /** Issue a 30s single-use ticket — binds the verified company at issue. */
  async issueTicket(
    actor: ActorContext & { sessionId: string },
    companyId: string,
  ): Promise<NotificationTicket> {
    await this.deps.uow.run((repos) => this.assertMembership(repos, actor, companyId));
    const jti = randomUUID();
    await this.deps.ticketStore.issue(jti, TICKET_TTL_SECONDS);
    const ticket = this.deps.signTicket({
      sub: actor.actorId,
      sid: actor.sessionId,
      companyId,
      jti,
      typ: TICKET_TYPE,
    });
    return { ticket, expiresInSeconds: TICKET_TTL_SECONDS };
  }

  /**
   * Consume a ticket — atomic single use. Returns the verified actor + company
   * for the socket bind. Session/principal revalidated live.
   */
  async consumeTicket(claims: {
    sub: string;
    sid: string;
    companyId: string;
    jti: string;
  }): Promise<ActorContext & { sessionId: string }> {
    const consumed = await this.deps.ticketStore.consume(claims.jti);
    if (!consumed) throw new NotificationTicketError('expired or already used');
    return this.deps.buildActorContext({ sub: claims.sub, sid: claims.sid });
  }

  /** Socket revalidation at a bounded interval — same live check as connect. */
  async revalidate(sub: string, sid: string): Promise<boolean> {
    try {
      await this.deps.buildActorContext({ sub, sid });
      return true;
    } catch {
      return false;
    }
  }

  // ------------------------------------------------------------- relay core

  /**
   * One batch: claim (leased) → durable inbox rows + DONE → publish → mark.
   * Rollback safety: a failed tx2 leaves events PROCESSING until lease expiry,
   * then the sweeper returns them to PENDING; dedupe makes redelivery safe.
   */
  async processBatch(): Promise<{ claimed: number; delivered: number; published: number }> {
    const now = this.now();
    const leaseUntil = new Date(now.getTime() + this.leaseMs);
    const claimed = await this.deps.uow.run((repos) =>
      repos.outbox.claim(now, leaseUntil, this.batchSize),
    );
    if (claimed.length === 0) return { claimed: 0, delivered: 0, published: 0 };

    let deliveredIds: string[] = [];
    try {
      deliveredIds = await this.deps.uow.run(async (repos) => {
        const ids: string[] = [];
        for (const ev of claimed) {
          const payload = ev.payload as {
            recipientPrincipalIds?: string[];
            summary?: Record<string, string>;
            titles?: Record<string, string>;
            emails?: Record<string, { subject: string; bodyText: string; appPath?: string }>;
          };
          const recipients = new Set(payload.recipientPrincipalIds ?? []);
          const summary = payload.summary ?? {};
          const sharedTitle = titleFor(ev.eventType, summary);
          await repos.notifications.createManySkipping(
            [...recipients].map((rid) => ({
              companyId: ev.companyId,
              recipientPrincipalId: rid,
              eventType: ev.eventType,
              title: payload.titles?.[rid] ?? sharedTitle,
              resourceType: ev.aggregateType,
              resourceId: ev.aggregateId,
              eventKey: ev.eventKey,
            })),
          );
          // Durable email intents — same tx as inbox rows so a committed
          // notification can never lose its email, and dedupe keys make
          // outbox replays idempotent. Recipients without a verified
          // (EMAIL-type) loginId are recorded SKIPPED, never sent.
          const emailRecipients = Object.keys(payload.emails ?? {});
          if (emailRecipients.length > 0) {
            const verified = await repos.principals.findVerifiedEmailAddresses(emailRecipients);
            await repos.emailDeliveries.createManySkipping(
              emailRecipients.map((rid) => {
                const mail = payload.emails?.[rid];
                const toAddress = verified.get(rid) ?? null;
                return {
                  companyId: ev.companyId,
                  recipientPrincipalId: rid,
                  eventKey: ev.eventKey,
                  toAddress,
                  subject: mail?.subject ?? ev.eventType,
                  bodyText: mail?.bodyText ?? '',
                  appPath: mail?.appPath ?? null,
                  status: toAddress !== null ? 'PENDING' : 'SKIPPED',
                  skipReason: toAddress !== null ? null : SKIP_NO_VERIFIED_ADDRESS,
                };
              }),
            );
          }
          ids.push(ev.id);
        }
        await repos.outbox.markDone(ids, now);
        return ids;
      });
    } catch (error) {
      // Separate tx per event so backoff persists past the delivery rollback.
      const lastError = error instanceof Error ? error.message : 'delivery failed';
      await this.deps.uow.run(async (repos) => {
        for (const c of claimed) {
          const next = c.attempts + 1;
          const dead = next >= MAX_ATTEMPTS;
          await repos.outbox.recordFailure(c.id, {
            lastError,
            dead,
            nextAttemptAt: new Date(this.now().getTime() + BASE_BACKOFF_MS * 2 ** c.attempts),
          });
        }
      });
      return { claimed: claimed.length, delivered: 0, published: 0 };
    }

    // Publish only rows that are durable but unpublished — a crash between
    // commit and publish is recovered by the sweep on the same query.
    const keys = claimed.map((c) => c.eventKey);
    const unpublished = await this.deps.uow.run((repos) =>
      repos.notifications.findUnpublished(keys, this.batchSize * 10),
    );
    const published = await this.publishAll(unpublished);
    return { claimed: claimed.length, delivered: deliveredIds.length, published };
  }

  private async publishAll(rows: Notification[]): Promise<number> {
    let published = 0;
    for (const n of rows) {
      try {
        await this.deps.publisher.publish(
          channelFor(n.companyId, n.recipientPrincipalId),
          realtimeMessage(n),
        );
        // A publish with zero subscribers still counts as published — the
        // inbox row is durable; offline users resync on reconnect.
        await this.deps.uow.run((repos) => repos.notifications.setPublished([n.id], this.now()));
        published += 1;
      } catch {
        // leave publishedAt null — sweep retries; inbox remains the truth
      }
    }
    return published;
  }

  /** Periodic sweep: reclaim expired leases + republish unpublished rows. */
  async sweep(): Promise<{ reclaimed: number; republished: number }> {
    const [reclaimed, reclaimedEmails] = await Promise.all([
      this.deps.uow.run((repos) => repos.outbox.reclaimExpiredLeases(this.now())),
      this.deps.uow.run((repos) => repos.emailDeliveries.reclaimExpiredLeases(this.now())),
    ]);
    const stale = await this.deps.uow.run((repos) =>
      repos.notifications.listUnpublishedAll(this.batchSize * 10),
    );
    const republished = await this.publishAll(stale);
    return { reclaimed: reclaimed + reclaimedEmails, republished };
  }

  // ---------------------------------------------------------- email delivery

  /**
   * One email batch: claim (leased) → send → mark SENT or record backoff.
   * Send happens strictly after the durable row exists — a crash mid-send is
   * recovered by lease expiry + claim replay; dedupe keys keep replays from
   * enqueueing a second row. Per-row failures are recorded in a separate tx
   * so backoff persists past any rollback. A mail failure never touches the
   * leave decision or the inbox row.
   */
  async processEmailBatch(): Promise<{
    claimed: number;
    sent: number;
    failed: number;
  }> {
    if (this.deps.mailService === undefined) return { claimed: 0, sent: 0, failed: 0 };
    const now = this.now();
    const leaseUntil = new Date(now.getTime() + this.leaseMs);
    const claimed = await this.deps.uow.run((repos) =>
      repos.emailDeliveries.claim(now, leaseUntil, this.batchSize),
    );
    if (claimed.length === 0) return { claimed: 0, sent: 0, failed: 0 };

    let sent = 0;
    let failed = 0;
    for (const d of claimed) {
      const ok = await this.sendDelivery(d);
      if (ok) sent += 1;
      else failed += 1;
    }
    return { claimed: claimed.length, sent, failed };
  }

  private async sendDelivery(d: NotificationEmailDelivery): Promise<boolean> {
    if (d.toAddress === null) {
      await this.deps.uow.run((repos) =>
        repos.emailDeliveries.recordFailure(d.id, {
          lastError: SKIP_NO_VERIFIED_ADDRESS,
          dead: true,
        }),
      );
      return false;
    }
    const link =
      d.appPath !== null && this.deps.appBaseUrl !== undefined
        ? `${this.deps.appBaseUrl.replace(/\/$/, '')}${d.appPath}`
        : null;
    const text = link !== null ? `${d.bodyText}\n\nView: ${link}` : d.bodyText;
    try {
      const result = await this.deps.mailService?.sendMail({
        to: d.toAddress,
        subject: d.subject,
        text,
      });
      if (result?.success === true) {
        await this.deps.uow.run((repos) => repos.emailDeliveries.markSent(d.id, this.now()));
        return true;
      }
      await this.deps.uow.run((repos) =>
        repos.emailDeliveries.recordFailure(d.id, {
          lastError: result?.error ?? 'send failed',
          dead: d.attempts + 1 >= EMAIL_MAX_ATTEMPTS,
          nextAttemptAt: new Date(this.now().getTime() + EMAIL_BASE_BACKOFF_MS * 2 ** d.attempts),
        }),
      );
      return false;
    } catch (error) {
      const lastError = error instanceof Error ? error.message : 'send failed';
      await this.deps.uow.run((repos) =>
        repos.emailDeliveries.recordFailure(d.id, {
          lastError,
          dead: d.attempts + 1 >= EMAIL_MAX_ATTEMPTS,
          nextAttemptAt: new Date(this.now().getTime() + EMAIL_BASE_BACKOFF_MS * 2 ** d.attempts),
        }),
      );
      return false;
    }
  }
}
