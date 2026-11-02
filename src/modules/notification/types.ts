import type { Notification, OutboxEvent } from '@prisma/client';

export const EVT_WORKFLOW_TRANSITIONED = 'WORKFLOW_TRANSITIONED';
export const EVT_APPROVAL_TASK_OPENED = 'APPROVAL_TASK_OPENED';
export const EVT_APPROVAL_TASK_DECIDED = 'APPROVAL_TASK_DECIDED';
export const EVT_DOCUMENT_APPROVED = 'DOCUMENT_APPROVED';
export const EVT_DOCUMENT_REJECTED = 'DOCUMENT_REJECTED';

/** Payload fields are safe identifiers/statuses only — never record values. */
export interface OutboxEmitInput {
  companyId: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  /** Unique per occurrence — e.g. evt:{aggregate}:{type}:{seq-or-uuid}. */
  eventKey: string;
  /** Transaction-time recipients — principal ids known inside the source tx. */
  recipientPrincipalIds: string[];
  /** Bounded safe summary for title/body construction. */
  summary: Record<string, string>;
}

export interface InboxCursor {
  createdAt: string; // ISO
  id: string;
}

export interface InboxListFilter {
  cursor?: string;
  unreadOnly?: boolean;
  limit?: number;
}

export interface NotificationTicket {
  ticket: string;
  expiresInSeconds: number;
}

export interface TicketClaims {
  principalId: string;
  sessionId: string;
  companyId: string;
  jti: string;
}

/** Redis-backed or in-memory single-use ticket store. */
export interface TicketStore {
  issue(jti: string, ttlSeconds: number): Promise<void>;
  /** Atomically consume — true only for the first caller. */
  consume(jti: string): Promise<boolean>;
}

/** Realtime publisher boundary — Redis pub/sub in production. */
export interface NotificationPublisher {
  publish(channel: string, message: string): Promise<void>;
}

export type { Notification, OutboxEvent };
