import type {
  ApprovalDecision,
  ApprovalTask,
  Prisma,
  WorkflowInstance,
  WorkflowTransition,
} from '@prisma/client';
import type { ActorContext } from '../organization/types.js';
import type { ApprovalRepos } from './repository.js';

export type DecisionAction = 'APPROVE' | 'REJECT' | 'RETURN';

export interface DecideTaskInput {
  /** Pinned step action — must be declared on the stage; destination is never caller-supplied. */
  action: DecisionAction;
  /** Required for REJECT and RETURN; optional for APPROVE. */
  reason?: string;
  /** Optimistic-concurrency check on the instance (retry-only — excluded from fingerprint). */
  expectedVersion?: number;
  /**
   * Action-specific structured payload (e.g. `{ approvedAmount: "1200.00" }`
   * for wallet funding). Stored on the decision row and folded into the
   * idempotency fingerprint — a replay with a different payload conflicts.
   */
  decisionPayload?: Record<string, unknown>;
  idempotencyKey?: string;
}

export interface DecideTaskResult {
  instance: WorkflowInstance;
  task: ApprovalTask;
  decision: ApprovalDecision;
  transition: WorkflowTransition;
  replayed: boolean;
}

export interface ApprovalTaskListFilter {
  status?: string;
  workflowInstanceId?: string;
  assigneeValue?: string;
}

export interface ApprovalTaskPage {
  items: ApprovalTask[];
  /** Present when more assigned tasks exist after the returned page. */
  nextCursor?: string;
}

/**
 * Domain-completion hook — invoked inside the SAME unit of work as the
 * approval decision, after the pinned transition and generic audit/outbox
 * writes but before commit. A hook that throws rolls back the decision,
 * transition, task close, audit, and outbox together.
 *
 * Keyed by `operationKey` — exactly one hook may claim an operation.
 */
export interface DecisionCompletionContext {
  repos: ApprovalRepos;
  /** The live transaction client — domain writes join this transaction. */
  tx: Prisma.TransactionClient;
  actor: ActorContext;
  companyId: string;
  instance: WorkflowInstance;
  task: ApprovalTask;
  decision: ApprovalDecision;
  input: DecideTaskInput;
}

export interface DecisionCompletionHook {
  operationKey: string;
  run(ctx: DecisionCompletionContext): Promise<void>;
}
