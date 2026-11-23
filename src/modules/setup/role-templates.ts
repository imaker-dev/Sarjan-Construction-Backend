// Approved assignable tenant role templates — whitelist for grant/revoke.
export const HO_ADMIN_ROLE_KEY = 'HO_ADMIN';
// NOTE: OPERATION_CONFIGURE / OPERATION_EMPLOYEE_ASSIGN are intentionally
// absent — those routes authorize at COMPANY scope, which a HEAD_OFFICE-scoped
// grant can never cover. Operation configuration remains company-admin
// authority. OPERATION_READ stays: it is also enforced at department scope
// for operation-definition reads, which an HO-scoped grant does cover.
export const HO_ADMIN_PERMISSIONS: readonly string[] = [
  'ORG_HEAD_OFFICE_READ',
  'ORG_HEAD_OFFICE_UPDATE',
  'ORG_PROJECT_READ',
  'ORG_SITE_READ',
  'DEPARTMENT_READ',
  'DEPARTMENT_CONFIGURE',
  'OPERATION_READ',
  'EMPLOYEE_READ',
  'COMPLIANCE_READ',
  'ATTENDANCE_RECORD',
  'ATTENDANCE_READ',
  'ATTENDANCE_MANAGE',
  'WORK_SCHEDULE_READ',
  'WORK_SCHEDULE_MANAGE',
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

/**
 * Finance API permission keys (tenant scope). These gate REST routes only —
 * they are deliberately separate from the FINANCE and payroll operation keys
 * in the operation catalogue, which gate employee command eligibility.
 */
/**
 * Roles whose assignment requires an active membership in an ACTIVE
 * FINANCE-category department. COMPANY_OWNER is deliberately absent —
 * the tenant admin keeps Finance access without department placement.
 */
export const FINANCE_ROLE_KEYS: ReadonlySet<string> = new Set(['FINANCE_MANAGER', 'FINANCE_STAFF']);

/**
 * Catalogue domains covered by Finance role assignments (COMPANY scope):
 * ops enabled on any ACTIVE department in these domains flow to FINANCE_*
 * role holders automatically — sensitive ops still require explicit grants.
 * PROJECT_DASHBOARD_VIEW is covered additionally in assignment.ts because it
 * lives in the PROJECT_REPORTS domain alongside non-finance ops.
 */
export const FINANCE_OPERATION_DOMAINS: ReadonlySet<string> = new Set([
  'PROJECT_FINANCE',
  'BUDGET',
  'WALLET',
  'PAYROLL',
  'BILLING',
  'QUOTATION',
  'ACCOUNTING',
  'REPORT',
]);

export const FINANCE_API_PERMISSIONS: readonly string[] = [
  'FINANCE_DASHBOARD_READ',
  'FINANCE_PORTFOLIO_READ',
  'FINANCE_EMPLOYEE_READ',
  'FINANCE_EMPLOYEE_SENSITIVE_READ',
  'FINANCE_BUDGET_READ',
  'FINANCE_BUDGET_MANAGE',
  'FINANCE_WALLET_READ',
  'FINANCE_WALLET_MANAGE',
  'FINANCE_QUOTATION_READ',
  'FINANCE_QUOTATION_MANAGE',
  'FINANCE_BILLING_READ',
  'FINANCE_BILLING_MANAGE',
  'FINANCE_PAYROLL_READ',
  'FINANCE_PAYROLL_MANAGE',
  'FINANCE_REPORT_READ',
  'FINANCE_REPORT_EXPORT',
];

/** Shared non-finance baseline every Finance staffer needs to work at all. */
const FINANCE_STAFF_BASE_PERMISSIONS: readonly string[] = [
  'ORG_COMPANY_READ',
  'ORG_HEAD_OFFICE_READ',
  'ORG_PROJECT_READ',
  'ORG_SITE_READ',
  'DEPARTMENT_READ',
  'EMPLOYEE_READ',
  'OPERATION_READ',
  'FORM_READ',
  'FORM_SUBMISSION_READ',
  'FORM_SUBMISSION_WRITE',
  'WORKFLOW_INSTANCE_READ',
  'WORKFLOW_APPROVAL_READ',
  'WORKFLOW_APPROVAL_DECIDE',
  'DOCUMENT_UPLOAD',
  'DOCUMENT_READ',
  'DOCUMENT_LINK',
  'NOTIFICATION_READ',
  'ATTENDANCE_RECORD',
  'ATTENDANCE_READ',
  'WORK_SCHEDULE_READ',
  'LEAVE_APPLY',
  'LEAVE_READ',
];

/**
 * Least-privilege Finance staffer: day-to-day billing/wallet/quotation work,
 * budget read, and report read. Explicitly NO payroll, sensitive-employee,
 * budget-manage, or report-export keys — those stay FINANCE_MANAGER/owner.
 */
export const FINANCE_STAFF_API_PERMISSIONS: readonly string[] = [
  'FINANCE_DASHBOARD_READ',
  'FINANCE_PORTFOLIO_READ',
  'FINANCE_EMPLOYEE_READ',
  'FINANCE_BUDGET_READ',
  'FINANCE_WALLET_READ',
  'FINANCE_WALLET_MANAGE',
  'FINANCE_QUOTATION_READ',
  'FINANCE_QUOTATION_MANAGE',
  'FINANCE_BILLING_READ',
  'FINANCE_BILLING_MANAGE',
  'FINANCE_REPORT_READ',
];

export const PROJECT_DIRECTOR_PERMISSIONS: readonly string[] = [
  'ORG_PROJECT_READ',
  'ORG_SITE_READ',
  'DEPARTMENT_READ',
  'EMPLOYEE_READ',
  // Scoped membership administration — effective only when the company
  // enables the "placement" delegation switch. Never company-wide access.
  'EMPLOYEE_MEMBER_MANAGE',
  // Scoped workforce onboarding (profile only, no login) — effective only
  // when the company enables the "employeeOnboard" delegation switch.
  'EMPLOYEE_ONBOARD',
  // Scoped read of member contact fields via the member-detail endpoint.
  'EMPLOYEE_CONTACT_READ',
  'OPERATION_READ',
  'FORM_READ',
  'COMPLIANCE_READ',
  'DOCUMENT_UPLOAD',
  'DOCUMENT_READ',
  'DOCUMENT_LINK',
  'DOCUMENT_REVIEW',
  'ATTENDANCE_READ',
  'WORK_SCHEDULE_READ',
  'LEAVE_READ',
  'LEAVE_APPROVE',
];
export const PROJECT_INCHARGE_PERMISSIONS: readonly string[] = [
  'ORG_PROJECT_READ',
  'ORG_SITE_READ',
  // Delegated site administration — effective only when the company enables
  // the matching delegation switch (CompanyDelegationPolicy, all off by
  // default). Scoped at project; never sibling or company-wide access.
  'ORG_SITE_CREATE',
  'ORG_SITE_UPDATE',
  'DEPARTMENT_READ',
  // Scoped project/site-department administration behind the deptManage
  // delegation switch — company/HO departments stay company-admin territory.
  'DEPARTMENT_CONFIGURE',
  'EMPLOYEE_READ',
  // Scoped membership administration behind the "placement" delegation
  // switch — project + child-site departments only.
  'EMPLOYEE_MEMBER_MANAGE',
  // Scoped workforce onboarding (profile only, no login) behind the
  // "employeeOnboard" delegation switch — project + child-site depts only.
  'EMPLOYEE_ONBOARD',
  // Scoped read of member contact fields via the member-detail endpoint.
  'EMPLOYEE_CONTACT_READ',
  'OPERATION_READ',
  'FORM_READ',
  'DOCUMENT_UPLOAD',
  'DOCUMENT_READ',
  'DOCUMENT_LINK',
  'DOCUMENT_REVIEW',
  'ATTENDANCE_RECORD',
  'ATTENDANCE_READ',
  'ATTENDANCE_MANAGE',
  'WORK_SCHEDULE_READ',
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
      'FORM_READ',
      'COMPLIANCE_READ',
      'ATTENDANCE_RECORD',
      'ATTENDANCE_READ',
      'ATTENDANCE_MANAGE',
      'WORK_SCHEDULE_READ',
      'WORK_SCHEDULE_MANAGE',
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
      'WORK_SCHEDULE_READ',
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
    key: 'FINANCE_MANAGER',
    name: 'Finance Manager',
    scopeShape: 'COMPANY',
    permissions: [
      'ORG_COMPANY_READ',
      'ORG_HEAD_OFFICE_READ',
      'ORG_PROJECT_READ',
      'ORG_SITE_READ',
      'DEPARTMENT_READ',
      'EMPLOYEE_READ',
      'EMPLOYEE_MANAGE',
      'EMPLOYEE_INVITE',
      'ROLE_ASSIGNMENT_READ',
      'OPERATION_READ',
      'FORM_READ',
      'FORM_SUBMISSION_READ',
      'FORM_SUBMISSION_WRITE',
      'WORKFLOW_INSTANCE_READ',
      'WORKFLOW_APPROVAL_READ',
      'WORKFLOW_APPROVAL_DECIDE',
      'DOCUMENT_UPLOAD',
      'DOCUMENT_READ',
      'DOCUMENT_LINK',
      'DOCUMENT_REVIEW',
      'NOTIFICATION_READ',
      'COMPLIANCE_READ',
      'COMPLIANCE_MANAGE',
      'ATTENDANCE_RECORD',
      'ATTENDANCE_READ',
      'ATTENDANCE_MANAGE',
      'WORK_SCHEDULE_READ',
      'WORK_SCHEDULE_MANAGE',
      'LEAVE_APPLY',
      'LEAVE_READ',
      'LEAVE_APPROVE',
      'LEAVE_MANAGE',
      ...FINANCE_API_PERMISSIONS,
    ],
  },
  {
    key: 'FINANCE_STAFF',
    name: 'Finance Staff',
    scopeShape: 'COMPANY',
    permissions: [...FINANCE_STAFF_BASE_PERMISSIONS, ...FINANCE_STAFF_API_PERMISSIONS],
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
      'WORK_SCHEDULE_READ',
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
      'WORK_SCHEDULE_READ',
      'LEAVE_APPLY',
      'LEAVE_READ',
    ],
  },
];
const ROLE_KEY_ALIASES: Record<string, string> = {
  'HEAD OFFICE ADMIN': 'HO_ADMIN',
  HEAD_OFFICE_ADMIN: 'HO_ADMIN',
  'HO ADMIN': 'HO_ADMIN',
  HO_ADMIN: 'HO_ADMIN',
  'COMPANY OWNER': 'COMPANY_OWNER',
  COMPANY_OWNER: 'COMPANY_OWNER',
  'PROJECT MANAGER': 'PROJECT_MANAGER',
  PROJECT_MANAGER: 'PROJECT_MANAGER',
  'SITE ENGINEER': 'SITE_ENGINEER',
  SITE_ENGINEER: 'SITE_ENGINEER',
  'DEPARTMENT HEAD': 'DEPT_HEAD',
  'DEPT HEAD': 'DEPT_HEAD',
  DEPT_HEAD: 'DEPT_HEAD',
  'FINANCE MANAGER': 'FINANCE_MANAGER',
  FINANCE_MANAGER: 'FINANCE_MANAGER',
  'FINANCE STAFF': 'FINANCE_STAFF',
  FINANCE_STAFF: 'FINANCE_STAFF',
  EMPLOYEE: 'EMPLOYEE',
};

export function findRoleTemplate(key: string): TenantRoleTemplate | undefined {
  const normalized = key.trim().toUpperCase().replace(/\s+/g, ' ');
  const resolvedKey =
    ROLE_KEY_ALIASES[normalized] ?? ROLE_KEY_ALIASES[normalized.replace(/\s+/g, '_')] ?? key.trim();
  return (
    TENANT_ROLE_TEMPLATES.find((t) => t.key === resolvedKey) ??
    TENANT_ROLE_TEMPLATES.find(
      (t) => t.key === key || t.name.toLowerCase() === key.trim().toLowerCase(),
    )
  );
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
    if (toAdd.length > 0) await tx.rolePermission.createMany({ data: toAdd, skipDuplicates: true });
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
