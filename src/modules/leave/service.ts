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
import { ForbiddenError } from '../../common/errors/app-error.js';
import type { ActorContext, AuditRecord } from '../organization/types.js';
import type { RoleNotificationDispatcher } from '../notification/role-dispatcher.js';
import { normalizeCode } from '../organization/validation.js';
import { PROJECT_DIRECTOR_ROLE_KEY, PROJECT_INCHARGE_ROLE_KEY } from '../setup/role-templates.js';
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
  DepartmentScopeColumns,
  LeavePolicyScopeTarget,
  LeaveRequestWithDetails,
  LeaveRepos,
  LeaveUnitOfWork,
  MembershipWithScope,
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
  type ResubmitLeaveRequestInput,
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
  hasPermission(principalId: string, permissionKey: string, target: ScopeTarget): Promise<boolean>;
  assertAnyScopePermission?(
    principalId: string,
    permissionKey: string,
    companyId: string,
  ): Promise<void>;
  assertApprovalHierarchy?(params: {
    companyId: string;
    actorPrincipalId: string;
    targetPrincipalId: string | null;
    permissionKey: string;
    sharedDepartment?: boolean;
  }): Promise<void>;
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

/**
 * Map a department to its permission scope target. A site department is
 * managed at its SITE; a project department at its PROJECT; a head-office
 * department resolves to HEAD_OFFICE (company administration); a company
 * department stays COMPANY. Downward grant inheritance (a PROJECT grant
 * covers child-SITE targets) is handled by access-control's scope chain.
 */
const departmentScopeTarget = (companyId: string, d: DepartmentScopeColumns): ScopeTarget => {
  if (d.siteId !== null) return { companyId, scopeType: 'SITE', scopeId: d.siteId };
  if (d.projectId !== null) return { companyId, scopeType: 'PROJECT', scopeId: d.projectId };
  if (d.baseHeadOfficeId !== null) {
    return { companyId, scopeType: 'HEAD_OFFICE', scopeId: d.baseHeadOfficeId };
  }
  return companyTarget(companyId);
};

export class LeaveService {
  constructor(
    private readonly uow: LeaveUnitOfWork,
    private readonly authorizer: Authorizer,
    private readonly dispatcher?: RoleNotificationDispatcher | undefined,
    /** Company delegation probe — scoped holders may author leave policies
     *  whose resolved target is a SITE/PROJECT inside their grant only when
     *  the company's `leavePolicyManage` switch is ON (default OFF, fail
     *  closed when the probe is not wired). */
    private readonly delegationEnabled?: (
      companyId: string,
      flag: 'leavePolicyManage',
    ) => Promise<boolean>,
  ) {}

  private async assertAnyScope(
    actorId: string,
    permissionKey: string,
    companyId: string,
  ): Promise<void> {
    if (typeof this.authorizer.assertAnyScopePermission === 'function') {
      await this.authorizer.assertAnyScopePermission(actorId, permissionKey, companyId);
    } else {
      await this.authorizer.assertPermission(actorId, permissionKey, companyTarget(companyId));
    }
  }

  private async isSupervisorOrManager(actorId: string, companyId: string): Promise<boolean> {
    try {
      await this.assertAnyScope(actorId, LEAVE_MANAGE, companyId);
      return true;
    } catch {
      try {
        await this.assertAnyScope(actorId, LEAVE_APPROVE, companyId);
        return true;
      } catch {
        return false;
      }
    }
  }

  private async assertSupervisorOrManager(actorId: string, companyId: string): Promise<void> {
    try {
      await this.assertAnyScope(actorId, LEAVE_MANAGE, companyId);
    } catch {
      await this.assertAnyScope(actorId, LEAVE_APPROVE, companyId);
    }
  }

  /**
   * The "may see others' leave data" check. LEAVE_READ@COMPANY is held by
   * every employee for self-service, so it cannot gate reads of someone
   * else's record — only an approver grant at the resolved target (scoped
   * PI/PD/PM/SE) or a company grant (Finance/Admin) may pass.
   */
  private async assertApproverAt(actorId: string, target: ScopeTarget): Promise<void> {
    try {
      await this.authorizer.assertPermission(actorId, LEAVE_MANAGE, target);
    } catch {
      await this.authorizer.assertPermission(actorId, LEAVE_APPROVE, target);
    }
  }

  // ---------------------------------------------------------------------------
  // Permission-scope resolution
  // ---------------------------------------------------------------------------

  /** Pick the effective department at `asOf`: the primary membership, else a
   *  single non-primary one. Multiple non-primary memberships are ambiguous
   *  — null forces the company target (fail closed, never leaks a scope). */
  private static pickMembershipAt(
    memberships: MembershipWithScope[],
    asOf: Date,
  ): MembershipWithScope | undefined {
    const active = memberships.filter((m) => {
      if (m.startedAt === undefined) return true; // already filtered by the query
      return m.startedAt <= asOf && (m.endedAt == null || m.endedAt > asOf);
    });
    const primary = active.find((m) => m.isPrimary);
    if (primary !== undefined) return primary;
    return active.length === 1 ? active[0] : undefined;
  }

  /** The permission scope of an employee's effective department at `asOf`.
   *  Ambiguous membership fails closed to the company target. */
  private async employeeScopeAt(
    repos: LeaveRepos,
    companyId: string,
    employeeId: string,
    asOf: Date,
  ): Promise<ScopeTarget> {
    const memberships = await repos.memberships.findActiveByEmployee(companyId, employeeId, asOf);
    const m = LeaveService.pickMembershipAt(memberships, asOf);
    return m?.department !== undefined
      ? departmentScopeTarget(companyId, m.department)
      : companyTarget(companyId);
  }

