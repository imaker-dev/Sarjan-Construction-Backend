import { randomUUID } from 'node:crypto';
import type { ActorContext, AuditRecord } from '../organization/types.js';
import { Prisma } from '@prisma/client';
import type { Department, Employee, EmployeeDocumentType } from '@prisma/client';
import {
  ActiveMembershipExistsError,
  AlreadyExitedError,
  AmbiguousPrimaryError,
  OrgEntityNotFoundError,
  OrgValidationError,
  PrimaryConflictError,
  PrimaryOutOfScopeError,
  VersionConflictError,
} from '../organization/errors.js';
import {
  ConflictError,
  DomainValidationError,
  ForbiddenError,
} from '../../common/errors/app-error.js';
import type { DelegationFlag } from '../organization/delegation.js';
import type {
  DepartmentMembershipDetail,
  DepartmentMembershipWithDepartment,
  EmployeeRepos,
  EmployeeUnitOfWork,
  LifecycleMembership,
  TeamScopeRef,
} from './repository.js';
import type { ScopeTarget } from '../access-control/service.js';

export const EMPLOYEE_READ = 'EMPLOYEE_READ';
export const EMPLOYEE_MANAGE = 'EMPLOYEE_MANAGE';
// Placement only — membership administration inside project/site departments.
// Membership itself never satisfies any permission check.
export const EMPLOYEE_MEMBER_MANAGE = 'EMPLOYEE_MEMBER_MANAGE';
// Profile-only workforce onboarding (no login/invite) into project/site
// departments — gated by the "employeeOnboard" delegation switch.
export const EMPLOYEE_ONBOARD = 'EMPLOYEE_ONBOARD';
// Scoped read of member contact/emergency fields — the ONLY scoped path to
// contact data. Granted to PI/PD via templates; company readers keep the
// company-wide employee detail route.
export const EMPLOYEE_CONTACT_READ = 'EMPLOYEE_CONTACT_READ';

// Keys that mark a holder as a company administrator — fail closed: revoke of
// the last active holder of ANY of these is blocked.
const ADMIN_GUARD_KEYS = ['ORG_COMPANY_UPDATE', 'EMPLOYEE_MANAGE', 'ACCESS_ROLE_ASSIGN'];

interface Authorizer {
  assertPermission(principalId: string, permissionKey: string, target: ScopeTarget): Promise<void>;
  /** Non-throwing probe — distinguishes company-scope grants (which bypass
   *  the delegation switch) from scoped grants. Absent probe → scoped callers
   *  always take the delegation path. */
  hasPermission?(principalId: string, permissionKey: string, target: ScopeTarget): Promise<boolean>;
  /** Company-controlled delegation switches (all default OFF). Absent probe
   *  → treated as OFF (fail closed). */
  delegationEnabled?(companyId: string, flag: DelegationFlag): Promise<boolean>;
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

function normalizeCode(code: string): string {
  const c = code.trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9_-]{0,39}$/.test(c)) {
    throw new OrgValidationError('employeeCode', '1–40 chars: A-Z 0-9 - _');
  }
  return c;
}
function normalizeName(name: string): string {
  const n = name.trim();
  if (n.length === 0 || n.length > 200) throw new OrgValidationError('displayName', '1–200 chars');
  return n;
}
export function encodeEmpCursor(e: Employee): string {
  return Buffer.from(JSON.stringify({ createdAt: e.createdAt.toISOString(), id: e.id })).toString(
    'base64url',
  );
}
export function decodeEmpCursor(cursor: string): { createdAt: Date; id: string } | null {
  try {
    const p = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as {
      createdAt: string;
      id: string;
    };
    return { createdAt: new Date(p.createdAt), id: p.id };
  } catch {
    return null;
  }
}

export function enrichEmployee<
  T extends {
    principalId?: string | null;
    principal?: {
      id?: string;
      loginId?: string | null;
      status?: string;
      sessions?: { createdAt: Date }[];
    } | null;
  },
>(emp: T) {
  const p = emp.principal;
  let accountStatus = 'NOT_INVITED';
  let hasPassword = false;
  let lastLoginAt: Date | null = null;

  if (emp.principalId || p) {
    if (p?.status === 'ACTIVE') {
      accountStatus = 'ACTIVE';
      hasPassword = true;
    } else if (p?.status === 'SUSPENDED') {
      accountStatus = 'INVITED';
    } else {
      accountStatus = p?.status ?? 'INVITED';
    }
    lastLoginAt = p?.sessions?.[0]?.createdAt ?? null;
  }

  return {
    ...emp,
    accountStatus,
    hasPassword,
    claimPending: accountStatus === 'INVITED',
    loginId: p?.loginId ?? null,
    lastLoginAt,
  };
}

const MAX_LIMIT = 100;

// --------------------------------------------------------------- Scoped team
// Read-only workforce directory for project/site-scoped holders (PI/PD).
// Membership scope is derived from department rows — never caller input.

export interface ScopedTeamQuery {
  q?: string;
  status?: string;
  cursor?: string;
  limit?: number;
}

export interface ScopedMembershipItem {
  id: string;
  departmentId: string;
  isPrimary: boolean;
  startedAt: Date;
  endedAt: Date | null;
  department: {
    id: string;
    scopeType: string;
    projectId: string | null;
    siteId: string | null;
    code: string;
    name: string;
  };
}

export interface ScopedTeamMember {
  id: string;
  employeeCode: string;
  displayName: string;
  engagementType: string | null;
  designation: string | null;
  tradeCategory: string | null;
  status: string;
  memberships: ScopedMembershipItem[];
}

export interface ScopedTeamResponse {
  items: ScopedTeamMember[];
  nextCursor: string | null;
}

export interface DepartmentMembersQuery {
  includeEnded?: boolean;
  cursor?: string;
  limit?: number;
}

/** Allowlist DTO for a department roster row — never exposes the raw
 *  membership/department record (companyId, headEmployeeId, internals). */
export interface DepartmentMemberItem {
  membershipId: string;
  employeeId: string;
  departmentId: string;
  isPrimary: boolean;
  startedAt: Date;
  endedAt: Date | null;
  department: {
    id: string;
    code: string;
    name: string;
    scopeType: string;
    projectId: string | null;
    siteId: string | null;
  } | null;
  employee: {
    id: string;
    employeeCode: string;
    displayName: string;
    engagementType: string | null;
    designation: string | null;
    tradeCategory: string | null;
    status: string;
  } | null;
}

export interface DepartmentMembersResponse {
  items: DepartmentMemberItem[];
  nextCursor: string | null;
}

/**
 * Member-detail employee projection — the narrowly scoped read-back path for
 * contact/emergency fields accepted by onboarding. Only reachable via
 * GET /departments/:id/members/:mid (DEPARTMENT_READ at the department's own
 * scope); the roster list and team lists keep the safe projection above.
 * principal/login identifiers are never included.
 */
export interface ScopedMemberDetailEmployee {
  id: string;
  employeeCode: string;
  displayName: string;
  engagementType: string | null;
  designation: string | null;
  tradeCategory: string | null;
  joiningDate: Date | null;
  contactPhone: string | null;
  contactEmail: string | null;
  emergencyContactName: string | null;
  emergencyContactPhone: string | null;
  status: string;
}

export interface ScopedMemberDetail extends Omit<DepartmentMemberItem, 'employee'> {
  employee: ScopedMemberDetailEmployee | null;
}

/** Document reference accepted by scoped onboarding — an existing company
 *  Document id plus the link metadata (same fields as attachExisting). */
export interface OnboardDocumentInput {
  documentId: string;
  documentType: EmployeeDocumentType;
  title: string;
  documentNumber?: string;
  issuingAuthority?: string;
  issueDate?: Date;
  expiryDate?: Date;
}

export interface OnboardScopedMemberInput {
  employeeCode: string;
  displayName: string;
  engagementType: string;
  designation?: string;
  tradeCategory?: string;
  joiningDate?: Date;
  contactPhone?: string;
  contactEmail?: string;
  emergencyContactName?: string;
  emergencyContactPhone?: string;
  documents?: OnboardDocumentInput[];
}

export interface OnboardedMember {
  employee: ScopedMemberDetailEmployee & { principalId: string | null };
  membership: DepartmentMemberItem;
  documentsLinked: number;
}

const ENGAGEMENT_TYPES = new Set([
  'DIRECT_EMPLOYEE',
  'CONTRACTOR_WORKER',
  'DAILY_WAGE',
  'APPRENTICE',
  'CONSULTANT',
  'OTHER',
]);

/**
 * P2002 → deliberate 409. Matches ONLY the verified membership indexes —
 * "DepartmentMembership_active_primary_uq" → PRIMARY_CONFLICT and
 * "DepartmentMembership_active_emp_dept_uq" → ACTIVE_MEMBERSHIP_EXISTS.
 * Prisma reports the index name under meta.constraint (string or
 * {index|name|fields}) and sometimes meta.target; unrelated uniqueness
 * violations map to a generic 409, never mislabeled as membership errors.
 * Applied on every primary-capable write path — the employee row lock
 * serializes races, this is the residual safety net. Exported for tests.
 */
export function mapMembershipRace(error: unknown): never {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    throw error;
  }
  const meta = error.meta as
    | {
        constraint?: string | { index?: unknown; name?: unknown; fields?: unknown } | undefined;
        target?: unknown;
      }
    | undefined;
  const candidates: string[] = [];
  const push = (v: unknown): void => {
    if (typeof v === 'string') candidates.push(v);
    if (Array.isArray(v)) v.forEach(push);
  };
  const c: unknown = meta?.constraint;
  push(c);
  if (typeof c === 'object' && c !== null) {
    const o = c as Record<string, unknown>;
    push(o.index);
    push(o.name);
    push(o.fields);
  }
  push(meta?.target);
  const haystack = candidates.join(' ');
  if (haystack.includes('DepartmentMembership_active_primary_uq')) {
    throw new PrimaryConflictError();
  }
  if (haystack.includes('DepartmentMembership_active_emp_dept_uq')) {
    throw new ActiveMembershipExistsError();
  }
  // Unrelated P2002 on a membership write path — a deliberate 409, not a
  // sanitized 500 and never mislabeled as a membership constraint.
  throw new ConflictError('UNIQUE_CONFLICT', 'a conflicting record already exists');
}

function encodeRowCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(
    JSON.stringify({ createdAt: row.createdAt.toISOString(), id: row.id }),
  ).toString('base64url');
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function decodeRowCursor(cursor: string): { createdAt: Date; id: string } {
  try {
    const p = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as {
      createdAt?: unknown;
      id?: unknown;
    };
    if (typeof p.createdAt !== 'string' || typeof p.id !== 'string') throw new Error();
    const createdAt = new Date(p.createdAt);
    if (Number.isNaN(createdAt.getTime())) throw new Error();
    return { createdAt, id: p.id };
  } catch {
    throw new DomainValidationError('INVALID_CURSOR', 'cursor is malformed');
  }
}

const membershipItem = (
  m: DepartmentMembershipWithDepartment | DepartmentMembershipDetail,
): ScopedMembershipItem => {
  const d = m.department;
  if (d === null || d === undefined) {
    // Repository always includes the department for scoped reads — treat a
    // missing relation as a data integrity error, not as in-scope data.
    throw new OrgValidationError('department', 'membership has no resolvable department');
  }
  return {
    id: m.id,
    departmentId: m.departmentId,
    isPrimary: m.isPrimary,
    startedAt: m.startedAt,
    endedAt: m.endedAt,
    department: {
      id: d.id,
      scopeType: d.scopeType,
      projectId: d.projectId,
      siteId: d.siteId,
      code: d.code,
      name: d.name,
    },
  };
};

/** A department's own columns ARE its scope target (mirrors the department
 *  module's scopeTargetOf). */
function deptScopeTarget(dept: Department): ScopeTarget {
  if (dept.scopeType === 'SITE') {
    if (dept.siteId === null) throw new Error('DEPARTMENT invariant violated: missing siteId');
    return { companyId: dept.companyId, scopeType: 'SITE', scopeId: dept.siteId };
  }
  if (dept.scopeType === 'PROJECT') {
    if (dept.projectId === null)
      throw new Error('DEPARTMENT invariant violated: missing projectId');
    return { companyId: dept.companyId, scopeType: 'PROJECT', scopeId: dept.projectId };
  }
  return { companyId: dept.companyId, scopeType: 'COMPANY', scopeId: dept.companyId };
}

/** W4 site/project workforce-lifecycle types. */
export interface WorkforceScope {
  scopeType: 'SITE' | 'PROJECT';
  scopeId: string;
}

export interface WorkforceEndedItem {
  membershipId: string;
  departmentId: string;
  wasPrimary: boolean;
}

export interface WorkforceRestoredItem {
  membershipId: string;
  departmentId: string;
  isPrimary: boolean;
}

export interface WorkforceActionResult {
  employeeId: string;
  action: 'SUSPEND' | 'EXIT' | 'REINSTATE';
  scopeType: 'SITE' | 'PROJECT';
  scopeId: string;
  ended: WorkforceEndedItem[];
  restored: WorkforceRestoredItem[];
  headsCleared: string[];
  /** ISO date — suspend only, null otherwise. */
  suspendUntil: string | null;
  /** SiteWorkforceExit marker id — exit only. */
  exitMarkerId: string | null;
}

const memberItem = (m: DepartmentMembershipDetail): DepartmentMemberItem => ({
  membershipId: m.id,
  employeeId: m.employeeId,
  departmentId: m.departmentId,
  isPrimary: m.isPrimary,
  startedAt: m.startedAt,
  endedAt: m.endedAt,
  department:
    m.department === null || m.department === undefined
      ? null
      : {
          id: m.department.id,
          code: m.department.code,
          name: m.department.name,
          scopeType: m.department.scopeType,
          projectId: m.department.projectId,
          siteId: m.department.siteId,
        },
  employee: m.employee ?? null,
});

export class EmployeeService {
  constructor(
    private readonly uow: EmployeeUnitOfWork,
    private readonly authorizer: Authorizer,
    private readonly cache?: import('../auth/cache.js').UserProfileCache,
  ) {}

  async list(
    actor: ActorContext,
    companyId: string,
    filter?: {
      status?: string;
      q?: string;
      cursor?: string;
      limit?: number;
      offset?: number;
      page?: number;
    },
  ): Promise<{
    employees: Employee[];
    items: Employee[];
    nextCursor: string | null;
    pagination: { total: number; limit: number; offset: number };
  }> {
    await this.authorizer.assertPermission(actor.actorId, EMPLOYEE_READ, companyTarget(companyId));
    const limit = Math.min(filter?.limit ?? 50, MAX_LIMIT);
    const useOffset = filter?.offset !== undefined || filter?.page !== undefined;
    const offset =
      filter?.offset !== undefined
        ? Math.max(0, filter.offset)
        : filter?.page !== undefined
          ? Math.max(0, (filter.page - 1) * limit)
          : 0;
    const cursor = !useOffset && filter?.cursor !== undefined ? decodeEmpCursor(filter.cursor) : null;
    const [rows, total] = await this.uow.run(async ({ employees }) => {
      const base = {
        ...(filter?.status !== undefined ? { status: filter.status } : {}),
        ...(filter?.q !== undefined ? { q: filter.q } : {}),
      };
      return Promise.all([
        employees.list(companyId, {
          ...base,
          ...(useOffset ? { offset, limit } : { ...(cursor !== null ? { cursor } : {}), limit: limit + 1 }),
        }),
        typeof employees.count === 'function' ? employees.count(companyId, base) : Promise.resolve(0),
      ]);
    });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const enriched = page.map(enrichEmployee);
    return {
      employees: enriched,
      items: enriched,
      nextCursor: !useOffset && rows.length > limit && last !== undefined ? encodeEmpCursor(last) : null,
      pagination: { total: total || enriched.length, limit, offset },
    };
  }

  async create(
    actor: ActorContext,
    companyId: string,
    input: {
      employeeCode: string;
      displayName: string;
      engagementType: string;
      designation?: string;
      tradeCategory?: string;
      joiningDate?: Date;
      contactPhone?: string;
      contactEmail?: string;
      emergencyContactName?: string;
      emergencyContactPhone?: string;
    },
  ): Promise<Employee> {
    await this.authorizer.assertPermission(
      actor.actorId,
      EMPLOYEE_MANAGE,
      companyTarget(companyId),
    );
    const employeeCode = normalizeCode(input.employeeCode);
    const displayName = normalizeName(input.displayName);
    // Emergency contact is a pair — both or neither.
    if (
      (input.emergencyContactName === undefined) !==
      (input.emergencyContactPhone === undefined)
    ) {
      throw new OrgValidationError(
        'emergencyContact',
        'emergency contact name and phone must be provided together',
      );
    }
    let joiningDate: Date | undefined;
    if (input.joiningDate !== undefined) {
      joiningDate =
        typeof input.joiningDate === 'string' ? new Date(input.joiningDate) : input.joiningDate;
      if (Number.isNaN(joiningDate.getTime())) {
        throw new OrgValidationError('joiningDate', 'must be a valid date');
      }
    }
    return this.uow.run(async ({ employees, audit }) => {
      const employee = await employees.create(companyId, {
        employeeCode,
        displayName,
        engagementType: input.engagementType,
        ...(input.designation !== undefined ? { designation: input.designation } : {}),
        ...(input.tradeCategory !== undefined ? { tradeCategory: input.tradeCategory } : {}),
        ...(joiningDate !== undefined ? { joiningDate } : {}),
        ...(input.contactPhone !== undefined ? { contactPhone: input.contactPhone } : {}),
        ...(input.contactEmail !== undefined ? { contactEmail: input.contactEmail } : {}),
        ...(input.emergencyContactName !== undefined
          ? { emergencyContactName: input.emergencyContactName }
          : {}),
        ...(input.emergencyContactPhone !== undefined
          ? { emergencyContactPhone: input.emergencyContactPhone }
          : {}),
      });
      await audit.record(
        auditEntry(actor, {
          action: 'EMPLOYEE_CREATED',
          entityType: 'EMPLOYEE',
          entityId: employee.id,
          companyId,
          statusAfter: employee.status,
          changedFields: {
            employeeCode: { before: null, after: employeeCode },
            displayName: { before: null, after: displayName },
          },
        }),
      );
      return employee;
    });
  }

  async update(
    actor: ActorContext,
    companyId: string,
    id: string,
    patch: {
      displayName?: string;
      engagementType?: string | null;
      designation?: string | null;
      tradeCategory?: string | null;
      joiningDate?: Date | null;
      contactPhone?: string | null;
      contactEmail?: string | null;
      emergencyContactName?: string | null;
      emergencyContactPhone?: string | null;
    },
    expectedVersion?: number,
  ): Promise<Employee> {
    // Emergency contact must remain a pair — both fields or neither.
    if (
      patch.emergencyContactName !== undefined &&
      patch.emergencyContactPhone !== undefined &&
      (patch.emergencyContactName === null) !== (patch.emergencyContactPhone === null)
    ) {
      throw new OrgValidationError(
        'emergencyContact',
        'emergency contact name and phone must be provided together',
      );
    }
    if (
      patch.emergencyContactName !== undefined &&
      patch.emergencyContactPhone === undefined &&
      patch.emergencyContactName !== null
    ) {
      throw new OrgValidationError(
        'emergencyContact',
        'emergency contact name and phone must be provided together',
      );
    }
    const data: Record<string, unknown> = {};
    if (patch.displayName !== undefined) data.displayName = normalizeName(patch.displayName);
    for (const f of [
      'engagementType',
      'designation',
      'tradeCategory',
      'contactPhone',
      'contactEmail',
      'emergencyContactName',
      'emergencyContactPhone',
    ] as const) {
      if (patch[f] !== undefined) data[f] = patch[f];
    }
    if (patch.joiningDate !== undefined) {
      if (patch.joiningDate === null) {
        data.joiningDate = null;
      } else {
        const d =
          typeof patch.joiningDate === 'string' ? new Date(patch.joiningDate) : patch.joiningDate;
        if (Number.isNaN(d.getTime())) {
          throw new OrgValidationError('joiningDate', 'must be a valid date');
        }
        data.joiningDate = d;
      }
    }
    return this.uow.run(async ({ employees, audit }) => {
      const existing = await employees.findById(companyId, id);
      if (!existing) throw new OrgEntityNotFoundError('EMPLOYEE');
      await this.authorizer.assertPermission(
        actor.actorId,
        EMPLOYEE_MANAGE,
        companyTarget(companyId),
      );
      if (Object.keys(data).length === 0) return existing;
      const updated = await employees.update(companyId, id, data, expectedVersion);
      await audit.record(
        auditEntry(actor, {
          action: 'EMPLOYEE_UPDATED',
          entityType: 'EMPLOYEE',
          entityId: id,
          companyId,
          statusBefore: existing.status,
          statusAfter: updated.status,
          changedFields: {
            displayName: { before: existing.displayName, after: updated.displayName },
          },
        }),
      );
      if (this.cache && existing.principalId) {
        await this.cache.invalidate(existing.principalId);
      }
      return updated;
    });
  }

