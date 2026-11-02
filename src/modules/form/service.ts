import { randomUUID } from 'node:crypto';
import type { Form, FormStatus, Prisma } from '@prisma/client';
import type { ActorContext, AuditRecord } from '../organization/types.js';
import { OrgEntityNotFoundError, OrgValidationError } from '../organization/errors.js';
import { normalizeCode, normalizeName } from '../organization/validation.js';
import { assertTransition } from '../organization/lifecycle.js';
import type { Authorizer } from '../department/service.js';
import type { ScopeTarget } from '../access-control/service.js';
import { departmentScopeTarget } from '../operation/service.js';
import { FORM_TRANSITIONS } from './lifecycle.js';
import { assertValidFormSchema } from './schema-validation.js';
import type { FormRepos, FormUnitOfWork } from './repository.js';
import type { CreateFormInput, UpdateFormInput } from './types.js';

export const FORM_CONFIGURE = 'FORM_CONFIGURE';
export const FORM_PUBLISH = 'FORM_PUBLISH';
export const FORM_READ = 'FORM_READ';

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

export class FormService {
  constructor(
    private readonly uow: FormUnitOfWork,
    private readonly authorizer: Authorizer,
  ) {}

  async createForm(
    actor: ActorContext,
    companyId: string,
    operationId: string,
    input: CreateFormInput,
  ): Promise<Form> {
    const key = normalizeCode(input.key);
    const name = normalizeName(input.name);
    if (input.schema !== undefined) assertValidFormSchema(input.schema);

    return this.uow.run(async (repos) => {
      const target = await this.scopeTargetForOperation(repos, companyId, operationId);
      await this.authorizer.assertPermission(actor.actorId, FORM_CONFIGURE, target);

      const form = await repos.forms.create(companyId, operationId, {
        key,
        name,
        ...(input.description !== undefined ? { description: input.description.trim() } : {}),
        ...(input.schema !== undefined ? { schema: input.schema as Prisma.InputJsonValue } : {}),
      });
      await repos.audit.record(
        auditEntry(actor, {
          action: 'FORM_CREATED',
          entityType: 'FORM',
          entityId: form.id,
          companyId,
          statusAfter: form.status,
          changedFields: {
            key: { before: null, after: key },
            name: { before: null, after: name },
          },
        }),
      );
      return form;
    });
  }

  async updateForm(
    actor: ActorContext,
    companyId: string,
    id: string,
    patch: UpdateFormInput,
    expectedVersion?: number,
  ): Promise<Form> {
    const data: Record<string, unknown> = {};
    if (patch.name !== undefined) data.name = normalizeName(patch.name);
    if (patch.description !== undefined) {
      const trimmed = patch.description?.trim();
      data.description = trimmed !== undefined && trimmed !== '' ? trimmed : null;
    }
    if (patch.schema !== undefined) {
      if (patch.schema !== null) assertValidFormSchema(patch.schema);
      data.schema = patch.schema;
    }

    return this.uow.run(async (repos) => {
      const existing = await repos.forms.findById(companyId, id);
      if (!existing) throw new OrgEntityNotFoundError('FORM');
      await this.authorizeForForm(repos, actor, FORM_CONFIGURE, existing);
      if (Object.keys(data).length === 0) return existing;
      const updated = await repos.forms.update(companyId, id, data, expectedVersion);
      await this.recordMutation(repos, actor, 'FORM_UPDATED', existing, updated, data);
      return updated;
    });
  }

  async transitionFormStatus(
    actor: ActorContext,
    companyId: string,
    id: string,
    to: string,
    expectedVersion?: number,
  ): Promise<Form> {
    return this.uow.run(async (repos) => {
      const existing = await repos.forms.findById(companyId, id);
      if (!existing) throw new OrgEntityNotFoundError('FORM');
      await this.authorizeForForm(repos, actor, FORM_CONFIGURE, existing);
      assertTransition('FORM', FORM_TRANSITIONS, existing.status, to);
      const updated = await repos.forms.update(companyId, id, { status: to }, expectedVersion);
      await this.recordMutation(repos, actor, 'FORM_STATUS_CHANGED', existing, updated, {
        status: to,
      });
      return updated;
    });
  }

