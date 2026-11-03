import { randomUUID } from 'node:crypto';
import { SYSTEM_PRINCIPAL_ID } from './bootstrap.js';

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
  const roles = await tx.role.findMany({ where: { key: 'COMPANY_OWNER', isSystem: true } });
  let changed = 0;
  for (const role of roles) {
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

import { HO_ADMIN_PERMISSIONS, HO_ADMIN_ROLE_KEY } from './role-templates.js';

/** Provision the fixed HO_ADMIN system role for every company missing it or
 *  diverging from the template. Idempotent — audits only real changes. */
export async function reconcileHoAdminRoles(tx: ReconcileTx): Promise<number> {
  const system = await tx.principal.findFirst({ where: { id: SYSTEM_PRINCIPAL_ID } });
  if (system === null) throw new Error('SYSTEM bootstrap principal not found');
  const companies = await tx.company.findMany({ where: { isPlatform: false } });
  let changed = 0;
  for (const company of companies) {
    let role = await tx.role.findFirst({
      where: { companyId: company.id, key: HO_ADMIN_ROLE_KEY, isSystem: true },
    });
    if (role === null) {
      role = await tx.role.create({
        data: { companyId: company.id, key: HO_ADMIN_ROLE_KEY, name: 'HO Admin', isSystem: true },
      });
      await tx.auditLog.create({
        data: {
          eventKey: randomUUID(),
          actorId: system.id,
          actorType: 'SYSTEM',
          action: 'SYSTEM_ROLE_PROVISIONED',
          entityType: 'ROLE',
          entityId: role.id,
          companyId: company.id,
          changedFields: { roleKey: { before: null, after: HO_ADMIN_ROLE_KEY } },
        },
      });
      changed += 1;
    }
    for (const key of HO_ADMIN_PERMISSIONS) {
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
          companyId: company.id,
          changedFields: { grantedPermission: { before: null, after: key } },
        },
      });
    }
  }
  return changed;
}
