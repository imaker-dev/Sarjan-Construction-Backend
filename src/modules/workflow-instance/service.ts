import { randomUUID } from 'node:crypto';
import type { WorkflowInstance, WorkflowState } from '@prisma/client';
import type { ActorContext, AuditRecord } from '../organization/types.js';
import {
  OrgEntityNotFoundError,
  OrgValidationError,
  InvalidStatusTransitionError,
} from '../organization/errors.js';
import { normalizeCode } from '../organization/validation.js';
import type { Authorizer } from '../department/service.js';
import type { ScopeTarget } from '../access-control/service.js';
import { departmentScopeTarget } from '../operation/service.js';
import { TERMINAL_STATES, STEP_ACTIONS } from '../workflow/definition-validation.js';
import { commandFingerprint } from './fingerprint.js';
import { BUSINESS_ENTITY_TYPE_RE, IdempotencyConflictError } from './errors.js';
import {
  applyPinnedTransition,
  ensureApprovalStageTask,
  stepsOf,
  initialStateOf,
} from './apply.js';
import type { WorkflowInstanceRepos, WorkflowInstanceUnitOfWork } from './repository.js';
import type {
  InstanceListFilter,
  StartInstanceInput,
  TransitionInput,
  TransitionResult,
} from './types.js';

export const WF_INSTANCE_READ = 'WORKFLOW_INSTANCE_READ';
export const WF_INSTANCE_START = 'WORKFLOW_INSTANCE_START';
export const WF_INSTANCE_TRANSITION = 'WORKFLOW_INSTANCE_TRANSITION';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

export class WorkflowInstanceService {
  constructor(
    private readonly uow: WorkflowInstanceUnitOfWork,
    private readonly authorizer: Authorizer,
  ) {}

  /**
   * Start an instance from an ACTIVE workflow's CURRENT published version —
   * callers never pick a version. The OperationVersion is derived from the
   * workflow, never accepted from the caller.
   */
  async startInstance(
    actor: ActorContext,
    companyId: string,
    workflowId: string,
    input: StartInstanceInput = {},
  ): Promise<WorkflowInstance> {
    // Business back-reference pair: both or neither.
    const hasType = input.businessEntityType !== undefined;
    const hasId = input.businessEntityId !== undefined;
    if (hasType !== hasId) {
      throw new OrgValidationError('businessEntity', 'type and id must be set together');
    }
    let businessEntityType: string | undefined;
    if (hasType && hasId) {
      businessEntityType = normalizeCode(input.businessEntityType ?? '');
      if (!BUSINESS_ENTITY_TYPE_RE.test(businessEntityType)) {
        throw new OrgValidationError('businessEntityType', 'must be a normalized token');
      }
      if (typeof input.businessEntityId !== 'string' || !UUID_RE.test(input.businessEntityId)) {
        throw new OrgValidationError('businessEntityId', 'must be a UUID');
      }
    }
    return this.uow.run(async (repos) => {
      const workflow = await repos.workflows.findForStart(companyId, workflowId);
      if (!workflow) throw new OrgEntityNotFoundError('WORKFLOW');
      const target = await this.scopeTargetForOperation(repos, companyId, workflow.operationId);
      await this.authorizer.assertPermission(actor.actorId, WF_INSTANCE_START, target);
      if (workflow.status !== 'ACTIVE') {
        throw new OrgValidationError(
          'status',
          `workflow is ${workflow.status} — only ACTIVE workflows start instances`,
        );
      }
      if (workflow.currentVersionId === null) {
        throw new OrgValidationError('currentVersionId', 'workflow has no published version');
      }
      const version = await repos.workflowVersions.findById(
        companyId,
        workflowId,
        workflow.currentVersionId,
      );
      if (version === null) throw new OrgEntityNotFoundError('WORKFLOW_VERSION');
      const initialState = initialStateOf(version.definition);
      if (initialState === null) {
        throw new OrgValidationError('definition', 'snapshot has no initialState');
      }
      const instance = await repos.instances.create(companyId, {
        operationId: workflow.operationId,
        workflowId,
        workflowVersionId: version.id,
        operationVersionId: workflow.operationVersionId,
        state: initialState as WorkflowState,
        ...(businessEntityType !== undefined
          ? { businessEntityType, businessEntityId: input.businessEntityId }
          : {}),
        ...(actor.actorType === 'USER' ? { startedByPrincipalId: actor.actorId } : {}),
      });
      await repos.audit.record(
        auditEntry(actor, {
          action: 'WF_INSTANCE_STARTED',
          entityType: 'WORKFLOW_INSTANCE',
          entityId: instance.id,
          companyId,
          statusAfter: instance.state,
          changedFields: {
            workflowId: { before: null, after: workflowId },
            workflowVersionId: { before: null, after: version.id },
            operationVersionId: { before: null, after: workflow.operationVersionId },
          },
        }),
      );
      // If the definition begins inside an approval stage, open the task now —
      // the approver must not need to call APPROVE just to see it.
      await ensureApprovalStageTask(repos, actor, companyId, instance, version.definition);
      return instance;
    });
  }