  async changeStatus(
    actor: ActorContext,
    companyId: string,
    id: string,
    to: 'ACTIVE' | 'INACTIVE',
    expectedVersion?: number,
  ): Promise<Employee> {
    return this.uow.run(async (repos) => {
      const { employees, audit } = repos;
      const existing = await employees.findById(companyId, id);
      if (!existing) throw new OrgEntityNotFoundError('EMPLOYEE');
      await this.authorizer.assertPermission(
        actor.actorId,
        EMPLOYEE_MANAGE,
        companyTarget(companyId),
      );
      if (existing.status === to) return existing;
      if (existing.status !== 'ACTIVE' && existing.status !== 'INACTIVE') {
        throw new OrgValidationError('status', `cannot move ${existing.status} to ${to}`);
      }

      // Lockout guard: deactivation must not remove the company's last active
      // administrator (any active holder of an admin key).
      if (to === 'INACTIVE' && existing.principalId !== null) {
        const holders = await employees.activeHoldersOfKeys(
          companyId,
          ADMIN_GUARD_KEYS,
          new Date(),
        );
        if (holders.length === 1 && holders[0] === existing.principalId) {
          throw new OrgValidationError('status', 'cannot deactivate the last active administrator');
        }
      }

      const updated = await employees.update(companyId, id, { status: to }, expectedVersion);
      if (to === 'INACTIVE') {
        // Same tx: revoke in-company assignments (principal stays globally
        // active), clear head references with version bumps, audit each.
        if (existing.principalId !== null) {
          const revoked = await employees.revokeAssignmentsForPrincipal(
            companyId,
            existing.principalId,
            new Date(),
          );
          for (const assignmentId of revoked) {
            await audit.record(
              auditEntry(actor, {
                action: 'ACCESS_ROLE_REVOKED',
                entityType: 'ROLE_ASSIGNMENT',
                entityId: assignmentId,
                companyId,
                statusBefore: 'ACTIVE',
                statusAfter: 'REVOKED',
                changedFields: { revokedAt: { before: null, after: 'employee deactivated' } },
              }),
            );
          }
        }
        // End all active department memberships in the same tx.
        const ended = await employees.endActiveMemberships(companyId, id);
        for (const m of ended) {
          await audit.record(
            auditEntry(actor, {
              action: 'MEMBERSHIP_ENDED',
              entityType: 'DEPARTMENT_MEMBERSHIP',
              entityId: m.id,
              companyId,
              statusBefore: 'ACTIVE',
              statusAfter: 'ENDED',
              changedFields: { endedAt: { before: null, after: 'employee deactivated' } },
            }),
          );
        }
        const cleared = await employees.clearHeadReferences(companyId, id);
        for (const dept of cleared) {
          await audit.record(
            auditEntry(actor, {
              action: 'DEPT_HEAD_CLEARED',
              entityType: 'DEPARTMENT',
              entityId: dept.id,
              companyId,
              changedFields: { headEmployeeId: { before: id, after: null } },
            }),
          );
        }
      }
      await audit.record(
        auditEntry(actor, {
          action: to === 'INACTIVE' ? 'EMPLOYEE_DEACTIVATED' : 'EMPLOYEE_REACTIVATED',
          entityType: 'EMPLOYEE',
          entityId: id,
          companyId,
          statusBefore: existing.status,
          statusAfter: to,
          changedFields: { status: { before: existing.status, after: to } },
        }),
      );
      if (this.cache && existing.principalId) {
        await this.cache.invalidate(existing.principalId);
      }
      return updated;
    });
  }

  async getById(actor: ActorContext, companyId: string, id: string) {
    await this.authorizer.assertPermission(
      actor.actorId,
      'EMPLOYEE_READ',
      companyTarget(companyId),
    );
    const employee = await this.uow.run(({ employees }) => employees.findById(companyId, id));
    if (!employee) throw new OrgEntityNotFoundError('EMPLOYEE');
    return enrichEmployee(employee);
  }

  /**
   * Scoped workforce directory — employees with a CURRENT membership in the
   * requested project/site's departments. Scope existence is verified
   * against the tenant company (cross-company/missing → not found), then
   * EMPLOYEE_READ is asserted at that exact scope.
   */
  async listScopedTeam(
    actor: ActorContext,
    companyId: string,
    scope: { scopeType: 'PROJECT' | 'SITE'; scopeId: string },
    query: ScopedTeamQuery,
  ): Promise<ScopedTeamResponse> {
    const limit = Math.min(query.limit ?? 50, MAX_LIMIT);
    const cursor = query.cursor !== undefined ? decodeRowCursor(query.cursor) : undefined;
    const now = new Date();
    if (!UUID_RE.test(scope.scopeId)) throw new OrgEntityNotFoundError(scope.scopeType);
    return this.uow.run(async ({ employees, memberships, projects, sites }) => {
      if (scope.scopeType === 'PROJECT') {
        const project = await projects.findById(companyId, scope.scopeId);
        if (project === null) throw new OrgEntityNotFoundError('PROJECT');
      } else {
        const site = await sites.findById(companyId, scope.scopeId);
        if (site === null) throw new OrgEntityNotFoundError('SITE');
      }
      await this.authorizer.assertPermission(actor.actorId, EMPLOYEE_READ, {
        companyId,
        scopeType: scope.scopeType,
        scopeId: scope.scopeId,
      });
      const scopeRef: TeamScopeRef =
        scope.scopeType === 'PROJECT' ? { projectId: scope.scopeId } : { siteId: scope.scopeId };
      const rows = await employees.listScopedTeam(
        companyId,
        scopeRef,
        {
          ...(query.q !== undefined ? { q: query.q } : {}),
          ...(query.status !== undefined ? { status: query.status } : {}),
          ...(cursor !== undefined ? { cursor } : {}),
          limit: limit + 1,
        },
        now,
      );
      const page = rows.slice(0, limit);
      const ids = page.map((e) => e.id);
      const inScope =
        ids.length === 0 ? [] : await memberships.currentInScope(companyId, scopeRef, ids, now);
      const byEmployee = new Map<string, typeof inScope>();
      for (const m of inScope) {
        const list = byEmployee.get(m.employeeId);
        if (list === undefined) byEmployee.set(m.employeeId, [m]);
        else list.push(m);
      }
      const items: ScopedTeamMember[] = page.map((e) => ({
        id: e.id,
        employeeCode: e.employeeCode,
        displayName: e.displayName,
        engagementType: e.engagementType,
        designation: e.designation,
        tradeCategory: e.tradeCategory,
        status: e.status,
        memberships: (byEmployee.get(e.id) ?? []).map(membershipItem),
      }));
      const last = page[page.length - 1];
      return {
        items,
        nextCursor: rows.length > limit && last !== undefined ? encodeRowCursor(last) : null,
      };
    });
  }

  /**
   * Membership roster of one department — DEPARTMENT_READ evaluated at the
   * department's own scope, so a project/site-scoped holder sees only its
   * own departments. includeEnded=false → current rows only; future-dated
   * memberships are never returned.
   */
  async listDepartmentMembers(
    actor: ActorContext,
    companyId: string,
    departmentId: string,
    query: DepartmentMembersQuery,
  ): Promise<DepartmentMembersResponse> {
    const limit = Math.min(query.limit ?? 50, MAX_LIMIT);
    const cursor = query.cursor !== undefined ? decodeRowCursor(query.cursor) : undefined;
    const now = new Date();
    if (!UUID_RE.test(departmentId)) throw new OrgEntityNotFoundError('DEPARTMENT');
    return this.uow.run(async ({ departments, memberships }) => {
      const dept = await departments.findById(companyId, departmentId);
      if (dept === null) throw new OrgEntityNotFoundError('DEPARTMENT');
      await this.authorizer.assertPermission(
        actor.actorId,
        'DEPARTMENT_READ',
        deptScopeTarget(dept),
      );
      const rows = await memberships.listForDepartment(
        companyId,
        departmentId,
        {
          includeEnded: query.includeEnded === true,
          ...(cursor !== undefined ? { cursor } : {}),
          limit: limit + 1,
        },
        now,
      );
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      return {
        items: page.map(memberItem),
        nextCursor: rows.length > limit && last !== undefined ? encodeRowCursor(last) : null,
      };
    });
  }

  // --------------------------------------------------------- Scoped placement
  // Delegated membership administration inside project/site departments.
  // Company-wide EMPLOYEE_MANAGE / EMPLOYEE_MEMBER_MANAGE holders keep their
  // existing path; scoped holders additionally require the company
  // "placement" delegation switch. Company/HO departments are never delegated.

