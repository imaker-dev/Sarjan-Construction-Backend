import { randomUUID } from 'node:crypto';
import type {
  LeaveBalance,
  LeavePolicy,
  LeavePolicyVersion,
  LeaveRequestStatus,
  LeaveType,
  LeaveTypeDef,
} from '@prisma/client';
import type { ScopeTarget } from '../access-control/service.js';
import type { ActorContext, AuditRecord } from '../organization/types.js';
import type { RoleNotificationDispatcher } from '../notification/role-dispatcher.js';
import { normalizeCode } from '../organization/validation.js';
import {
  AmbiguousLeaveScopeError,
  InsufficientLeaveBalanceError,
  InvalidLeavePolicyStateError,
  LastActiveLeavePolicyVersionError,
  LeaveDateConflictError,
  LeaveDocumentRequiredError,
  LeaveNoticePeriodError,
  LeavePeriodBoundaryError,
  LeavePolicyNotFoundError,
  LeavePolicyValidationError,
  LeavePolicyVersionNotFoundError,
  LeaveRequestStateError,
  LeaveScopeShapeError,
  LeaveTypeDefNotFoundError,
  MaxConsecutiveLeaveDaysExceededError,
  NoEffectiveLeavePolicyError,
  SelfApprovalNotAllowedError,
} from './errors.js';
import type {
  LeavePolicyScopeTarget,
  LeaveRequestWithDetails,
  LeaveRepos,
  LeaveUnitOfWork,
} from './repository.js';
import {
  calculateNetLeaveDays,
  type AddLeavePolicyVersionInput,
  type AllocateLeaveBalanceInput,
  type CancelLeaveRequestInput,
  type CreateLeavePolicyInput,
  type CreateLeaveTypeDefInput,
  type EffectiveLeavePolicyCriteria,
  type ListLeaveBalancesFilter,
  type ListLeavePoliciesFilter,
  type ListLeaveRequestsFilter,
  type ListLeaveTypeDefsFilter,
  type PolicyVersionInput,
  type ReviewLeaveRequestInput,
  type SubmitLeaveRequestInput,
  type UpdateLeavePolicyInput,
  type UpdateLeaveTypeDefInput,
} from './types.js';

export const LEAVE_APPLY = 'LEAVE_APPLY';
export const LEAVE_READ = 'LEAVE_READ';
export const LEAVE_APPROVE = 'LEAVE_APPROVE';
export const LEAVE_MANAGE = 'LEAVE_MANAGE';

interface Authorizer {
  assertPermission(principalId: string, permissionKey: string, target: ScopeTarget): Promise<void>;
}

const auditEntry = (
  actor: ActorContext,
  base: Omit<AuditRecord, 'eventKey' | 'actorId' | 'actorType' | 'correlationId'>,
): AuditRecord => ({
  eventKey: randomUUID(),
  actorId: actor.actorId,
  actorType: actor.actorType,
  ...(actor.correlationId !== undefined ? { correlationId: actor.correlationId } : {}),
  ...base,
});

const companyTarget = (companyId: string): ScopeTarget => ({
  companyId,
  scopeType: 'COMPANY',
  scopeId: companyId,
});

export class LeaveService {
  constructor(
    private readonly uow: LeaveUnitOfWork,
    private readonly authorizer: Authorizer,
    private readonly dispatcher?: RoleNotificationDispatcher | undefined,
  ) {}

  private async isSupervisorOrManager(actorId: string, companyId: string): Promise<boolean> {
    try {
      await this.authorizer.assertPermission(actorId, LEAVE_MANAGE, companyTarget(companyId));
      return true;
    } catch {
      try {
        await this.authorizer.assertPermission(actorId, LEAVE_APPROVE, companyTarget(companyId));
        return true;
      } catch {
        return false;
      }
    }
  }

  private async assertSupervisorOrManager(actorId: string, companyId: string): Promise<void> {
    try {
      await this.authorizer.assertPermission(actorId, LEAVE_MANAGE, companyTarget(companyId));
    } catch {
      await this.authorizer.assertPermission(actorId, LEAVE_APPROVE, companyTarget(companyId));
    }
  }

  // ---------------------------------------------------------------------------
  // Leave Type Definitions (company-configured vocabulary)
  // ---------------------------------------------------------------------------

  async createTypeDef(
    actor: ActorContext,
    companyId: string,
    input: CreateLeaveTypeDefInput,
  ): Promise<LeaveTypeDef> {
    await this.authorizer.assertPermission(actor.actorId, LEAVE_MANAGE, companyTarget(companyId));

    return this.uow.run(async (repos) => {
      const created = await repos.typeDefs.create(companyId, {
        code: normalizeCode(input.code),
        name: input.name.trim(),
        description: input.description?.trim() ?? null,
        leaveType: input.leaveType ?? null,
      });
      await repos.audit.record(
        auditEntry(actor, {
          action: 'LEAVE_TYPE_CREATED',
          entityType: 'LEAVE_TYPE_DEF',
          entityId: created.id,
          companyId,
          metadata: { code: created.code, name: created.name, leaveType: created.leaveType },
        }),
      );
      return created;
    });
  }

  async listTypeDefs(
    actor: ActorContext,
    companyId: string,
    filter?: ListLeaveTypeDefsFilter,
  ): Promise<LeaveTypeDef[]> {
    await this.authorizer.assertPermission(actor.actorId, LEAVE_READ, companyTarget(companyId));
    return this.uow.run((repos) => repos.typeDefs.list(companyId, filter));
  }

