// Stable permission keys. Machine-readable; referenced by seeds and checks.
// Never renamed — additions only in new milestones.
export const PERMISSIONS = [
  'ORG_COMPANY_CREATE',
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
  'ORG_SITE_SENSITIVE_READ',
  'IDENTITY_PRINCIPAL_READ',
  'ACCESS_ROLE_ASSIGN',
  'ACCESS_ROLE_REVOKE',
  'AUDIT_LOG_VIEW',
  'DEPARTMENT_READ',
  'DEPARTMENT_CONFIGURE',
  'OPERATION_READ',
  'OPERATION_CONFIGURE',
  'OPERATION_PUBLISH',
  'OPERATION_EMPLOYEE_ASSIGN',
  'FORM_READ',
  'FORM_CONFIGURE',
  'FORM_PUBLISH',
  'WORKFLOW_READ',
  'WORKFLOW_CONFIGURE',
  'WORKFLOW_PUBLISH',
  'RULE_READ',
  'RULE_CONFIGURE',
  'RULE_PUBLISH',
  'WORKFLOW_INSTANCE_READ',
  'WORKFLOW_INSTANCE_START',
  'WORKFLOW_INSTANCE_TRANSITION',
  'WORKFLOW_APPROVAL_READ',
  'WORKFLOW_APPROVAL_DECIDE',
  'FORM_SUBMISSION_READ',
  'FORM_SUBMISSION_WRITE',
  'DOCUMENT_UPLOAD',
  'DOCUMENT_READ',
  'DOCUMENT_LINK',
  'DOCUMENT_UNLINK',
  'DOCUMENT_ARCHIVE',
  'DOCUMENT_REVIEW',
  'NOTIFICATION_READ',
  'OUTBOX_ADMIN',
  'EMPLOYEE_READ',
  'EMPLOYEE_MANAGE',
  // Placement only — scoped membership administration inside project/site
  // departments. Distinct from EMPLOYEE_MANAGE (lifecycle) and gated by the
  // company "placement" delegation switch for scoped holders.
  'EMPLOYEE_MEMBER_MANAGE',
  // Profile-only workforce onboarding (no login/invite) into project/site
  // departments — distinct from EMPLOYEE_MANAGE (lifecycle) and
  // EMPLOYEE_MEMBER_MANAGE (existing employees), gated by the company
  // "employeeOnboard" delegation switch for scoped holders.
  'EMPLOYEE_ONBOARD',
  // Scoped read of contact/emergency-contact fields on department members —
  // the ONLY scoped path to contact data. Granted to PI/PD only; company
  // readers keep the company-wide employee detail route.
  'EMPLOYEE_CONTACT_READ',
  'COMPLIANCE_READ',
  'COMPLIANCE_MANAGE',
  'EMPLOYEE_INVITE',
  'ROLE_ASSIGNMENT_READ',
  'PLATFORM_COMPANY_CREATE',
  'PLATFORM_COMPANY_READ',
  'ATTENDANCE_RECORD',
  'ATTENDANCE_READ',
  'ATTENDANCE_MANAGE',
  'WORK_SCHEDULE_READ',
  'WORK_SCHEDULE_MANAGE',
  'LEAVE_APPLY',
  'LEAVE_READ',
  'LEAVE_APPROVE',
  'LEAVE_MANAGE',
  // Finance API surface (tenant scope only). Distinct from the FINANCE and
  // payroll keys of the operation catalogue — these gate REST routes;
  // employee operation grants gate command eligibility separately.
  'FINANCE_DASHBOARD_READ',
  'FINANCE_PORTFOLIO_READ',
  'FINANCE_EMPLOYEE_READ',
  'FINANCE_EMPLOYEE_SENSITIVE_READ',
  'FINANCE_BUDGET_READ',
  'FINANCE_BUDGET_MANAGE',
  'FINANCE_WALLET_READ',
  'FINANCE_WALLET_MANAGE',
  // Site-scoped wallet surface for field roles (PI manages within an
  // authorized site; PD reads only). Separate from the FINANCE_WALLET_*
  // keys, which are company-wide and granted to Finance roles only.
  'SITE_WALLET_VIEW',
  'SITE_WALLET_MANAGE',
  'FINANCE_QUOTATION_READ',
  'FINANCE_QUOTATION_MANAGE',
  'FINANCE_BILLING_READ',
  'FINANCE_BILLING_MANAGE',
  'FINANCE_PAYROLL_READ',
  'FINANCE_PAYROLL_MANAGE',
  'FINANCE_REPORT_READ',
  'FINANCE_REPORT_EXPORT',
] as const;

export type PermissionKey = (typeof PERMISSIONS)[number];
