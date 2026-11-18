// Approved assignable tenant role templates — whitelist for grant/revoke.
export const HO_ADMIN_ROLE_KEY = 'HO_ADMIN';
export const HO_ADMIN_PERMISSIONS: readonly string[] = [
  'ORG_HEAD_OFFICE_READ',
  'ORG_HEAD_OFFICE_UPDATE',
  'ORG_PROJECT_READ',
  'ORG_SITE_READ',
  'DEPARTMENT_READ',
  'DEPARTMENT_CONFIGURE',
  'OPERATION_READ',
  'OPERATION_CONFIGURE',
  'OPERATION_EMPLOYEE_ASSIGN',
  'EMPLOYEE_READ',
  'COMPLIANCE_READ',
  'ATTENDANCE_RECORD',
  'ATTENDANCE_READ',
  'ATTENDANCE_MANAGE',
  'LEAVE_APPLY',
  'LEAVE_READ',
  'LEAVE_APPROVE',
  'LEAVE_MANAGE',
  'AUDIT_LOG_VIEW',
];
export const PROJECT_DIRECTOR_ROLE_KEY = 'PROJECT_DIRECTOR';
export const PROJECT_INCHARGE_ROLE_KEY = 'PROJECT_INCHARGE';

/** Project leadership roles — unique per project, PROJECT scope only. */
export const PROJECT_LEADERSHIP_KEYS: ReadonlySet<string> = new Set([
  PROJECT_DIRECTOR_ROLE_KEY,
  PROJECT_INCHARGE_ROLE_KEY,
]);

export const PROJECT_DIRECTOR_PERMISSIONS: readonly string[] = [
  'ORG_PROJECT_READ',
  'ORG_SITE_READ',
  'DEPARTMENT_READ',
  'EMPLOYEE_READ',
  'OPERATION_READ',
  'FORM_READ',
  'COMPLIANCE_READ',
  'ATTENDANCE_READ',
  'LEAVE_READ',
  'LEAVE_APPROVE',
];
export const PROJECT_INCHARGE_PERMISSIONS: readonly string[] = [
  'ORG_PROJECT_READ',
  'ORG_SITE_READ',
  'DEPARTMENT_READ',
  'EMPLOYEE_READ',
  'OPERATION_READ',
  'FORM_READ',
  'ATTENDANCE_RECORD',
  'ATTENDANCE_READ',
  'ATTENDANCE_MANAGE',
  'LEAVE_APPLY',
  'LEAVE_READ',
  'LEAVE_APPROVE',
];

