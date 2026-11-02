import { randomUUID } from 'node:crypto';
import { passwordService } from '../identity/password.js';
import { PERMISSIONS } from '../access-control/catalogue.js';
import { AppError } from '../../common/errors/app-error.js';
import type { ActorContext } from '../organization/types.js';

/**
 * One-time operator bootstrap: first Company + primary Head Office +
 * Finance/Admin departments + first owner identity — inside a single tx,
 * audited as an explicit SYSTEM principal. Never a route, never a fake actor.
 * The credential arrives via env only and is never logged or audited.
 */

// Principal_credentials_check forbids loginId on non-USER principals —
// the SYSTEM actor is identified by a sentinel id instead.
export const SYSTEM_PRINCIPAL_ID = '00000000-0000-4000-8000-000000000001';
export const SYSTEM_LOGIN_ID = SYSTEM_PRINCIPAL_ID; // kept for older lookups
export const OWNER_ROLE_KEY = 'COMPANY_OWNER';

// Least-privilege: organization + department setup keys only — no workflow,
// document, finance, or payment permissions.
const OWNER_PERMISSIONS = PERMISSIONS.filter(
  (k) => k.startsWith('ORG_') || k.startsWith('DEPARTMENT_') || k.startsWith('EMPLOYEE_'),
);

export interface BootstrapInput {
  companyCode: string;
  companyName: string;
  ownerLoginId: string;
  ownerPassword: string;
}

/** Narrow tx surface — satisfied by a Prisma transaction and by test fakes. */
export interface BootstrapTx {
  company: {
    findFirst(args?: unknown): Promise<{ id: string; code: string } | null>;
    create(args: { data: Record<string, unknown> }): Promise<{ id: string }>;
  };
  headOffice: { create(args: { data: Record<string, unknown> }): Promise<{ id: string }> };
  department: { create(args: { data: Record<string, unknown> }): Promise<{ id: string }> };
  principal: {
    findFirst(args: { where: Record<string, unknown> }): Promise<{ id: string } | null>;
    create(args: { data: Record<string, unknown> }): Promise<{ id: string }>;
  };
  employee: { create(args: { data: Record<string, unknown> }): Promise<{ id: string }> };
  role: { create(args: { data: Record<string, unknown> }): Promise<{ id: string }> };
  permission: {
    upsert(args: {
      where: { key: string };
      update: Record<string, unknown>;
      create: { key: string };
    }): Promise<{ id: string }>;
  };
  rolePermission: { create(args: { data: Record<string, unknown> }): Promise<unknown> };
  roleAssignment: { create(args: { data: Record<string, unknown> }): Promise<unknown> };
  auditLog: { create(args: { data: Record<string, unknown> }): Promise<unknown> };
}

export interface BootstrapResult {
  status: 'CREATED' | 'ALREADY_COMPLETE';
  companyId: string;
}

export async function bootstrapOrganization(
  tx: BootstrapTx,
  input: BootstrapInput,
): Promise<BootstrapResult> {
  const existing = await tx.company.findFirst();
  if (existing !== null) {
    if (existing.code === input.companyCode)
      return { status: 'ALREADY_COMPLETE', companyId: existing.id };
    throw new AppError(
      409,
      'BOOTSTRAP_REFUSED',
      'a company already exists; bootstrap is a one-time operation',
    );
  }

  // Explicit SYSTEM audit actor — a real Principal row, not an invented user.
  const system =
    (await tx.principal.findFirst({ where: { id: SYSTEM_PRINCIPAL_ID } })) ??
    (await tx.principal.create({
      data: { id: SYSTEM_PRINCIPAL_ID, type: 'SYSTEM', status: 'ACTIVE' },
    }));
  const actor: ActorContext = { actorId: system.id, actorType: 'SYSTEM' };

  const company = await tx.company.create({
    data: { code: input.companyCode, name: input.companyName },
  });
  const headOffice = await tx.headOffice.create({
    data: { companyId: company.id, code: 'HO', name: 'Head Office', isPrimary: true },
  });
  for (const [code, name] of [
    ['FINANCE', 'Finance'],
    ['ADMIN', 'Administration'],
  ] as const) {
    await tx.department.create({
      data: {
        companyId: company.id,
        scopeType: 'COMPANY',
        code,
        name,
        status: 'ACTIVE',
        baseHeadOfficeId: headOffice.id,
      },
    });
  }

  const passwordHash = await passwordService.hash(input.ownerPassword);
  const owner = await tx.principal.create({
    data: {
      loginId: input.ownerLoginId.toLowerCase().trim(),
      loginIdType: 'EMAIL',
      type: 'USER',
      status: 'ACTIVE',
      passwordHash,
    },
  });
  await tx.employee.create({
    data: {
      companyId: company.id,
      principalId: owner.id,
      employeeCode: 'OWN-001',
      displayName: input.companyName + ' Owner',
    },
  });
  const role = await tx.role.create({
    data: {
      companyId: company.id,
      key: OWNER_ROLE_KEY,
      name: 'Company Owner',
      isSystem: true,
      description: 'Initial owner — organization and department setup only',
    },
  });
  for (const key of OWNER_PERMISSIONS) {
    const permission = await tx.permission.upsert({
      where: { key },
      update: {},
      create: { key },
    });
    await tx.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } });
  }
  await tx.roleAssignment.create({
    data: {
      principalId: owner.id,
      roleId: role.id,
      companyId: company.id,
      scopeType: 'COMPANY',
      grantedByPrincipalId: system.id,
    },
  });
  await tx.auditLog.create({
    data: {
      eventKey: randomUUID(),
      actorId: actor.actorId,
      actorType: actor.actorType,
      action: 'SYSTEM_BOOTSTRAP_COMPLETED',
      entityType: 'COMPANY',
      entityId: company.id,
      companyId: company.id,
      statusAfter: 'ACTIVE',
      changedFields: {
        companyCode: { before: null, after: input.companyCode },
        headOffice: { before: null, after: 'HO (primary)' },
        departments: { before: null, after: 'FINANCE, ADMIN' },
        ownerRole: { before: null, after: OWNER_ROLE_KEY },
      },
    },
  });
  return { status: 'CREATED', companyId: company.id };
}
