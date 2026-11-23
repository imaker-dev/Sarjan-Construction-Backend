import { randomUUID } from 'node:crypto';
import { SYSTEM_PRINCIPAL_ID } from './bootstrap.js';
import { FINANCE_API_PERMISSIONS, TENANT_ROLE_TEMPLATES } from './role-templates.js';

/**
 * Additive owner-permission reconcile: grants only the employee keys to
 * isSystem COMPANY_OWNER roles. Idempotent — re-runs add nothing and write
 * no audit rows. Runs inside the caller's transaction.
 */
export const RECONCILE_KEYS = [
  'EMPLOYEE_READ',
  'EMPLOYEE_MANAGE',
  'EMPLOYEE_INVITE',
  'ROLE_ASSIGNMENT_READ',
  'ACCESS_ROLE_ASSIGN',
  'ACCESS_ROLE_REVOKE',
  'COMPLIANCE_READ',
  'COMPLIANCE_MANAGE',
  // Project/site document register — upload, read, link, review at the
  // owning scope; tenant owner administers the whole document surface.
  'DOCUMENT_UPLOAD',
  'DOCUMENT_READ',
  'DOCUMENT_LINK',
  'DOCUMENT_REVIEW',
  'ATTENDANCE_RECORD',
  'ATTENDANCE_READ',
  'ATTENDANCE_MANAGE',
  'LEAVE_APPLY',
  'LEAVE_READ',
  'LEAVE_APPROVE',
  'LEAVE_MANAGE',
  'OPERATION_READ',
  'OPERATION_CONFIGURE',
  'OPERATION_EMPLOYEE_ASSIGN',
  'FORM_READ',
  'FORM_CONFIGURE',
  'FORM_PUBLISH',
  'AUDIT_LOG_VIEW',
  // Sensitive site fields (access instructions / emergency details) — owner
  // only by default; other roles must be granted it explicitly.
  'ORG_SITE_SENSITIVE_READ',
  // Finance API keys — tenant owner administers the whole Finance surface,
  // including the sensitive/payroll tiers that stay off staff templates.
  // Shared with onboarding (TENANT_OWNER_PERMISSIONS) — one source of truth.
  ...FINANCE_API_PERMISSIONS,
] as const;

export interface ReconcileTx {
  principal: {
    findFirst(args: { where: Record<string, unknown> }): Promise<{ id: string } | null>;
  };
  company: {
    findMany(args: { where: { isPlatform: boolean } }): Promise<{ id: string }[]>;
  };
  role: {
    findMany(args: {
      where: { key: string; isSystem: boolean };
    }): Promise<{ id: string; companyId: string }[]>;
    findFirst(args: {
      where: { companyId: string; key: string; isSystem: boolean };
    }): Promise<{ id: string } | null>;
    create(args: {
      data: { companyId: string; key: string; name: string; isSystem: boolean };
    }): Promise<{ id: string }>;
  };
  permission: {
    upsert(args: {
      where: { key: string };
      update: Record<string, unknown>;
      create: { key: string };
    }): Promise<{ id: string }>;
  };
  rolePermission: {
    findUnique(args: {
      where: { roleId_permissionId: { roleId: string; permissionId: string } };
    }): Promise<unknown>;
    create(args: { data: { roleId: string; permissionId: string } }): Promise<unknown>;
  };
  auditLog: { create(args: { data: Record<string, unknown> }): Promise<unknown> };
}

export async function reconcileOwnerPermissions(tx: ReconcileTx): Promise<number> {
  const system = await tx.principal.findFirst({ where: { id: SYSTEM_PRINCIPAL_ID } });
  if (system === null) {
    throw new Error('SYSTEM bootstrap principal not found — run db:bootstrap first');
  }
  // Tenant grants only — a COMPANY_OWNER role on the platform company is not a
  // tenant admin and must not receive tenant permission keys.
  const tenants = new Set(
    (await tx.company.findMany({ where: { isPlatform: false } })).map((c) => c.id),
  );
  const roles = await tx.role.findMany({ where: { key: 'COMPANY_OWNER', isSystem: true } });
  let changed = 0;
  for (const role of roles) {
    if (!tenants.has(role.companyId)) continue;
    for (const key of RECONCILE_KEYS) {
      const permission = await tx.permission.upsert({
        where: { key },
        update: {},
        create: { key },
      });
      const existing = await tx.rolePermission.findUnique({
        where: { roleId_permissionId: { roleId: role.id, permissionId: permission.id } },
      });
      if (existing !== null) continue;
      await tx.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } });
      changed += 1;
      await tx.auditLog.create({
        data: {
          eventKey: randomUUID(),
          actorId: system.id,
          actorType: 'SYSTEM',
          action: 'SYSTEM_PERMISSION_RECONCILED',
          entityType: 'ROLE',
          entityId: role.id,
          companyId: role.companyId,
          changedFields: { grantedPermission: { before: null, after: key } },
        },
      });
    }
  }
  return changed;
}

/** Provision the fixed system role templates for every company missing them
 *  or missing template grants. Idempotent — audits only real changes.
 *  COMPANY_OWNER is skipped here: reconcileOwnerPermissions owns its keyset. */
export async function reconcileHoAdminRoles(tx: ReconcileTx): Promise<number> {
  const system = await tx.principal.findFirst({ where: { id: SYSTEM_PRINCIPAL_ID } });
  if (system === null) throw new Error('SYSTEM bootstrap principal not found');
  const companies = await tx.company.findMany({ where: { isPlatform: false } });
  let changed = 0;
  for (const company of companies) {
    for (const tpl of TENANT_ROLE_TEMPLATES) {
      if (tpl.key === 'COMPANY_OWNER') continue;
      changed += await provisionRoleTemplate(tx, company.id, tpl, system.id);
    }
  }
  return changed;
}

async function provisionRoleTemplate(
  tx: ReconcileTx,
  companyId: string,
  tpl: { key: string; name: string; permissions: readonly string[] },
  systemId: string,
): Promise<number> {
  let changed = 0;
  let role = await tx.role.findFirst({
    where: { companyId, key: tpl.key, isSystem: true },
  });
  if (role === null) {
    role = await tx.role.create({
      data: { companyId, key: tpl.key, name: tpl.name, isSystem: true },
    });
    await tx.auditLog.create({
      data: {
        eventKey: randomUUID(),
        actorId: systemId,
        actorType: 'SYSTEM',
        action: 'SYSTEM_ROLE_PROVISIONED',
        entityType: 'ROLE',
        entityId: role.id,
        companyId,
        changedFields: { roleKey: { before: null, after: tpl.key } },
      },
    });
    changed += 1;
  }
  for (const key of tpl.permissions) {
    const permission = await tx.permission.upsert({
      where: { key },
      update: {},
      create: { key },
    });
    const existing = await tx.rolePermission.findUnique({
      where: { roleId_permissionId: { roleId: role.id, permissionId: permission.id } },
    });
    if (existing !== null) continue;
    await tx.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } });
    changed += 1;
    await tx.auditLog.create({
      data: {
        eventKey: randomUUID(),
        actorId: systemId,
        actorType: 'SYSTEM',
        action: 'SYSTEM_PERMISSION_RECONCILED',
        entityType: 'ROLE',
        entityId: role.id,
        companyId,
        changedFields: { grantedPermission: { before: null, after: key } },
      },
    });
  }
  return changed;
}
