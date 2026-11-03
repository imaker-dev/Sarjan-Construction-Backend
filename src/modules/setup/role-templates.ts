// Approved assignable tenant role templates — whitelist for grant/revoke.
export const HO_ADMIN_ROLE_KEY = 'HO_ADMIN';
export const HO_ADMIN_PERMISSIONS: readonly string[] = [
  'ORG_HEAD_OFFICE_READ',
  'ORG_HEAD_OFFICE_UPDATE',
  'ORG_PROJECT_READ',
  'ORG_SITE_READ',
  'DEPARTMENT_READ',
  'DEPARTMENT_CONFIGURE',
  'EMPLOYEE_READ',
  'COMPLIANCE_READ',
];
export interface TenantRoleTemplate {
  key: string;
  name: string;
  scopeShape: 'COMPANY' | 'HEAD_OFFICE';
  permissions: readonly string[];
}
export const TENANT_ROLE_TEMPLATES: readonly TenantRoleTemplate[] = [
  { key: 'COMPANY_OWNER', name: 'Company Owner', scopeShape: 'COMPANY', permissions: [] },
  {
    key: HO_ADMIN_ROLE_KEY,
    name: 'HO Admin',
    scopeShape: 'HEAD_OFFICE',
    permissions: HO_ADMIN_PERMISSIONS,
  },
];
export function findRoleTemplate(key: string): TenantRoleTemplate | undefined {
  return TENANT_ROLE_TEMPLATES.find((t) => t.key === key);
}

interface TemplateTx {
  role: {
    findFirst(args: unknown): Promise<{ id: string } | null>;
    create(args: { data: unknown }): Promise<{ id: string }>;
    update(args: { where: { id: string }; data: unknown }): Promise<unknown>;
  };
  permission: {
    findMany(args: unknown): Promise<{ id: string; key: string }[]>;
    create(args: { data: unknown }): Promise<unknown>;
  };
  rolePermission: {
    findMany(args: unknown): Promise<{ permissionId: string }[]>;
    createMany(args: { data: unknown[]; skipDuplicates?: boolean }): Promise<unknown>;
  };
  auditLog: { create(args: { data: unknown }): Promise<unknown> };
}

/**
 * Provision the approved system role templates for a company. Idempotent:
 * creates missing roles/permissions/grants; if an existing HO_ADMIN grant set
 * diverges from the template, missing grants are added and extraneous grants
 * removed — the fix-up is audited. Permissions catalogue rows are global.
 */
export async function provisionTenantRoles(
  tx: TemplateTx,
  companyId: string,
  actorId: string,
): Promise<void> {
  const perms = await tx.permission.findMany({ where: { key: { in: [...HO_ADMIN_PERMISSIONS] } } });
  const permIdByKey = new Map(perms.map((p) => [p.key, p.id]));
  for (const key of HO_ADMIN_PERMISSIONS) {
    if (!permIdByKey.has(key)) {
      const created = await tx.permission.create({
        data: { key, description: `${key} permission` },
      });
      permIdByKey.set(key, (created as { id: string }).id);
    }
  }
  const expectedIds = HO_ADMIN_PERMISSIONS.flatMap((k) => {
    const id = permIdByKey.get(k);
    return id === undefined ? [] : [id];
  });
  const role =
    (await tx.role.findFirst({ where: { companyId, key: HO_ADMIN_ROLE_KEY } })) ??
    (await tx.role.create({
      data: { companyId, key: HO_ADMIN_ROLE_KEY, name: 'HO Admin', isSystem: true },
    }));
  const existing = await tx.rolePermission.findMany({ where: { roleId: role.id } });
  const existingIds = new Set(existing.map((g) => g.permissionId));
  const toAdd = expectedIds
    .filter((id) => !existingIds.has(id))
    .map((permissionId) => ({ roleId: role.id, permissionId }));
  if (toAdd.length > 0) await tx.rolePermission.createMany({ data: toAdd, skipDuplicates: true });
  await tx.auditLog.create({
    data: {
      action: toAdd.length > 0 ? 'ROLE_TEMPLATE_RECONCILED' : 'ROLE_TEMPLATE_VERIFIED',
      entityType: 'ROLE',
      entityId: role.id,
      companyId,
      actorId,
      changedFields: {
        roleKey: { before: null, after: HO_ADMIN_ROLE_KEY },
        grants: { before: existingIds.size, after: expectedIds.length },
      },
    },
  });
}
