import { randomUUID } from 'node:crypto';
import type { Prisma, Workflow, WorkflowStatus } from '@prisma/client';
import type { ActorContext, AuditRecord } from '../organization/types.js';
import { OrgEntityNotFoundError, OrgValidationError } from '../organization/errors.js';
import { normalizeCode, normalizeName } from '../organization/validation.js';
import { assertTransition } from '../organization/lifecycle.js';
import type { Authorizer } from '../department/service.js';
import type { ScopeTarget } from '../access-control/service.js';
import { departmentScopeTarget } from '../operation/service.js';
import { WORKFLOW_TRANSITIONS } from './lifecycle.js';
import {
  assertValidWorkflowDefinition,
  formVersionRefs,
  ruleVersionRefs,
} from './definition-validation.js';
import type { WorkflowRepos, WorkflowUnitOfWork } from './repository.js';
import type { CreateWorkflowInput, UpdateWorkflowInput } from './types.js';

export const WF_CONFIGURE = 'WORKFLOW_CONFIGURE';
export const WF_PUBLISH = 'WORKFLOW_PUBLISH';
export const WF_READ = 'WORKFLOW_READ';

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

export class WorkflowService {
  constructor(
    private readonly uow: WorkflowUnitOfWork,
    private readonly authorizer: Authorizer,
  ) {}

  async createWorkflow(
    actor: ActorContext,
    companyId: string,
    input: CreateWorkflowInput,
  ): Promise<Workflow> {
    const key = normalizeCode(input.key);
    const name = normalizeName(input.name);
    if (input.definition !== undefined) assertValidWorkflowDefinition(input.definition);

    return this.uow.run(async (repos) => {
      // The pinned OperationVersion must exist in this company; the composite
      // FK guarantees it also belongs to this operation.
      const operationId = await repos.operationVersions.findOperationId(
        companyId,
        input.operationVersionId,
      );
      if (operationId === null) throw new OrgEntityNotFoundError('OPERATION_VERSION');
      const target = await this.scopeTargetForOperation(repos, companyId, operationId);
      await this.authorizer.assertPermission(actor.actorId, WF_CONFIGURE, target);

      const workflow = await repos.workflows.create(
        companyId,
        operationId,
        input.operationVersionId,
        {
          key,
          name,
          ...(input.description !== undefined ? { description: input.description.trim() } : {}),
          ...(input.definition !== undefined
            ? { definition: input.definition as Prisma.InputJsonValue }
            : {}),
        },
      );
      await repos.audit.record(
        auditEntry(actor, {
          action: 'WF_CREATED',
          entityType: 'WORKFLOW',
          entityId: workflow.id,
          companyId,
          statusAfter: workflow.status,
          changedFields: {
            key: { before: null, after: key },
            name: { before: null, after: name },
          },
        }),
      );
      return workflow;
    });
  }

  async updateWorkflow(
    actor: ActorContext,
    companyId: string,
    id: string,
    patch: UpdateWorkflowInput,
    expectedVersion?: number,
  ): Promise<Workflow> {
    const data: Record<string, unknown> = {};
    if (patch.name !== undefined) data.name = normalizeName(patch.name);
    if (patch.description !== undefined) {
      const trimmed = patch.description?.trim();
      data.description = trimmed !== undefined && trimmed !== '' ? trimmed : null;
    }
    if (patch.definition !== undefined) {
      if (patch.definition !== null) assertValidWorkflowDefinition(patch.definition);
      data.definition = patch.definition;
    }

    return this.uow.run(async (repos) => {
      const existing = await repos.workflows.findById(companyId, id);
      if (!existing) throw new OrgEntityNotFoundError('WORKFLOW');
      await this.authorizeForWorkflow(repos, actor, WF_CONFIGURE, existing);
      if (Object.keys(data).length === 0) return existing;
      const updated = await repos.workflows.update(companyId, id, data, expectedVersion);
      await this.recordMutation(repos, actor, 'WF_UPDATED', existing, updated, data);
      return updated;
    });
  }

  async transitionWorkflowStatus(
    actor: ActorContext,
    companyId: string,
    id: string,
    to: string,
    expectedVersion?: number,
  ): Promise<Workflow> {
    return this.uow.run(async (repos) => {
      const existing = await repos.workflows.findById(companyId, id);
      if (!existing) throw new OrgEntityNotFoundError('WORKFLOW');
      await this.authorizeForWorkflow(repos, actor, WF_CONFIGURE, existing);
      assertTransition('WORKFLOW', WORKFLOW_TRANSITIONS, existing.status, to);
      const updated = await repos.workflows.update(companyId, id, { status: to }, expectedVersion);
      await this.recordMutation(repos, actor, 'WF_STATUS_CHANGED', existing, updated, {
        status: to,
      });
      return updated;
    });
  }