  async updateTypeDef(
    actor: ActorContext,
    companyId: string,
    id: string,
    input: UpdateLeaveTypeDefInput,
  ): Promise<LeaveTypeDef> {
    await this.authorizer.assertPermission(actor.actorId, LEAVE_MANAGE, companyTarget(companyId));

    const { expectedVersion, ...patch } = input;
    return this.uow.run(async (repos) => {
      const existing = await repos.typeDefs.findById(companyId, id);
      if (!existing) throw new LeaveTypeDefNotFoundError();
      if (existing.status === 'ARCHIVED') {
        throw new InvalidLeavePolicyStateError('Archived leave types are immutable');
      }
      const data: Record<string, unknown> = {
        ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
        ...(patch.description !== undefined
          ? { description: patch.description?.trim() ?? null }
          : {}),
      };
      const updated = await repos.typeDefs.update(companyId, id, data, expectedVersion);
      await repos.audit.record(
        auditEntry(actor, {
          action: 'LEAVE_TYPE_UPDATED',
          entityType: 'LEAVE_TYPE_DEF',
          entityId: id,
          companyId,
          changedFields: { version: { before: expectedVersion, after: updated.version } },
        }),
      );
      return updated;
    });
  }

  async archiveTypeDef(
    actor: ActorContext,
    companyId: string,
    id: string,
    expectedVersion: number,
  ): Promise<LeaveTypeDef> {
    await this.authorizer.assertPermission(actor.actorId, LEAVE_MANAGE, companyTarget(companyId));

    return this.uow.run(async (repos) => {
      const existing = await repos.typeDefs.findById(companyId, id);
      if (!existing) throw new LeaveTypeDefNotFoundError();
      if (existing.status === 'ARCHIVED') {
        throw new InvalidLeavePolicyStateError('Leave type is already archived');
      }
      const referencing = await repos.policies.countActiveReferencingTypeDef(companyId, id);
      if (referencing > 0) {
        throw new InvalidLeavePolicyStateError(
          'Leave type is still referenced by active policies — archive those policies first',
        );
      }
      const updated = await repos.typeDefs.update(
        companyId,
        id,
        { status: 'ARCHIVED' },
        expectedVersion,
      );
      await repos.audit.record(
        auditEntry(actor, {
          action: 'LEAVE_TYPE_ARCHIVED',
          entityType: 'LEAVE_TYPE_DEF',
          entityId: id,
          companyId,
          statusBefore: 'ACTIVE',
          statusAfter: 'ARCHIVED',
        }),
      );
      return updated;
    });
  }

  // ---------------------------------------------------------------------------
  // Leave Policies
  // ---------------------------------------------------------------------------

  private validateScopeShape(input: {
    scopeType: string;
    departmentId?: string | undefined;
    employeeId?: string | undefined;
  }): void {
    const required =
      input.scopeType === 'DEPARTMENT'
        ? 'departmentId'
        : input.scopeType === 'EMPLOYEE'
          ? 'employeeId'
          : null;
    for (const ref of ['departmentId', 'employeeId'] as const) {
      if (ref === required && input[ref] === undefined) {
        throw new LeaveScopeShapeError(`scopeType ${input.scopeType} requires ${ref}`);
      }
      if (ref !== required && input[ref] !== undefined) {
        throw new LeaveScopeShapeError(`scopeType ${input.scopeType} must not set ${ref}`);
      }
    }
  }

  /**
   * Validate mode-specific fields and reject contradictory settings.
   * WORKED_DAYS_RATIO uses one non-duplicating rule: credits =
   * floor((eligibleDays + residualDays) / threshold) * earnedAmount — only the
   * remainder carries forward; the policy stores only the rule parameters.
   */
  private validateVersionMode(input: PolicyVersionInput): void {
    const { mode, monthlyCreditAmount, ratioThresholdDays, ratioEarnedAmount } = input;
    const monthly = monthlyCreditAmount !== undefined;
    const ratio = ratioThresholdDays !== undefined || ratioEarnedAmount !== undefined;
    if (mode === 'MONTHLY_CREDIT') {
      if (!monthly) {
        throw new LeavePolicyValidationError(
          'monthlyCreditAmount',
          'required when mode is MONTHLY_CREDIT',
        );
      }
      if (ratio) {
        throw new LeavePolicyValidationError(
          'ratioThresholdDays/ratioEarnedAmount',
          'must not be set when mode is MONTHLY_CREDIT',
        );
      }
    } else if (mode === 'WORKED_DAYS_RATIO') {
      if (ratioThresholdDays === undefined || ratioEarnedAmount === undefined) {
        throw new LeavePolicyValidationError(
          'ratioThresholdDays/ratioEarnedAmount',
          'both required when mode is WORKED_DAYS_RATIO',
        );
      }
      if (monthly) {
        throw new LeavePolicyValidationError(
          'monthlyCreditAmount',
          'must not be set when mode is WORKED_DAYS_RATIO',
        );
      }
    } else {
      if (monthly || ratio) {
        throw new LeavePolicyValidationError('mode', 'NONE mode must not set accrual parameters');
      }
    }
  }

  private async assertPolicyScopeTarget(
    repos: LeaveRepos,
    companyId: string,
    input: {
      scopeType: string;
      departmentId?: string | undefined;
      employeeId?: string | undefined;
    },
  ): Promise<void> {
    if (input.scopeType === 'DEPARTMENT') {
      const dept = await repos.departments.findById(companyId, input.departmentId ?? '');
      if (dept === null || dept.status === 'ARCHIVED') {
        throw new LeavePolicyValidationError('departmentId', 'unknown or archived department');
      }
    } else if (input.scopeType === 'EMPLOYEE') {
      const emp = await repos.employees.findById(companyId, input.employeeId ?? '');
      if (emp === null || emp.status === 'ARCHIVED') {
        throw new LeavePolicyValidationError('employeeId', 'unknown or archived employee');
      }
    }
  }

