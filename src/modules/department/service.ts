import { randomUUID } from 'node:crypto';
import type { Department, DepartmentStatus } from '@prisma/client';
import type { ActorContext, AuditRecord } from '../organization/types.js';
import { OrgEntityNotFoundError, OrgValidationError } from '../organization/errors.js';
import { normalizeCode, normalizeName } from '../organization/validation.js';
import { assertTransition } from '../organization/lifecycle.js';
import { DEPARTMENT_TRANSITIONS } from './lifecycle.js';
import type { DepartmentRepos, DepartmentUnitOfWork } from './repository.js';
import type { CreateDepartmentInput, UpdateDepartmentInput } from './types.js';
import type { ScopeTarget } from '../access-control/service.js';

// Authorization boundary: services check permissions, not just routes.
// Satisfied by AccessControlService in production; faked in unit tests.
export interface Authorizer {
  assertPermission(principalId: string, permissionKey: string, target: ScopeTarget): Promise<void>;
}

export const DEPT_CONFIGURE = 'DEPARTMENT_CONFIGURE';
export const DEPT_READ = 'DEPARTMENT_READ';

function assertDeptTransition(from: string, to: string): void {
  assertTransition('DEPARTMENT', DEPARTMENT_TRANSITIONS, from, to);
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

export class DepartmentService {
  constructor(
    private readonly uow: DepartmentUnitOfWork,
    private readonly authorizer: Authorizer,
  ) {}

  async createDepartment(
    actor: ActorContext,
    companyId: string,
    input: CreateDepartmentInput,
  ): Promise<Department> {
    const code = normalizeCode(input.code);
    const name = normalizeName(input.name);
    const scope = this.resolveScope(input); // validates scopeType + scopeId pairing

    // Permission checked against the scope the department will live at.
    await this.authorizer.assertPermission(actor.actorId, DEPT_CONFIGURE, {
      companyId,
      scopeType: input.scopeType,
      scopeId: scope.scopeId ?? companyId,
    });

    return this.uow.run(async ({ departments, projects, sites, employees, headOffices, audit }) => {
      // Parent scope validation inside the requested company.
      if (scope.projectId !== undefined) {
        if (!(await projects.findById(companyId, scope.projectId))) {
          throw new OrgEntityNotFoundError('PROJECT');
        }
      }
      if (scope.siteId !== undefined) {
        if (!(await sites.findById(companyId, scope.siteId))) {
          throw new OrgEntityNotFoundError('SITE');
        }
      }
      if (input.headEmployeeId !== undefined) {
        const head = await employees.findById(companyId, input.headEmployeeId);
        if (!head) throw new OrgEntityNotFoundError('EMPLOYEE');
        if (head.status !== 'ACTIVE') {
          throw new OrgValidationError('headEmployeeId', 'must be an active employee');
        }
      }
      if (input.baseHeadOfficeId !== undefined) {
        if (!(await headOffices.findById(companyId, input.baseHeadOfficeId))) {
          throw new OrgEntityNotFoundError('HEAD_OFFICE');
        }
      }
      const category = input.category ?? 'CUSTOM';
      if (input.category === 'CUSTOM' && (input.categoryLabel ?? '').trim() === '') {
        throw new OrgValidationError('categoryLabel', 'required when category is CUSTOM');
      }
      const department = await departments.create(companyId, {
        scopeType: input.scopeType,
        code,
        name,
        category,
        ...(input.categoryLabel !== undefined ? { categoryLabel: input.categoryLabel.trim() } : {}),
        ...(scope.projectId !== undefined ? { projectId: scope.projectId } : {}),
        ...(scope.siteId !== undefined ? { siteId: scope.siteId } : {}),
        // capabilityKey is INTERNAL: derived from the controlled category,
        // never a user-entered free-text field anymore.
        capabilityKey: input.capabilityKey?.trim() ?? `DEPT_${input.category}`,
        ...(input.headEmployeeId !== undefined ? { headEmployeeId: input.headEmployeeId } : {}),
        ...(input.baseHeadOfficeId !== undefined
          ? { baseHeadOfficeId: input.baseHeadOfficeId }
          : {}),
      });
      await audit.record(
        auditEntry(actor, {
          action: 'DEPT_DEPARTMENT_CREATED',
          entityType: 'DEPARTMENT',
          entityId: department.id,
          companyId,
          statusAfter: department.status,
          changedFields: {
            code: { before: null, after: code },
            name: { before: null, after: name },
            scopeType: { before: null, after: input.scopeType },
          },
        }),
      );
      return department;
    });
  }

  async updateDepartment(
    actor: ActorContext,
    companyId: string,
    id: string,
    patch: UpdateDepartmentInput,
    expectedVersion?: number,
  ): Promise<Department> {
    const data: Record<string, unknown> = {};
    if (patch.name !== undefined) data.name = normalizeName(patch.name);
    if (patch.capabilityKey !== undefined) {
      const trimmed = patch.capabilityKey?.trim();
      data.capabilityKey = trimmed !== undefined && trimmed !== '' ? trimmed : null;
    }
    if (patch.headEmployeeId !== undefined) data.headEmployeeId = patch.headEmployeeId;
    if (patch.baseHeadOfficeId !== undefined) data.baseHeadOfficeId = patch.baseHeadOfficeId;

    return this.uow.run(async (repos) => {
      const existing = await repos.departments.findById(companyId, id);
      if (!existing) throw new OrgEntityNotFoundError('DEPARTMENT');
      await this.authorizeForDepartment(actor, DEPT_CONFIGURE, existing);
      if (Object.keys(data).length === 0) return existing; // no-op: no write/audit
      if (typeof data.headEmployeeId === 'string') {
        const head = await repos.employees.findById(companyId, data.headEmployeeId);
        if (!head) throw new OrgEntityNotFoundError('EMPLOYEE');
        if (head.status !== 'ACTIVE') {
          throw new OrgValidationError('headEmployeeId', 'must be an active employee');
        }
      }
      if (typeof data.baseHeadOfficeId === 'string') {
        if (!(await repos.headOffices.findById(companyId, data.baseHeadOfficeId))) {
          throw new OrgEntityNotFoundError('HEAD_OFFICE');
        }
      }
      const updated = await repos.departments.update(companyId, id, data, expectedVersion);
      await this.recordMutation(repos, actor, 'DEPT_DEPARTMENT_UPDATED', existing, updated, data);
      return updated;
    });
  }

  async transitionDepartmentStatus(
    actor: ActorContext,
    companyId: string,
    id: string,
    to: string,
    expectedVersion?: number,
  ): Promise<Department> {
    return this.uow.run(async (repos) => {
      const existing = await repos.departments.findById(companyId, id);
      if (!existing) throw new OrgEntityNotFoundError('DEPARTMENT');
      await this.authorizeForDepartment(actor, DEPT_CONFIGURE, existing);
      assertDeptTransition(existing.status, to);
      const updated = await repos.departments.update(
        companyId,
        id,
        { status: to },
        expectedVersion,
      );
      await this.recordMutation(repos, actor, 'DEPT_DEPARTMENT_STATUS_CHANGED', existing, updated, {
        status: to,
      });
      return updated;
    });
  }

  async listDepartments(
    actor: ActorContext,
    companyId: string,
    filter?: { status?: DepartmentStatus; projectId?: string; siteId?: string },
  ) {
    await this.authorizer.assertPermission(actor.actorId, DEPT_READ, {
      companyId,
      scopeType: 'COMPANY',
      scopeId: companyId,
    });
    return this.uow.run(({ departments }) => departments.list(companyId, filter));
  }

  // ----------------------------------------------------------------- internal

  // A department's own columns ARE its scope target — no extra lookup needed.
  private scopeTargetOf(dept: Department): ScopeTarget {
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

  private authorizeForDepartment(
    actor: ActorContext,
    permission: string,
    dept: Department,
  ): Promise<void> {
    return this.authorizer.assertPermission(actor.actorId, permission, this.scopeTargetOf(dept));
  }

  private resolveScope(input: CreateDepartmentInput): {
    projectId?: string;
    siteId?: string;
    scopeId?: string;
  } {
    switch (input.scopeType) {
      case 'COMPANY':
        if (input.scopeId !== undefined) {
          throw new OrgValidationError('scopeId', 'must be omitted for COMPANY scope');
        }
        return {};
      case 'PROJECT':
        if (input.scopeId === undefined) {
          throw new OrgValidationError('scopeId', 'project id is required for PROJECT scope');
        }
        return { projectId: input.scopeId, scopeId: input.scopeId };
      case 'SITE':
        if (input.scopeId === undefined) {
          throw new OrgValidationError('scopeId', 'site id is required for SITE scope');
        }
        return { siteId: input.scopeId, scopeId: input.scopeId };
      default:
        // HEAD_OFFICE and any unknown scope are rejected.
        throw new OrgValidationError('scopeType', 'must be COMPANY, PROJECT, or SITE');
    }
  }

  private async recordMutation(
    repos: DepartmentRepos,
    actor: ActorContext,
    action: string,
    before: Department,
    after: Department,
    patch: Record<string, unknown>,
  ): Promise<void> {
    const changedFields: Record<string, { before: unknown; after: unknown }> = {};
    for (const [key, afterValue] of Object.entries(patch)) {
      const beforeValue = (before as unknown as Record<string, unknown>)[key];
      if (beforeValue !== afterValue)
        changedFields[key] = { before: beforeValue ?? null, after: afterValue };
    }
    await repos.audit.record(
      auditEntry(actor, {
        action,
        entityType: 'DEPARTMENT',
        entityId: after.id,
        companyId: after.companyId,
        statusBefore: before.status,
        statusAfter: after.status,
        ...(Object.keys(changedFields).length > 0 ? { changedFields } : {}),
      }),
    );
  }
}