  /**
   * Pin the current draft descriptor as an immutable FormVersion. Requires a
   * valid schema and a non-archived form; revision + pointer update are atomic.
   */
  async publishForm(
    actor: ActorContext,
    companyId: string,
    id: string,
    expectedVersion?: number,
  ): Promise<Form> {
    return this.uow.run(async (repos) => {
      const existing = await repos.forms.findById(companyId, id);
      if (!existing) throw new OrgEntityNotFoundError('FORM');
      await this.authorizeForForm(repos, actor, FORM_PUBLISH, existing);
      if (existing.status === 'ARCHIVED') {
        throw new OrgValidationError('status', 'cannot publish an archived form');
      }
      // Publish requires a present, valid descriptor — never snapshot a null.
      if (existing.schema === null) {
        throw new OrgValidationError('schema', 'a valid draft descriptor is required to publish');
      }
      assertValidFormSchema(existing.schema);
      const revision = existing.latestRevision + 1;
      const versionRow = await repos.formVersions.create({
        companyId,
        formId: id,
        revision,
        schema: existing.schema,
        ...(actor.actorType === 'USER' ? { publishedByPrincipalId: actor.actorId } : {}),
      });
      const updated = await repos.forms.updateForPublish(
        companyId,
        id,
        revision,
        versionRow.id,
        expectedVersion,
      );
      await repos.audit.record(
        auditEntry(actor, {
          action: 'FORM_PUBLISHED',
          entityType: 'FORM',
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

  async listForms(
    actor: ActorContext,
    companyId: string,
    filter?: { status?: FormStatus; operationId?: string },
  ) {
    await this.authorizer.assertPermission(actor.actorId, FORM_READ, {
      companyId,
      scopeType: 'COMPANY',
      scopeId: companyId,
    });
    return this.uow.run(({ forms }) => forms.list(companyId, filter));
  }

  async listVersions(actor: ActorContext, companyId: string, formId: string) {
    return this.uow.run(async (repos) => {
      const existing = await repos.forms.findById(companyId, formId);
      if (!existing) throw new OrgEntityNotFoundError('FORM');
      const target = await this.scopeTargetForOperation(repos, companyId, existing.operationId);
      await this.authorizer.assertPermission(actor.actorId, FORM_READ, target);
      return repos.formVersions.list(companyId, formId);
    });
  }

  // ----------------------------------------------------------------- internal

  // Resolve the operation's parent department to its scope target.
  private async scopeTargetForOperation(
    repos: FormRepos,
    companyId: string,
    operationId: string,
  ): Promise<ScopeTarget> {
    const operation = await repos.operations.findById(companyId, operationId);
    if (!operation) throw new OrgEntityNotFoundError('OPERATION');
    const department = await repos.departments.findById(companyId, operation.departmentId);
    if (!department) throw new OrgEntityNotFoundError('DEPARTMENT');
    return departmentScopeTarget(department);
  }

  private async authorizeForForm(
    repos: FormRepos,
    actor: ActorContext,
    permission: string,
    form: Form,
  ): Promise<void> {
    const target = await this.scopeTargetForOperation(repos, form.companyId, form.operationId);
    await this.authorizer.assertPermission(actor.actorId, permission, target);
  }

  private async recordMutation(
    repos: FormRepos,
    actor: ActorContext,
    action: string,
    before: Form,
    after: Form,
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
        entityType: 'FORM',
        entityId: after.id,
        companyId: after.companyId,
        statusBefore: before.status,
        statusAfter: after.status,
        ...(Object.keys(changedFields).length > 0 ? { changedFields } : {}),
      }),
    );
  }
}