  /**
   * Apply a transition from the pinned WorkflowVersion snapshot. Idempotent:
   * same key + same action returns the recorded transition; same key + a
   * different action is a conflict.
   */
  async transition(
    actor: ActorContext,
    companyId: string,
    instanceId: string,
    input: TransitionInput,
  ): Promise<TransitionResult> {
    if (!STEP_ACTIONS.includes(input.action as never)) {
      throw new OrgValidationError('action', `unknown action ${JSON.stringify(input.action)}`);
    }
    if (input.idempotencyKey === '') {
      throw new OrgValidationError('idempotencyKey', 'must be non-empty');
    }

    // Stable fingerprint of the complete semantic command — bound to the
    // idempotency key. expectedVersion and correlation ids are excluded.
    const fingerprint =
      input.idempotencyKey !== undefined
        ? commandFingerprint({
            action: input.action,
            ...(input.reason !== undefined ? { reason: input.reason } : {}),
          })
        : undefined;

    return this.uow.run(async (repos) => {
      const instance = await repos.instances.findById(companyId, instanceId);
      if (!instance) throw new OrgEntityNotFoundError('WORKFLOW_INSTANCE');
      const target = await this.scopeTargetForOperation(repos, companyId, instance.operationId);
      await this.authorizer.assertPermission(actor.actorId, WF_INSTANCE_TRANSITION, target);

      // Idempotent replay — authorized before any recorded data is returned.
      if (input.idempotencyKey !== undefined) {
        const recorded = await repos.transitions.findByIdempotencyKey(
          companyId,
          instanceId,
          input.idempotencyKey,
        );
        if (recorded !== null) {
          if (recorded.requestFingerprint !== fingerprint) {
            throw new IdempotencyConflictError(input.idempotencyKey);
          }
          return { instance, transition: recorded, replayed: true, pendingApproval: false };
        }
      }

      if (TERMINAL_STATES.has(instance.state)) {
        throw new InvalidStatusTransitionError(
          'WORKFLOW_INSTANCE',
          instance.state,
          `action ${input.action}`,
        );
      }
      // The pinned snapshot is the law — it cannot change after start.
      const version = await repos.workflowVersions.findById(
        companyId,
        instance.workflowId,
        instance.workflowVersionId,
      );
      if (version === null) throw new OrgEntityNotFoundError('WORKFLOW_VERSION');
      const matches = stepsOf(version.definition).filter(
        (s) => s.from === instance.state && s.action === input.action,
      );
      if (matches.length === 0) {
        throw new InvalidStatusTransitionError('WORKFLOW_INSTANCE', instance.state, input.action);
      }
      // Duplicates rejected at publish — length ≥ 1 is guaranteed, but the
      // runtime still defends against a corrupted snapshot.
      const step = matches[0];
      if (step === undefined) {
        throw new InvalidStatusTransitionError('WORKFLOW_INSTANCE', instance.state, input.action);
      }
      if (step.kind === 'APPROVAL') {
        // Approval actions open a task — decisions go through the Approval
        // Engine. The task normally already exists (opened on stage entry);
        // creating defensively covers snapshots pinned before tasks existed.
        const task = await ensureApprovalStageTask(
          repos,
          actor,
          companyId,
          instance,
          version.definition,
        );
        return {
          instance,
          ...(task !== null ? { task } : {}),
          replayed: false,
          pendingApproval: true,
        };
      }

      const result = await applyPinnedTransition(repos, actor, companyId, instance, step, {
        action: input.action,
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
        ...(input.expectedVersion !== undefined ? { expectedVersion: input.expectedVersion } : {}),
        ...(input.idempotencyKey !== undefined && fingerprint !== undefined
          ? { idempotencyKey: input.idempotencyKey, fingerprint }
          : {}),
      });
      // A state move may enter a new approval stage — open its task now.
      const task = await ensureApprovalStageTask(
        repos,
        actor,
        companyId,
        result.instance,
        version.definition,
      );
      return {
        instance: result.instance,
        transition: result.transition,
        ...(task !== null ? { task } : {}),
        replayed: result.replayed,
        pendingApproval: task !== null,
      };
    });
  }

  async listInstances(actor: ActorContext, companyId: string, filter?: InstanceListFilter) {
    await this.authorizer.assertPermission(actor.actorId, WF_INSTANCE_READ, {
      companyId,
      scopeType: 'COMPANY',
      scopeId: companyId,
    });
    return this.uow.run(({ instances }) => instances.list(companyId, filter));
  }

  async listTransitions(actor: ActorContext, companyId: string, instanceId: string) {
    return this.uow.run(async (repos) => {
      const instance = await repos.instances.findById(companyId, instanceId);
      if (!instance) throw new OrgEntityNotFoundError('WORKFLOW_INSTANCE');
      const target = await this.scopeTargetForOperation(repos, companyId, instance.operationId);
      await this.authorizer.assertPermission(actor.actorId, WF_INSTANCE_READ, target);
      return repos.transitions.list(companyId, instanceId);
    });
  }

  // ----------------------------------------------------------------- internal

  private async scopeTargetForOperation(
    repos: WorkflowInstanceRepos,
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
