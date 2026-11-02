import { randomUUID } from 'node:crypto';
import type { Prisma, Rule, RuleStatus } from '@prisma/client';
import type { ActorContext, AuditRecord } from '../organization/types.js';
import { OrgEntityNotFoundError, OrgValidationError } from '../organization/errors.js';
import { normalizeCode, normalizeName } from '../organization/validation.js';
import { assertTransition } from '../organization/lifecycle.js';
import type { Authorizer } from '../department/service.js';
import type { ScopeTarget } from '../access-control/service.js';
import { departmentScopeTarget } from '../operation/service.js';
import { RULE_TRANSITIONS } from './lifecycle.js';
import { assertValidRuleDefinition, fieldRefs } from './definition-validation.js';
import type { RuleRepos, RuleUnitOfWork } from './repository.js';
import type { CreateRuleInput, UpdateRuleInput } from './types.js';

export const RULE_CONFIGURE = 'RULE_CONFIGURE';
export const RULE_PUBLISH = 'RULE_PUBLISH';
export const RULE_READ = 'RULE_READ';

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

export class RuleService {
  constructor(
    private readonly uow: RuleUnitOfWork,
    private readonly authorizer: Authorizer,
  ) {}

  async createRule(
    actor: ActorContext,
    companyId: string,
    operationId: string,
    input: CreateRuleInput,
  ): Promise<Rule> {
    const key = normalizeCode(input.key);
    const name = normalizeName(input.name);
    if (input.definition !== undefined) assertValidRuleDefinition(input.definition);

    return this.uow.run(async (repos) => {
      const target = await this.scopeTargetForOperation(repos, companyId, operationId);
      await this.authorizer.assertPermission(actor.actorId, RULE_CONFIGURE, target);

      const rule = await repos.rules.create(companyId, operationId, {
        key,
        name,
        ...(input.description !== undefined ? { description: input.description.trim() } : {}),
        ...(input.definition !== undefined
          ? { definition: input.definition as Prisma.InputJsonValue }
          : {}),
      });
      await repos.audit.record(
        auditEntry(actor, {
          action: 'RULE_CREATED',
          entityType: 'RULE',
          entityId: rule.id,
          companyId,
          statusAfter: rule.status,
          changedFields: {
            key: { before: null, after: key },
            name: { before: null, after: name },
          },
        }),
      );
      return rule;
    });
  }

  async updateRule(
    actor: ActorContext,
    companyId: string,
    id: string,
    patch: UpdateRuleInput,
    expectedVersion?: number,
  ): Promise<Rule> {
    const data: Record<string, unknown> = {};
    if (patch.name !== undefined) data.name = normalizeName(patch.name);
    if (patch.description !== undefined) {
      const trimmed = patch.description?.trim();
      data.description = trimmed !== undefined && trimmed !== '' ? trimmed : null;
    }
    if (patch.definition !== undefined) {
      if (patch.definition !== null) assertValidRuleDefinition(patch.definition);
      data.definition = patch.definition;
    }

    return this.uow.run(async (repos) => {
      const existing = await repos.rules.findById(companyId, id);
      if (!existing) throw new OrgEntityNotFoundError('RULE');
      await this.authorizeForRule(repos, actor, RULE_CONFIGURE, existing);
      if (Object.keys(data).length === 0) return existing;
      const updated = await repos.rules.update(companyId, id, data, expectedVersion);
      await this.recordMutation(repos, actor, 'RULE_UPDATED', existing, updated, data);
      return updated;
    });
  }

  async transitionRuleStatus(
    actor: ActorContext,
    companyId: string,
    id: string,
    to: string,
    expectedVersion?: number,
  ): Promise<Rule> {
    return this.uow.run(async (repos) => {
      const existing = await repos.rules.findById(companyId, id);
      if (!existing) throw new OrgEntityNotFoundError('RULE');
      await this.authorizeForRule(repos, actor, RULE_CONFIGURE, existing);
      assertTransition('RULE', RULE_TRANSITIONS, existing.status, to);
      const updated = await repos.rules.update(companyId, id, { status: to }, expectedVersion);
      await this.recordMutation(repos, actor, 'RULE_STATUS_CHANGED', existing, updated, {
        status: to,
      });
      return updated;
    });
  }