  /** The permission scope of a leave request — the requester's department
   *  membership effective at the request start date, which is the same
   *  anchor the submission boundary checks pin. */
  private async requestScope(
    repos: LeaveRepos,
    companyId: string,
    request: { employeeId: string; startDate: Date },
  ): Promise<ScopeTarget> {
    return this.employeeScopeAt(repos, companyId, request.employeeId, request.startDate);
  }

  private async scopeOfPolicy(
    repos: LeaveRepos,
    companyId: string,
    p: LeavePolicy,
  ): Promise<ScopeTarget> {
    switch (p.scopeType) {
      case 'SITE':
        return p.siteId !== null
          ? { companyId, scopeType: 'SITE', scopeId: p.siteId }
          : companyTarget(companyId);
      case 'PROJECT':
        return p.projectId !== null
          ? { companyId, scopeType: 'PROJECT', scopeId: p.projectId }
          : companyTarget(companyId);
      case 'DEPARTMENT':
        if (p.departmentId === null) return companyTarget(companyId);
        {
          const d = await repos.departments.findById(companyId, p.departmentId);
          return d !== null ? departmentScopeTarget(companyId, d) : companyTarget(companyId);
        }
      case 'EMPLOYEE':
        return p.employeeId !== null
          ? this.employeeScopeAt(repos, companyId, p.employeeId, new Date())
          : companyTarget(companyId);
      default:
        return companyTarget(companyId);
    }
  }

  private async policyScope(
    repos: LeaveRepos,
    companyId: string,
    policyId: string,
  ): Promise<ScopeTarget> {
    const p = await repos.policies.findById(companyId, policyId);
    if (p === null) return companyTarget(companyId);
    return this.scopeOfPolicy(repos, companyId, p);
  }

  /**
   * Manage authority for a resolved policy target — mirrors the schedule
   * service's delegation contract. The caller must hold LEAVE_MANAGE at the
   * resolved target (a PROJECT grant covers child-SITE targets); a
   * company-wide grant or a HEAD_OFFICE grant then satisfies the check
   * directly, while SITE/PROJECT targets additionally require the company's
   * `leavePolicyManage` delegation switch — default OFF, fail closed.
   */
  private async assertManageAt(
    actor: ActorContext,
    companyId: string,
    target: ScopeTarget,
  ): Promise<void> {
    await this.authorizer.assertPermission(actor.actorId, LEAVE_MANAGE, target);
    if (target.scopeType === 'COMPANY') return;
    const companyWide = await this.authorizer.hasPermission(
      actor.actorId,
      LEAVE_MANAGE,
      companyTarget(companyId),
    );
    if (companyWide) return;
    // A HEAD_OFFICE-scoped grant (HO administration) is sufficient on its own
    // — delegation switches govern project/site delegation only.
    if (target.scopeType === 'HEAD_OFFICE') return;
    const delegated =
      this.delegationEnabled !== undefined &&
      (await this.delegationEnabled(companyId, 'leavePolicyManage'));
    if (!delegated) {
      throw new ForbiddenError(
        'DELEGATION_DISABLED',
        'company has not enabled delegated leave-policy management',
      );
    }
  }

  /**
   * Write authority for a leave policy. COMPANY- and EMPLOYEE-scope policies
   * are per-company/per-person administration and stay company-only;
   * DEPARTMENT-, SITE-, and PROJECT-scope policies resolve to a real scope
   * target where scoped holders may act only with the delegation switch.
   */
  private async assertPolicyWrite(
    actor: ActorContext,
    companyId: string,
    scopeType: string,
    target: ScopeTarget,
  ): Promise<void> {
    if (scopeType === 'EMPLOYEE' || scopeType === 'COMPANY') {
      await this.authorizer.assertPermission(actor.actorId, LEAVE_MANAGE, companyTarget(companyId));
      return;
    }
    await this.assertManageAt(actor, companyId, target);
  }

  /**
   * Authorization target for route-level scoped gates — mirrors the
   * attendance resolver contract. `kind` + `id` resolve server-side;
   * unresolvable entities fall back to COMPANY and fail closed.
   */
  async resolveScope(
    companyId: string,
    kind: 'request' | 'employee' | 'department' | 'policy',
    id: string,
  ): Promise<ScopeTarget> {
    return this.uow.run(async (repos) => {
      switch (kind) {
        case 'request': {
          const r = await repos.requests.findById(companyId, id);
          return r !== null ? this.requestScope(repos, companyId, r) : companyTarget(companyId);
        }
        case 'employee':
          return this.employeeScopeAt(repos, companyId, id, new Date());
        case 'department': {
          const d = await repos.departments.findById(companyId, id);
          return d !== null ? departmentScopeTarget(companyId, d) : companyTarget(companyId);
        }
        case 'policy':
          return this.policyScope(repos, companyId, id);
      }
    });
  }

  /** The scope target a list-query scope filter asserts against. */
  private static scopeFromFilter(filter?: {
    siteId?: string;
    projectId?: string;
    departmentId?: string;
  }): { kind: 'site' | 'project' | 'department' | null; id: string | null } {
    if (filter?.siteId !== undefined) return { kind: 'site', id: filter.siteId };
    if (filter?.projectId !== undefined) return { kind: 'project', id: filter.projectId };
    if (filter?.departmentId !== undefined) return { kind: 'department', id: filter.departmentId };
    return { kind: null, id: null };
  }

