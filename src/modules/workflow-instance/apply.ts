import { randomUUID } from 'node:crypto';
import type {
  ApprovalTask,
  WorkflowInstance,
  WorkflowState,
  WorkflowTransition,
} from '@prisma/client';
import type { ActorContext, AuditRecord } from '../organization/types.js';
import { AppError } from '../../common/errors/app-error.js';
import { OrgEntityNotFoundError } from '../organization/errors.js';
import { TERMINAL_STATES } from '../workflow/definition-validation.js';
import { evaluateCondition } from '../rule/evaluator.js';
import type { Condition } from '../rule/evaluator.js';
import { buildVerifiedGuardContext, collectGuardFields } from './context.js';
import { WorkflowEvaluationError, WorkflowGuardDeniedError } from './errors.js';
import { IdempotencyConflictError } from './errors.js';
import type { WorkflowInstanceRepos } from './repository.js';

export interface WorkflowStepDef {
  key: string;
  kind: string;
  from: string;
  action: string;
  to: string;
  assignee?: { type: string; value?: unknown };
  selfApprove?: boolean;
  stageKey?: string;
  ruleVersionId?: string;
  formVersionId?: string;
}

export function stepsOf(definition: unknown): WorkflowStepDef[] {
  return ((definition as { steps?: unknown }).steps ?? []) as WorkflowStepDef[];
}

export function initialStateOf(definition: unknown): string | null {
  const s = (definition as { initialState?: unknown }).initialState;
  return typeof s === 'string' ? s : null;
}

function auditEntry(
  actor: ActorContext,
  base: Omit<AuditRecord, 'eventKey' | 'actorId' | 'actorType' | 'correlationId'>,
): AuditRecord {
  return {
    eventKey: randomUUID(),
    actorId: actor.actorId,
    actorType: actor.actorType,
    ...(actor.correlationId !== undefined ? { correlationId: actor.correlationId } : {}),
    ...base,
  };
}

export interface ApplyStepInput {
  action: string;
  reason?: string;
  expectedVersion?: number;
  idempotencyKey?: string;
  fingerprint?: string;
}

/**
 * Evaluate a step's guard rule (if any) with a server-verified, persisted
 * context. Throws WorkflowEvaluationError / WorkflowGuardDeniedError /
 * WorkflowContextUnavailableError — never treats INVALID as a match.
 */
export async function enforceGuard(
  repos: WorkflowInstanceRepos,
  companyId: string,
  instance: WorkflowInstance,
  step: WorkflowStepDef,
  action: string,
): Promise<string | undefined> {
  if (step.ruleVersionId === undefined) return undefined;
  const ruleVersion = await repos.ruleVersions.findDefinition(companyId, step.ruleVersionId);
  if (ruleVersion === null) throw new OrgEntityNotFoundError('RULE_VERSION');
  const when = (ruleVersion.definition as { when?: unknown }).when;
  const leaves = collectGuardFields(when);
  const ctx = await buildVerifiedGuardContext(instance, action, leaves, {
    findFieldSpec: (c, fv, fk) => repos.formVersions.findFieldSpec(c, fv, fk),
    findSubmittedFieldValue: (c, i, fv, fk) =>
      repos.submissions.findSubmittedFieldValue(c, i, fv, fk),
  });
  const result = evaluateCondition(when as Condition, ctx, { strictType: true });
  if (result.outcome === 'INVALID') {
    throw new WorkflowEvaluationError(result.reason ?? 'unknown');
  }
  if (result.outcome === 'NO_MATCH') {
    throw new WorkflowGuardDeniedError(action, instance.state);
  }
  return 'MATCH';
}

/**
 * Apply a pinned step transition atomically: version-guarded state update,
 * transition-history row, pending-approval cleanup, and audit — all inside
 * the caller's transaction. Handles concurrent idempotent writers.
 */
