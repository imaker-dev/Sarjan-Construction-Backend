import { randomUUID } from 'node:crypto';
import type { ApprovalTask } from '@prisma/client';
import type { ActorContext, AuditRecord } from '../organization/types.js';
import {
  OrgEntityNotFoundError,
  OrgValidationError,
  InvalidStatusTransitionError,
} from '../organization/errors.js';
import type { Authorizer } from '../department/service.js';
import type { ScopeTarget } from '../access-control/service.js';
import { scopeCovers } from '../access-control/service.js';
import type { ScopeChain } from '../access-control/repository.js';
import { departmentScopeTarget } from '../operation/service.js';
import { commandFingerprint } from '../workflow-instance/fingerprint.js';
import { IdempotencyConflictError } from '../workflow-instance/errors.js';
import { applyPinnedTransition, stepsOf } from '../workflow-instance/apply.js';
import {
  ApprovalTaskClosedError,
  NotTaskAssigneeError,
  SeparationOfDutiesError,
} from './errors.js';
import type { ApprovalRepos, ApprovalUnitOfWork } from './repository.js';
import type { ApprovalTaskListFilter, DecideTaskInput, DecideTaskResult } from './types.js';

export const WORKFLOW_APPROVAL_READ = 'WORKFLOW_APPROVAL_READ';
export const WORKFLOW_APPROVAL_DECIDE = 'WORKFLOW_APPROVAL_DECIDE';

const REASON_MAX = 500;
const DECISION_ACTIONS = ['APPROVE', 'REJECT', 'RETURN'] as const;

