import type {
  ApprovalDecision,
  ApprovalTask,
  WorkflowInstance,
  WorkflowTransition,
} from '@prisma/client';

export type DecisionAction = 'APPROVE' | 'REJECT' | 'RETURN';

export interface DecideTaskInput {
  /** Pinned step action — must be declared on the stage; destination is never caller-supplied. */
  action: DecisionAction;
  /** Required for REJECT and RETURN; optional for APPROVE. */
  reason?: string;
  /** Optimistic-concurrency check on the instance (retry-only — excluded from fingerprint). */
  expectedVersion?: number;
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