  /**
   * Shared scoped-mutation gate: company-wide EMPLOYEE_MANAGE (or the
   * action's own key at COMPANY) bypasses the flag — admins keep their
   * existing paths. Scoped holders need a PROJECT/SITE department, the
   * matching delegation flag ON, and the action permission at the
   * department's own scope. Company/HO departments are never delegated.
   */
  private async assertScopedMutation(
    actor: ActorContext,
    companyId: string,
    dept: Department,
    permissionKey: string,
    flag: DelegationFlag,
  ): Promise<void> {
    const companyWide =
      (await this.authorizer.hasPermission?.(
        actor.actorId,
        EMPLOYEE_MANAGE,
        companyTarget(companyId),
      )) === true ||
      (await this.authorizer.hasPermission?.(
        actor.actorId,
        permissionKey,
        companyTarget(companyId),
      )) === true;
    if (companyWide) return;
    if (dept.scopeType !== 'PROJECT' && dept.scopeType !== 'SITE') {
      throw new ForbiddenError(
        'DELEGATION_NEVER',
        'company and head-office department administration is never delegated',
      );
    }
    const delegated = (await this.authorizer.delegationEnabled?.(companyId, flag)) === true;
    if (!delegated) {
      throw new ForbiddenError(
        'DELEGATION_DISABLED',
        `company has not enabled delegated administration (${flag})`,
      );
    }
    await this.authorizer.assertPermission(actor.actorId, permissionKey, deptScopeTarget(dept));
  }

  private assertMembershipMutationScope(
    actor: ActorContext,
    companyId: string,
    dept: Department,
  ): Promise<void> {
    return this.assertScopedMutation(actor, companyId, dept, EMPLOYEE_MEMBER_MANAGE, 'placement');
  }

  /**
   * W4 workforce-lifecycle gate: company-wide EMPLOYEE_MANAGE /
   * EMPLOYEE_MEMBER_MANAGE bypasses; scoped holders need the delegation flag
   * ON plus EMPLOYEE_MEMBER_MANAGE at the resolved site/project target. The
   * target comes from the route path and is inherently SITE or PROJECT —
   * company/head-office scope can never reach this gate.
   */
  private async assertScopedWorkforce(
    actor: ActorContext,
    companyId: string,
    target: ScopeTarget,
    flag: DelegationFlag,
  ): Promise<void> {
    const companyWide =
      (await this.authorizer.hasPermission?.(
        actor.actorId,
        EMPLOYEE_MANAGE,
        companyTarget(companyId),
      )) === true ||
      (await this.authorizer.hasPermission?.(
        actor.actorId,
        EMPLOYEE_MEMBER_MANAGE,
        companyTarget(companyId),
      )) === true;
    if (companyWide) return;
    const delegated = (await this.authorizer.delegationEnabled?.(companyId, flag)) === true;
    if (!delegated) {
      throw new ForbiddenError(
        'DELEGATION_DISABLED',
        `company has not enabled delegated administration (${flag})`,
      );
    }
    await this.authorizer.assertPermission(actor.actorId, EMPLOYEE_MEMBER_MANAGE, target);
  }

  /** Non-throwing boundary probe — project grants cover child sites through
   *  the scope chain. Used to decide whether demoting a primary elsewhere is
   *  inside the caller's authorized boundary. */
  private async deptInBoundary(actor: ActorContext, dept: Department): Promise<boolean> {
    if (dept.scopeType !== 'PROJECT' && dept.scopeType !== 'SITE') return false;
    return (
      (await this.authorizer.hasPermission?.(
        actor.actorId,
        EMPLOYEE_MEMBER_MANAGE,
        deptScopeTarget(dept),
      )) === true
    );
  }

  private static assertStart(
    startedAt: Date | undefined,
    now: Date,
  ): { start: Date; isFuture: boolean } {
    if (startedAt === undefined) return { start: now, isFuture: false };
    if (Number.isNaN(startedAt.getTime()) || startedAt <= now) {
      throw new OrgValidationError(
        'startedAt',
        'must be a future timestamp, or omitted to start immediately',
      );
    }
    return { start: startedAt, isFuture: true };
  }

  private static async loadDept(
    departments: { findById(c: string, id: string): Promise<Department | null> },
    companyId: string,
    departmentId: string,
  ): Promise<Department> {
    const dept = await departments.findById(companyId, departmentId);
    if (dept === null) throw new OrgEntityNotFoundError('DEPARTMENT');
    return dept;
  }

  /**
   * The employee's sole active primary (at most one exists — partial unique
   * index). If it sits outside the caller's boundary, changing primary would
   * silently demote a row they cannot see — opaque 409, no writes.
   */
  private async assertPrimaryDemotable(
    actor: ActorContext,
    repos: {
      memberships: {
        activePrimary(c: string, e: string): Promise<DepartmentMembershipWithDepartment | null>;
      };
    },
    companyId: string,
    employeeId: string,
    excludeId?: string,
  ): Promise<void> {
    const current = await repos.memberships.activePrimary(companyId, employeeId);
    if (current === null || current.id === excludeId) return;
    const inBoundary =
      current.department !== null &&
      current.department !== undefined &&
      (await this.deptInBoundary(actor, current.department));
    if (!inBoundary) throw new PrimaryOutOfScopeError();
  }

  async addScopedMember(
    actor: ActorContext,
    companyId: string,
    departmentId: string,
    input: { employeeId: string; isPrimary?: boolean; startedAt?: Date },
  ): Promise<DepartmentMemberItem> {
    if (!UUID_RE.test(departmentId)) throw new OrgEntityNotFoundError('DEPARTMENT');
    if (!UUID_RE.test(input.employeeId)) throw new OrgEntityNotFoundError('EMPLOYEE');
    const now = new Date();
    const { start, isFuture } = EmployeeService.assertStart(input.startedAt, now);
    if (input.isPrimary === true && isFuture) {
      throw new OrgValidationError('isPrimary', 'a future-dated membership cannot be primary');
    }
    return this.uow.run(async ({ employees, departments, memberships, audit }) => {
      const dept = await EmployeeService.loadDept(departments, companyId, departmentId);
      await this.assertMembershipMutationScope(actor, companyId, dept);
      if (dept.status !== 'ACTIVE') {
        throw new OrgValidationError('departmentId', 'department must be active');
      }
      const employee = await employees.findById(companyId, input.employeeId);
      if (employee === null) throw new OrgEntityNotFoundError('EMPLOYEE');
      if (employee.status !== 'ACTIVE') {
        throw new OrgValidationError('employeeId', 'employee must be active');
      }
      // Serialize per-employee membership/primary changes on the row lock.
      await employees.lockForUpdate(companyId, employee.id);
      const effective = await memberships.effectiveAt(companyId, input.employeeId, start);
      if (effective.some((m) => m.departmentId === departmentId)) {
        throw new ActiveMembershipExistsError();
      }
      if (input.isPrimary === true) {
        await this.assertPrimaryDemotable(actor, { memberships }, companyId, input.employeeId);
        await memberships
          .demoteOthers(companyId, input.employeeId, '00000000-0000-0000-0000-000000000000')
          .catch(mapMembershipRace);
      } else if (effective.length > 0 && !effective.some((m) => m.isPrimary)) {
        // Result would be multiple effective memberships with no primary —
        // leave-policy resolution is fail-closed on ambiguity.
        throw new AmbiguousPrimaryError();
      }
      let membership;
      try {
        membership = await memberships.create({
          companyId,
          employeeId: input.employeeId,
          departmentId,
          isPrimary: input.isPrimary ?? false,
          startedAt: start,
        });
      } catch (e) {
        mapMembershipRace(e);
      }
      await audit.record(
        auditEntry(actor, {
          action: 'MEMBERSHIP_CREATED',
          entityType: 'DEPARTMENT_MEMBERSHIP',
          entityId: membership.id,
          companyId,
          statusAfter: 'ACTIVE',
          changedFields: {
            departmentId: { before: null, after: departmentId },
            isPrimary: { before: null, after: membership.isPrimary },
          },
        }),
      );
      if (this.cache && employee.principalId !== null) {
        await this.cache.invalidate(employee.principalId);
      }
      return memberItem(membership);
    });
  }

  async updateScopedMember(
    actor: ActorContext,
    companyId: string,
    departmentId: string,
    membershipId: string,
    input: { isPrimary: boolean; expectedVersion: number },
  ): Promise<DepartmentMemberItem> {
    if (!UUID_RE.test(departmentId)) throw new OrgEntityNotFoundError('DEPARTMENT');
    if (!UUID_RE.test(membershipId)) throw new OrgEntityNotFoundError('DEPARTMENT_MEMBERSHIP');
    const now = new Date();
    return this.uow.run(async ({ employees, departments, memberships, audit }) => {
      const dept = await EmployeeService.loadDept(departments, companyId, departmentId);
      await this.assertMembershipMutationScope(actor, companyId, dept);
      const m = await memberships.findInDepartment(companyId, departmentId, membershipId);
      if (m === null) throw new OrgEntityNotFoundError('DEPARTMENT_MEMBERSHIP');
      if (m.endedAt !== null) {
        throw new OrgValidationError('membership', 'cannot change an ended membership');
      }
      await employees.lockForUpdate(companyId, m.employeeId);
      if (input.isPrimary) {
        if (m.startedAt > now) {
          throw new OrgValidationError('isPrimary', 'a future-dated membership cannot be primary');
        }
        await this.assertPrimaryDemotable(
          actor,
          { memberships },
          companyId,
          m.employeeId,
          membershipId,
        );
        await memberships
          .demoteOthers(companyId, m.employeeId, membershipId)
          .catch(mapMembershipRace);
      } else if (m.isPrimary) {
        const others = (await memberships.effectiveAt(companyId, m.employeeId, now)).filter(
          (x) => x.id !== membershipId,
        );
        if (others.length > 1) throw new AmbiguousPrimaryError();
      }
      const res = await memberships
        .setPrimaryFlag(
          companyId,
          departmentId,
          membershipId,
          input.isPrimary,
          input.expectedVersion,
        )
        .catch(mapMembershipRace);
      if (res.count === 0) throw new VersionConflictError('DEPARTMENT_MEMBERSHIP');
      await audit.record(
        auditEntry(actor, {
          action: 'MEMBERSHIP_PRIMARY_SET',
          entityType: 'DEPARTMENT_MEMBERSHIP',
          entityId: membershipId,
          companyId,
          changedFields: { isPrimary: { before: m.isPrimary, after: input.isPrimary } },
        }),
      );
      if (this.cache && m.employee?.principalId) {
        await this.cache.invalidate(m.employee.principalId);
      }
      const updated = await memberships.findInDepartment(companyId, departmentId, membershipId);
      if (updated === null) throw new OrgEntityNotFoundError('DEPARTMENT_MEMBERSHIP');
      return memberItem(updated);
    });
  }