  private async assertUsableTypeDef(
    repos: LeaveRepos,
    companyId: string,
    typeDefId: string,
  ): Promise<LeaveTypeDef> {
    const def = await repos.typeDefs.findById(companyId, typeDefId);
    if (def === null) throw new LeaveTypeDefNotFoundError();
    if (def.status !== 'ACTIVE') {
      throw new LeavePolicyValidationError('typeDefId', 'leave type is archived');
    }
    return def;
  }

  /**
   * Create a new-style leave policy: scope + type definition + immutable
   * version 1 holding the accrual mode parameters. The policy's legacy
   * leaveType enum is copied from the def's mapping when one exists so
   * enum-mapped types keep gating existing request flows; custom types
   * leave it NULL until request handling becomes type-def aware.
   */
  async createPolicy(
    actor: ActorContext,
    companyId: string,
    input: CreateLeavePolicyInput,
  ): Promise<{ policy: LeavePolicy; version: LeavePolicyVersion }> {
    await this.authorizer.assertPermission(actor.actorId, LEAVE_MANAGE, companyTarget(companyId));
    this.validateScopeShape(input);
    this.validateVersionMode(input.version);

    return this.uow.run(async (repos) => {
      const def = await this.assertUsableTypeDef(repos, companyId, input.typeDefId);
      await this.assertPolicyScopeTarget(repos, companyId, input);

      const created = await repos.policies.create(companyId, {
        scopeType: input.scopeType,
        ...(input.departmentId !== undefined
          ? { department: { connect: { id_companyId: { id: input.departmentId, companyId } } } }
          : {}),
        ...(input.employeeId !== undefined
          ? { employee: { connect: { id_companyId: { id: input.employeeId, companyId } } } }
          : {}),
        typeDef: { connect: { id_companyId: { id: def.id, companyId } } },
        leaveType: def.leaveType ?? null,
        name: input.name.trim(),
        description: input.description?.trim() ?? null,
      });

      const version = await repos.versions.create(companyId, {
        policyId: created.id,
        version: 1,
        effectiveFrom: new Date(`${input.version.effectiveFrom}T00:00:00.000Z`),
        mode: input.version.mode,
        monthlyCreditAmount: input.version.monthlyCreditAmount ?? null,
        ratioThresholdDays: input.version.ratioThresholdDays ?? null,
        ratioEarnedAmount: input.version.ratioEarnedAmount ?? null,
        note: input.version.note ?? null,
        createdByPrincipalId: actor.actorId,
      });

      await repos.audit.record(
        auditEntry(actor, {
          action: 'LEAVE_POLICY_CREATED',
          entityType: 'LEAVE_POLICY',
          entityId: created.id,
          companyId,
          metadata: {
            name: created.name,
            scopeType: created.scopeType,
            typeDefId: def.id,
            typeCode: def.code,
          },
        }),
      );
      await repos.audit.record(
        auditEntry(actor, {
          action: 'LEAVE_POLICY_VERSION_ADDED',
          entityType: 'LEAVE_POLICY_VERSION',
          entityId: version.id,
          companyId,
          metadata: { policyId: created.id, version: 1, mode: version.mode },
        }),
      );

      return { policy: created, version };
    });
  }

  async listPolicies(
    actor: ActorContext,
    companyId: string,
    filter?: ListLeavePoliciesFilter,
  ): Promise<LeavePolicy[]> {
    await this.authorizer.assertPermission(actor.actorId, LEAVE_READ, companyTarget(companyId));
    return this.uow.run((repos) => repos.policies.list(companyId, filter));
  }

  async updatePolicy(
    actor: ActorContext,
    companyId: string,
    id: string,
    input: UpdateLeavePolicyInput,
  ): Promise<LeavePolicy> {
    await this.authorizer.assertPermission(actor.actorId, LEAVE_MANAGE, companyTarget(companyId));

    const { expectedVersion, ...patch } = input;
    return this.uow.run(async (repos) => {
      const existing = await repos.policies.findById(companyId, id);
      if (!existing) throw new LeavePolicyNotFoundError(`Leave policy ${id} not found`);

      const updated = await repos.policies.update(companyId, id, patch, expectedVersion);

      const changedFields: Record<string, { before: unknown; after: unknown }> = {};
      for (const [key, value] of Object.entries(patch)) {
        changedFields[key] = {
          before: (existing as unknown as Record<string, unknown>)[key],
          after: value,
        };
      }

      await repos.audit.record(
        auditEntry(actor, {
          action: 'LEAVE_POLICY_UPDATED',
          entityType: 'LEAVE_POLICY',
          entityId: id,
          companyId,
          changedFields,
        }),
      );

      return updated;
    });
  }

  async getPolicy(actor: ActorContext, companyId: string, id: string): Promise<LeavePolicy> {
    await this.authorizer.assertPermission(actor.actorId, LEAVE_READ, companyTarget(companyId));
    return this.uow.run(async (repos) => {
      const policy = await repos.policies.findById(companyId, id);
      if (!policy) throw new LeavePolicyNotFoundError();
      return policy;
    });
  }

  /** Archive (deactivate) a policy — audited, optimistic-concurrency guarded. */
  async archivePolicy(
    actor: ActorContext,
    companyId: string,
    id: string,
    expectedVersion: number,
  ): Promise<LeavePolicy> {
    await this.authorizer.assertPermission(actor.actorId, LEAVE_MANAGE, companyTarget(companyId));

    return this.uow.run(async (repos) => {
      const existing = await repos.policies.findById(companyId, id);
      if (!existing) throw new LeavePolicyNotFoundError();
      if (!existing.isActive) {
        throw new InvalidLeavePolicyStateError('Leave policy is already archived');
      }
      const updated = await repos.policies.update(
        companyId,
        id,
        { isActive: false },
        expectedVersion,
      );
      await repos.audit.record(
        auditEntry(actor, {
          action: 'LEAVE_POLICY_ARCHIVED',
          entityType: 'LEAVE_POLICY',
          entityId: id,
          companyId,
          statusBefore: 'ACTIVE',
          statusAfter: 'ARCHIVED',
        }),
      );
      return updated;
    });
  }