  /**
   * Pin the current draft definition as an immutable WorkflowVersion. Requires
   * a valid descriptor and every referenced FormVersion to exist in the same
   * company and belong to the same operation.
   */
  async publishWorkflow(
    actor: ActorContext,
    companyId: string,
    id: string,
    expectedVersion?: number,
  ): Promise<Workflow> {
    return this.uow.run(async (repos) => {
      const existing = await repos.workflows.findById(companyId, id);
      if (!existing) throw new OrgEntityNotFoundError('WORKFLOW');
      await this.authorizeForWorkflow(repos, actor, WF_PUBLISH, existing);
      if (existing.status === 'ARCHIVED') {
        throw new OrgValidationError('status', 'cannot publish an archived workflow');
      }
      if (existing.definition === null) {
        throw new OrgValidationError('definition', 'a valid draft descriptor is required');
      }
      assertValidWorkflowDefinition(existing.definition);
      // Publish-time referential check: same company AND same operation.
      for (const formVersionId of formVersionRefs(existing.definition)) {
        const refOperationId = await repos.formVersions.findOperationId(companyId, formVersionId);
        if (refOperationId === null) {
          throw new OrgValidationError('formVersionId', `version ${formVersionId} not found`);
        }
        if (refOperationId !== existing.operationId) {
          throw new OrgValidationError(
            'formVersionId',
            `version ${formVersionId} belongs to a different operation`,
          );
        }
      }
      // Guard references: same company AND same operation.
      for (const ruleVersionId of ruleVersionRefs(existing.definition)) {
        const refOperationId = await repos.ruleVersions.findOperationId(companyId, ruleVersionId);
        if (refOperationId === null) {
          throw new OrgValidationError('ruleVersionId', `version ${ruleVersionId} not found`);
        }
        if (refOperationId !== existing.operationId) {
          throw new OrgValidationError(
            'ruleVersionId',
            `version ${ruleVersionId} belongs to a different operation`,
          );
        }
      }
      const revision = existing.latestRevision + 1;
      const versionRow = await repos.workflowVersions.create({
        companyId,
        workflowId: id,
        revision,
        definition: existing.definition,
        ...(actor.actorType === 'USER' ? { publishedByPrincipalId: actor.actorId } : {}),
      });
      const updated = await repos.workflows.updateForPublish(
        companyId,
        id,
        revision,
        versionRow.id,
        expectedVersion,
      );
      await repos.audit.record(
        auditEntry(actor, {
          action: 'WF_PUBLISHED',
          entityType: 'WORKFLOW',
          entityId: id,
          companyId,
          statusBefore: existing.status,
          statusAfter: existing.status,
          changedFields: {
            revision: { before: existing.latestRevision, after: revision },
            currentVersionId: { before: existing.currentVersionId, after: versionRow.id },
          },
        }),
      );
      return updated;
    });
  }

  async listWorkflows(
    actor: ActorContext,
    companyId: string,
    filter?: { status?: WorkflowStatus; operationId?: string },
  ) {
    await this.authorizer.assertPermission(actor.actorId, WF_READ, {
      companyId,
      scopeType: 'COMPANY',
      scopeId: companyId,
    });
    return this.uow.run(({ workflows }) => workflows.list(companyId, filter));
  }

  async listVersions(actor: ActorContext, companyId: string, workflowId: string) {
    return this.uow.run(async (repos) => {
      const existing = await repos.workflows.findById(companyId, workflowId);
      if (!existing) throw new OrgEntityNotFoundError('WORKFLOW');
      const target = await this.scopeTargetForOperation(repos, companyId, existing.operationId);
      await this.authorizer.assertPermission(actor.actorId, WF_READ, target);
      return repos.workflowVersions.list(companyId, workflowId);
    });
  }

  // ----------------------------------------------------------------- internal

  private async scopeTargetForOperation(
    repos: WorkflowRepos,
    companyId: string,
    operationId: string,
  ): Promise<ScopeTarget> {
    const operation = await repos.operations.findById(companyId, operationId);
    if (!operation) throw new OrgEntityNotFoundError('OPERATION');
    const department = await repos.departments.findById(companyId, operation.departmentId);
    if (!department) throw new OrgEntityNotFoundError('DEPARTMENT');
    return departmentScopeTarget(department);
  }

  private async authorizeForWorkflow(
    repos: WorkflowRepos,
    actor: ActorContext,
    permission: string,
    workflow: Workflow,
  ): Promise<void> {
    const target = await this.scopeTargetForOperation(
      repos,
      workflow.companyId,
      workflow.operationId,
    );
    await this.authorizer.assertPermission(actor.actorId, permission, target);
  }

  private async recordMutation(
    repos: WorkflowRepos,
    actor: ActorContext,
    action: string,
    before: Workflow,
    after: Workflow,
    patch: Record<string, unknown>,
  ): Promise<void> {
    const changedFields: Record<string, { before: unknown; after: unknown }> = {};
    for (const [key, afterValue] of Object.entries(patch)) {
      const beforeValue = (before as unknown as Record<string, unknown>)[key];
      if (beforeValue !== afterValue) {
        changedFields[key] = { before: beforeValue ?? null, after: afterValue };
      }
    }
    await repos.audit.record(
      auditEntry(actor, {
        action,
        entityType: 'WORKFLOW',
        entityId: after.id,
        companyId: after.companyId,
        statusBefore: before.status,
        statusAfter: after.status,
        ...(Object.keys(changedFields).length > 0 ? { changedFields } : {}),
      }),
    );
  }
}