  async endScopedMember(
    actor: ActorContext,
    companyId: string,
    departmentId: string,
    membershipId: string,
    input: { expectedVersion: number },
  ): Promise<DepartmentMemberItem> {
    if (!UUID_RE.test(departmentId)) throw new OrgEntityNotFoundError('DEPARTMENT');
    if (!UUID_RE.test(membershipId)) throw new OrgEntityNotFoundError('DEPARTMENT_MEMBERSHIP');
    const now = new Date();
    return this.uow.run(async ({ employees, departments, memberships, audit }) => {
      const dept = await EmployeeService.loadDept(departments, companyId, departmentId);
      await this.assertMembershipMutationScope(actor, companyId, dept);
      const m = await memberships.findInDepartment(companyId, departmentId, membershipId);
      if (m === null) throw new OrgEntityNotFoundError('DEPARTMENT_MEMBERSHIP');
      if (m.endedAt !== null) {
        throw new OrgValidationError('membership', 'membership already ended');
      }
      await employees.lockForUpdate(companyId, m.employeeId);
      if (m.isPrimary) {
        const others = (await memberships.effectiveAt(companyId, m.employeeId, now)).filter(
          (x) => x.id !== membershipId,
        );
        if (others.length > 1) throw new AmbiguousPrimaryError();
      }
      const res = await memberships.end(
        companyId,
        m.employeeId,
        membershipId,
        input.expectedVersion,
        'PLACEMENT_END',
      );
      if ((res as { count: number }).count === 0) {
        throw new VersionConflictError('DEPARTMENT_MEMBERSHIP');
      }
      if (dept.headEmployeeId === m.employeeId) {
        await departments.clearHeadIf(companyId, departmentId, m.employeeId);
        await audit.record(
          auditEntry(actor, {
            action: 'DEPT_HEAD_CLEARED',
            entityType: 'DEPARTMENT',
            entityId: departmentId,
            companyId,
            changedFields: { headEmployeeId: { before: m.employeeId, after: null } },
          }),
        );
      }
      await audit.record(
        auditEntry(actor, {
          action: 'MEMBERSHIP_ENDED',
          entityType: 'DEPARTMENT_MEMBERSHIP',
          entityId: membershipId,
          companyId,
          statusBefore: 'ACTIVE',
          statusAfter: 'ENDED',
          changedFields: {
            endedAt: { before: null, after: 'ended by scoped admin' },
            endReason: { before: null, after: 'PLACEMENT_END' },
          },
        }),
      );
      if (this.cache && m.employee?.principalId) {
        await this.cache.invalidate(m.employee.principalId);
      }
      const ended = await memberships.findInDepartment(companyId, departmentId, membershipId);
      if (ended === null) throw new OrgEntityNotFoundError('DEPARTMENT_MEMBERSHIP');
      return memberItem(ended);
    });
  }

  /**
   * Immediate transfer: end the source membership and create the destination
   * one in ONE transaction with a single coherent MEMBERSHIP_TRANSFERRED
   * audit. Both departments must be inside the caller's authorized boundary.
   */
  async transferScopedMember(
    actor: ActorContext,
    companyId: string,
    departmentId: string,
    membershipId: string,
    input: {
      toDepartmentId: string;
      expectedVersion: number;
      isPrimary?: boolean;
      /** Rejected — transfers are immediate; endedAt/startedAt are server-controlled. */
      startedAt?: Date;
    },
  ): Promise<DepartmentMemberItem> {
    if (!UUID_RE.test(departmentId)) throw new OrgEntityNotFoundError('DEPARTMENT');
    if (!UUID_RE.test(membershipId)) throw new OrgEntityNotFoundError('DEPARTMENT_MEMBERSHIP');
    if (!UUID_RE.test(input.toDepartmentId)) {
      throw new OrgEntityNotFoundError('DEPARTMENT');
    }
    if (input.toDepartmentId === departmentId) {
      throw new OrgValidationError('toDepartmentId', 'must differ from the source department');
    }
    // Transfers are immediate: the source ends and the destination starts at
    // server `now` in one transaction. A caller-supplied startedAt would end
    // the source now and start the destination later — a coverage gap with
    // no effective membership (and possibly no primary) in between.
    if (input.startedAt !== undefined) {
      throw new OrgValidationError(
        'startedAt',
        'transfers are immediate; startedAt is server-controlled',
      );
    }
    const now = new Date();
    const start = now;
    return this.uow.run(async ({ employees, departments, memberships, audit }) => {
      const dept = await EmployeeService.loadDept(departments, companyId, departmentId);
      await this.assertMembershipMutationScope(actor, companyId, dept);
      const toDept = await EmployeeService.loadDept(departments, companyId, input.toDepartmentId);
      await this.assertMembershipMutationScope(actor, companyId, toDept);
      if (dept.status !== 'ACTIVE' || toDept.status !== 'ACTIVE') {
        throw new OrgValidationError('departmentId', 'both departments must be active');
      }
      const m = await memberships.findInDepartment(companyId, departmentId, membershipId);
      if (m === null) throw new OrgEntityNotFoundError('DEPARTMENT_MEMBERSHIP');
      if (m.endedAt !== null) {
        throw new OrgValidationError('membership', 'membership already ended');
      }
      await employees.lockForUpdate(companyId, m.employeeId);
      const effective = await memberships.effectiveAt(companyId, m.employeeId, start);
      if (effective.some((x) => x.departmentId === input.toDepartmentId && x.id !== membershipId)) {
        throw new ActiveMembershipExistsError();
      }
      if (input.isPrimary === true) {
        // The source row ends in this same transaction — it never blocks.
        await this.assertPrimaryDemotable(
          actor,
          { memberships },
          companyId,
          m.employeeId,
          membershipId,
        );
        await memberships
          .demoteOthers(companyId, m.employeeId, membershipId)
          .catch(mapMembershipRace);
      } else if (m.isPrimary) {
        const others = effective.filter((x) => x.id !== membershipId);
        if (others.length > 1) throw new AmbiguousPrimaryError();
      }
      const res = await memberships.end(
        companyId,
        m.employeeId,
        membershipId,
        input.expectedVersion,
        'TRANSFERRED',
      );
      if ((res as { count: number }).count === 0) {
        throw new VersionConflictError('DEPARTMENT_MEMBERSHIP');
      }
      if (dept.headEmployeeId === m.employeeId) {
        await departments.clearHeadIf(companyId, departmentId, m.employeeId);
        await audit.record(
          auditEntry(actor, {
            action: 'DEPT_HEAD_CLEARED',
            entityType: 'DEPARTMENT',
            entityId: departmentId,
            companyId,
            changedFields: { headEmployeeId: { before: m.employeeId, after: null } },
          }),
        );
      }
      let created;
      try {
        created = await memberships.create({
          companyId,
          employeeId: m.employeeId,
          departmentId: input.toDepartmentId,
          isPrimary: input.isPrimary ?? false,
          startedAt: start,
        });
      } catch (e) {
        mapMembershipRace(e);
      }
      await audit.record(
        auditEntry(actor, {
          action: 'MEMBERSHIP_TRANSFERRED',
          entityType: 'DEPARTMENT_MEMBERSHIP',
          entityId: created.id,
          companyId,
          changedFields: {
            departmentId: { before: departmentId, after: input.toDepartmentId },
            sourceMembershipId: { before: membershipId, after: created.id },
            isPrimary: { before: m.isPrimary, after: created.isPrimary },
          },
        }),
      );
      if (this.cache && m.employee?.principalId) {
        await this.cache.invalidate(m.employee.principalId);
      }
      return memberItem(created);
    });
  }

  // ------------------------------------------------------------------ W4 --
  // Site/project workforce suspension, exit, and reinstatement. All three
  // resolve their affected set from trusted department→site/project columns
  // inside ONE transaction guarded by the employee row lock; they never
  // touch Employee.status, Principal.status, or out-of-scope memberships.

  /** Shared prologue: anchor existence + scoped-workforce authorization +
   *  employee load + row lock. Returns the resolved in-scope query handle. */
  private async workforcePrologue(
    repos: EmployeeRepos,
    actor: ActorContext,
    companyId: string,
    scope: WorkforceScope,
    employeeId: string,
    flag: DelegationFlag,
  ): Promise<{
    target: ScopeTarget;
    teamScope: TeamScopeRef;
    siteProjectId: string | null;
    employee: Employee;
  }> {
    let siteProjectId: string | null = null;
    if (scope.scopeType === 'SITE') {
      const site = await repos.sites.findById(companyId, scope.scopeId);
      if (site === null) throw new OrgEntityNotFoundError('SITE');
      siteProjectId = site.projectId;
    } else {
      const project = await repos.projects.findById(companyId, scope.scopeId);
      if (project === null) throw new OrgEntityNotFoundError('PROJECT');
    }
    const target: ScopeTarget = {
      companyId,
      scopeType: scope.scopeType,
      scopeId: scope.scopeId,
    };
    await this.assertScopedWorkforce(actor, companyId, target, flag);
    const employee = await repos.employees.findById(companyId, employeeId);
    if (employee === null) throw new OrgEntityNotFoundError('EMPLOYEE');
    await repos.employees.lockForUpdate(companyId, employeeId);
    const teamScope: TeamScopeRef =
      scope.scopeType === 'SITE' ? { siteId: scope.scopeId } : { projectId: scope.scopeId };
    return { target, teamScope, siteProjectId, employee };
  }

  /** True when an exit marker already covers this action's whole scope —
   *  a site action is covered by its own marker or the parent project's;
   *  a project action only by the project marker. */
  private static scopeCoveredByMarker(
    scope: WorkforceScope,
    siteProjectId: string | null,
    markers: { siteId: string | null; projectId: string | null }[],
  ): boolean {
    return scope.scopeType === 'SITE'
      ? markers.some((m) => m.siteId === scope.scopeId || m.projectId === siteProjectId)
      : markers.some((m) => m.projectId === scope.scopeId);
  }