  /**
   * Publish an immutable snapshot. Verifies every field ref: the FormVersion
   * exists in the company, belongs to the same operation, declares the field
   * key, and (when the leaf declares fieldType) the type matches.
   */
  async publishRule(
    actor: ActorContext,
    companyId: string,
    id: string,
    expectedVersion?: number,
  ): Promise<Rule> {
    return this.uow.run(async (repos) => {
      const existing = await repos.rules.findById(companyId, id);
      if (!existing) throw new OrgEntityNotFoundError('RULE');
      await this.authorizeForRule(repos, actor, RULE_PUBLISH, existing);
      if (existing.status === 'ARCHIVED') {
        throw new OrgValidationError('status', 'cannot publish an archived rule');
      }
      if (existing.definition === null) {
        throw new OrgValidationError('definition', 'a valid draft descriptor is required');
      }
      assertValidRuleDefinition(existing.definition);
      // Field-ref verification: type comes from the FormVersion, not the rule.
      for (const ref of fieldRefs(existing.definition)) {
        const found = await repos.formVersions.findField(
          companyId,
          ref.formVersionId,
          ref.fieldKey,
        );
        if (found.operationId === null) {
          throw new OrgValidationError('ref', `FormVersion ${ref.formVersionId} not found`);
        }
        if (found.operationId !== existing.operationId) {
          throw new OrgValidationError(
            'ref',
            `FormVersion ${ref.formVersionId} belongs to a different operation`,
          );
        }
        if (found.fieldType === null) {
          throw new OrgValidationError(
            'ref',
            `field ${ref.fieldKey} not declared in FormVersion ${ref.formVersionId}`,
          );
        }
        // The FormVersion's declared type is authoritative — a leaf's own
        // fieldType must agree, never override it.
        if (ref.declaredType !== undefined && ref.declaredType !== found.fieldType) {
          throw new OrgValidationError(
            'ref',
            `field ${ref.fieldKey} is typed ${found.fieldType}, not ${ref.declaredType}`,
          );
        }
      }
      const revision = existing.latestRevision + 1;
      const versionRow = await repos.ruleVersions.create({
        companyId,
        ruleId: id,
        revision,
        definition: existing.definition,
        ...(actor.actorType === 'USER' ? { publishedByPrincipalId: actor.actorId } : {}),
      });
      const updated = await repos.rules.updateForPublish(
        companyId,
        id,
        revision,
        versionRow.id,
        expectedVersion,
      );
      await repos.audit.record(
        auditEntry(actor, {
          action: 'RULE_PUBLISHED',
          entityType: 'RULE',
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

  async listRules(
    actor: ActorContext,
    companyId: string,
    filter?: { status?: RuleStatus; operationId?: string },
  ) {
    await this.authorizer.assertPermission(actor.actorId, RULE_READ, {
      companyId,
      scopeType: 'COMPANY',
      scopeId: companyId,
    });
    return this.uow.run(({ rules }) => rules.list(companyId, filter));
  }

  async listVersions(actor: ActorContext, companyId: string, ruleId: string) {
    return this.uow.run(async (repos) => {
      const existing = await repos.rules.findById(companyId, ruleId);
      if (!existing) throw new OrgEntityNotFoundError('RULE');
      const target = await this.scopeTargetForOperation(repos, companyId, existing.operationId);
      await this.authorizer.assertPermission(actor.actorId, RULE_READ, target);
      return repos.ruleVersions.list(companyId, ruleId);
    });
  }

  // ----------------------------------------------------------------- internal

  private async scopeTargetForOperation(
    repos: RuleRepos,
    companyId: string,
    operationId: string,
  ): Promise<ScopeTarget> {
    const operation = await repos.operations.findById(companyId, operationId);
    if (!operation) throw new OrgEntityNotFoundError('OPERATION');
    const department = await repos.departments.findById(companyId, operation.departmentId);
    if (!department) throw new OrgEntityNotFoundError('DEPARTMENT');
    return departmentScopeTarget(department);
  }

  private async authorizeForRule(
    repos: RuleRepos,
    actor: ActorContext,
    permission: string,
    rule: Rule,
  ): Promise<void> {
    const target = await this.scopeTargetForOperation(repos, rule.companyId, rule.operationId);
    await this.authorizer.assertPermission(actor.actorId, permission, target);
  }

  private async recordMutation(
    repos: RuleRepos,
    actor: ActorContext,
    action: string,
    before: Rule,
    after: Rule,
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
        entityType: 'RULE',
        entityId: after.id,
        companyId: after.companyId,
        statusBefore: before.status,
        statusAfter: after.status,
        ...(Object.keys(changedFields).length > 0 ? { changedFields } : {}),
      }),
    );
  }
}