  // ---------------------------------------------------------------------------
  // Immutable policy versions
  // ---------------------------------------------------------------------------

  private async assertPolicyMutable(
    repos: LeaveRepos,
    companyId: string,
    id: string,
  ): Promise<LeavePolicy> {
    const policy = await repos.policies.findById(companyId, id);
    if (!policy) throw new LeavePolicyNotFoundError();
    if (!policy.isActive) {
      throw new InvalidLeavePolicyStateError('Archived policies are immutable');
    }
    return policy;
  }

  /**
   * Append an immutable accrual version. effectiveFrom must be today or later:
   * a past-dated version would silently change which configuration resolves
   * for dates that were already submitted and evaluated.
   */
  async addVersion(
    actor: ActorContext,
    companyId: string,
    policyId: string,
    input: AddLeavePolicyVersionInput,
  ): Promise<LeavePolicyVersion> {
    await this.authorizer.assertPermission(actor.actorId, LEAVE_MANAGE, companyTarget(companyId));
    this.validateVersionMode(input);

    const effectiveFrom = new Date(`${input.effectiveFrom}T00:00:00.000Z`);
    if (Number.isNaN(effectiveFrom.getTime())) {
      throw new LeavePolicyValidationError('effectiveFrom', 'must be a valid calendar date');
    }
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    if (effectiveFrom < today) {
      throw new LeavePolicyValidationError(
        'effectiveFrom',
        'cannot be a past date — that would retroactively change already-submitted records',
      );
    }

    return this.uow.run(async (repos) => {
      await this.assertPolicyMutable(repos, companyId, policyId);
      // Two ACTIVE versions sharing effectiveFrom would be an ambiguous
      // effective-date match — reject (the DB partial-unique backs this up).
      const sameDate = await repos.versions.findActiveAtDate(companyId, policyId, effectiveFrom);
      if (sameDate !== null) {
        throw new LeavePolicyValidationError(
          'effectiveFrom',
          `an ACTIVE version ${sameDate.version} already uses this date — pick another or cancel it first`,
        );
      }
      const versionNumber = await repos.versions.nextVersionNumber(companyId, policyId);
      const version = await repos.versions.create(companyId, {
        policyId,
        version: versionNumber,
        effectiveFrom,
        mode: input.mode,
        monthlyCreditAmount: input.monthlyCreditAmount ?? null,
        ratioThresholdDays: input.ratioThresholdDays ?? null,
        ratioEarnedAmount: input.ratioEarnedAmount ?? null,
        note: input.note ?? null,
        createdByPrincipalId: actor.actorId,
      });
      // Bump the identity version for optimistic-concurrency tracking.
      await repos.policies.update(companyId, policyId, {}, input.expectedVersion);
      await repos.audit.record(
        auditEntry(actor, {
          action: 'LEAVE_POLICY_VERSION_ADDED',
          entityType: 'LEAVE_POLICY_VERSION',
          entityId: version.id,
          companyId,
          metadata: { policyId, version: versionNumber, mode: version.mode },
        }),
      );
      return version;
    });
  }

  async listVersions(
    actor: ActorContext,
    companyId: string,
    policyId: string,
  ): Promise<LeavePolicyVersion[]> {
    await this.authorizer.assertPermission(actor.actorId, LEAVE_READ, companyTarget(companyId));
    return this.uow.run(async (repos) => {
      const policy = await repos.policies.findById(companyId, policyId);
      if (!policy) throw new LeavePolicyNotFoundError();
      return repos.versions.list(companyId, policyId);
    });
  }

  /**
   * Cancel a mistaken version (e.g. a wrong future-dated mode). The row is
   * retained as ARCHIVED and never applied; the cancellation is audited. The
   * sole ACTIVE version cannot be cancelled — archive the policy instead.
   */
  async cancelVersion(
    actor: ActorContext,
    companyId: string,
    policyId: string,
    versionId: string,
  ): Promise<LeavePolicyVersion> {
    await this.authorizer.assertPermission(actor.actorId, LEAVE_MANAGE, companyTarget(companyId));

    return this.uow.run(async (repos) => {
      await this.assertPolicyMutable(repos, companyId, policyId);
      const version = await repos.versions.findById(companyId, policyId, versionId);
      if (!version) throw new LeavePolicyVersionNotFoundError();
      if (version.status === 'ARCHIVED') {
        throw new InvalidLeavePolicyStateError('Version is already cancelled');
      }
      const active = await repos.versions.countActive(companyId, policyId);
      if (active <= 1) {
        throw new LastActiveLeavePolicyVersionError();
      }
      const cancelled = await repos.versions.cancel(companyId, versionId);
      await repos.audit.record(
        auditEntry(actor, {
          action: 'LEAVE_POLICY_VERSION_CANCELLED',
          entityType: 'LEAVE_POLICY_VERSION',
          entityId: versionId,
          companyId,
          statusBefore: 'ACTIVE',
          statusAfter: 'ARCHIVED',
          metadata: { policyId, version: version.version },
        }),
      );
      return cancelled;
    });
  }

  /**
   * Resolve the department an employee's DEPARTMENT-scoped policies follow:
   * the primary membership, else a single non-primary one. Multiple active
   * memberships with no primary is ambiguous — fail closed everywhere
   * (preview AND request submission), never silently pick a department.
   */
  private async resolvePrimaryDepartmentId(
    repos: LeaveRepos,
    companyId: string,
    employeeId: string,
    asOf?: Date,
  ): Promise<string | undefined> {
    const memberships = await repos.memberships.findActiveByEmployee(
      companyId,
      employeeId,
      ...(asOf !== undefined ? [asOf] : []),
    );
    const primary = memberships.find((m) => m.isPrimary);
    if (primary !== undefined) return primary.departmentId;
    if (memberships.length === 1) return memberships[0]?.departmentId;
    if (memberships.length > 1) throw new AmbiguousLeaveScopeError();
    return undefined;
  }