  /** Per-row marker coverage for reinstatement eligibility — a row is
   *  unrestorable when a marker names its site, its site project's parent,
   *  or its own project. */
  private static rowBlockedByMarker(
    dept: LifecycleMembership['department'],
    markers: { siteId: string | null; projectId: string | null }[],
  ): boolean {
    if (dept === null) return true;
    return markers.some(
      (x) =>
        (dept.siteId !== null && x.siteId === dept.siteId) ||
        (x.projectId !== null &&
          (x.projectId === dept.projectId || x.projectId === dept.site?.projectId)),
    );
  }

  /** End-phase primary check — R = effective memberships OUTSIDE the ended
   *  set. |R|≤1 unambiguous; |R|≥2 needs a primary among R (never touched —
   *  it is out of scope by construction). Fail closed otherwise. */
  private async assertEndPhasePrimary(
    memberships: EmployeeRepos['memberships'],
    companyId: string,
    employeeId: string,
    endedIds: Set<string>,
    now: Date,
  ): Promise<void> {
    const remaining = (await memberships.effectiveAt(companyId, employeeId, now)).filter(
      (x) => !endedIds.has(x.id),
    );
    if (remaining.length > 1 && !remaining.some((x) => x.isPrimary)) {
      throw new AmbiguousPrimaryError();
    }
  }

  /** Clear headEmployeeId on affected departments the worker heads — atomic
   *  with the lifecycle write; unrelated department heads are untouched. */
  private async clearScopedHeads(
    repos: EmployeeRepos,
    actor: ActorContext,
    companyId: string,
    employeeId: string,
    affected: LifecycleMembership[],
    cleared: string[],
  ): Promise<void> {
    for (const m of affected) {
      if (m.department !== null && m.department.headEmployeeId === employeeId) {
        await repos.departments.clearHeadIf(companyId, m.departmentId, employeeId);
        cleared.push(m.departmentId);
        await repos.audit.record(
          auditEntry(actor, {
            action: 'DEPT_HEAD_CLEARED',
            entityType: 'DEPARTMENT',
            entityId: m.departmentId,
            companyId,
            changedFields: { headEmployeeId: { before: employeeId, after: null } },
          }),
        );
      }
    }
  }

  private async workforceNotify(
    repos: EmployeeRepos,
    companyId: string,
    employee: Employee,
    eventType: string,
    eventKey: string,
    scope: WorkforceScope,
    count: number,
  ): Promise<void> {
    if (employee.principalId === null) return;
    await repos.outbox.record({
      companyId,
      eventType,
      aggregateType: 'EMPLOYEE',
      aggregateId: employee.id,
      eventKey,
      recipientPrincipalIds: [employee.principalId],
      summary: {
        action: eventType,
        scopeType: scope.scopeType,
        scopeId: scope.scopeId,
        membershipCount: count,
      },
    });
  }

  /**
   * Suspend the worker's ACTIVE memberships in the resolved site/project
   * scope — temporary removal; rows get endReason=SUSPENDED, an optional
   * structured suspendUntil date, and a server-controlled endedAt.
   * Employee/Principal status is unchanged; other scopes are untouched.
   */
  async suspendWorkforce(
    actor: ActorContext,
    companyId: string,
    scope: WorkforceScope,
    employeeId: string,
    input: { reason: string; expectedReturnDate?: Date },
  ): Promise<WorkforceActionResult> {
    if (!UUID_RE.test(scope.scopeId)) throw new OrgEntityNotFoundError(scope.scopeType);
    if (!UUID_RE.test(employeeId)) throw new OrgEntityNotFoundError('EMPLOYEE');
    const now = new Date();
    return this.uow.run(async (repos) => {
      const { teamScope, employee } = await this.workforcePrologue(
        repos,
        actor,
        companyId,
        scope,
        employeeId,
        'memberSuspend',
      );
      const affected = await repos.memberships.activeInScope(companyId, employeeId, teamScope);
      if (affected.length === 0) {
        throw new ConflictError(
          'WORKFORCE_NOT_ACTIVE',
          'the employee has no active memberships in this scope',
        );
      }
      const ids = affected.map((m) => m.id);
      await this.assertEndPhasePrimary(repos.memberships, companyId, employeeId, new Set(ids), now);
      const res = await repos.memberships.endAll(companyId, ids, 'SUSPENDED', {
        endNote: input.reason,
        ...(input.expectedReturnDate !== undefined
          ? { suspendUntil: input.expectedReturnDate }
          : {}),
      });
      if (res.count !== ids.length) throw new VersionConflictError('DEPARTMENT_MEMBERSHIP');
      const headsCleared: string[] = [];
      await this.clearScopedHeads(repos, actor, companyId, employeeId, affected, headsCleared);
      for (const m of affected) {
        await repos.audit.record(
          auditEntry(actor, {
            action: 'MEMBERSHIP_SUSPENDED',
            entityType: 'DEPARTMENT_MEMBERSHIP',
            entityId: m.id,
            companyId,
            statusBefore: 'ACTIVE',
            statusAfter: 'SUSPENDED',
            changedFields: {
              departmentId: { before: null, after: m.departmentId },
              endReason: { before: null, after: 'SUSPENDED' },
              ...(input.expectedReturnDate !== undefined
                ? {
                    suspendUntil: {
                      before: null,
                      after: input.expectedReturnDate.toISOString().slice(0, 10),
                    },
                  }
                : {}),
              endNote: { before: null, after: input.reason },
            },
          }),
        );
      }
      await this.workforceNotify(
        repos,
        companyId,
        employee,
        'WORKFORCE_SUSPENDED',
        `evt:${ids[0]}:WORKFORCE_SUSPENDED`,
        scope,
        ids.length,
      );
      if (this.cache && employee.principalId !== null) {
        await this.cache.invalidate(employee.principalId);
      }
      return {
        employeeId,
        action: 'SUSPEND',
        scopeType: scope.scopeType,
        scopeId: scope.scopeId,
        ended: affected.map((m) => ({
          membershipId: m.id,
          departmentId: m.departmentId,
          wasPrimary: m.isPrimary,
        })),
        restored: [],
        headsCleared,
        suspendUntil: input.expectedReturnDate?.toISOString().slice(0, 10) ?? null,
        exitMarkerId: null,
      };
    });
  }