export async function applyPinnedTransition(
  repos: WorkflowInstanceRepos,
  actor: ActorContext,
  companyId: string,
  instance: WorkflowInstance,
  step: WorkflowStepDef,
  input: ApplyStepInput,
): Promise<{ instance: WorkflowInstance; transition: WorkflowTransition; replayed: boolean }> {
  const ruleOutcome = await enforceGuard(repos, companyId, instance, step, input.action);

  const toTerminal = TERMINAL_STATES.has(step.to);
  const updated = await repos.instances.update(
    companyId,
    instance.id,
    { state: step.to, ...(toTerminal ? { closedAt: new Date() } : {}) },
    input.expectedVersion,
  );
  let transition: WorkflowTransition;
  try {
    transition = await repos.transitions.create({
      companyId,
      workflowInstanceId: instance.id,
      fromState: instance.state,
      toState: step.to as WorkflowState,
      action: input.action,
      stepKey: step.key,
      ...(actor.actorType === 'USER' ? { actorPrincipalId: actor.actorId } : {}),
      actorType: actor.actorType,
      ...(input.reason !== undefined ? { reason: input.reason.trim() } : {}),
      ...(step.ruleVersionId !== undefined ? { ruleVersionId: step.ruleVersionId } : {}),
      ...(ruleOutcome !== undefined ? { ruleOutcome } : {}),
      ...(input.idempotencyKey !== undefined && input.fingerprint !== undefined
        ? { idempotencyKey: input.idempotencyKey, requestFingerprint: input.fingerprint }
        : {}),
      eventKey: randomUUID(),
    });
  } catch (error) {
    // Concurrent duplicate: the winner's row already exists — replay or
    // conflict depending on fingerprint.
    if ((error as { name?: string }).name === 'DuplicateCodeError') {
      if (input.idempotencyKey !== undefined) {
        const winner = await repos.transitions.findByIdempotencyKey(
          companyId,
          instance.id,
          input.idempotencyKey,
        );
        if (winner !== null) {
          if (winner.requestFingerprint !== input.fingerprint) {
            throw new IdempotencyConflictError(input.idempotencyKey);
          }
          return { instance: updated, transition: winner, replayed: true };
        }
      }
    }
    throw error;
  }
  // Any state move orphans pending approval tasks for this instance — cancel
  // them in the same transaction (the decided task is already closed).
  await repos.approvalTasks.cancelPending(companyId, instance.id);
  await repos.audit.record(
    auditEntry(actor, {
      action: 'WF_TRANSITION',
      entityType: 'WORKFLOW_INSTANCE',
      entityId: instance.id,
      companyId,
      statusBefore: instance.state,
      statusAfter: updated.state,
      changedFields: {
        action: { before: instance.state, after: input.action },
        stepKey: { before: null, after: step.key },
        state: { before: instance.state, after: updated.state },
      },
    }),
  );
  // Transactional outbox — same tx as the transition; the relay fans out.
  await repos.outbox.record({
    companyId,
    eventType: 'WORKFLOW_TRANSITIONED',
    aggregateType: 'WORKFLOW_INSTANCE',
    aggregateId: instance.id,
    eventKey: `evt:${instance.id}:WORKFLOW_TRANSITIONED:v${updated.version}`,
    recipientPrincipalIds:
      updated.startedByPrincipalId !== null ? [updated.startedByPrincipalId] : [],
    summary: { action: input.action, fromState: instance.state, toState: updated.state },
  });
  return { instance: updated, transition, replayed: false };
}

// --------------------------------------------------------------------------
// Approval-task persistence used through the shared transaction boundary.
// --------------------------------------------------------------------------

/**
 * Open a pending approval task when the instance's current state is the
 * `from` of an APPROVAL stage. Returns the task row created or already open,
 * or null when no approval stage starts here.
 */
export async function ensureApprovalStageTask(
  repos: WorkflowInstanceRepos,
  actor: ActorContext,
  companyId: string,
  instance: WorkflowInstance,
  definition: unknown,
): Promise<ApprovalTask | null> {
  const approvalSteps = stepsOf(definition).filter(
    (s) => s.from === instance.state && s.kind === 'APPROVAL',
  );
  const first = approvalSteps[0];
  if (first?.stageKey === undefined) return null;
  const pending = await repos.approvalTasks.findPending(companyId, instance.id);
  if (pending !== null) return pending;
  // Conflict-safe insert: ON CONFLICT DO NOTHING. A plain create would abort
  // this transaction in PostgreSQL on the partial unique index — the loser
  // can instead re-read the scoped winner and proceed.
  const inserted = await repos.approvalTasks.createPending({
    companyId,
    workflowInstanceId: instance.id,
    stageKey: first.stageKey,
    fromState: instance.state,
    assigneeType: first.assignee?.type ?? '',
    assigneeValue: typeof first.assignee?.value === 'string' ? first.assignee.value : null,
    selfApprove: first.selfApprove ?? false,
  });
  const winner = await repos.approvalTasks.findPending(companyId, instance.id);
  if (winner === null) {
    // The insert was skipped yet no pending row is visible — an inconsistent
    // state we must not silently continue past.
    throw new AppError(
      500,
      'APPROVAL_TASK_OPEN_FAILED',
      'pending approval task insert skipped but none exists after re-read',
    );
  }
  if (!inserted) return winner; // concurrent transaction won — return its task
  await repos.audit.record(
    auditEntry(actor, {
      action: 'APPROVAL_TASK_OPENED',
      entityType: 'APPROVAL_TASK',
      entityId: winner.id,
      companyId,
      statusAfter: 'PENDING',
      changedFields: {
        stageKey: { before: null, after: first.stageKey },
        workflowInstanceId: { before: null, after: instance.id },
      },
    }),
  );
  // Outbox — the assignee spec goes in the summary; the initiator is the
  // transaction-known recipient (role/permission assignees are not scanned).
  await repos.outbox.record({
    companyId,
    eventType: 'APPROVAL_TASK_OPENED',
    aggregateType: 'APPROVAL_TASK',
    aggregateId: winner.id,
    eventKey: `evt:${winner.id}:APPROVAL_TASK_OPENED`,
    recipientPrincipalIds:
      instance.startedByPrincipalId !== null ? [instance.startedByPrincipalId] : [],
    summary: {
      stageKey: first.stageKey,
      assigneeType: winner.assigneeType,
      workflowInstanceId: instance.id,
    },
  });
  return winner;
}