export interface TenantRoleTemplate {
  key: string;
  name: string;
  scopeShape: 'COMPANY' | 'HEAD_OFFICE' | 'PROJECT' | 'SITE';
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
  {
    key: 'PROJECT_MANAGER',
    name: 'Project Manager',
    scopeShape: 'PROJECT',
    permissions: [
      'ORG_PROJECT_READ',
      'ORG_SITE_READ',
      'ORG_SITE_CREATE',
      'ORG_SITE_UPDATE',
      'DEPARTMENT_READ',
      'DEPARTMENT_CONFIGURE',
      'EMPLOYEE_READ',
      'EMPLOYEE_MANAGE',
      'OPERATION_READ',
      'OPERATION_EMPLOYEE_ASSIGN',
      'FORM_READ',
      'COMPLIANCE_READ',
      'ATTENDANCE_RECORD',
      'ATTENDANCE_READ',
      'ATTENDANCE_MANAGE',
      'LEAVE_APPLY',
      'LEAVE_READ',
      'LEAVE_APPROVE',
      'LEAVE_MANAGE',
    ],
  },
  {
    key: 'SITE_ENGINEER',
    name: 'Site Engineer',
    scopeShape: 'SITE',
    permissions: [
      'ORG_SITE_READ',
      'DEPARTMENT_READ',
      'EMPLOYEE_READ',
      'OPERATION_READ',
      'FORM_READ',
      'ATTENDANCE_RECORD',
      'ATTENDANCE_READ',
      'ATTENDANCE_MANAGE',
      'LEAVE_APPLY',
      'LEAVE_READ',
      'LEAVE_APPROVE',
    ],
  },
  {
    key: PROJECT_DIRECTOR_ROLE_KEY,
    name: 'Project Director',
    scopeShape: 'PROJECT',
    permissions: PROJECT_DIRECTOR_PERMISSIONS,
  },
  {
    key: PROJECT_INCHARGE_ROLE_KEY,
    name: 'Project Incharge',
    scopeShape: 'PROJECT',
    permissions: PROJECT_INCHARGE_PERMISSIONS,
  },
  {
    key: 'DEPT_HEAD',
    name: 'Department Head',
    scopeShape: 'COMPANY',
    permissions: [
      'DEPARTMENT_READ',
      'EMPLOYEE_READ',
      'OPERATION_READ',
      'OPERATION_EMPLOYEE_ASSIGN',
      'FORM_READ',
      'FORM_CONFIGURE',
      'LEAVE_APPLY',
      'LEAVE_READ',
      'LEAVE_APPROVE',
    ],
  },
  {
    key: 'EMPLOYEE',
    name: 'Employee',
    scopeShape: 'COMPANY',
    permissions: [
      'ORG_COMPANY_READ',
      'ORG_HEAD_OFFICE_READ',
      'ORG_PROJECT_READ',
      'ORG_SITE_READ',
      'DEPARTMENT_READ',
      'OPERATION_READ',
      'FORM_READ',
      'ATTENDANCE_RECORD',
      'ATTENDANCE_READ',
      'LEAVE_APPLY',
      'LEAVE_READ',
    ],
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
 * creates missing roles/permissions/grants and audits every real change.
 * Permissions catalogue rows are global. COMPANY_OWNER is provisioned by the
 * platform onboarding path (it carries the tenant-owner keyset), so it is
 * skipped here.
 */
export async function provisionTenantRoles(
  tx: TemplateTx,
  companyId: string,
  actorId: string,
): Promise<void> {
  for (const tpl of TENANT_ROLE_TEMPLATES) {
    if (tpl.key === 'COMPANY_OWNER') continue;
    const perms = await tx.permission.findMany({ where: { key: { in: [...tpl.permissions] } } });
    const permIdByKey = new Map(perms.map((p) => [p.key, p.id]));
    for (const key of tpl.permissions) {
      if (!permIdByKey.has(key)) {
        const created = await tx.permission.create({
          data: { key, description: `${key} permission` },
        });
        permIdByKey.set(key, (created as { id: string }).id);
      }
    }
    const expectedIds = tpl.permissions.flatMap((k) => {
      const id = permIdByKey.get(k);
      return id === undefined ? [] : [id];
    });
    const role =
      (await tx.role.findFirst({ where: { companyId, key: tpl.key } })) ??
      (await tx.role.create({
        data: { companyId, key: tpl.key, name: tpl.name, isSystem: true },
      }));
    const existing = await tx.rolePermission.findMany({ where: { roleId: role.id } });
    const existingIds = new Set(existing.map((g) => g.permissionId));
    const toAdd = expectedIds
      .filter((id) => !existingIds.has(id))
      .map((permissionId) => ({ roleId: role.id, permissionId }));
    if (toAdd.length > 0)
      await tx.rolePermission.createMany({ data: toAdd, skipDuplicates: true });
    await tx.auditLog.create({
      data: {
        action: toAdd.length > 0 ? 'ROLE_TEMPLATE_RECONCILED' : 'ROLE_TEMPLATE_VERIFIED',
        entityType: 'ROLE',
        entityId: role.id,
        companyId,
        actorId,
        changedFields: {
          roleKey: { before: null, after: tpl.key },
          grants: { before: existingIds.size, after: expectedIds.length },
        },
      },
    });
  }
}