  // ---------------------------------------------------------------------------
  // Effective policy resolution (preview)
  // ---------------------------------------------------------------------------

  /**
   * Resolve the effective policy + version for a leave type in an employee
   * context. Precedence: EMPLOYEE override → primary DEPARTMENT membership →
   * COMPANY fallback. Fail closed: multiple active memberships with no
   * primary is an ambiguity error, and no match anywhere is a 404 — never a
   * fabricated default.
   */
  async resolveEffectiveConfig(
    actor: ActorContext,
    companyId: string,
    criteria: EffectiveLeavePolicyCriteria,
  ): Promise<{
    policy: LeavePolicy;
    version: LeavePolicyVersion;
    typeDef: LeaveTypeDef;
    resolvedVia: 'EMPLOYEE' | 'DEPARTMENT' | 'COMPANY';
  }> {
    await this.authorizer.assertPermission(actor.actorId, LEAVE_READ, companyTarget(companyId));

    const asOf =
      criteria.asOf !== undefined ? new Date(`${criteria.asOf}T00:00:00.000Z`) : new Date();
    if (Number.isNaN(asOf.getTime())) {
      throw new LeavePolicyValidationError('asOf', 'must be a valid calendar date');
    }

    return this.uow.run(async (repos) => {
      let def: LeaveTypeDef | null = null;
      if (criteria.typeDefId !== undefined) {
        def = await repos.typeDefs.findById(companyId, criteria.typeDefId);
      } else if (criteria.leaveType !== undefined) {
        def = await repos.typeDefs.findByLeaveType(companyId, criteria.leaveType);
      } else {
        throw new LeavePolicyValidationError(
          'typeDefId',
          'either typeDefId or leaveType is required',
        );
      }
      if (def === null) throw new LeaveTypeDefNotFoundError();
      const typeDef = def;

      const attempt = async (
        target: LeavePolicyScopeTarget,
        via: 'EMPLOYEE' | 'DEPARTMENT' | 'COMPANY',
      ) => {
        const policy = await repos.policies.findAtScope(companyId, target, typeDef.id);
        if (policy === null) return null;
        const version = await repos.versions.findEffective(companyId, policy.id, asOf);
        if (version === null) return null;
        return { policy, version, typeDef, resolvedVia: via };
      };

      if (criteria.employeeId !== undefined) {
        const emp = await repos.employees.findById(companyId, criteria.employeeId);
        if (emp === null) {
          throw new LeavePolicyValidationError('employeeId', 'unknown or archived employee');
        }
        const empResult = await attempt(
          { scopeType: 'EMPLOYEE', employeeId: criteria.employeeId },
          'EMPLOYEE',
        );
        if (empResult !== null) return empResult;

        const departmentId = await this.resolvePrimaryDepartmentId(
          repos,
          companyId,
          criteria.employeeId,
          asOf,
        );
        if (departmentId !== undefined) {
          const deptResult = await attempt({ scopeType: 'DEPARTMENT', departmentId }, 'DEPARTMENT');
          if (deptResult !== null) return deptResult;
        }
      }

      const companyResult = await attempt({ scopeType: 'COMPANY' }, 'COMPANY');
      if (companyResult !== null) return companyResult;
      throw new NoEffectiveLeavePolicyError();
    });
  }

