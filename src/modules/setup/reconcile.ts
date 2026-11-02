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
  'COMPLIANCE_READ',
  'COMPLIANCE_MANAGE',
] as const;

export interface ReconcileTx {
  principal: {
    findFirst(args: { where: Record<string, unknown> }): Promise<{ id: string } | null>;
  };
  role: {
    findMany(args: {
      where: { key: string; isSystem: boolean };
    }): Promise<{ id: string; companyId: string }[]>;
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