  /** Does a resolved department sit inside the query scope filter? SITE
   *  matches its own site; PROJECT covers project departments AND site
   *  departments of child sites; DEPARTMENT matches exactly. */
  private static departmentMatchesFilter(
    d: DepartmentScopeColumns,
    filter: { kind: 'site' | 'project' | 'department' | null; id: string | null },
  ): boolean {
    switch (filter.kind) {
      case 'site':
        return d.siteId === filter.id;
      case 'project':
        return d.projectId === filter.id || d.site?.projectId === filter.id;
      case 'department':
        return d.id === filter.id;
      default:
        return false;
    }
  }

  /**
   * Batch-filter entity rows by a site/project/department scope filter using
   * each row's department membership effective at `anchorOf(row)`. Rows
   * whose department cannot be resolved are excluded — fail closed.
   */
  private async filterRowsByDepartmentScope<T>(
    repos: LeaveRepos,
    companyId: string,
    rows: T[],
    employeeIdOf: (row: T) => string,
    anchorOf: (row: T) => Date,
    filter: { kind: 'site' | 'project' | 'department' | null; id: string | null },
  ): Promise<T[]> {
    if (filter.kind === null || rows.length === 0) return rows;
    const employeeIds = [...new Set(rows.map(employeeIdOf))];
    const minStart = new Date(Math.min(...rows.map((r) => anchorOf(r).getTime())));
    const maxEnd = new Date(Math.max(...rows.map((r) => anchorOf(r).getTime())));
    const memberships =
      (await repos.memberships.findByEmployeesInWindow?.(
        companyId,
        employeeIds,
        minStart,
        maxEnd,
      )) ?? [];
    const byEmployee = new Map<string, MembershipWithScope[]>();
    for (const m of memberships) {
      const list = byEmployee.get(m.employeeId) ?? [];
      list.push(m);
      byEmployee.set(m.employeeId, list);
    }
    return rows.filter((row) => {
      const m = LeaveService.pickMembershipAt(
        byEmployee.get(employeeIdOf(row)) ?? [],
        anchorOf(row),
      );
      return (
        m?.department !== undefined && LeaveService.departmentMatchesFilter(m.department, filter)
      );
    });
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
    await this.assertAnyScope(actor.actorId, LEAVE_READ, companyId);
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
  ): Promise<ScopeTarget> {
    if (input.scopeType === 'DEPARTMENT') {
      const dept = await repos.departments.findById(companyId, input.departmentId ?? '');
      if (dept === null || dept.status === 'ARCHIVED') {
        throw new LeavePolicyValidationError('departmentId', 'unknown or archived department');
      }
      return departmentScopeTarget(companyId, dept);
    }
    if (input.scopeType === 'EMPLOYEE') {
      const emp = await repos.employees.findById(companyId, input.employeeId ?? '');
      if (emp === null || emp.status === 'ARCHIVED') {
        throw new LeavePolicyValidationError('employeeId', 'unknown or archived employee');
      }
    }
    // COMPANY/EMPLOYEE scopes are company administration — the write check
    // asserts LEAVE_MANAGE at the company target regardless of resolution.
    return companyTarget(companyId);
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
    this.validateScopeShape(input);
    this.validateVersionMode(input.version);

    return this.uow.run(async (repos) => {
      const def = await this.assertUsableTypeDef(repos, companyId, input.typeDefId);
      const writeTarget = await this.assertPolicyScopeTarget(repos, companyId, input);
      await this.assertPolicyWrite(actor, companyId, input.scopeType, writeTarget);

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
    const scopeFilter = LeaveService.scopeFromFilter(filter ?? {});
    if (scopeFilter.kind === null) {
      await this.authorizer.assertPermission(actor.actorId, LEAVE_READ, companyTarget(companyId));
      return this.uow.run((repos) => repos.policies.list(companyId, filter));
    }
    return this.uow.run(async (repos) => {
      const target = await this.filterTarget(repos, companyId, scopeFilter);
      await this.authorizer.assertPermission(actor.actorId, LEAVE_READ, target);
      return repos.policies.list(companyId, filter);
    });
  }

  async updatePolicy(
    actor: ActorContext,
    companyId: string,
    id: string,
    input: UpdateLeavePolicyInput,
  ): Promise<LeavePolicy> {
    const { expectedVersion, ...patch } = input;
    return this.uow.run(async (repos) => {
      const existing = await repos.policies.findById(companyId, id);
      if (!existing) throw new LeavePolicyNotFoundError(`Leave policy ${id} not found`);
      const target = await this.scopeOfPolicy(repos, companyId, existing);
      await this.assertPolicyWrite(actor, companyId, existing.scopeType, target);

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
    return this.uow.run(async (repos) => {
      const target = await this.policyScope(repos, companyId, id);
      await this.authorizer.assertPermission(actor.actorId, LEAVE_READ, target);
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
    return this.uow.run(async (repos) => {
      const existing = await repos.policies.findById(companyId, id);
      if (!existing) throw new LeavePolicyNotFoundError();
      const target = await this.scopeOfPolicy(repos, companyId, existing);
      await this.assertPolicyWrite(actor, companyId, existing.scopeType, target);
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
      const policy = await this.assertPolicyMutable(repos, companyId, policyId);
      const target = await this.scopeOfPolicy(repos, companyId, policy);
      await this.assertPolicyWrite(actor, companyId, policy.scopeType, target);
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
    return this.uow.run(async (repos) => {
      const target = await this.policyScope(repos, companyId, policyId);
      await this.authorizer.assertPermission(actor.actorId, LEAVE_READ, target);
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
    return this.uow.run(async (repos) => {
      const policy = await this.assertPolicyMutable(repos, companyId, policyId);
      const target = await this.scopeOfPolicy(repos, companyId, policy);
      await this.assertPolicyWrite(actor, companyId, policy.scopeType, target);
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
  private async resolvePrimaryMembership(
    repos: LeaveRepos,
    companyId: string,
    employeeId: string,
    asOf?: Date,
  ): Promise<MembershipWithScope | undefined> {
    const memberships = await repos.memberships.findActiveByEmployee(
      companyId,
      employeeId,
      ...(asOf !== undefined ? [asOf] : []),
    );
    const primary = memberships.find((m) => m.isPrimary);
    if (primary !== undefined) return primary;
    if (memberships.length === 1) return memberships[0];
    if (memberships.length > 1) throw new AmbiguousLeaveScopeError();
    return undefined;
  }

  private async resolvePrimaryDepartmentId(
    repos: LeaveRepos,
    companyId: string,
    employeeId: string,
    asOf?: Date,
  ): Promise<string | undefined> {
    return (await this.resolvePrimaryMembership(repos, companyId, employeeId, asOf))?.departmentId;
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
    const asOf =
      criteria.asOf !== undefined ? new Date(`${criteria.asOf}T00:00:00.000Z`) : new Date();
    if (Number.isNaN(asOf.getTime())) {
      throw new LeavePolicyValidationError('asOf', 'must be a valid calendar date');
    }

    return this.uow.run(async (repos) => {
      // Self-preview is always allowed; previewing another employee's
      // effective policy requires LEAVE_READ at their resolved scope.
      const callerEmp = await repos.employees.findByPrincipal(companyId, actor.actorId);
      if (criteria.employeeId !== undefined && callerEmp?.id !== criteria.employeeId) {
        const target = await this.employeeScopeAt(repos, companyId, criteria.employeeId, asOf);
        await this.authorizer.assertPermission(actor.actorId, LEAVE_READ, target);
      } else {
        await this.authorizer.assertPermission(actor.actorId, LEAVE_READ, companyTarget(companyId));
      }

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
    const asOf =
      criteria.asOf !== undefined ? new Date(`${criteria.asOf}T00:00:00.000Z`) : undefined;
    return this.uow.run(async (repos) => {
      const callerEmp = await repos.employees.findByPrincipal(companyId, actor.actorId);
      if (criteria.employeeId !== undefined && callerEmp?.id !== criteria.employeeId) {
        const target = await this.employeeScopeAt(
          repos,
          companyId,
          criteria.employeeId,
          asOf ?? new Date(),
        );
        await this.authorizer.assertPermission(actor.actorId, LEAVE_READ, target);
      } else {
        await this.authorizer.assertPermission(actor.actorId, LEAVE_READ, companyTarget(companyId));
      }
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
    return this.uow.run(async (repos) => {
      const callerEmp = await repos.employees.findByPrincipal(companyId, actor.actorId);
      const isManagerOrSupervisor = await this.isSupervisorOrManager(actor.actorId, companyId);
      const scopeFilter = LeaveService.scopeFromFilter(filter);

      // Scoped-approver view — same rule as request lists: the filter's
      // target gates the read, rows are kept only when the employee's
      // current department resolves inside the scope.
      if (scopeFilter.kind !== null) {
        if (!isManagerOrSupervisor) {
          const target = await this.filterTarget(repos, companyId, scopeFilter);
          await this.assertApproverAt(actor.actorId, target);
        }
        const rows = await repos.balances.list(companyId, filter);
        const now = new Date();
        return this.filterRowsByDepartmentScope(
          repos,
          companyId,
          rows,
          (r) => r.employeeId,
          () => now,
          scopeFilter,
        );
      }

      if (
        filter?.employeeId !== undefined &&
        callerEmp?.id !== filter.employeeId &&
        !isManagerOrSupervisor
      ) {
        const target = await this.employeeScopeAt(repos, companyId, filter.employeeId, new Date());
        await this.assertApproverAt(actor.actorId, target);
        return repos.balances.list(companyId, filter);
      }

      if (!isManagerOrSupervisor) {
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
    return this.uow.run(async (repos) => {
      const callerEmp = await repos.employees.findByPrincipal(companyId, actor.actorId);
      const isOwn = callerEmp !== null && callerEmp.id === employeeId;
      if (!isOwn) {
        const target = await this.employeeScopeAt(repos, companyId, employeeId, new Date());
        await this.assertApproverAt(actor.actorId, target);
      }
      return repos.balances.find(companyId, employeeId, leaveType, year);
    });
  }

  // ---------------------------------------------------------------------------
  // Leave Requests & Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Shared submission pipeline — boundary checks, effective policy +
   * version window, notice, net days, consecutive cap, document gate,
   * date conflict, and the pending-balance reservation. Used by both the
   * initial submit and owner resubmission of a RETURNED request; the
   * `excludeRequestId` option keeps a resubmission from conflicting with
   * itself.
   */
  private async validateSubmission(
    repos: LeaveRepos,
    companyId: string,
    employeeId: string,
    window: {
      leaveType: LeaveType;
      start: Date;
      end: Date;
      startDate: string;
      endDate: string;
      isHalfDay: boolean;
      documentId?: string | null | undefined;
      excludeRequestId?: string | undefined;
    },
  ): Promise<{ totalDays: number; membership: MembershipWithScope | undefined }> {
    // Boundary semantics: the department resolved at the request start must
    // equal the one at the request end, and that membership must cover the
    // whole window. A mid-request transfer or lapse means two different
    // configurations would govern different parts — fail closed and ask for
    // the request to be split.
    const membershipAtStart = await this.resolvePrimaryMembership(
      repos,
      companyId,
      employeeId,
      window.start,
    );
    const deptAtStart = membershipAtStart?.departmentId;
    const deptAtEnd = await this.resolvePrimaryDepartmentId(
      repos,
      companyId,
      employeeId,
      window.end,
    );
    if (deptAtStart !== deptAtEnd) {
      throw new LeavePeriodBoundaryError(
        'Department membership changes during the requested period — split the request at the boundary',
      );
    }
    if (deptAtStart !== undefined) {
      const covering = await repos.memberships.findCoveringByEmployee(
        companyId,
        employeeId,
        window.start,
        window.end,
      );
      if (!covering.some((m) => m.departmentId === deptAtStart)) {
        throw new LeavePeriodBoundaryError(
          'Department membership lapses during the requested period — split the request at the boundary',
        );
      }
    }
    const policy = await repos.policies.resolveEffective(companyId, window.leaveType, {
      employeeId,
      ...(deptAtStart !== undefined ? { departmentId: deptAtStart } : {}),
    });

    // One policy version must govern the whole window.
    if (policy.typeDefId !== null) {
      const effective = await repos.versions.findEffective(companyId, policy.id, window.start);
      if (effective === null) {
        throw new LeavePeriodBoundaryError(
          'No policy version is effective at the request start date',
        );
      }
      const next = await repos.versions.findNextEffective(companyId, policy.id, window.start);
      if (next !== null && next.effectiveFrom <= window.end) {
        throw new LeavePeriodBoundaryError(
          `Policy version ${next.version} takes effect ${next.effectiveFrom.toISOString().slice(0, 10)} mid-request — split the request at the boundary`,
        );
      }
    }

    if (policy.minNoticeDays > 0) {
      const diffDays = Math.ceil((window.start.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
      if (diffDays < policy.minNoticeDays) {
        throw new LeaveNoticePeriodError(policy.minNoticeDays);
      }
    }

    const totalDays = calculateNetLeaveDays(
      window.startDate,
      window.endDate,
      window.isHalfDay,
      policy.sandwichRule,
    );

    if (policy.maxConsecutiveDays !== null && totalDays > policy.maxConsecutiveDays) {
      throw new MaxConsecutiveLeaveDaysExceededError(policy.maxConsecutiveDays);
    }

    if (
      policy.requiresDocAboveDays !== null &&
      totalDays > policy.requiresDocAboveDays &&
      window.documentId == null
    ) {
      throw new LeaveDocumentRequiredError(policy.requiresDocAboveDays);
    }

    const conflict = await repos.requests.findConflicting(
      companyId,
      employeeId,
      window.start,
      window.end,
      window.excludeRequestId,
    );
    if (conflict) {
      throw new LeaveDateConflictError(conflict.id);
    }

    if (window.leaveType !== 'LOSS_OF_PAY') {
      const year = window.start.getUTCFullYear();
      const balance = await repos.balances.find(companyId, employeeId, window.leaveType, year);
      const allocated = balance ? Number(balance.allocatedDays) : 0;
      const carried = balance ? Number(balance.carriedOverDays) : 0;
      const used = balance ? Number(balance.usedDays) : 0;
      const pending = balance ? Number(balance.pendingDays) : 0;
      const available = allocated + carried - used - pending;

      if (available < totalDays) {
        throw new InsufficientLeaveBalanceError(available, totalDays);
      }

      await repos.balances.reservePending(companyId, employeeId, window.leaveType, year, totalDays);
    }

    return { totalDays, membership: membershipAtStart };
  }

  /**
   * Fanout for a new/resubmitted request. Scoped approvers (PI/PD/PM/SE at
   * the site/project of the requester's department) get it only when the
   * requester is a plain employee — a requester who themselves holds
   * LEAVE_APPROVE in that scope is company-administration business and
   * stays with company approvers. Notifications never carry the free-text
   * reason or medical details; the request id is the lookup key.
   */
  private async notifyLeaveSubmitted(
    companyId: string,
    request: LeaveRequestWithDetails,
    dept: DepartmentScopeColumns | undefined,
    requesterIsScopedApprover: boolean,
  ): Promise<void> {
    if (this.dispatcher === undefined) return;
    const totalDays = Number(request.totalDays);
    const start = request.startDate.toISOString().slice(0, 10);
    const end = request.endDate.toISOString().slice(0, 10);
    const base = {
      companyId,
      eventType: 'LEAVE_REQUEST_SUBMITTED',
      title: `New Leave Request: ${request.leaveType} (${String(totalDays)} day${totalDays > 1 ? 's' : ''})`,
      body: `Leave request ${start} to ${end} awaiting review`,
      resourceType: 'LEAVE_REQUEST' as const,
      resourceId: request.id,
      email: {
        subject: `New Leave Application: ${request.leaveType}`,
        text: `A ${request.leaveType} leave request from ${start} to ${end} awaits your review.`,
      },
    };

    if (dept !== undefined && !requesterIsScopedApprover) {
      const scopes: { scopeType: 'SITE' | 'PROJECT'; scopeId: string }[] = [];
      if (dept.siteId !== null) scopes.push({ scopeType: 'SITE', scopeId: dept.siteId });
      const projectId = dept.projectId ?? dept.site?.projectId ?? null;
      if (projectId !== null) scopes.push({ scopeType: 'PROJECT', scopeId: projectId });
      for (const scope of scopes) {
        void this.dispatcher.notifyRoles({
          ...base,
          scope,
          roleKeys: [
            PROJECT_INCHARGE_ROLE_KEY,
            PROJECT_DIRECTOR_ROLE_KEY,
            'PROJECT_MANAGER',
            'SITE_ENGINEER',
            'DEPT_HEAD',
          ],
        });
      }
    }

    void this.dispatcher.notifyRoles({
      ...base,
      roleKeys: ['HO_ADMIN', 'COMPANY_OWNER', 'FINANCE_MANAGER'],
    });
  }

  /** True when the requester holds LEAVE_APPROVE at their own resolved
   *  scope — a scoped approver's personal request is company-scope
   *  business (approved only by company-level approvers). */
  private async requesterIsScopedApprover(
    companyId: string,
    principalId: string | null,
    target: ScopeTarget,
  ): Promise<boolean> {
    if (target.scopeType === 'COMPANY' || principalId === null) return false;
    return this.authorizer.hasPermission(principalId, LEAVE_APPROVE, target);
  }

  async submitRequest(
    actor: ActorContext,
    companyId: string,
    input: SubmitLeaveRequestInput,
  ): Promise<LeaveRequestWithDetails> {
    await this.assertAnyScope(actor.actorId, LEAVE_APPLY, companyId);

    const isHalfDay = input.isHalfDay ?? false;

    if (isHalfDay && input.startDate !== input.endDate) {
      throw new LeaveRequestStateError('Half-day leave must have the same startDate and endDate');
    }

    const start = new Date(`${input.startDate}T00:00:00.000Z`);
    const end = new Date(`${input.endDate}T00:00:00.000Z`);
    if (start.getTime() > end.getTime()) {
      throw new LeaveRequestStateError('startDate cannot be after endDate');
    }

    return this.uow.run(async (repos) => {
      // 0. Resolve employee context and permissions
      const callerEmp = await repos.employees.findByPrincipal(companyId, actor.actorId);
      let employeeId: string;
      let requesterPrincipalId: string | null;

      if (!input.employeeId) {
        if (!callerEmp) {
          throw new LeaveRequestStateError('No employee profile found for caller in this company');
        }
        employeeId = callerEmp.id;
        requesterPrincipalId = callerEmp.principalId ?? actor.actorId;
      } else {
        employeeId = input.employeeId;
        const targetEmp = await repos.employees.findById(companyId, employeeId);
        if (!targetEmp) {
          throw new LeaveRequestStateError(`Employee ${employeeId} not found`);
        }
        requesterPrincipalId = targetEmp.principalId ?? null;
        if (callerEmp?.id !== employeeId) {
          // On-behalf filing is administration at the TARGET EMPLOYEE's
          // scope — a project manager may file for project workforce,
          // never for employees outside their grant.
          const target = await this.employeeScopeAt(repos, companyId, employeeId, start);
          await this.authorizer.assertPermission(actor.actorId, LEAVE_MANAGE, target);
        }
      }

      // Serialize concurrent requests for this employee
      await repos.employees.lockForUpdate?.(companyId, employeeId);

      const { totalDays, membership } = await this.validateSubmission(
        repos,
        companyId,
        employeeId,
        {
          leaveType: input.leaveType,
          start,
          end,
          startDate: input.startDate,
          endDate: input.endDate,
          isHalfDay,
          documentId: input.documentId,
        },
      );

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

      const dept = membership?.department;
      const target =
        dept !== undefined ? departmentScopeTarget(companyId, dept) : companyTarget(companyId);
      const scopedApproverRequest = await this.requesterIsScopedApprover(
        companyId,
        requesterPrincipalId,
        target,
      );
      await this.notifyLeaveSubmitted(companyId, created, dept, scopedApproverRequest);

      return created;
    });
  }

  async reviewRequest(
    actor: ActorContext,
    companyId: string,
    id: string,
    input: ReviewLeaveRequestInput,
  ): Promise<LeaveRequestWithDetails> {
    return this.uow.run(async (repos) => {
      const existing = await repos.requests.findById(companyId, id);
      if (!existing) {
        throw new LeaveRequestStateError(`Leave request ${id} not found`);
      }
      if (existing.status !== 'PENDING') {
        throw new LeaveRequestStateError(`Leave request is already in ${existing.status} status`);
      }

      // Scoped authorization — the requester's department at the request
      // start date (the same anchor submission pins). A site department
      // resolves to SITE; a PROJECT grant covers it; a company grant
      // covers everything.
      const target = await this.requestScope(repos, companyId, existing);
      await this.authorizer.assertPermission(actor.actorId, LEAVE_APPROVE, target);

      // Check for self-approval (separation of duties)
      const callerEmp = await repos.employees.findByPrincipal(companyId, actor.actorId);
      const isSelf =
        (existing.employee.principalId !== null &&
          existing.employee.principalId === actor.actorId) ||
        (callerEmp !== null && callerEmp.id === existing.employeeId);
      if (isSelf) {
        throw new SelfApprovalNotAllowedError('Employees cannot approve their own leave requests');
      }

      // Scoped approvers do not judge their own management layer: when the
      // requester themselves holds LEAVE_APPROVE at this target (PI/PD/SE/
      // PM), the request is company-administration business and only a
      // company-scope approver may decide it.
      if (await this.requesterIsScopedApprover(companyId, existing.employee.principalId, target)) {
        await this.authorizer.assertPermission(
          actor.actorId,
          LEAVE_APPROVE,
          companyTarget(companyId),
        );
      }

      // Tier / peer-approver hierarchy guard:
      // - FINANCE_MANAGER requests require COMPANY_OWNER / HO_ADMIN
      // - Same-role or same-department approvers cannot approve each other
      if (this.authorizer.assertApprovalHierarchy !== undefined) {
        let sharedDepartment = false;
        if (callerEmp !== null) {
          const [actorDepts, targetDepts] = await Promise.all([
            repos.memberships.findActiveByEmployee(companyId, callerEmp.id),
            repos.memberships.findActiveByEmployee(companyId, existing.employeeId),
          ]);
          const actorDeptIds = new Set(actorDepts.map((m) => m.departmentId));
          sharedDepartment = targetDepts.some((m) => actorDeptIds.has(m.departmentId));
        }
        await this.authorizer.assertApprovalHierarchy({
          companyId,
          actorPrincipalId: actor.actorId,
          targetPrincipalId: existing.employee.principalId,
          permissionKey: LEAVE_APPROVE,
          sharedDepartment,
        });
      }

      if (
        (input.action === 'REJECT' || input.action === 'RETURN') &&
        (input.remarks === undefined || input.remarks.trim().length === 0)
      ) {
        throw new LeaveRequestStateError(
          'remarks are required when rejecting or returning a leave request',
        );
      }

      const totalDays = Number(existing.totalDays);
      const year = existing.startDate.getUTCFullYear();
      const newStatus: LeaveRequestStatus =
        input.action === 'APPROVE'
          ? 'APPROVED'
          : input.action === 'REJECT'
            ? 'REJECTED'
            : 'RETURNED';

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
          // REJECT and RETURN both release the pending reservation —
          // RETURNED re-reserves on owner resubmission.
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
          action: `LEAVE_REQUEST_${newStatus}`,
          entityType: 'LEAVE_REQUEST',
          entityId: id,
          companyId,
          statusBefore: 'PENDING',
          statusAfter: newStatus,
          metadata: { remarks: input.remarks },
        }),
      );

      if (this.dispatcher && existing.employee.principalId) {
        const label = newStatus === 'RETURNED' ? 'RETURNED for correction' : newStatus;
        void this.dispatcher.notifyUser({
          companyId,
          recipientPrincipalId: existing.employee.principalId,
          eventType: `LEAVE_REQUEST_${newStatus}`,
          title: `Your Leave Request has been ${label}`,
          body: `${existing.leaveType} leave from ${existing.startDate.toISOString().slice(0, 10)} to ${existing.endDate.toISOString().slice(0, 10)} was ${label}. ${input.remarks ? `Remarks: ${input.remarks}` : ''}`.trim(),
          resourceType: 'LEAVE_REQUEST',
          resourceId: id,
          email: {
            subject: `Leave Request ${label}: ${existing.leaveType}`,
            text: `Your ${existing.leaveType} leave request from ${existing.startDate.toISOString().slice(0, 10)} to ${existing.endDate.toISOString().slice(0, 10)} has been ${label}. ${input.remarks ? `Remarks: ${input.remarks}` : ''}`.trim(),
          },
        });
      }

      return updated;
    });
  }

  /**
   * Owner resubmission of a RETURNED request. Editable fields are dates,
   * reason, and supporting document — the entire submission pipeline
   * (boundary, notice, conflict, balance reservation) is re-validated and
   * the row returns to PENDING with a fresh review cycle.
   */
  async resubmitRequest(
    actor: ActorContext,
    companyId: string,
    id: string,
    input: ResubmitLeaveRequestInput,
  ): Promise<LeaveRequestWithDetails> {
    await this.authorizer.assertPermission(actor.actorId, LEAVE_APPLY, companyTarget(companyId));

    return this.uow.run(async (repos) => {
      const existing = await repos.requests.findById(companyId, id);
      if (!existing) {
        throw new LeaveRequestStateError(`Leave request ${id} not found`);
      }
      if (existing.status !== 'RETURNED') {
        throw new LeaveRequestStateError(
          `Cannot resubmit a leave request in ${existing.status} status`,
        );
      }

      const callerEmp = await repos.employees.findByPrincipal(companyId, actor.actorId);
      const isOwner =
        (existing.employee.principalId !== null &&
          existing.employee.principalId === actor.actorId) ||
        (callerEmp !== null && callerEmp.id === existing.employeeId);
      if (!isOwner) {
        throw new LeaveRequestStateError('Only the requester may resubmit their leave request');
      }

      const startDateStr = input.startDate ?? existing.startDate.toISOString().slice(0, 10);
      const endDateStr = input.endDate ?? existing.endDate.toISOString().slice(0, 10);
      const start = new Date(`${startDateStr}T00:00:00.000Z`);
      const end = new Date(`${endDateStr}T00:00:00.000Z`);
      if (start.getTime() > end.getTime()) {
        throw new LeaveRequestStateError('startDate cannot be after endDate');
      }
      const documentId = input.documentId === undefined ? existing.documentId : input.documentId;

      await repos.employees.lockForUpdate?.(companyId, existing.employeeId);

      const { totalDays, membership } = await this.validateSubmission(
        repos,
        companyId,
        existing.employeeId,
        {
          leaveType: existing.leaveType,
          start,
          end,
          startDate: startDateStr,
          endDate: endDateStr,
          isHalfDay: existing.isHalfDay,
          documentId,
          excludeRequestId: id,
        },
      );

      const updated = await repos.requests.resubmit(
        companyId,
        id,
        {
          startDate: start,
          endDate: end,
          totalDays,
          ...(input.reason !== undefined ? { reason: input.reason } : {}),
          ...(input.documentId !== undefined ? { documentId } : {}),
        },
        input.expectedVersion,
      );

      await repos.audit.record(
        auditEntry(actor, {
          action: 'LEAVE_REQUEST_RESUBMITTED',
          entityType: 'LEAVE_REQUEST',
          entityId: id,
          companyId,
          statusBefore: 'RETURNED',
          statusAfter: 'PENDING',
          metadata: { startDate: startDateStr, endDate: endDateStr, totalDays },
        }),
      );

      const dept = membership?.department;
      const target =
        dept !== undefined ? departmentScopeTarget(companyId, dept) : companyTarget(companyId);
      const scopedApproverRequest = await this.requesterIsScopedApprover(
        companyId,
        existing.employee.principalId,
        target,
      );
      await this.notifyLeaveSubmitted(companyId, updated, dept, scopedApproverRequest);

      return updated;
    });
  }

  async cancelRequest(
    actor: ActorContext,
    companyId: string,
    id: string,
    input: CancelLeaveRequestInput,
  ): Promise<LeaveRequestWithDetails> {
    await this.assertAnyScope(actor.actorId, LEAVE_APPLY, companyId);

    return this.uow.run(async (repos) => {
      const existing = await repos.requests.findById(companyId, id);
      if (!existing) {
        throw new LeaveRequestStateError(`Leave request ${id} not found`);
      }
      if (
        existing.status !== 'PENDING' &&
        existing.status !== 'APPROVED' &&
        existing.status !== 'RETURNED'
      ) {
        throw new LeaveRequestStateError(`Cannot cancel leave in ${existing.status} status`);
      }

      // Check ownership: caller must be owner or hold LEAVE_MANAGE at the
      // request's scope (project administration may cancel for its own
      // workforce; company administration covers everything).
      const callerEmp = await repos.employees.findByPrincipal(companyId, actor.actorId);
      const isOwner =
        (existing.employee.principalId !== null &&
          existing.employee.principalId === actor.actorId) ||
        (callerEmp !== null && callerEmp.id === existing.employeeId);

      if (!isOwner) {
        const target = await this.requestScope(repos, companyId, existing);
        await this.authorizer.assertPermission(actor.actorId, LEAVE_MANAGE, target);
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
        } else if (existing.status === 'APPROVED') {
          await repos.balances.refundApproved(
            companyId,
            existing.employeeId,
            existing.leaveType,
            year,
            totalDays,
          );
        }
        // RETURNED released its pending reservation at review time —
        // nothing to refund.
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
    return this.uow.run(async (repos) => {
      const callerEmp = await repos.employees.findByPrincipal(companyId, actor.actorId);
      const isManagerOrSupervisor = await this.isSupervisorOrManager(actor.actorId, companyId);
      const scopeFilter = LeaveService.scopeFromFilter(filter);

      // Scoped-approver list: siteId/projectId/departmentId resolves the
      // authorization target (the route gate asserts LEAVE_READ there —
      // re-asserting here keeps the service boundary fail-closed when the
      // caller holds no company-level approver grant).
      if (scopeFilter.kind !== null) {
        if (!isManagerOrSupervisor) {
          const target = await this.filterTarget(repos, companyId, scopeFilter);
          await this.assertApproverAt(actor.actorId, target);
        }
        const rows = await repos.requests.list(companyId, filter);
        return this.filterRowsByDepartmentScope(
          repos,
          companyId,
          rows,
          (r) => r.employeeId,
          (r) => r.startDate,
          scopeFilter,
        );
      }

      // Single-employee view: the requester themselves, or an approver at
      // that employee's resolved scope.
      if (
        filter?.employeeId !== undefined &&
        callerEmp?.id !== filter.employeeId &&
        !isManagerOrSupervisor
      ) {
        const target = await this.employeeScopeAt(repos, companyId, filter.employeeId, new Date());
        await this.assertApproverAt(actor.actorId, target);
        return repos.requests.list(companyId, filter);
      }

      if (!isManagerOrSupervisor) {
        const effectiveFilter: ListLeaveRequestsFilter = {
          ...filter,
          employeeId: callerEmp ? callerEmp.id : '00000000-0000-0000-0000-000000000000',
        };
        return repos.requests.list(companyId, effectiveFilter);
      }

      return repos.requests.list(companyId, filter);
    });
  }

  /** Map a resolved scope filter to its permission target for the
   *  service-level assert (site/project columns resolve directly; a
   *  department id resolves through the department's own scope). */
  private async filterTarget(
    repos: LeaveRepos,
    companyId: string,
    filter: { kind: 'site' | 'project' | 'department' | null; id: string | null },
  ): Promise<ScopeTarget> {
    if (filter.kind === 'site' && filter.id !== null) {
      return { companyId, scopeType: 'SITE', scopeId: filter.id };
    }
    if (filter.kind === 'project' && filter.id !== null) {
      return { companyId, scopeType: 'PROJECT', scopeId: filter.id };
    }
    if (filter.kind === 'department' && filter.id !== null) {
      const d = await repos.departments.findById(companyId, filter.id);
      return d !== null ? departmentScopeTarget(companyId, d) : companyTarget(companyId);
    }
    return companyTarget(companyId);
  }

  async getRequestById(
    actor: ActorContext,
    companyId: string,
    id: string,
  ): Promise<LeaveRequestWithDetails | null> {
    return this.uow.run(async (repos) => {
      const req = await repos.requests.findById(companyId, id);
      if (!req) return null;

      const callerEmp = await repos.employees.findByPrincipal(companyId, actor.actorId);
      const isOwner =
        (req.employee.principalId !== null && req.employee.principalId === actor.actorId) ||
        (callerEmp !== null && callerEmp.id === req.employeeId);

      if (!isOwner) {
        const target = await this.requestScope(repos, companyId, req);
        await this.assertApproverAt(actor.actorId, target);
      }

      return req;
    });
  }
}
