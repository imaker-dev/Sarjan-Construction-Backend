import { randomUUID } from 'node:crypto';
import type { Department, Operation, OperationStatus, Prisma } from '@prisma/client';
import type { ActorContext, AuditRecord } from '../organization/types.js';
import { OrgEntityNotFoundError, OrgValidationError } from '../organization/errors.js';
import { normalizeCode, normalizeName } from '../organization/validation.js';
import { assertTransition } from '../organization/lifecycle.js';
import type { Authorizer } from '../department/service.js';
import type { ScopeTarget } from '../access-control/service.js';
import { OPERATION_TRANSITIONS } from './lifecycle.js';
import { assertValidDefinition } from './validation.js';
import type { OperationRepos, OperationUnitOfWork } from './repository.js';
import type { CreateOperationInput, UpdateOperationInput } from './types.js';

export const OP_CONFIGURE = 'OPERATION_CONFIGURE';
export const OP_PUBLISH = 'OPERATION_PUBLISH';
export const OP_READ = 'OPERATION_READ';

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

// A department's stored columns are its scope target (see DepartmentService).
export function departmentScopeTarget(dept: Department): ScopeTarget {
  if (dept.scopeType === 'SITE') {
    if (dept.siteId === null) throw new Error('DEPARTMENT invariant violated: missing siteId');
    return { companyId: dept.companyId, scopeType: 'SITE', scopeId: dept.siteId };
  }
  if (dept.scopeType === 'PROJECT') {
    if (dept.projectId === null) {
      throw new Error('DEPARTMENT invariant violated: missing projectId');
    }
    return { companyId: dept.companyId, scopeType: 'PROJECT', scopeId: dept.projectId };
  }
  return { companyId: dept.companyId, scopeType: 'COMPANY', scopeId: dept.companyId };
}

export class OperationService {
  constructor(
    private readonly uow: OperationUnitOfWork,
    private readonly authorizer: Authorizer,
  ) {}

  async createOperation(
    actor: ActorContext,
    companyId: string,
    departmentId: string,
    input: CreateOperationInput,
  ): Promise<Operation> {
    const key = normalizeCode(input.key);
    const name = normalizeName(input.name);
    if (input.definition !== undefined) assertValidDefinition(input.definition);

    return this.uow.run(async ({ departments, operations, audit }) => {
      const department = await departments.findById(companyId, departmentId);
      if (!department) throw new OrgEntityNotFoundError('DEPARTMENT');
      // An operation inherits its department's scope — authorize there.
      await this.authorizer.assertPermission(
        actor.actorId,
        OP_CONFIGURE,
        departmentScopeTarget(department),
      );

      const operation = await operations.create(companyId, departmentId, {
        key,
        name,
        ...(input.capabilityKey !== undefined ? { capabilityKey: input.capabilityKey.trim() } : {}),
        ...(input.description !== undefined ? { description: input.description.trim() } : {}),
        ...(input.definition !== undefined
          ? { definition: input.definition as Prisma.InputJsonValue }
          : {}),
      });
      await audit.record(
        auditEntry(actor, {
          action: 'OP_OPERATION_CREATED',
          entityType: 'OPERATION',
          entityId: operation.id,
          companyId,
          statusAfter: operation.status,
          changedFields: {
            key: { before: null, after: key },
            name: { before: null, after: name },
          },
        }),
      );
      return operation;
    });
  }

  async updateOperation(
    actor: ActorContext,
    companyId: string,
    id: string,
    patch: UpdateOperationInput,
    expectedVersion?: number,
  ): Promise<Operation> {
    const data: Record<string, unknown> = {};
    if (patch.name !== undefined) data.name = normalizeName(patch.name);
    if (patch.capabilityKey !== undefined) {
      const trimmed = patch.capabilityKey?.trim();
      data.capabilityKey = trimmed !== undefined && trimmed !== '' ? trimmed : null;
    }
    if (patch.description !== undefined) {
      const trimmed = patch.description?.trim();
      data.description = trimmed !== undefined && trimmed !== '' ? trimmed : null;
    }
    if (patch.definition !== undefined) {
      if (patch.definition !== null) assertValidDefinition(patch.definition);
      data.definition = patch.definition;
    }

    return this.uow.run(async (repos) => {
      const existing = await repos.operations.findById(companyId, id);
      if (!existing) throw new OrgEntityNotFoundError('OPERATION');
      await this.authorizeForOperation(repos, actor, OP_CONFIGURE, existing);
      if (Object.keys(data).length === 0) return existing;
      const updated = await repos.operations.update(companyId, id, data, expectedVersion);
      await this.recordMutation(repos, actor, 'OP_OPERATION_UPDATED', existing, updated, data);
      return updated;
    });
  }

