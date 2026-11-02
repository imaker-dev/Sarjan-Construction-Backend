import { randomUUID } from 'node:crypto';
import type { ActorContext, AuditRecord } from '../organization/types.js';
import type { Employee } from '@prisma/client';
import { OrgEntityNotFoundError, OrgValidationError } from '../organization/errors.js';
import type { EmployeeUnitOfWork } from './repository.js';
import type { ScopeTarget } from '../access-control/service.js';

export const EMPLOYEE_READ = 'EMPLOYEE_READ';
export const EMPLOYEE_MANAGE = 'EMPLOYEE_MANAGE';

// Keys that mark a holder as a company administrator — fail closed: revoke of
// the last active holder of ANY of these is blocked.
const ADMIN_GUARD_KEYS = ['ORG_COMPANY_UPDATE', 'EMPLOYEE_MANAGE', 'ACCESS_ROLE_ASSIGN'];

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

const MAX_LIMIT = 100;

export class EmployeeService {
  constructor(
    private readonly uow: EmployeeUnitOfWork,
    private readonly authorizer: Authorizer,
  ) {}

  async list(
    actor: ActorContext,
    companyId: string,
    filter?: { status?: string; cursor?: string; limit?: number },
  ): Promise<{ employees: Employee[]; nextCursor: string | null }> {
    await this.authorizer.assertPermission(actor.actorId, EMPLOYEE_READ, companyTarget(companyId));
    const limit = Math.min(filter?.limit ?? 50, MAX_LIMIT);
    const cursor = filter?.cursor !== undefined ? decodeEmpCursor(filter.cursor) : null;
    const rows = await this.uow.run(({ employees }) =>
      employees.list(companyId, {
        ...(filter?.status !== undefined ? { status: filter.status } : {}),
        ...(cursor !== null ? { cursor } : {}),
        limit: limit + 1,
      }),
    );
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      employees: page,
      nextCursor: rows.length > limit && last !== undefined ? encodeEmpCursor(last) : null,
    };
  }

  async create(
    actor: ActorContext,
    companyId: string,
    input: { employeeCode: string; displayName: string },
  ): Promise<Employee> {
    await this.authorizer.assertPermission(
      actor.actorId,
      EMPLOYEE_MANAGE,
      companyTarget(companyId),
    );
    const employeeCode = normalizeCode(input.employeeCode);
    const displayName = normalizeName(input.displayName);
    return this.uow.run(async ({ employees, audit }) => {
      const employee = await employees.create(companyId, { employeeCode, displayName });
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
    patch: { displayName?: string },
    expectedVersion?: number,
  ): Promise<Employee> {
    const data: Record<string, unknown> = {};
    if (patch.displayName !== undefined) data.displayName = normalizeName(patch.displayName);
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
      return updated;
    });
  }
}
