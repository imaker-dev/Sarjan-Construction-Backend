import type { ApprovalTask, WorkflowState } from '@prisma/client';

export interface StartInstanceInput {
  /** Optional business back-reference — both fields or neither. */
  businessEntityType?: string;
  businessEntityId?: string;
}

export interface TransitionInput {
  action: string;
  reason?: string;
  expectedVersion?: number;
  idempotencyKey?: string;
}

export interface TransitionResult {
  instance: import('@prisma/client').WorkflowInstance;
  transition?: import('@prisma/client').WorkflowTransition;
  /** Pending approval task when the action opened an approval stage. */
  task?: ApprovalTask;
  /** true when this returned a recorded transition for a replayed request. */
  replayed: boolean;
  /** true when the action opened (or matched) a pending approval task. */
  pendingApproval: boolean;
}

export interface InstanceListFilter {
  workflowId?: string;
  operationId?: string;
  state?: WorkflowState;
  businessEntityType?: string;
  businessEntityId?: string;
}