  /** Legacy gating resolution used by request submission — kept for the
   *  existing request flow (leaveType enum keyed, legacy compliance fields).
   *  Resolves EMPLOYEE → DEPARTMENT (primary membership) → SITE → PROJECT →
   *  COMPANY; fails closed instead of fabricating defaults. */
  async resolveEffectivePolicy(
    actor: ActorContext,
    companyId: string,
    leaveType: LeaveType,
    criteria: { employeeId?: string; siteId?: string; projectId?: string; asOf?: string },
  ): Promise<LeavePolicy> {
    await this.authorizer.assertPermission(actor.actorId, LEAVE_READ, companyTarget(companyId));
    const asOf =
      criteria.asOf !== undefined ? new Date(`${criteria.asOf}T00:00:00.000Z`) : undefined;
    return this.uow.run(async (repos) => {
      const departmentId =
        criteria.employeeId !== undefined
          ? await this.resolvePrimaryDepartmentId(
              repos,
              companyId,
              criteria.employeeId,
              ...(asOf !== undefined ? [asOf] : []),
            )
          : undefined;
      return repos.policies.resolveEffective(companyId, leaveType, {
        ...(criteria.employeeId !== undefined ? { employeeId: criteria.employeeId } : {}),
        ...(criteria.siteId !== undefined ? { siteId: criteria.siteId } : {}),
        ...(criteria.projectId !== undefined ? { projectId: criteria.projectId } : {}),
        ...(departmentId !== undefined ? { departmentId } : {}),
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Leave Allocations & Balances
  // ---------------------------------------------------------------------------

  async allocateBalance(
    actor: ActorContext,
    companyId: string,
    input: AllocateLeaveBalanceInput,
  ): Promise<LeaveBalance> {
    await this.authorizer.assertPermission(actor.actorId, LEAVE_MANAGE, companyTarget(companyId));

    return this.uow.run(async (repos) => {
      const balance = await repos.balances.upsertAllocation(
        companyId,
        input.employeeId,
        input.leaveType,
        input.year,
        input.allocatedDays,
        input.carriedOverDays ?? 0,
      );

      await repos.audit.record(
        auditEntry(actor, {
          action: 'LEAVE_BALANCE_ALLOCATED',
          entityType: 'LEAVE_BALANCE',
          entityId: balance.id,
          companyId,
          metadata: {
            employeeId: input.employeeId,
            leaveType: input.leaveType,
            year: input.year,
            allocatedDays: input.allocatedDays,
          },
        }),
      );

      return balance;
    });
  }

  async listBalances(
    actor: ActorContext,
    companyId: string,
    filter?: ListLeaveBalancesFilter,
  ): Promise<LeaveBalance[]> {
    await this.authorizer.assertPermission(actor.actorId, LEAVE_READ, companyTarget(companyId));
    return this.uow.run(async (repos) => {
      const callerEmp = await repos.employees.findByPrincipal(companyId, actor.actorId);
      const isManagerOrSupervisor = await this.isSupervisorOrManager(actor.actorId, companyId);

      if (!isManagerOrSupervisor) {
        if (filter?.employeeId !== undefined && callerEmp && filter.employeeId !== callerEmp.id) {
          await this.assertSupervisorOrManager(actor.actorId, companyId);
        }
        const effectiveFilter: ListLeaveBalancesFilter = {
          ...filter,
          employeeId: callerEmp ? callerEmp.id : '00000000-0000-0000-0000-000000000000',
        };
        return repos.balances.list(companyId, effectiveFilter);
      }

      return repos.balances.list(companyId, filter);
    });
  }

  async getEmployeeBalance(
    actor: ActorContext,
    companyId: string,
    employeeId: string,
    leaveType: LeaveType,
    year: number,
  ): Promise<LeaveBalance | null> {
    await this.authorizer.assertPermission(actor.actorId, LEAVE_READ, companyTarget(companyId));
    return this.uow.run(async (repos) => {
      const callerEmp = await repos.employees.findByPrincipal(companyId, actor.actorId);
      const isOwn = callerEmp !== null && callerEmp.id === employeeId;
      if (!isOwn) {
        await this.assertSupervisorOrManager(actor.actorId, companyId);
      }
      return repos.balances.find(companyId, employeeId, leaveType, year);
    });
  }

  // ---------------------------------------------------------------------------
  // Leave Requests & Lifecycle
  // ---------------------------------------------------------------------------

  async submitRequest(
    actor: ActorContext,
    companyId: string,
    input: SubmitLeaveRequestInput,
  ): Promise<LeaveRequestWithDetails> {
    await this.authorizer.assertPermission(actor.actorId, LEAVE_APPLY, companyTarget(companyId));

    const isHalfDay = input.isHalfDay ?? false;

    if (isHalfDay && input.startDate !== input.endDate) {
      throw new LeaveRequestStateError('Half-day leave must have the same startDate and endDate');
    }

    const start = new Date(`${input.startDate}T00:00:00.000Z`);
    const end = new Date(`${input.endDate}T00:00:00.000Z`);
    if (start.getTime() > end.getTime()) {
      throw new LeaveRequestStateError('startDate cannot be after endDate');
    }

    const year = start.getUTCFullYear();

    return this.uow.run(async (repos) => {
      // 0. Resolve employee context and permissions
      const callerEmp = await repos.employees.findByPrincipal(companyId, actor.actorId);
      let employeeId: string;

      if (!input.employeeId) {
        if (!callerEmp) {
          throw new LeaveRequestStateError('No employee profile found for caller in this company');
        }
        employeeId = callerEmp.id;
      } else {
        employeeId = input.employeeId;
        if (callerEmp?.id !== employeeId) {
          await this.authorizer.assertPermission(
            actor.actorId,
            LEAVE_MANAGE,
            companyTarget(companyId),
          );
        }
        const targetEmp = await repos.employees.findById(companyId, employeeId);
        if (!targetEmp) {
          throw new LeaveRequestStateError(`Employee ${employeeId} not found`);
        }
      }

      // Serialize concurrent requests for this employee
      await repos.employees.lockForUpdate?.(companyId, employeeId);

      // 1. Resolve effective policy for sandwich and compliance rules —
      //    DEPARTMENT-scoped policies apply via the primary membership
      //    effective for the requested window (same rules as the preview).
      //
      //    Boundary semantics: the department resolved at the request start
      //    must equal the one at the request end, and that membership must
      //    cover the whole window. A mid-request transfer or lapse means two
      //    different configurations would govern different parts — fail
      //    closed and ask for the request to be split.
      const deptAtStart = await this.resolvePrimaryDepartmentId(
        repos,
        companyId,
        employeeId,
        start,
      );
      const deptAtEnd = await this.resolvePrimaryDepartmentId(repos, companyId, employeeId, end);
      if (deptAtStart !== deptAtEnd) {
        throw new LeavePeriodBoundaryError(
          'Department membership changes during the requested period — split the request at the boundary',
        );
      }
      if (deptAtStart !== undefined) {
        const covering = await repos.memberships.findCoveringByEmployee(
          companyId,
          employeeId,
          start,
          end,
        );
        if (!covering.some((m) => m.departmentId === deptAtStart)) {
          throw new LeavePeriodBoundaryError(
            'Department membership lapses during the requested period — split the request at the boundary',
          );
        }
      }
      const policy = await repos.policies.resolveEffective(companyId, input.leaveType, {
        employeeId,
        ...(deptAtStart !== undefined ? { departmentId: deptAtStart } : {}),
      });

      // 1b. One policy version must govern the whole window. A typed policy
      //     with no version effective at the start, or one whose next version
      //     takes effect mid-request, is a boundary — fail closed.
      if (policy.typeDefId !== null) {
        const effective = await repos.versions.findEffective(companyId, policy.id, start);
        if (effective === null) {
          throw new LeavePeriodBoundaryError(
            'No policy version is effective at the request start date',
          );
        }
        const next = await repos.versions.findNextEffective(companyId, policy.id, start);
        if (next !== null && next.effectiveFrom <= end) {
          throw new LeavePeriodBoundaryError(
            `Policy version ${next.version} takes effect ${next.effectiveFrom.toISOString().slice(0, 10)} mid-request — split the request at the boundary`,
          );
        }
      }

      // 2. Minimum advance notice check
      if (policy.minNoticeDays > 0) {
        const diffDays = Math.ceil((start.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
        if (diffDays < policy.minNoticeDays) {
          throw new LeaveNoticePeriodError(policy.minNoticeDays);
        }
      }

      // 3. Net leave days computation
      const totalDays = calculateNetLeaveDays(
        input.startDate,
        input.endDate,
        isHalfDay,
        policy.sandwichRule,
      );

      // 4. Max consecutive days check
      if (policy.maxConsecutiveDays !== null) {
        if (totalDays > policy.maxConsecutiveDays) {
          throw new MaxConsecutiveLeaveDaysExceededError(policy.maxConsecutiveDays);
        }
      }

      // 5. Supporting document check
      if (
        policy.requiresDocAboveDays !== null &&
        totalDays > policy.requiresDocAboveDays &&
        !input.documentId
      ) {
        throw new LeaveDocumentRequiredError(policy.requiresDocAboveDays);
      }

      // 6. Date conflict check against active requests
      const conflict = await repos.requests.findConflicting(companyId, employeeId, start, end);
      if (conflict) {
        throw new LeaveDateConflictError(conflict.id);
      }

      // 7. Balance check (for non-loss-of-pay)
      if (input.leaveType !== 'LOSS_OF_PAY') {
        const balance = await repos.balances.find(companyId, employeeId, input.leaveType, year);
        const allocated = balance ? Number(balance.allocatedDays) : 0;
        const carried = balance ? Number(balance.carriedOverDays) : 0;
        const used = balance ? Number(balance.usedDays) : 0;
        const pending = balance ? Number(balance.pendingDays) : 0;
        const available = allocated + carried - used - pending;

        if (available < totalDays) {
          throw new InsufficientLeaveBalanceError(available, totalDays);
        }

        // Reserve pending days
        await repos.balances.reservePending(
          companyId,
          employeeId,
          input.leaveType,
          year,
          totalDays,
        );
      }

      // 8. Create Leave Request
      const created = await repos.requests.create(companyId, {
        employee: { connect: { id_companyId: { id: employeeId, companyId } } },
        leaveType: input.leaveType,
        startDate: start,
        endDate: end,
        isHalfDay,
        halfDayPortion: input.halfDayPortion ?? null,
        totalDays,
        reason: input.reason,
        documentId: input.documentId ?? null,
        status: 'PENDING',
      });

      await repos.audit.record(
        auditEntry(actor, {
          action: 'LEAVE_REQUEST_SUBMITTED',
          entityType: 'LEAVE_REQUEST',
          entityId: created.id,
          companyId,
          metadata: {
            employeeId,
            leaveType: input.leaveType,
            startDate: input.startDate,
            endDate: input.endDate,
            totalDays,
          },
        }),
      );

      if (this.dispatcher) {
        void this.dispatcher.notifyRoles({
          companyId,
          roleKeys: ['HO_ADMIN', 'COMPANY_OWNER', 'PROJECT_MANAGER', 'DEPT_HEAD'],
          eventType: 'LEAVE_REQUEST_SUBMITTED',
          title: `New Leave Request: ${input.leaveType} (${String(totalDays)} day${totalDays > 1 ? 's' : ''})`,
          body: `Leave submitted from ${input.startDate} to ${input.endDate}`,
          resourceType: 'LEAVE_REQUEST',
          resourceId: created.id,
          email: {
            subject: `New Leave Application: ${input.leaveType}`,
            text: `An employee has applied for ${input.leaveType} leave from ${input.startDate} to ${input.endDate}. Reason: ${input.reason}`,
          },
        });
      }

      return created;
    });
  }

  async reviewRequest(
    actor: ActorContext,
    companyId: string,
    id: string,
    input: ReviewLeaveRequestInput,
  ): Promise<LeaveRequestWithDetails> {
    await this.authorizer.assertPermission(actor.actorId, LEAVE_APPROVE, companyTarget(companyId));

    return this.uow.run(async (repos) => {
      const existing = await repos.requests.findById(companyId, id);
      if (!existing) {
        throw new LeaveRequestStateError(`Leave request ${id} not found`);
      }
      if (existing.status !== 'PENDING') {
        throw new LeaveRequestStateError(`Leave request is already in ${existing.status} status`);
      }

      // Check for self-approval (separation of duties)
      const callerEmp = await repos.employees.findByPrincipal(companyId, actor.actorId);
      const isSelf =
        (existing.employee.principalId !== null &&
          existing.employee.principalId === actor.actorId) ||
        (callerEmp !== null && callerEmp.id === existing.employeeId);
      if (isSelf) {
        throw new SelfApprovalNotAllowedError('Employees cannot approve their own leave requests');
      }

      const totalDays = Number(existing.totalDays);
      const year = existing.startDate.getUTCFullYear();
      const newStatus: LeaveRequestStatus = input.action === 'APPROVE' ? 'APPROVED' : 'REJECTED';

      if (existing.leaveType !== 'LOSS_OF_PAY') {
        if (input.action === 'APPROVE') {
          await repos.balances.commitApproved(
            companyId,
            existing.employeeId,
            existing.leaveType,
            year,
            totalDays,
          );
        } else {
          await repos.balances.rejectPending(
            companyId,
            existing.employeeId,
            existing.leaveType,
            year,
            totalDays,
          );
        }
      }

      const updated = await repos.requests.updateStatus(
        companyId,
        id,
        newStatus,
        actor.actorId,
        input.remarks,
        input.expectedVersion,
      );

      await repos.audit.record(
        auditEntry(actor, {
          action: input.action === 'APPROVE' ? 'LEAVE_REQUEST_APPROVED' : 'LEAVE_REQUEST_REJECTED',
          entityType: 'LEAVE_REQUEST',
          entityId: id,
          companyId,
          statusBefore: 'PENDING',
          statusAfter: newStatus,
          metadata: { remarks: input.remarks },
        }),
      );

      if (this.dispatcher && existing.employee.principalId) {
        void this.dispatcher.notifyUser({
          companyId,
          recipientPrincipalId: existing.employee.principalId,
          eventType:
            input.action === 'APPROVE' ? 'LEAVE_REQUEST_APPROVED' : 'LEAVE_REQUEST_REJECTED',
          title: `Your Leave Request has been ${newStatus}`,
          body: `${existing.leaveType} leave from ${existing.startDate.toISOString().slice(0, 10)} to ${existing.endDate.toISOString().slice(0, 10)} was ${newStatus}. ${input.remarks ? `Remarks: ${input.remarks}` : ''}`.trim(),
          resourceType: 'LEAVE_REQUEST',
          resourceId: id,
          email: {
            subject: `Leave Request ${newStatus}: ${existing.leaveType}`,
            text: `Your ${existing.leaveType} leave request from ${existing.startDate.toISOString().slice(0, 10)} to ${existing.endDate.toISOString().slice(0, 10)} has been ${newStatus}. ${input.remarks ? `Remarks: ${input.remarks}` : ''}`.trim(),
          },
        });
      }

      return updated;
    });
  }

  async cancelRequest(
    actor: ActorContext,
    companyId: string,
    id: string,
    input: CancelLeaveRequestInput,
  ): Promise<LeaveRequestWithDetails> {
    await this.authorizer.assertPermission(actor.actorId, LEAVE_APPLY, companyTarget(companyId));

    return this.uow.run(async (repos) => {
      const existing = await repos.requests.findById(companyId, id);
      if (!existing) {
        throw new LeaveRequestStateError(`Leave request ${id} not found`);
      }
      if (existing.status !== 'PENDING' && existing.status !== 'APPROVED') {
        throw new LeaveRequestStateError(`Cannot cancel leave in ${existing.status} status`);
      }

      // Check ownership: caller must be owner or hold LEAVE_MANAGE
      const callerEmp = await repos.employees.findByPrincipal(companyId, actor.actorId);
      const isOwner =
        (existing.employee.principalId !== null &&
          existing.employee.principalId === actor.actorId) ||
        (callerEmp !== null && callerEmp.id === existing.employeeId);

      if (!isOwner) {
        await this.authorizer.assertPermission(
          actor.actorId,
          LEAVE_MANAGE,
          companyTarget(companyId),
        );
      }

      const totalDays = Number(existing.totalDays);
      const year = existing.startDate.getUTCFullYear();

      if (existing.leaveType !== 'LOSS_OF_PAY') {
        if (existing.status === 'PENDING') {
          await repos.balances.rejectPending(
            companyId,
            existing.employeeId,
            existing.leaveType,
            year,
            totalDays,
          );
        } else {
          await repos.balances.refundApproved(
            companyId,
            existing.employeeId,
            existing.leaveType,
            year,
            totalDays,
          );
        }
      }

      const updated = await repos.requests.updateStatus(
        companyId,
        id,
        'CANCELLED',
        actor.actorId,
        input.reason,
        input.expectedVersion,
      );

      await repos.audit.record(
        auditEntry(actor, {
          action: 'LEAVE_REQUEST_CANCELLED',
          entityType: 'LEAVE_REQUEST',
          entityId: id,
          companyId,
          statusBefore: existing.status,
          statusAfter: 'CANCELLED',
          metadata: { reason: input.reason },
        }),
      );

      return updated;
    });
  }

  async listRequests(
    actor: ActorContext,
    companyId: string,
    filter?: ListLeaveRequestsFilter,
  ): Promise<LeaveRequestWithDetails[]> {
    await this.authorizer.assertPermission(actor.actorId, LEAVE_READ, companyTarget(companyId));
    return this.uow.run(async (repos) => {
      const callerEmp = await repos.employees.findByPrincipal(companyId, actor.actorId);
      const isManagerOrSupervisor = await this.isSupervisorOrManager(actor.actorId, companyId);

      if (!isManagerOrSupervisor) {
        if (filter?.employeeId !== undefined && callerEmp && filter.employeeId !== callerEmp.id) {
          await this.assertSupervisorOrManager(actor.actorId, companyId);
        }
        const effectiveFilter: ListLeaveRequestsFilter = {
          ...filter,
          employeeId: callerEmp ? callerEmp.id : '00000000-0000-0000-0000-000000000000',
        };
        return repos.requests.list(companyId, effectiveFilter);
      }

      return repos.requests.list(companyId, filter);
    });
  }

  async getRequestById(
    actor: ActorContext,
    companyId: string,
    id: string,
  ): Promise<LeaveRequestWithDetails | null> {
    await this.authorizer.assertPermission(actor.actorId, LEAVE_READ, companyTarget(companyId));
    return this.uow.run(async (repos) => {
      const req = await repos.requests.findById(companyId, id);
      if (!req) return null;

      const callerEmp = await repos.employees.findByPrincipal(companyId, actor.actorId);
      const isOwner =
        (req.employee.principalId !== null && req.employee.principalId === actor.actorId) ||
        (callerEmp !== null && callerEmp.id === req.employeeId);

      if (!isOwner) {
        await this.assertSupervisorOrManager(actor.actorId, companyId);
      }

      return req;
    });
  }
}