  async transitionOperationStatus(
    actor: ActorContext,
    companyId: string,
    id: string,
    to: string,
    expectedVersion?: number,
  ): Promise<Operation> {
    return this.uow.run(async (repos) => {
      const existing = await repos.operations.findById(companyId, id);
      if (!existing) throw new OrgEntityNotFoundError('OPERATION');
      await this.authorizeForOperation(repos, actor, OP_CONFIGURE, existing);
      assertTransition('OPERATION', OPERATION_TRANSITIONS, existing.status, to);
      const updated = await repos.operations.update(companyId, id, { status: to }, expectedVersion);
      await this.recordMutation(repos, actor, 'OP_OPERATION_STATUS_CHANGED', existing, updated, {
        status: to,
      });
      return updated;
    });
  }

  /**
   * Pin the current draft definition as an immutable published version.
   * Revision is monotonic per operation; the version row and the
   * currentVersionId pointer are written atomically.
   */
  async publishOperation(
    actor: ActorContext,
    companyId: string,
    id: string,
    expectedVersion?: number,
  ): Promise<Operation> {
    return this.uow.run(async (repos) => {
      const existing = await repos.operations.findById(companyId, id);
      if (!existing) throw new OrgEntityNotFoundError('OPERATION');
      await this.authorizeForOperation(repos, actor, OP_PUBLISH, existing);
      if (existing.status === 'ARCHIVED') {
        throw new OrgValidationError('status', 'cannot publish an archived operation');
      }
      const revision = existing.latestRevision + 1;
      const versionRow = await repos.operationVersions.create({
        companyId,
        operationId: id,
        revision,
        definition: existing.definition ?? {},
        // Only a USER actor is recorded; SYSTEM/SERVICE publish leaves it null.
        ...(actor.actorType === 'USER' ? { publishedByPrincipalId: actor.actorId } : {}),
      });
      const updated = await repos.operations.updateForPublish(
        companyId,
        id,
        revision,
        versionRow.id,
        expectedVersion,
      );
      await repos.audit.record(
        auditEntry(actor, {
          action: 'OP_OPERATION_PUBLISHED',
          entityType: 'OPERATION',
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

  async listOperations(
    actor: ActorContext,
    companyId: string,
    filter?: { status?: OperationStatus; departmentId?: string },
  ) {
    await this.authorizer.assertPermission(actor.actorId, OP_READ, {
      companyId,
      scopeType: 'COMPANY',
      scopeId: companyId,
    });
    return this.uow.run(({ operations }) => operations.list(companyId, filter));
  }

  async listVersions(actor: ActorContext, companyId: string, operationId: string) {
    return this.uow.run(async ({ operations, departments, operationVersions }) => {
      const existing = await operations.findById(companyId, operationId);
      if (!existing) throw new OrgEntityNotFoundError('OPERATION');
      const department = await departments.findById(companyId, existing.departmentId);
      if (!department) throw new OrgEntityNotFoundError('DEPARTMENT');
      await this.authorizer.assertPermission(
        actor.actorId,
        OP_READ,
        departmentScopeTarget(department),
      );
      return operationVersions.list(companyId, operationId);
    });
  }

  // ----------------------------------------------------------------- internal

  // Authorize against the operation's parent department scope.
  private async authorizeForOperation(
    repos: OperationRepos,
    actor: ActorContext,
    permission: string,
    operation: Operation,
  ): Promise<void> {
    const department = await repos.departments.findById(
      operation.companyId,
      operation.departmentId,
    );
    if (!department) throw new OrgEntityNotFoundError('DEPARTMENT');
    await this.authorizer.assertPermission(
      actor.actorId,
      permission,
      departmentScopeTarget(department),
    );
  }

  private async recordMutation(
    repos: OperationRepos,
    actor: ActorContext,
    action: string,
    before: Operation,
    after: Operation,
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
        entityType: 'OPERATION',
        entityId: after.id,
        companyId: after.companyId,
        statusBefore: before.status,
        statusAfter: after.status,
        ...(Object.keys(changedFields).length > 0 ? { changedFields } : {}),
      }),
    );
  }
}