// DECIDE is a gate; PERMISSION_KEY assignee checks need a boolean verdict —
// the concrete AccessControlService supplies it.
export interface ApprovalAuthorizer extends Authorizer {
  hasPermission(principalId: string, permissionKey: string, target: ScopeTarget): Promise<boolean>;
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

export class ApprovalService {
  constructor(
    private readonly uow: ApprovalUnitOfWork,
    private readonly authorizer: ApprovalAuthorizer,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Decide a pending approval task. One authorized approver, one outcome —
   * the decision, task close, pinned transition, and audit commit atomically.
   */
  async decideTask(
    actor: ActorContext,
    companyId: string,
    taskId: string,
    input: DecideTaskInput,
  ): Promise<DecideTaskResult> {
    if (!(DECISION_ACTIONS as readonly string[]).includes(input.action)) {
      throw new OrgValidationError('action', `unknown decision ${JSON.stringify(input.action)}`);
    }
    if (input.action !== 'APPROVE' && (input.reason === undefined || input.reason.trim() === '')) {
      throw new OrgValidationError('reason', `required for ${input.action}`);
    }
    if (input.reason !== undefined && input.reason.length > REASON_MAX) {
      throw new OrgValidationError('reason', `exceeds ${REASON_MAX} chars`);
    }
    if (input.idempotencyKey === '') {
      throw new OrgValidationError('idempotencyKey', 'must be non-empty');
    }
    const fingerprint =
      input.idempotencyKey !== undefined
        ? commandFingerprint({
            action: input.action,
            ...(input.reason !== undefined ? { reason: input.reason } : {}),
          })
        : undefined;

    return this.uow.run(async (repos) => {
      const task = await repos.approvalTasks.findById(companyId, taskId);
      if (task === null) throw new OrgEntityNotFoundError('APPROVAL_TASK');
      const instance = await repos.instances.findById(companyId, task.workflowInstanceId);
      if (instance === null) throw new OrgEntityNotFoundError('WORKFLOW_INSTANCE');
      const target = await this.scopeTargetForOperation(repos, companyId, instance.operationId);

      // Authorize first — replayed decisions are never disclosed without it.
      await this.authorizer.assertPermission(actor.actorId, WORKFLOW_APPROVAL_DECIDE, target);
      await this.assertAssignee(repos, actor, task, instance, target);

      if (input.idempotencyKey !== undefined) {
        const recorded = await repos.approvalDecisions.findByIdempotencyKey(
          companyId,
          task.id,
          input.idempotencyKey,
        );
        if (recorded !== null) {
          if (recorded.requestFingerprint !== fingerprint) {
            throw new IdempotencyConflictError(input.idempotencyKey);
          }
          const transition = await repos.transitions.findByIdempotencyKey(
            companyId,
            instance.id,
            input.idempotencyKey,
          );
          if (transition === null) throw new OrgEntityNotFoundError('WORKFLOW_TRANSITION');
          return { instance, task, decision: recorded, transition, replayed: true };
        }
      }

      if (task.status !== 'PENDING') throw new ApprovalTaskClosedError(task.id);
      if (instance.state !== task.fromState) {
        throw new InvalidStatusTransitionError(
          'APPROVAL_TASK',
          instance.state,
          `decide ${input.action}`,
        );
      }

      // Separation of duties: the initiator cannot decide unless the pinned
      // stage explicitly allows self-approval.
      if (!task.selfApprove && instance.startedByPrincipalId === actor.actorId) {
        throw new SeparationOfDutiesError();
      }

      // Resolve the pinned step matching this decision action — destination
      // and guard come from the snapshot, never from the caller.
      const version = await repos.workflowVersions.findById(
        companyId,
        instance.workflowId,
        instance.workflowVersionId,
      );
      if (version === null) throw new OrgEntityNotFoundError('WORKFLOW_VERSION');
      const step = stepsOf(version.definition).find(
        (s) => s.kind === 'APPROVAL' && s.stageKey === task.stageKey && s.action === input.action,
      );
      if (step === undefined) {
        throw new OrgValidationError('action', `not a valid outcome of stage ${task.stageKey}`);
      }

      // One transaction: decision row → task close → pinned transition + audit.
      const outcome =
        input.action === 'APPROVE'
          ? 'APPROVED'
          : input.action === 'REJECT'
            ? 'REJECTED'
            : 'RETURNED';
      const decision = await repos.approvalDecisions.create({
        companyId,
        approvalTaskId: task.id,
        outcome,
        action: input.action,
        ...(actor.actorType === 'USER' ? { actorPrincipalId: actor.actorId } : {}),
        actorType: actor.actorType,
        ...(input.reason !== undefined ? { reason: input.reason.trim() } : {}),
        ...(input.idempotencyKey !== undefined && fingerprint !== undefined
          ? { idempotencyKey: input.idempotencyKey, requestFingerprint: fingerprint }
          : {}),
        eventKey: randomUUID(),
      });
      const closed = await repos.approvalTasks.close(
        companyId,
        task.id,
        {
          status: outcome,
          ...(actor.actorType === 'USER' ? { decidedByPrincipalId: actor.actorId } : {}),
          decidedAt: this.now(),
          decisionAction: input.action,
          ...(input.reason !== undefined ? { decisionReason: input.reason.trim() } : {}),
        },
        task.version,
      );
      const applied = await applyPinnedTransition(repos, actor, companyId, instance, step, {
        action: input.action,
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
        ...(input.expectedVersion !== undefined ? { expectedVersion: input.expectedVersion } : {}),
        ...(input.idempotencyKey !== undefined && fingerprint !== undefined
          ? { idempotencyKey: input.idempotencyKey, fingerprint }
          : {}),
      });
      // RETURN coupling: when the stage's pinned step names a FormVersion,
      // that exact submission goes back for correction — same transaction.
      // Missing target fails closed; never touch an arbitrary submission.
      if (input.action === 'RETURN' && step.formVersionId !== undefined) {
        const submission = await repos.submissions.findByInstanceForm(
          companyId,
          instance.id,
          step.formVersionId,
        );
        if (submission === null) {
          throw new OrgEntityNotFoundError('FORM_SUBMISSION');
        }
        await repos.submissions.markReturned(
          companyId,
          submission.id,
          input.reason?.trim() ?? '',
          submission.version,
        );
      }
      await repos.audit.record(
        auditEntry(actor, {
          action: 'APPROVAL_DECIDED',
          entityType: 'APPROVAL_TASK',
          entityId: task.id,
          companyId,
          statusBefore: 'PENDING',
          statusAfter: outcome,
          changedFields: {
            action: { before: null, after: input.action },
            workflowInstanceId: { before: null, after: instance.id },
          },
        }),
      );
      // Outbox — initiator is the transaction-known recipient.
      await repos.outbox.record({
        companyId,
        eventType: 'APPROVAL_TASK_DECIDED',
        aggregateType: 'APPROVAL_TASK',
        aggregateId: task.id,
        eventKey: `evt:${decision.id}:APPROVAL_TASK_DECIDED`,
        recipientPrincipalIds:
          instance.startedByPrincipalId !== null ? [instance.startedByPrincipalId] : [],
        summary: { action: input.action, outcome, stageKey: task.stageKey },
      });
      return {
        instance: applied.instance,
        task: closed,
        decision,
        transition: applied.transition,
        replayed: false,
      };
    });
  }

  async getTask(actor: ActorContext, companyId: string, taskId: string): Promise<ApprovalTask> {
    return this.uow.run(async (repos) => {
      const task = await repos.approvalTasks.findById(companyId, taskId);
      if (task === null) throw new OrgEntityNotFoundError('APPROVAL_TASK');
      const instance = await repos.instances.findById(companyId, task.workflowInstanceId);
      if (instance === null) throw new OrgEntityNotFoundError('WORKFLOW_INSTANCE');
      const target = await this.scopeTargetForOperation(repos, companyId, instance.operationId);
      await this.authorizer.assertPermission(actor.actorId, WORKFLOW_APPROVAL_READ, target);
      return task;
    });
  }

  async listTasks(actor: ActorContext, companyId: string, filter?: ApprovalTaskListFilter) {
    await this.authorizer.assertPermission(actor.actorId, WORKFLOW_APPROVAL_READ, {
      companyId,
      scopeType: 'COMPANY',
      scopeId: companyId,
    });
    return this.uow.run(({ approvalTasks }) => approvalTasks.list(companyId, filter));
  }

  async listDecisions(actor: ActorContext, companyId: string, taskId: string) {
    return this.uow.run(async (repos) => {
      const task = await repos.approvalTasks.findById(companyId, taskId);
      if (task === null) throw new OrgEntityNotFoundError('APPROVAL_TASK');
      const instance = await repos.instances.findById(companyId, task.workflowInstanceId);
      if (instance === null) throw new OrgEntityNotFoundError('WORKFLOW_INSTANCE');
      const target = await this.scopeTargetForOperation(repos, companyId, instance.operationId);
      await this.authorizer.assertPermission(actor.actorId, WORKFLOW_APPROVAL_READ, target);
      return repos.approvalDecisions.listByTask(companyId, taskId);
    });
  }

  // ----------------------------------------------------------------- internal

  /**
   * Assignee check — fail closed on every branch. A missing role assignment,
   * missing employee link, or absent permission denies; nothing passes by
   * omission.
   */
  private async assertAssignee(
    repos: ApprovalRepos,
    actor: ActorContext,
    task: ApprovalTask,
    instance: { startedByPrincipalId: string | null; operationId: string },
    target: ScopeTarget,
  ): Promise<void> {
    switch (task.assigneeType) {
      case 'INITIATOR':
        if (actor.actorId === instance.startedByPrincipalId) return;
        break;
      case 'PERMISSION_KEY': {
        if (
          task.assigneeValue !== null &&
          (await this.authorizer.hasPermission(actor.actorId, task.assigneeValue, target))
        )
          return;
        break;
      }
      case 'ROLE_KEY': {
        if (task.assigneeValue === null) break;
        const chain = await this.resolveChain(repos, target);
        if (chain === null) break;
        const assignments = await repos.roleAssignments.listActiveForPrincipal(
          actor.actorId,
          target.companyId,
          this.now(),
        );
        const match = assignments.filter(
          (a) => a.role.key === task.assigneeValue && scopeCovers(a, chain),
        );
        if (match.length > 0) return;
        break;
      }
      case 'DEPARTMENT_HEAD': {
        const operation = await repos.operations.findById(target.companyId, instance.operationId);
        const department =
          operation === null
            ? null
            : await repos.departments.findById(target.companyId, operation.departmentId);
        if (department?.headEmployeeId !== null && department?.headEmployeeId !== undefined) {
          const employee = await repos.employees.findById(
            target.companyId,
            department.headEmployeeId,
          );
          if (employee?.principalId === actor.actorId) return;
        }
        break;
      }
    }
    throw new NotTaskAssigneeError();
  }

  private async resolveChain(
    repos: ApprovalRepos,
    target: ScopeTarget,
  ): Promise<ScopeChain | null> {
    switch (target.scopeType) {
      case 'COMPANY':
        return { companyId: target.companyId };
      case 'HEAD_OFFICE':
        return { companyId: target.companyId, headOfficeId: target.scopeId };
      case 'PROJECT': {
        const project = await repos.projects.findChain(target.companyId, target.scopeId);
        if (project === null) return null;
        return {
          companyId: target.companyId,
          projectId: target.scopeId,
          ...(project.headOfficeId !== null ? { headOfficeId: project.headOfficeId } : {}),
        };
      }
      case 'SITE': {
        const site = await repos.sites.findChain(target.companyId, target.scopeId);
        if (site === null) return null;
        const project = await repos.projects.findChain(target.companyId, site.projectId);
        if (project === null) return null;
        return {
          companyId: target.companyId,
          siteId: target.scopeId,
          projectId: site.projectId,
          ...(project.headOfficeId !== null ? { headOfficeId: project.headOfficeId } : {}),
        };
      }
    }
  }

  private async scopeTargetForOperation(
    repos: ApprovalRepos,
    companyId: string,
    operationId: string,
  ): Promise<ScopeTarget> {
    const operation = await repos.operations.findById(companyId, operationId);
    if (!operation) throw new OrgEntityNotFoundError('OPERATION');
    const department = await repos.departments.findById(companyId, operation.departmentId);
    if (!department) throw new OrgEntityNotFoundError('DEPARTMENT');
    return departmentScopeTarget(department);
  }
}
