import { randomUUID } from 'node:crypto';
import { passwordService } from '../identity/password.js';
import type { ActorContext } from '../organization/types.js';

/**
 * One-time operator bootstrap: initialize the PLATFORM — sentinel platform
 * company (isPlatform=true, at most one per DB) + PLATFORM_ADMIN role +
 * first Platform Admin principal. Customer companies are created later via
 * the protected platform API — bootstrap never creates them and never
 * touches existing ones. Idempotent; credential arrives via env only.
 */

// Principal_credentials_check forbids loginId on non-USER principals —
// the SYSTEM actor is identified by a sentinel id instead.
export const SYSTEM_PRINCIPAL_ID = '00000000-0000-4000-8000-000000000001';
export const PLATFORM_COMPANY_CODE = 'PLATFORM';
export const PLATFORM_ADMIN_ROLE_KEY = 'PLATFORM_ADMIN';
export const OWNER_ROLE_KEY = 'COMPANY_OWNER';

// Explicit allowlist — new catalogue keys are NEVER silently granted to
// tenant owners; additions require a deliberate edit here.
export const TENANT_OWNER_PERMISSIONS: readonly string[] = [
  'ORG_COMPANY_READ',
  'ORG_COMPANY_UPDATE',
  'ORG_COMPANY_STATUS',
  'ORG_HEAD_OFFICE_CREATE',
  'ORG_HEAD_OFFICE_READ',
  'ORG_HEAD_OFFICE_UPDATE',
  'ORG_HEAD_OFFICE_STATUS',
  'ORG_PROJECT_CREATE',
  'ORG_PROJECT_READ',
  'ORG_PROJECT_UPDATE',
  'ORG_PROJECT_STATUS',
  'ORG_SITE_CREATE',
  'ORG_SITE_READ',
  'ORG_SITE_UPDATE',
  'ORG_SITE_STATUS',
  'DEPARTMENT_READ',
  'DEPARTMENT_CONFIGURE',
  'EMPLOYEE_READ',
  'EMPLOYEE_MANAGE',
  'COMPLIANCE_READ',
  'COMPLIANCE_MANAGE',
];
export const PLATFORM_ADMIN_PERMISSIONS: readonly string[] = [
  'PLATFORM_COMPANY_CREATE',
  'PLATFORM_COMPANY_READ',
];

export interface BootstrapInput {
  adminLoginId: string;
  adminPassword: string;
}

/** Narrow tx surface — satisfied by a Prisma transaction and by test fakes. */
export interface BootstrapTx {
  company: {
    findFirst(args?: { where: Record<string, unknown> }): Promise<{
      id: string;
      code: string;
      isPlatform: boolean;
    } | null>;
    create(args: { data: Record<string, unknown> }): Promise<{ id: string }>;
  };
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

export async function bootstrapPlatform(
  tx: BootstrapTx,
  input: BootstrapInput,
): Promise<BootstrapResult> {
  const existing = await tx.company.findFirst({ where: { isPlatform: true } });
  if (existing !== null) return { status: 'ALREADY_COMPLETE', companyId: existing.id };

  // Explicit SYSTEM audit actor — a real Principal row, not an invented user.
  const system =
    (await tx.principal.findFirst({ where: { id: SYSTEM_PRINCIPAL_ID } })) ??
    (await tx.principal.create({
      data: { id: SYSTEM_PRINCIPAL_ID, type: 'SYSTEM', status: 'ACTIVE' },
    }));
  const actor: ActorContext = { actorId: system.id, actorType: 'SYSTEM' };

  // The sentinel platform company — no HO/depts; tenant structure lives in
  // customer companies created later via the platform API.
  const platform = await tx.company.create({
    data: { code: PLATFORM_COMPANY_CODE, name: 'Platform', isPlatform: true },
  });
  const role = await tx.role.create({
    data: {
      companyId: platform.id,
      key: PLATFORM_ADMIN_ROLE_KEY,
      name: 'Platform Admin',
      isSystem: true,
      description: 'ERP operator — creates customer companies and their first admins',
    },
  });
  for (const key of PLATFORM_ADMIN_PERMISSIONS) {
    const permission = await tx.permission.upsert({ where: { key }, update: {}, create: { key } });
    await tx.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } });
  }

  const passwordHash = await passwordService.hash(input.adminPassword);
  const admin = await tx.principal.create({
    data: {
      loginId: input.adminLoginId.toLowerCase().trim(),
      loginIdType: 'EMAIL',
      type: 'USER',
      status: 'ACTIVE',
      passwordHash,
    },
  });
  await tx.employee.create({
    data: {
      companyId: platform.id,
      principalId: admin.id,
      employeeCode: 'PADMIN-001',
      displayName: 'Platform Admin',
    },
  });
  await tx.roleAssignment.create({
    data: {
      principalId: admin.id,
      roleId: role.id,
      companyId: platform.id,
      scopeType: 'COMPANY',
      grantedByPrincipalId: system.id,
    },
  });
  await tx.auditLog.create({
    data: {
      eventKey: randomUUID(),
      actorId: actor.actorId,
      actorType: actor.actorType,
      action: 'PLATFORM_BOOTSTRAP_COMPLETED',
      entityType: 'COMPANY',
      entityId: platform.id,
      companyId: platform.id,
      statusAfter: 'ACTIVE',
      changedFields: {
        platformCompany: { before: null, after: PLATFORM_COMPANY_CODE },
        adminRole: { before: null, after: PLATFORM_ADMIN_ROLE_KEY },
      },
    },
  });
  return { status: 'CREATED', companyId: platform.id };
}