  /**
   * Permanently exit the worker from the resolved scope — ends ACTIVE
   * in-scope memberships with endReason=EXITED and appends a
   * SiteWorkforceExit marker. A worker already suspended keeps their
   * SUSPENDED rows untouched; the marker alone blocks reinstatement. A
   * covering marker with no active rows is a deliberate ALREADY_EXITED
   * conflict; a covering marker with re-placed active rows still ends them
   * (the marker already records the episode).
   */
  async exitWorkforce(
    actor: ActorContext,
    companyId: string,
    scope: WorkforceScope,
    employeeId: string,
    input: { reason: string },
  ): Promise<WorkforceActionResult> {
    if (!UUID_RE.test(scope.scopeId)) throw new OrgEntityNotFoundError(scope.scopeType);
    if (!UUID_RE.test(employeeId)) throw new OrgEntityNotFoundError('EMPLOYEE');
    const now = new Date();
    return this.uow.run(async (repos) => {
      const { teamScope, siteProjectId, employee } = await this.workforcePrologue(
        repos,
        actor,
        companyId,
        scope,
        employeeId,
        'memberExit',
      );
      const affected = await repos.memberships.activeInScope(companyId, employeeId, teamScope);
      const markers = await repos.siteWorkforceExits.listForEmployee(companyId, employeeId);
      const covered = EmployeeService.scopeCoveredByMarker(scope, siteProjectId, markers);
      if (affected.length === 0) {
        if (covered) throw new AlreadyExitedError();
        const suspended = await repos.memberships.suspendedInScope(
          companyId,
          employeeId,
          teamScope,
        );
        if (suspended.length === 0) throw new OrgEntityNotFoundError('SITE_WORKFORCE');
        // Suspended -> exit: preserve SUSPENDED rows; the marker blocks
        // their reinstatement. Fall through to marker creation only.
      } else {
        const ids = affected.map((m) => m.id);
        await this.assertEndPhasePrimary(
          repos.memberships,
          companyId,
          employeeId,
          new Set(ids),
          now,
        );
        const res = await repos.memberships.endAll(companyId, ids, 'EXITED', {
          endNote: input.reason,
        });
        if (res.count !== ids.length) throw new VersionConflictError('DEPARTMENT_MEMBERSHIP');
      }
      const headsCleared: string[] = [];
      await this.clearScopedHeads(repos, actor, companyId, employeeId, affected, headsCleared);
      let markerId: string | null = null;
      if (!covered) {
        try {
          const marker = await repos.siteWorkforceExits.create({
            companyId,
            employeeId,
            ...(scope.scopeType === 'SITE'
              ? { siteId: scope.scopeId }
              : { projectId: scope.scopeId }),
            exitedByPrincipalId: actor.actorId,
            note: input.reason,
          });
          markerId = marker.id;
        } catch (e) {
          // Partial-unique race → the episode was already exited.
          if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
            throw new AlreadyExitedError();
          }
          throw e;
        }
      }
      for (const m of affected) {
        await repos.audit.record(
          auditEntry(actor, {
            action: 'MEMBERSHIP_EXITED',
            entityType: 'DEPARTMENT_MEMBERSHIP',
            entityId: m.id,
            companyId,
            statusBefore: 'ACTIVE',
            statusAfter: 'EXITED',
            changedFields: {
              departmentId: { before: null, after: m.departmentId },
              endReason: { before: null, after: 'EXITED' },
              endNote: { before: null, after: input.reason },
            },
          }),
        );
      }
      const keyBasis = markerId ?? affected[0]?.id ?? employeeId;
      await this.workforceNotify(
        repos,
        companyId,
        employee,
        'WORKFORCE_EXITED',
        `evt:${keyBasis}:WORKFORCE_EXITED`,
        scope,
        affected.length,
      );
      if (this.cache && employee.principalId !== null) {
        await this.cache.invalidate(employee.principalId);
      }
      return {
        employeeId,
        action: 'EXIT',
        scopeType: scope.scopeType,
        scopeId: scope.scopeId,
        ended: affected.map((m) => ({
          membershipId: m.id,
          departmentId: m.departmentId,
          wasPrimary: m.isPrimary,
        })),
        restored: [],
        headsCleared,
        suspendUntil: null,
        exitMarkerId: markerId,
      };
    });
  }

  /**
   * Reinstate a suspended worker — NEVER reopens ended rows; creates new
   * membership rows linked back via supersededBy (composite FK enforces
   * same company + same employee). All-or-nothing: any unrestorable
   * department (inactive, exit-marked, scope-moved, dup-active) aborts the
   * whole restore inside the transaction.
   */
  async reinstateWorkforce(
    actor: ActorContext,
    companyId: string,
    scope: WorkforceScope,
    employeeId: string,
    input: { note?: string },
  ): Promise<WorkforceActionResult> {
    if (!UUID_RE.test(scope.scopeId)) throw new OrgEntityNotFoundError(scope.scopeType);
    if (!UUID_RE.test(employeeId)) throw new OrgEntityNotFoundError('EMPLOYEE');
    const now = new Date();
    return this.uow.run(async (repos) => {
      const { teamScope, employee } = await this.workforcePrologue(
        repos,
        actor,
        companyId,
        scope,
        employeeId,
        'memberSuspend',
      );
      if (employee.status !== 'ACTIVE') {
        throw new ConflictError('EMPLOYEE_NOT_ACTIVE', 'only ACTIVE employees can be reinstated');
      }
      const suspended = await repos.memberships.suspendedInScope(companyId, employeeId, teamScope);
      if (suspended.length === 0) {
        throw new ConflictError(
          'NOTHING_TO_REINSTATE',
          'no suspended memberships remain in this scope',
        );
      }
      const markers = await repos.siteWorkforceExits.listForEmployee(companyId, employeeId);
      const actives = await repos.memberships.activeForEmployee(companyId, employeeId);
      const activeDeptIds = new Set(actives.map((a) => a.departmentId));
      // All-or-nothing eligibility — validate EVERY row before any write.
      for (const m of suspended) {
        if (EmployeeService.rowBlockedByMarker(m.department, markers)) {
          throw new AlreadyExitedError();
        }
        if (m.department?.status !== 'ACTIVE') {
          throw new ConflictError(
            'DEPT_NOT_RESTORABLE',
            'a suspended department is no longer restorable',
          );
        }
        if (activeDeptIds.has(m.departmentId)) {
          throw new ActiveMembershipExistsError();
        }
      }
      // Predicted post-restore primary state — fail before any write.
      const hasCurrentPrimary = actives.some((a) => a.isPrimary);
      const predictedTotal = actives.length + suspended.length;
      if (predictedTotal > 1 && !hasCurrentPrimary && !suspended.some((s) => s.isPrimary)) {
        throw new AmbiguousPrimaryError();
      }
      const restored: WorkforceRestoredItem[] = [];
      for (const m of suspended) {
        let created;
        try {
          created = await repos.memberships.create({
            companyId,
            employeeId,
            departmentId: m.departmentId,
            isPrimary: !hasCurrentPrimary && m.isPrimary,
            startedAt: now,
          });
        } catch (e) {
          mapMembershipRace(e);
        }
        const sup = (await repos.memberships.markSuperseded(
          companyId,
          employeeId,
          m.id,
          created.id,
        )) as { count: number };
        if (sup.count === 0) throw new VersionConflictError('DEPARTMENT_MEMBERSHIP');
        restored.push({
          membershipId: created.id,
          departmentId: m.departmentId,
          isPrimary: created.isPrimary,
        });
        await repos.audit.record(
          auditEntry(actor, {
            action: 'MEMBERSHIP_REINSTATED',
            entityType: 'DEPARTMENT_MEMBERSHIP',
            entityId: created.id,
            companyId,
            statusBefore: 'SUSPENDED',
            statusAfter: 'ACTIVE',
            changedFields: {
              departmentId: { before: null, after: m.departmentId },
              supersedesMembershipId: { before: null, after: m.id },
              isPrimary: { before: m.isPrimary, after: created.isPrimary },
              ...(input.note !== undefined ? { note: { before: null, after: input.note } } : {}),
            },
          }),
        );
      }
      await this.workforceNotify(
        repos,
        companyId,
        employee,
        'WORKFORCE_REINSTATED',
        `evt:${restored[0]?.membershipId ?? employeeId}:WORKFORCE_REINSTATED`,
        scope,
        restored.length,
      );
      if (this.cache && employee.principalId !== null) {
        await this.cache.invalidate(employee.principalId);
      }
      return {
        employeeId,
        action: 'REINSTATE',
        scopeType: scope.scopeType,
        scopeId: scope.scopeId,
        ended: [],
        restored,
        headsCleared: [],
        suspendUntil: null,
        exitMarkerId: null,
      };
    });
  }

  /**
   * Scoped member detail — the ONLY scoped read-back path for contact and
   * emergency-contact fields. Company-wide EMPLOYEE_MANAGE /
   * EMPLOYEE_CONTACT_READ holders keep their existing access; scoped
   * callers need EMPLOYEE_CONTACT_READ at the department's own scope —
   * DEPARTMENT_READ is deliberately insufficient because broad templates
   * (EMPLOYEE@COMPANY, SITE_ENGINEER@SITE) would expose contact data
   * company-wide. The record must belong to that exact department.
   * Team/roster lists never carry these fields.
   */
  async getScopedMember(
    actor: ActorContext,
    companyId: string,
    departmentId: string,
    membershipId: string,
  ): Promise<ScopedMemberDetail> {
    if (!UUID_RE.test(departmentId) || !UUID_RE.test(membershipId)) {
      throw new OrgEntityNotFoundError('DEPARTMENT');
    }
    return this.uow.run(async ({ departments, memberships }) => {
      const dept = await departments.findById(companyId, departmentId);
      if (dept === null) throw new OrgEntityNotFoundError('DEPARTMENT');
      const companyWide =
        (await this.authorizer.hasPermission?.(
          actor.actorId,
          EMPLOYEE_MANAGE,
          companyTarget(companyId),
        )) === true ||
        (await this.authorizer.hasPermission?.(
          actor.actorId,
          EMPLOYEE_CONTACT_READ,
          companyTarget(companyId),
        )) === true;
      if (!companyWide) {
        await this.authorizer.assertPermission(
          actor.actorId,
          EMPLOYEE_CONTACT_READ,
          deptScopeTarget(dept),
        );
      }
      const m = await memberships.findInDepartment(companyId, departmentId, membershipId);
      if (m === null) throw new OrgEntityNotFoundError('DEPARTMENT_MEMBERSHIP');
      const item = memberItem(m);
      return {
        ...item,
        employee:
          m.employee === null || m.employee === undefined
            ? null
            : {
                id: m.employee.id,
                employeeCode: m.employee.employeeCode,
                displayName: m.employee.displayName,
                engagementType: m.employee.engagementType,
                designation: m.employee.designation,
                tradeCategory: m.employee.tradeCategory,
                joiningDate: m.employee.joiningDate,
                contactPhone: m.employee.contactPhone,
                contactEmail: m.employee.contactEmail,
                emergencyContactName: m.employee.emergencyContactName,
                emergencyContactPhone: m.employee.emergencyContactPhone,
                status: m.employee.status,
              },
      };
    });
  }

  // -------------------------------------------------------- Scoped onboarding
  // Delegated workforce onboarding — creates a principal-less employee
  // profile and its initial ACTIVE primary membership in one transaction.
  // Scoped holders require the "employeeOnboard" switch; company-wide
  // EMPLOYEE_MANAGE / EMPLOYEE_ONBOARD holders keep their existing access.
  // Never creates a Principal, login, invitation, role, permission, or
  // operation — those require separate, separately authorized flows.

  async onboardScopedMember(
    actor: ActorContext,
    companyId: string,
    departmentId: string,
    input: OnboardScopedMemberInput,
  ): Promise<OnboardedMember> {
    const employeeCode = normalizeCode(input.employeeCode);
    const displayName = normalizeName(input.displayName);
    if (!ENGAGEMENT_TYPES.has(input.engagementType)) {
      throw new OrgValidationError('engagementType', 'unsupported engagement type');
    }
    // Emergency contact is a pair — both or neither.
    if (
      (input.emergencyContactName === undefined) !==
      (input.emergencyContactPhone === undefined)
    ) {
      throw new OrgValidationError(
        'emergencyContact',
        'emergency contact name and phone must be provided together',
      );
    }
    let joiningDate: Date | undefined;
    if (input.joiningDate !== undefined) {
      joiningDate = input.joiningDate;
      if (Number.isNaN(joiningDate.getTime())) {
        throw new OrgValidationError('joiningDate', 'must be a valid date');
      }
    }
    if (!UUID_RE.test(departmentId)) throw new OrgEntityNotFoundError('DEPARTMENT');
    const docs = input.documents ?? [];
    const seenDocIds = new Set<string>();
    for (const d of docs) {
      if (!UUID_RE.test(d.documentId)) {
        throw new OrgValidationError('documents', 'documentId must be a uuid');
      }
      if (seenDocIds.has(d.documentId)) {
        throw new OrgValidationError('documents', 'duplicate documentId');
      }
      seenDocIds.add(d.documentId);
      if (d.title.trim().length === 0) {
        throw new OrgValidationError('documents', 'document title is required');
      }
    }
    return this.uow.run(
      async ({ departments, memberships, employees, documents, employeeDocuments, audit }) => {
        const dept = await EmployeeService.loadDept(departments, companyId, departmentId);
        await this.assertScopedMutation(
          actor,
          companyId,
          dept,
          EMPLOYEE_ONBOARD,
          'employeeOnboard',
        );
        if (dept.status !== 'ACTIVE') {
          throw new OrgValidationError('departmentId', 'department must be active');
        }
        const available = new Set(
          await documents.availableIds(
            companyId,
            docs.map((d) => d.documentId),
          ),
        );
        if (docs.some((d) => !available.has(d.documentId))) {
          throw new OrgValidationError('documents', 'not an available company document');
        }
        // principalId is never set — the profile is workforce-only. P2002 on
        // the (companyId, employeeCode) index maps to DUPLICATE_CODE (409).
        const employee = await employees.create(companyId, {
          employeeCode,
          displayName,
          engagementType: input.engagementType,
          ...(input.designation !== undefined ? { designation: input.designation } : {}),
          ...(input.tradeCategory !== undefined ? { tradeCategory: input.tradeCategory } : {}),
          ...(joiningDate !== undefined ? { joiningDate } : {}),
          ...(input.contactPhone !== undefined ? { contactPhone: input.contactPhone } : {}),
          ...(input.contactEmail !== undefined ? { contactEmail: input.contactEmail } : {}),
          ...(input.emergencyContactName !== undefined
            ? { emergencyContactName: input.emergencyContactName }
            : {}),
          ...(input.emergencyContactPhone !== undefined
            ? { emergencyContactPhone: input.emergencyContactPhone }
            : {}),
        });
        // First membership — always primary and effective now so leave/policy
        // resolution is unambiguous from the start. joiningDate is a profile
        // fact only; it never backdates membership or access.
        let membership;
        try {
          membership = await memberships.create({
            companyId,
            employeeId: employee.id,
            departmentId,
            isPrimary: true,
          });
        } catch (e) {
          mapMembershipRace(e);
        }
        if (docs.length > 0) {
          await employeeDocuments.createMany(
            docs.map((d) => ({
              companyId,
              employeeId: employee.id,
              documentId: d.documentId,
              documentType: d.documentType,
              title: d.title.trim(),
              documentNumber: d.documentNumber?.trim() ?? null,
              issuingAuthority: d.issuingAuthority?.trim() ?? null,
              issueDate: d.issueDate ?? null,
              expiryDate: d.expiryDate ?? null,
            })),
          );
        }
        // One coherent onboarding event on the membership entity — the feed
        // scope-resolves it through the department. The employee profile is
        // never created without this placement in the same transaction.
        await audit.record(
          auditEntry(actor, {
            action: 'EMPLOYEE_ONBOARDED',
            entityType: 'DEPARTMENT_MEMBERSHIP',
            entityId: membership.id,
            companyId,
            statusAfter: 'ACTIVE',
            changedFields: {
              employeeId: { before: null, after: employee.id },
              departmentId: { before: null, after: departmentId },
              isPrimary: { before: null, after: true },
              employeeCode: { before: null, after: employeeCode },
              ...(docs.length > 0 ? { documentsLinked: { before: null, after: docs.length } } : {}),
            },
          }),
        );
        return {
          employee: {
            id: employee.id,
            employeeCode: employee.employeeCode,
            displayName: employee.displayName,
            engagementType: employee.engagementType,
            designation: employee.designation,
            tradeCategory: employee.tradeCategory,
            joiningDate: employee.joiningDate,
            contactPhone: employee.contactPhone,
            contactEmail: employee.contactEmail,
            emergencyContactName: employee.emergencyContactName,
            emergencyContactPhone: employee.emergencyContactPhone,
            status: employee.status,
            principalId: employee.principalId,
          },
          membership: memberItem(membership),
          documentsLinked: docs.length,
        };
      },
    );
  }

  // ------------------------------------------------------------ Memberships
  // Placement only — membership never satisfies any permission check.

  async listMemberships(
    companyId: string,
    employeeId: string,
  ): Promise<DepartmentMembershipWithDepartment[]> {
    return this.uow.run(({ employees, memberships }) =>
      employees.findById(companyId, employeeId).then(async (employee) => {
        if (!employee) throw new OrgEntityNotFoundError('EMPLOYEE');
        return memberships.list(companyId, employeeId);
      }),
    );
  }

  async addMembership(
    actor: ActorContext,
    companyId: string,
    employeeId: string,
    input: { departmentId: string; isPrimary?: boolean; startedAt?: Date },
  ): Promise<DepartmentMembershipWithDepartment> {
    await this.authorizer.assertPermission(
      actor.actorId,
      EMPLOYEE_MANAGE,
      companyTarget(companyId),
    );
    return this.uow.run(async ({ employees, departments, memberships, audit }) => {
      const employee = await employees.findById(companyId, employeeId);
      if (!employee) throw new OrgEntityNotFoundError('EMPLOYEE');
      if (employee.status !== 'ACTIVE') {
        throw new OrgValidationError('employeeId', 'employee must be active');
      }
      const dept = await departments.findById(companyId, input.departmentId);
      if (!dept) throw new OrgEntityNotFoundError('DEPARTMENT');
      if (dept.status !== 'ACTIVE') {
        throw new OrgValidationError('departmentId', 'department must be active');
      }
      if (input.isPrimary === true) {
        await memberships.demoteOthers(
          companyId,
          employeeId,
          '00000000-0000-0000-0000-000000000000',
        );
      }
      const membership = await memberships.create({
        companyId,
        employeeId,
        departmentId: input.departmentId,
        isPrimary: input.isPrimary ?? false,
        ...(input.startedAt !== undefined ? { startedAt: input.startedAt } : {}),
      });
      await audit.record(
        auditEntry(actor, {
          action: 'MEMBERSHIP_CREATED',
          entityType: 'DEPARTMENT_MEMBERSHIP',
          entityId: membership.id,
          companyId,
          statusAfter: 'ACTIVE',
          changedFields: {
            departmentId: { before: null, after: input.departmentId },
            isPrimary: { before: null, after: membership.isPrimary },
          },
        }),
      );
      if (this.cache && employee.principalId) {
        await this.cache.invalidate(employee.principalId);
      }
      return membership;
    });
  }

  async updateMembership(
    actor: ActorContext,
    companyId: string,
    employeeId: string,
    membershipId: string,
    input: { isPrimary: boolean },
    expectedVersion: number,
  ): Promise<DepartmentMembershipWithDepartment | null> {
    await this.authorizer.assertPermission(
      actor.actorId,
      EMPLOYEE_MANAGE,
      companyTarget(companyId),
    );
    return this.uow.run(async ({ employees, memberships, audit }) => {
      const existing = await memberships.findById(companyId, employeeId, membershipId);
      if (!existing) throw new OrgEntityNotFoundError('DEPARTMENT_MEMBERSHIP');
      if (existing.endedAt !== null) {
        throw new OrgValidationError('membership', 'cannot change an ended membership');
      }
      if (input.isPrimary) {
        await memberships.demoteOthers(companyId, employeeId, membershipId);
      }
      const result = await memberships.setPrimary(
        companyId,
        employeeId,
        membershipId,
        expectedVersion,
      );
      if ((result as { count: number }).count === 0) {
        throw new OrgValidationError('expectedVersion', 'stale version');
      }
      const updated = await memberships.findById(companyId, employeeId, membershipId);
      await audit.record(
        auditEntry(actor, {
          action: 'MEMBERSHIP_PRIMARY_SET',
          entityType: 'DEPARTMENT_MEMBERSHIP',
          entityId: membershipId,
          companyId,
          changedFields: { isPrimary: { before: existing.isPrimary, after: true } },
        }),
      );
      if (this.cache) {
        const emp = await employees.findById(companyId, employeeId);
        if (emp?.principalId) await this.cache.invalidate(emp.principalId);
      }
      return updated;
    });
  }

  async endMembership(
    actor: ActorContext,
    companyId: string,
    employeeId: string,
    membershipId: string,
    expectedVersion: number,
  ): Promise<DepartmentMembershipWithDepartment | null> {
    await this.authorizer.assertPermission(
      actor.actorId,
      EMPLOYEE_MANAGE,
      companyTarget(companyId),
    );
    return this.uow.run(async ({ employees, memberships, audit }) => {
      const existing = await memberships.findById(companyId, employeeId, membershipId);
      if (!existing) throw new OrgEntityNotFoundError('DEPARTMENT_MEMBERSHIP');
      if (existing.endedAt !== null) {
        throw new OrgValidationError('membership', 'membership already ended');
      }
      const result = await memberships.end(companyId, employeeId, membershipId, expectedVersion);
      if ((result as { count: number }).count === 0) {
        throw new OrgValidationError('expectedVersion', 'stale version');
      }
      await audit.record(
        auditEntry(actor, {
          action: 'MEMBERSHIP_ENDED',
          entityType: 'DEPARTMENT_MEMBERSHIP',
          entityId: membershipId,
          companyId,
          statusBefore: 'ACTIVE',
          statusAfter: 'ENDED',
          changedFields: { endedAt: { before: null, after: 'ended by admin' } },
        }),
      );
      // Finance-role cascade: if this ended the employee's last effective
      // membership in an ACTIVE FINANCE department, their FINANCE_* role
      // assignments stop applying immediately — same transaction, audited.
      // Other role assignments are untouched.
      const emp = await employees.findById(companyId, employeeId);
      if (emp?.principalId) {
        const remainingFinance = await memberships.activeFinanceCount(
          companyId,
          employeeId,
          new Date(),
        );
        if (remainingFinance === 0) {
          const revoked = await employees.revokeFinanceRoleAssignments(
            companyId,
            emp.principalId,
            new Date(),
          );
          for (const assignmentId of revoked) {
            await audit.record(
              auditEntry(actor, {
                action: 'ACCESS_ROLE_REVOKED',
                entityType: 'ROLE_ASSIGNMENT',
                entityId: assignmentId,
                companyId,
                statusBefore: 'ACTIVE',
                statusAfter: 'REVOKED',
                changedFields: {
                  revokedAt: { before: null, after: 'finance membership ended' },
                },
              }),
            );
          }
        }
      }
      if (this.cache && emp?.principalId) {
        await this.cache.invalidate(emp.principalId);
      }
      return memberships.findById(companyId, employeeId, membershipId);
    });
  }
}
