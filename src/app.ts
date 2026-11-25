import Fastify, { type FastifyInstance } from 'fastify';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import rateLimit from '@fastify/rate-limit';
import configPlugin from './plugins/config.js';
import requestContextPlugin from './plugins/request-context.js';
import errorHandlerPlugin from './plugins/error-handler.js';
import prismaPlugin from './plugins/prisma.js';
import redisPlugin from './plugins/redis.js';
import authenticationPlugin from './plugins/authentication.js';
import authorizationPlugin from './plugins/authorization.js';
import healthRoutes from './modules/health/routes.js';
import authRoutes from './modules/auth/routes.js';
import cors from '@fastify/cors';
import { RedisUserProfileCache, InMemoryUserProfileCache } from './modules/auth/cache.js';
import websocketPlugin from '@fastify/websocket';
import { PrismaNotificationUnitOfWork } from './modules/notification/repository.js';
import { NotificationService } from './modules/notification/service.js';
import { NotificationWorker } from './modules/notification/worker.js';
import { NotificationGateway } from './modules/notification/ws-gateway.js';
import {
  RedisNotificationPublisher,
  RedisTicketStore,
} from './modules/notification/redis-adapters.js';
import { RoleNotificationDispatcher } from './modules/notification/role-dispatcher.js';
import { notificationRoutes } from './modules/notification/routes.js';
import notificationWorkerPlugin from './plugins/notification-worker.js';
import { OrganizationService } from './modules/organization/service.js';
import { DelegationService } from './modules/organization/delegation.js';
import { delegationRoutes } from './modules/organization/delegation-routes.js';
import { DepartmentService } from './modules/department/service.js';
import { organizationRoutes } from './modules/organization/routes.js';
import { departmentRoutes } from './modules/department/routes.js';
import { PrismaOrgUnitOfWork } from './modules/organization/repository.js';
import { PrismaDepartmentUnitOfWork } from './modules/department/repository.js';
import { PrismaEmployeeUnitOfWork } from './modules/employee/repository.js';
import { EmployeeService } from './modules/employee/service.js';
import { employeeRoutes } from './modules/employee/routes.js';
import { EmployeeAccessService } from './modules/employee/access.js';
import { PrismaEmployeeDocumentRepository } from './modules/employee/document-repository.js';
import { EmployeeDocumentService } from './modules/employee/document-service.js';
import { DocumentService } from './modules/document/service.js';
import { PrismaDocumentUnitOfWork } from './modules/document/repository.js';
import { LocalDiskStorage } from './modules/document/storage.js';
import multipartPlugin from './plugins/multipart.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlatformService } from './modules/platform/service.js';
import { platformRoutes } from './modules/platform/routes.js';
import { PrismaPlatformUnitOfWork } from './modules/platform/repository.js';
import type { ScopeTarget } from './modules/access-control/service.js';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { ComplianceService } from './modules/compliance/service.js';
import { complianceRoutes } from './modules/compliance/routes.js';
import { operationAssignmentRoutes } from './modules/operation/routes.js';
import { OperationAssignmentService } from './modules/operation/assignment.js';
import { FormService } from './modules/form/service.js';
import { formRoutes } from './modules/form/routes.js';
import { PrismaFormUnitOfWork } from './modules/form/repository.js';
import { AttendanceService } from './modules/attendance/service.js';
import { attendanceRoutes } from './modules/attendance/routes.js';
import { PrismaAttendanceUnitOfWork } from './modules/attendance/repository.js';
import { AttendanceWorker } from './modules/attendance/worker.js';
import attendanceWorkerPlugin from './plugins/attendance-worker.js';
import { LeaveService } from './modules/leave/service.js';
import { leaveRoutes } from './modules/leave/routes.js';
import { PrismaLeaveUnitOfWork } from './modules/leave/repository.js';
import { ScheduleService } from './modules/schedule/service.js';
import { scheduleRoutes } from './modules/schedule/routes.js';
import { PrismaScheduleUnitOfWork } from './modules/schedule/repository.js';
import { AuditService } from './modules/audit/service.js';
import { auditRoutes } from './modules/audit/routes.js';
import { approvalRoutes } from './modules/approval/routes.js';
import { ApprovalService } from './modules/approval/service.js';
import { PrismaApprovalUnitOfWork } from './modules/approval/repository.js';
import { financeRoutes } from './modules/finance/routes.js';
import { FinanceService } from './modules/finance/service.js';
import { PrismaFinanceUnitOfWork } from './modules/finance/repository.js';
import { MailService } from './modules/mail/service.js';
import { mailRoutes } from './modules/mail/routes.js';
import { AuthService } from './modules/auth/service.js';
import { MfaService, type MfaTokenPayload } from './modules/auth/mfa.js';
import { makeAuthRepos, PrismaAuthUnitOfWork } from './modules/auth/repository.js';
import { AccessControlService } from './modules/access-control/service.js';
import { makeAccessRepository } from './modules/access-control/repository.js';
import type { PrincipalContext } from './plugins/authentication.js';

// Per-operation documentation — keyed "METHOD /path" (api prefix stripped).
// Summaries/descriptions document real behavior; permission is appended to
// the description so the doc stays truthful without a parallel contract.
const OPERATION_DOCS: Record<
  string,
  { summary: string; description?: string; permission?: string }
> = {
  'GET /health': { summary: 'Liveness probe (unauthenticated)' },
  'GET /ready': { summary: 'Readiness probe (unauthenticated)' },
  'POST /auth/login': {
    summary: 'Password login — issues access + refresh tokens',
    description: 'Unauthenticated; rate-limited per loginId+IP.',
  },
  'POST /auth/refresh': { summary: 'Rotate refresh token' },
  'POST /auth/logout': { summary: 'Invalidate the current session', permission: 'authenticated' },
  'POST /auth/mfa/verify': {
    summary: 'Verify 2FA OTP code and complete login',
    description: 'Unauthenticated; completes login using challenge mfaToken and 6-digit OTP code.',
  },
  'POST /auth/mfa/send-otp': {
    summary: 'Resend 2FA verification code',
    description: 'Unauthenticated; rate-limited. Generates and sends a new OTP for the challenge.',
  },
  'GET /auth/mfa/status': {
    summary: 'Get 2FA status for authenticated user',
    permission: 'authenticated',
  },
  'POST /auth/mfa/setup': {
    summary: 'Request 2FA registration setup (sends OTP code to registered email)',
    permission: 'authenticated',
  },
  'POST /auth/mfa/enable': {
    summary: 'Enable or confirm 2FA (Email OTP) for authenticated user',
    permission: 'authenticated',
  },
  'POST /auth/mfa/disable': {
    summary: 'Disable 2FA for authenticated user',
    permission: 'authenticated',
  },
  'POST /auth/change-password': {
    summary: 'Change password for authenticated user',
    permission: 'authenticated',
  },
  'GET /auth/me': {
    summary:
      'Get current authenticated user profile, roles, permissions, and scope assignments (cached)',
    permission: 'authenticated',
  },
  'GET /profile': {
    summary:
      'Get aggregated profile of authenticated user including employee, attendance, and leave details',
    permission: 'authenticated',
  },
  'POST /auth/claim': {
    summary: 'Consume a one-time claim code and set password',
  },
  'GET /auth/claim/verify': {
    summary: 'Verify claim code validity and return company info',
    description: 'Unauthenticated; rate-limited.',
  },
  'POST /auth/claim/onboard': {
    summary: 'Onboard Company',
    description:
      'Unauthenticated; rate-limited. Sets password, updates company, and creates HeadOffice. ' +
      'The Head Office body shares the POST /org/head-offices structured-address contract; ' +
      'isPrimary is NOT client-controlled — the first head office is always the company primary.',
  },
  'GET /org/company': { summary: 'Read own company profile', permission: 'ORG_COMPANY_READ' },
  'GET /org/company/delegations': {
    summary: 'Read company delegation switches',
    description:
      'Delegation switches are all OFF by default and only ever amplify ' +
      'holders of the matching SCOPED permission inside their assigned ' +
      'project/site — they never grant company-wide or sibling access.',
    permission: 'ORG_COMPANY_READ',
  },
  'PATCH /org/company/delegations': {
    summary: 'Update company delegation switches',
    description:
      'siteCreate/siteUpdate delegate site administration; deptManage ' +
      'delegates project- and site-scoped department administration ' +
      '(company/HO departments are never delegated). expectedVersion guards ' +
      'optimistic concurrency (409 on stale).',
    permission: 'ORG_COMPANY_UPDATE',
  },
  'PATCH /org/company': {
    summary: 'Update company profile (optimistic version)',
    permission: 'ORG_COMPANY_UPDATE',
  },
  'POST /org/company/status': {
    summary: 'Transition company status',
    permission: 'ORG_COMPANY_STATUS',
  },
  'GET /org/head-offices': {
    summary: 'List head offices (cursor-paginated)',
    description: 'Deterministic cursor pagination on (createdAt,id); pass `cursor`.',
    permission: 'ORG_HEAD_OFFICE_READ',
  },
  'POST /org/head-offices': {
    summary: 'Create head office',
    description:
      'Structured operational address + contact fields; isPrimary=true promotes by replacement ' +
      'under the one-primary-per-company invariant.',
    permission: 'ORG_HEAD_OFFICE_CREATE',
  },
  'PATCH /org/head-offices/:id': {
    summary: 'Update head office',
    permission: 'ORG_HEAD_OFFICE_UPDATE',
  },
  'POST /org/head-offices/:id/status': {
    summary: 'Transition head office status',
    permission: 'ORG_HEAD_OFFICE_STATUS',
  },
  'GET /org/projects': {
    summary: 'List projects (cursor-paginated)',
    permission: 'ORG_PROJECT_READ',
  },
  'POST /org/projects': {
    summary: 'Create project',
    description:
      'headOfficeId is derived server-side from the active primary Head Office — ' +
      'never accepted from the body. Requires an active primary HO and company-wide ' +
      'FINANCE and ADMINISTRATION departments to already exist (422 otherwise). ' +
      'Supports the extended construction profile (client/contract, location, land, ' +
      'programme) plus optional nested landParcels, document links, external ' +
      'approvals, and an initialBudget — the latter requires FINANCE_BUDGET_MANAGE ' +
      'plus budget create/revise operations and produces a DRAFT revision in the ' +
      'same transaction (total computed server-side).',
    permission: 'ORG_PROJECT_CREATE',
  },
  'GET /org/projects/:id': {
    summary: 'Get project profile + registers',
    description:
      'Project row plus its landParcels, document register entries, and external ' +
      'approval records.',
    permission: 'ORG_PROJECT_READ',
  },
  'PATCH /org/projects/:id': {
    summary: 'Update project',
    description:
      'Patch semantics: absent keys untouched, explicit null clears the field. ' +
      'expectedVersion guards optimistic concurrency (409 on stale).',
    permission: 'ORG_PROJECT_UPDATE',
  },
  'POST /org/projects/:id/status': {
    summary: 'Transition project status',
    permission: 'ORG_PROJECT_STATUS',
  },
  'POST /org/projects/:id/parcels': {
    summary: 'Add land parcel to project',
    permission: 'ORG_PROJECT_UPDATE',
  },
  'GET /org/projects/:id/parcels': {
    summary: 'List project land parcels',
    permission: 'ORG_PROJECT_READ',
  },
  'POST /org/projects/:id/documents': {
    summary: 'Link an existing document to the project register',
    description:
      'documentId must reference an AVAILABLE Document in this company whose ' +
      'upload scope contains the project (COMPANY or the project itself). ' +
      'Carries drawing-register metadata: type, title, number, discipline, ' +
      'revision, issue date, link status.',
    permission: 'DOCUMENT_LINK',
  },
  'POST /org/projects/:id/documents/upload': {
    summary: 'Upload a file to the project register (multipart)',
    description:
      'multipart/form-data file field plus optional metadata fields ' +
      '(documentType, title, documentNumber, discipline, revision, issueDate, ' +
      'linkStatus). The Document is stored at PROJECT scope and linked in the ' +
      'project document register.',
    permission: 'DOCUMENT_UPLOAD',
  },
  'GET /org/projects/:id/documents': {
    summary: 'List project document register',
    permission: 'DOCUMENT_READ',
  },
  'PATCH /org/projects/:id/documents/:linkId': {
    summary: 'Update project document register metadata',
    permission: 'DOCUMENT_LINK',
  },
  'POST /org/projects/:id/approvals': {
    summary: 'Record external authority approval/registration',
    description:
      'Statutory/authority record (RERA, fire NOC, environmental clearance …) — ' +
      'distinct from internal workflow approvals. approvalType OTHER requires ' +
      'customType. No approval type is universally required.',
    permission: 'ORG_PROJECT_UPDATE',
  },
  'GET /org/projects/:id/approvals': {
    summary: 'List project external approvals',
    permission: 'ORG_PROJECT_READ',
  },
  'PATCH /org/projects/:id/approvals/:approvalId': {
    summary: 'Update external approval record',
    permission: 'ORG_PROJECT_UPDATE',
  },
  'GET /org/sites': { summary: 'List sites (cursor-paginated)', permission: 'ORG_SITE_READ' },
  'POST /org/sites': {
    summary: 'Create site',
    description:
      'Structured address fields (addressLine1/2, locality, city, district, state, pinCode, country). ' +
      'geoLatitude/geoLongitude form a required pair with range validation; geoFenceRadiusM (10-5000m) ' +
      'requires coordinates. Omitted timezone inherits the parent project timezone. ' +
      'Optional siteType, land/parcel, facilities, contact, and sensitive ' +
      'access/emergency fields (the latter two are written here but only ' +
      'readable with ORG_SITE_SENSITIVE_READ). landParcelId must reference a ' +
      'parcel of the same project. Authorization evaluates at the body ' +
      'projectId: a company-scope grant covers any project; a project-scoped ' +
      'grant additionally requires the company siteCreate delegation switch.',
    permission: 'ORG_SITE_CREATE',
  },
  'GET /org/sites/:id': {
    summary: 'Get site profile + document register',
    description:
      'accessInstructions and emergencyDetails are included only for holders ' +
      'of ORG_SITE_SENSITIVE_READ; omitted otherwise.',
    permission: 'ORG_SITE_READ',
  },
  'GET /org/projects/:id/effective-operations': {
    summary: 'Inspect effective operations within a project',
    description:
      'Lists which employees can perform which catalogue operations inside the ' +
      'project (and its sites), with source attribution: DEPARTMENT (inherited ' +
      'from an active dept enablement), DIRECT (explicit per-employee grant ' +
      'backed by dept enablement), or ROLE (PD/PI leadership coverage of ' +
      'leadership-inheritable ops). Keyset-paginated via cursor; only safe ' +
      'employee identity fields are returned.',
    permission: 'ORG_PROJECT_READ',
  },
  'GET /org/sites/:id/effective-operations': {
    summary: 'Inspect effective operations within a site',
    description:
      'Same shape as the project inspection endpoint, scoped to departments ' +
      'of the site plus leadership coverage inherited from the parent ' +
      "project's active PD/PI assignments.",
    permission: 'ORG_SITE_READ',
  },
  'GET /org/projects/:id/activity': {
    summary: 'Project activity feed (includes child sites)',
    description:
      'Audit events whose project scope is proven from server-side entity ' +
      'data — caller metadata never establishes scope, and events with ' +
      'unresolvable or security-sensitive entities are excluded. Keyset ' +
      'cursor on (occurredAt, id); sensitive changedFields values are ' +
      'redacted and audit metadata is never returned.',
    permission: 'ORG_PROJECT_READ',
  },
  'GET /org/sites/:id/activity': {
    summary: 'Site activity feed',
    description:
      'Same shape as the project activity feed, restricted to events ' +
      'provably scoped to this site.',
    permission: 'ORG_SITE_READ',
  },
  'POST /org/sites/:id/workforce/:employeeId/suspend': {
    summary: 'Suspend site workforce member',
    description:
      'Ends all ACTIVE memberships in departments scoped to THIS site ' +
      '(server-controlled endedAt, endReason=SUSPENDED). A project-only ' +
      'membership is not in scope. Body: reason (required, 1-500 chars, ' +
      'audit-only), expectedReturnDate (optional ISO date -> suspendUntil). ' +
      'Employee.status/Principal.status are never changed. Scoped callers ' +
      'need EMPLOYEE_MEMBER_MANAGE at this site plus the memberSuspend ' +
      'delegation switch; company-wide EMPLOYEE_MANAGE/' +
      'EMPLOYEE_MEMBER_MANAGE bypasses the switch. 409 WORKFORCE_NOT_ACTIVE ' +
      'when no active in-scope memberships; 409 AMBIGUOUS_PRIMARY when the ' +
      'remaining effective set would lack a primary.',
    permission: 'EMPLOYEE_MEMBER_MANAGE (scoped + memberSuspend) or company-wide',
  },
  'POST /org/sites/:id/workforce/:employeeId/exit': {
    summary: 'Permanently exit site workforce member',
    description:
      'Ends ACTIVE in-scope memberships with endReason=EXITED and appends a ' +
      'SiteWorkforceExit marker that blocks reinstatement of this episode. ' +
      'Rows already SUSPENDED keep their reason — history is never rewritten. ' +
      'Body: reason (required, 1-500 chars). Requires memberExit delegation ' +
      'switch (or company-wide EMPLOYEE_MANAGE/EMPLOYEE_MEMBER_MANAGE). ' +
      '409 ALREADY_EXITED on repeat exit; 404 when no in-scope rows exist.',
    permission: 'EMPLOYEE_MEMBER_MANAGE (scoped + memberExit) or company-wide',
  },
  'POST /org/sites/:id/workforce/:employeeId/reinstate': {
    summary: 'Reinstate suspended site workforce member',
    description:
      'Creates NEW membership rows for the whole eligible SUSPENDED set ' +
      '(ended rows are never reopened; supersededBy links them). ' +
      'All-or-nothing: any inactive, exit-marked, or out-of-scope department ' +
      'aborts the restore. Body: note (optional, <=500 chars). Requires the ' +
      'memberSuspend switch or company-wide admin. 409 NOTHING_TO_REINSTATE, ' +
      'ALREADY_EXITED, or AMBIGUOUS_PRIMARY as applicable.',
    permission: 'EMPLOYEE_MEMBER_MANAGE (scoped + memberSuspend) or company-wide',
  },
  'POST /org/projects/:id/workforce/:employeeId/suspend': {
    summary: 'Suspend project workforce member',
    description:
      'Same contract as the site suspend route; the affected set covers ' +
      'departments pinned to this project AND its child-site departments.',
    permission: 'EMPLOYEE_MEMBER_MANAGE (scoped + memberSuspend) or company-wide',
  },
  'POST /org/projects/:id/workforce/:employeeId/exit': {
    summary: 'Permanently exit project workforce member',
    description:
      'Same contract as the site exit route; the marker covers the whole ' +
      'project including child sites.',
    permission: 'EMPLOYEE_MEMBER_MANAGE (scoped + memberExit) or company-wide',
  },
  'POST /org/projects/:id/workforce/:employeeId/reinstate': {
    summary: 'Reinstate suspended project workforce member',
    description:
      'Same contract as the site reinstate route; restorable rows are those ' +
      'in project departments or child-site departments not covered by an ' +
      'exit marker.',
    permission: 'EMPLOYEE_MEMBER_MANAGE (scoped + memberSuspend) or company-wide',
  },
  'PATCH /org/sites/:id': {
    summary: 'Update site',
    description:
      'Patch semantics: absent keys untouched, explicit null clears the field. ' +
      'expectedVersion guards optimistic concurrency (409 on stale). A ' +
      'project/site-scoped ORG_SITE_UPDATE grant additionally requires the ' +
      'company siteUpdate delegation switch; company-scope grants are ' +
      'unaffected.',
    permission: 'ORG_SITE_UPDATE',
  },
  'POST /org/sites/:id/documents': {
    summary: 'Link an existing document to the site register',
    description:
      'documentId must reference an AVAILABLE Document whose scope contains ' +
      'the site (COMPANY, the parent project, or the site itself).',
    permission: 'DOCUMENT_LINK',
  },
  'POST /org/sites/:id/documents/upload': {
    summary: 'Upload a file to the site register (multipart)',
    description:
      'multipart/form-data file field plus optional register metadata fields. ' +
      'The Document is stored at SITE scope.',
    permission: 'DOCUMENT_UPLOAD',
  },
  'GET /org/sites/:id/documents': {
    summary: 'List site document register',
    permission: 'DOCUMENT_READ',
  },
  'PATCH /org/sites/:id/documents/:linkId': {
    summary: 'Update site document register metadata',
    permission: 'DOCUMENT_LINK',
  },
  'POST /org/sites/:id/status': {
    summary: 'Transition site status',
    permission: 'ORG_SITE_STATUS',
  },
  'GET /departments': { summary: 'List departments', permission: 'DEPARTMENT_READ' },
  'POST /departments': {
    summary: 'Create department',
    description:
      'category is a controlled construction-department enum (FINANCE, ADMINISTRATION, HR, ' +
      'PROCUREMENT, STORE, MACHINERY, SAFETY, QUALITY, SITE_ENGINEERING, KITCHEN, OPERATIONS, CUSTOM); ' +
      'categoryLabel is required when category=CUSTOM. scopeId is required for PROJECT/SITE scopes ' +
      'and omitted for COMPANY. baseHeadOfficeId is physical location only — never a permission scope. ' +
      'capabilityKey is an internal routing identifier. Authorization evaluates at the declared ' +
      'scopeType/scopeId: project/site-scoped mutations by non-company holders also require the ' +
      'company deptManage delegation switch; company departments keep the company-scope check.',
    permission: 'DEPARTMENT_CONFIGURE',
  },
  'GET /departments/:id': {
    summary: 'Get department detail (includes embedded base head office)',
    permission: 'DEPARTMENT_READ',
  },
  'PATCH /departments/:id': { summary: 'Update department', permission: 'DEPARTMENT_CONFIGURE' },
  'POST /departments/:id/status': {
    summary: 'Transition department status',
    permission: 'DEPARTMENT_CONFIGURE',
  },
  'GET /employees': {
    summary: 'List employees (cursor-paginated)',
    permission: 'EMPLOYEE_READ',
  },
  'POST /employees': { summary: 'Create employee profile', permission: 'EMPLOYEE_MANAGE' },
  'GET /employees/:id': { summary: 'Get employee profile', permission: 'EMPLOYEE_READ' },
  'PATCH /employees/:id': {
    summary: 'Update employee profile',
    description: 'Operational fields only; nullable-union fields clear the stored value.',
    permission: 'EMPLOYEE_MANAGE',
  },
  'GET /operations': {
    summary: 'Operation catalogue',
    description:
      'Global master list of work types an admin can enable on departments ' +
      '(finance payroll, billing, quotation, wallet, reports). Read-only rows ' +
      'seeded by migration — not per-company.',
    permission: 'OPERATION_READ',
  },
  'GET /departments/:id/operations': {
    summary: 'List enabled department operations',
    permission: 'DEPARTMENT_READ',
  },
  'POST /departments/:id/operations': {
    summary: 'Enable operation on a department',
    description:
      'operationKey must exist in the global catalogue and the department must be ACTIVE. ' +
      'Duplicate enablement conflicts (409).',
    permission: 'OPERATION_CONFIGURE',
  },
  'DELETE /departments/:id/operations/:operationKey': {
    summary: 'Disable operation on a department',
    permission: 'OPERATION_CONFIGURE',
  },
  'GET /employees/:id/operations': {
    summary: 'List employee assigned operations',
    permission: 'EMPLOYEE_READ',
  },
  'POST /employees/:id/operations': {
    summary: 'Assign operation to employee',
    description:
      'Strict subset rule: the operation must be enabled on at least one ACTIVE ' +
      'department the employee is a member of — membership is the work boundary.',
    permission: 'OPERATION_EMPLOYEE_ASSIGN',
  },
  'DELETE /employees/:id/operations/:operationKey': {
    summary: 'Revoke operation from employee',
    permission: 'OPERATION_EMPLOYEE_ASSIGN',
  },
  'GET /employees/:id/memberships': {
    summary: 'List department memberships (active + history)',
    description: 'Placement records only — membership never grants API permission.',
    permission: 'EMPLOYEE_READ',
  },
  'POST /employees/:id/memberships': {
    summary: 'Add department membership',
    description:
      'Targets an ACTIVE COMPANY/PROJECT/SITE department in the same company. ' +
      'isPrimary=true demotes the prior active primary in the same transaction.',
    permission: 'EMPLOYEE_MANAGE',
  },
  'PATCH /employees/:id/memberships/:membershipId': {
    summary: 'Set membership primary flag',
    permission: 'EMPLOYEE_MANAGE',
  },
  'POST /employees/:id/memberships/:membershipId/end': {
    summary: 'End membership (server timestamp)',
    permission: 'EMPLOYEE_MANAGE',
  },
  'POST /employees/:id/status': {
    summary: 'Activate/deactivate employee (atomic offboarding)',
    permission: 'EMPLOYEE_MANAGE',
  },
  'POST /employees/:id/invite': {
    summary: 'Invite profile-only employee — creates suspended account + one-time claim code',
    description:
      'Code returned once, never logged/stored raw; the employee claims via /auth/claim.',
    permission: 'EMPLOYEE_INVITE',
  },
  'POST /employees/:id/invite/resend': {
    summary: 'Reissue employee claim code (invalidates prior)',
    permission: 'EMPLOYEE_INVITE',
  },
  'GET /employees/:id/assignments': {
    summary: 'List active role assignments of an employee',
    permission: 'ROLE_ASSIGNMENT_READ',
  },
  'POST /employees/:id/assignments': {
    summary:
      'Grant a whitelisted tenant role (COMPANY_OWNER@COMPANY, HO_ADMIN@HEAD_OFFICE primary, PROJECT_DIRECTOR|PROJECT_INCHARGE@PROJECT — one active holder per project, covers project-scoped department operations across its sites)',
    permission: 'ACCESS_ROLE_ASSIGN',
  },
  'DELETE /employees/:id/assignments/:assignmentId': {
    summary: 'Revoke a role assignment',
    permission: 'ACCESS_ROLE_REVOKE',
  },
  'GET /employees/documents/expiring': {
    summary: 'List expiring employee documents',
    description: 'Lists employee certificates and licenses expiring within threshold days.',
    permission: 'EMPLOYEE_READ',
  },
  'POST /employees/:id/documents/upload': {
    summary: 'Upload and attach employee document (multipart)',
    description: 'Direct multipart file upload with metadata attachment.',
  },
  'POST /employees/:id/documents': {
    summary: 'Attach document to employee',
    description: 'Attach an existing documentId or base64 file to employee profile.',
  },
  'GET /employees/:id/documents': {
    summary: 'List employee documents',
    description: 'Lists all documents for an employee with optional type/status filters.',
  },
  'GET /employees/:id/documents/:docId': {
    summary: 'Get employee document details',
    description: 'Retrieves metadata for a specific employee document.',
  },
  'GET /employees/:id/documents/:docId/download': {
    summary: 'Download employee document',
    description: 'Streams the original document file with proper content-type.',
  },
  'PATCH /employees/:id/documents/:docId': {
    summary: 'Update employee document metadata',
    description: 'Updates document title, number, authority, or expiry date.',
    permission: 'EMPLOYEE_MANAGE',
  },
  'POST /employees/:id/documents/:docId/verify': {
    summary: 'Verify or reject employee document',
    description: 'Admin/supervisor verification or rejection of an employee document.',
    permission: 'EMPLOYEE_MANAGE',
  },
  'DELETE /employees/:id/documents/:docId': {
    summary: 'Delete employee document',
    description: 'Removes the document attachment from the employee profile.',
    permission: 'EMPLOYEE_MANAGE',
  },
  'GET /me/documents': {
    summary: 'List current user documents',
    description: 'Self-service endpoint listing documents for the authenticated user.',
  },
  'POST /me/documents/upload': {
    summary: 'Upload document for current user',
    description: 'Self-service multipart upload for the authenticated user.',
  },
  'GET /me/documents/:docId/download': {
    summary: 'Download current user document',
    description: 'Self-service download of a document belonging to the authenticated user.',
  },
  'GET /roles': {
    summary: 'List assignable tenant role templates and their required scope shapes',
    permission: 'ROLE_ASSIGNMENT_READ',
  },
  'GET /compliance-records': {
    summary: 'List company compliance records',
    permission: 'COMPLIANCE_READ',
  },
  'POST /compliance-records': {
    summary: 'Create compliance record (GST/TAN/licence/cert/insurance)',
    permission: 'COMPLIANCE_MANAGE',
  },
  'PATCH /compliance-records/:id': {
    summary: 'Update compliance record',
    permission: 'COMPLIANCE_MANAGE',
  },
  'POST /compliance-records/:id/status': {
    summary: 'Transition compliance record status',
    permission: 'COMPLIANCE_MANAGE',
  },
  'POST /compliance-records/:id/verify': {
    summary: 'Verify record (optional document attach)',
    permission: 'COMPLIANCE_MANAGE',
  },
  'GET /notifications': {
    summary: 'List own notifications (cursor-paginated)',
    permission: 'authenticated',
  },
  'POST /notifications/:id/read': {
    summary: 'Mark notification read',
    permission: 'authenticated',
  },
  'GET /notifications/ticket': {
    summary: 'Issue single-use WebSocket ticket',
    permission: 'authenticated',
  },
  'POST /platform/companies': {
    summary: 'Create customer company + first Company Admin (returns one-time claim code)',
    permission: 'PLATFORM_COMPANY_CREATE',
  },
  'GET /platform/companies': {
    summary: 'List customer companies',
    permission: 'PLATFORM_COMPANY_READ',
  },
  'POST /platform/companies/:companyId/claim-token': {
    summary: 'Reissue admin claim code (invalidates prior codes)',
    permission: 'PLATFORM_COMPANY_CREATE',
  },
  'GET /platform/companies/:companyId': {
    summary: 'Get customer company details, head offices, and admin info',
    permission: 'PLATFORM_COMPANY_READ',
  },
  'PATCH /platform/companies/:companyId': {
    summary: 'Update customer company profile from platform portal',
    permission: 'PLATFORM_COMPANY_CREATE',
  },
  'POST /platform/companies/:companyId/status': {
    summary: 'Transition customer company status (ACTIVE/SUSPENDED/ARCHIVED)',
    permission: 'PLATFORM_COMPANY_CREATE',
  },
  'POST /platform/companies/:companyId/impersonate': {
    summary: 'Impersonate company owner (Platform Admin only)',
    description:
      'Creates an impersonated session as the tenant company administrator. Records audit trail.',
    permission: 'PLATFORM_COMPANY_READ',
  },
  'GET /platform/operations': {
    summary: 'List global operations catalogue (Platform Admin)',
    permission: 'PLATFORM_COMPANY_READ',
  },
  'POST /platform/operations': {
    summary: 'Create global operation in master catalogue',
    permission: 'PLATFORM_COMPANY_CREATE',
  },
  'DELETE /platform/operations/:key': {
    summary: 'Delete global operation from master catalogue (fails if in use)',
    permission: 'PLATFORM_COMPANY_CREATE',
  },
  'GET /forms': { summary: 'List forms in company', permission: 'FORM_READ' },
  'POST /forms': { summary: 'Create draft form definition', permission: 'FORM_CONFIGURE' },
  'GET /forms/:id': { summary: 'Get form definition by ID', permission: 'FORM_READ' },
  'PATCH /forms/:id': { summary: 'Update draft form definition', permission: 'FORM_CONFIGURE' },
  'POST /forms/:id/status': {
    summary: 'Transition form status (DRAFT/ACTIVE/ARCHIVED)',
    permission: 'FORM_CONFIGURE',
  },
  'POST /forms/:id/publish': {
    summary: 'Publish form draft to immutable revision',
    permission: 'FORM_PUBLISH',
  },
  'GET /forms/:id/versions': {
    summary: 'List published revisions of a form',
    permission: 'FORM_READ',
  },
  'GET /attendance/policies': {
    summary: 'List attendance policies',
    permission: 'ATTENDANCE_READ',
  },
  'POST /attendance/policies': {
    summary: 'Create attendance policy',
    permission: 'ATTENDANCE_MANAGE',
  },
  'GET /attendance/policies/effective': {
    summary: 'Resolve effective attendance policy',
    permission: 'ATTENDANCE_READ',
  },
  'GET /attendance/policies/:id': {
    summary: 'Get attendance policy by ID',
    permission: 'ATTENDANCE_READ',
  },
  'PATCH /attendance/policies/:id': {
    summary: 'Update attendance policy',
    permission: 'ATTENDANCE_MANAGE',
  },
  'POST /attendance/punch-in': {
    summary: 'Punch In session with geofence validation',
    permission: 'ATTENDANCE_RECORD',
  },
  'POST /attendance/punch-out': {
    summary: 'Punch Out session and calculate work units',
    permission: 'ATTENDANCE_RECORD',
  },
  'POST /attendance/breaks/start': {
    summary: 'Start dynamic break',
    permission: 'ATTENDANCE_RECORD',
  },
  'POST /attendance/breaks/end': {
    summary: 'End active dynamic break',
    permission: 'ATTENDANCE_RECORD',
  },
  'GET /attendance/sessions/active': {
    summary: 'Get active in-progress attendance session',
    description:
      'Returns active session enriched with delay clock-in timing (if delayed) and clock-out time for proper 8 working hours.',
    permission: 'ATTENDANCE_READ',
  },
  'GET /attendance/sessions': {
    summary: 'List attendance sessions',
    permission: 'ATTENDANCE_READ',
  },
  'GET /attendance/sessions/:id': {
    summary: 'Get attendance session details',
    permission: 'ATTENDANCE_READ',
  },
  'POST /attendance/sessions/:id/regularize': {
    summary: 'Regularize attendance session',
    permission: 'ATTENDANCE_MANAGE',
  },
  'GET /attendance/daily-summary': {
    summary: 'Daily muster roll / hazri summary',
    permission: 'ATTENDANCE_READ',
  },
  'POST /attendance/kiosk/batch-punch-in': {
    summary: 'Batch punch in workers via kiosk',
    permission: 'ATTENDANCE_RECORD',
  },
  'POST /attendance/kiosk/batch-punch-out': {
    summary: 'Batch punch out workers via kiosk',
    permission: 'ATTENDANCE_RECORD',
  },
  'POST /attendance/kiosk/sync': {
    summary: 'Sync offline kiosk attendance sessions',
    permission: 'ATTENDANCE_RECORD',
  },
  'POST /attendance/tvt': {
    summary: 'Create Safety Toolbox Talk session',
    permission: 'ATTENDANCE_RECORD',
  },
  'GET /attendance/tvt': {
    summary: 'List Safety Toolbox Talk sessions',
    permission: 'ATTENDANCE_READ',
  },
  'GET /attendance/tvt/:id': {
    summary: 'Get Safety Toolbox Talk session details',
    permission: 'ATTENDANCE_READ',
  },
  'POST /attendance/tvt/:id/attendees': {
    summary: 'Add attendees to Safety Toolbox Talk session',
    permission: 'ATTENDANCE_RECORD',
  },
  'GET /attendance/muster-roll': {
    summary: 'Range muster roll period settlement export',
    permission: 'ATTENDANCE_READ',
  },
  'POST /attendance/daily-reports/calculate': {
    summary: 'Auto-calculate or re-calculate daily site report for a business date',
    permission: 'ATTENDANCE_MANAGE',
  },
  'GET /attendance/daily-reports': {
    summary: 'List daily site reports with site, date range and status filters',
    permission: 'ATTENDANCE_READ',
  },
  'GET /attendance/daily-reports/:id': {
    summary: 'Get daily site report details with labour breakdown and session totals',
    permission: 'ATTENDANCE_READ',
  },
  'PATCH /attendance/daily-reports/:id': {
    summary: 'Update daily site report header, weather, work progress and safety notes',
    permission: 'ATTENDANCE_MANAGE',
  },
  'PATCH /attendance/daily-reports/:id/labour-summary/:summaryId': {
    summary: 'Adjust labour summary headcount or hours with mandatory justification reason',
    permission: 'ATTENDANCE_MANAGE',
  },
  'POST /attendance/daily-reports/:id/submit': {
    summary: 'Submit daily site report for Project Manager review',
    permission: 'ATTENDANCE_RECORD',
  },
  'POST /attendance/daily-reports/:id/approve': {
    summary: 'Approve daily site report by Project Manager',
    permission: 'ATTENDANCE_MANAGE',
  },
  'POST /attendance/daily-reports/:id/reject': {
    summary: 'Reject daily site report with revision notes',
    permission: 'ATTENDANCE_MANAGE',
  },
  'POST /attendance/daily-reports/:id/lock': {
    summary: 'Lock and freeze daily site report for immutable payroll and billing certification',
    permission: 'ATTENDANCE_MANAGE',
  },
  'GET /attendance/daily-reports/:id/audit-trail': {
    summary: 'Fetch audit log history of changes made to daily site report',
    permission: 'ATTENDANCE_READ',
  },
  'POST /leave/policies': {
    summary: 'Create leave policy',
    permission: 'LEAVE_MANAGE',
  },
  'GET /leave/policies': {
    summary: 'List leave policies',
    permission: 'LEAVE_READ',
  },
  'PATCH /leave/policies/:id': {
    summary: 'Update leave policy',
    permission: 'LEAVE_MANAGE',
  },
  'GET /leave/policies/effective': {
    summary: 'Resolve effective leave policy',
    permission: 'LEAVE_READ',
  },
  'POST /leave/allocations': {
    summary: 'Allocate leave balance',
    permission: 'LEAVE_MANAGE',
  },
  'GET /leave/balances': {
    summary: 'List leave balances',
    permission: 'LEAVE_READ',
  },
  'GET /leave/balances/:employeeId': {
    summary: 'Get employee leave balance',
    permission: 'LEAVE_READ',
  },
  'POST /leave/requests': {
    summary: 'Submit leave request',
    permission: 'LEAVE_APPLY',
  },
  'GET /leave/requests': {
    summary: 'List leave requests',
    permission: 'LEAVE_READ',
  },
  'GET /leave/requests/:id': {
    summary: 'Get leave request details',
    permission: 'LEAVE_READ',
  },
  'POST /leave/requests/:id/review': {
    summary: 'Review leave request (approve/reject)',
    permission: 'LEAVE_APPROVE',
  },
  'POST /leave/requests/:id/cancel': {
    summary: 'Cancel leave request',
    permission: 'LEAVE_APPLY',
  },
  'GET /approval-tasks': {
    summary: 'List approval tasks assigned to the caller',
    permission: 'WORKFLOW_APPROVAL_READ',
  },
  'GET /approval-tasks/:id': {
    summary: 'Get an approval task assigned to the caller',
    permission: 'WORKFLOW_APPROVAL_READ',
  },
  'GET /approval-tasks/:id/decisions': {
    summary: 'List decisions on an assigned approval task',
    permission: 'WORKFLOW_APPROVAL_READ',
  },
  'POST /approval-tasks/:id/decisions': {
    summary: 'Decide an assigned approval task (approve/reject/return)',
    permission: 'WORKFLOW_APPROVAL_DECIDE',
  },
  'POST /finance/projects/:projectId/budgets': {
    summary: 'Create a project budget (operation: PROJECT_BUDGET_CREATE)',
    description:
      'Body: {code, name, description?, currency, idempotencyKey?}. Currency is ISO 4217; ' +
      'codes normalize to upper-case. idempotencyKey replays the recorded budget when the ' +
      'semantic fingerprint matches, 409 IDEMPOTENCY_CONFLICT when it differs. ' +
      'Errors: 403 OPERATION_NOT_ASSIGNED (employee lacks PROJECT_BUDGET_CREATE), ' +
      '404 project, 409 duplicate code, 422 validation.',
    permission: 'FINANCE_BUDGET_MANAGE',
  },
  'GET /finance/projects/:projectId/budgets': {
    summary: 'List budgets for a project (operation: PROJECT_BUDGET_VIEW)',
    description:
      'Query: {status?, limit?, cursor?} — keyset pagination, ascending id, ' +
      'nextCursor in the response while more rows exist.',
    permission: 'FINANCE_BUDGET_READ',
  },
  'GET /finance/budgets/:id': {
    summary: 'Get a budget with revisions and latest approved revision',
    description:
      'Response: budget header + latestApprovedRevisionId + revisions (with lines). ' +
      '404 when the budget is missing or belongs to another company.',
    permission: 'FINANCE_BUDGET_READ',
  },
  'PATCH /finance/budgets/:id': {
    summary: 'Update budget header fields (optimistic version required)',
    description:
      'Body: {expectedVersion, name?, description?, currency?}. Header-only — cannot ' +
      'touch revisions, lines, status, or latestApprovedRevisionId (no approval bypass). ' +
      '422 on stale version or non-ACTIVE budget.',
    permission: 'FINANCE_BUDGET_MANAGE',
  },
  'POST /finance/budgets/:id/revisions': {
    summary: 'Create an immutable budget revision (operation: PROJECT_BUDGET_REVISE)',
    description:
      'Body: {notes?, idempotencyKey?, lines: [{category, description, amount}]} — ' +
      'category is MATERIAL|LABOUR|EQUIPMENT|SUBCONTRACT|OVERHEAD|CONTINGENCY|OTHER; ' +
      'amount is a decimal string (18,2). totalAmount is server-computed. ' +
      '409 REVISION_IN_PROGRESS while a DRAFT/SUBMITTED revision is open.',
    permission: 'FINANCE_BUDGET_MANAGE',
  },
  'GET /finance/budgets/:id/revisions': {
    summary: 'List revisions of a budget (operation: PROJECT_BUDGET_VIEW)',
    description: 'Query: {status?} — ascending revision number, includes lines.',
    permission: 'FINANCE_BUDGET_READ',
  },
  'GET /finance/budgets/:id/revisions/:revisionId': {
    summary: 'Get a revision with lines and decision history',
    description: 'Response: revision + lines + append-only decisions array.',
    permission: 'FINANCE_BUDGET_READ',
  },
  'POST /finance/budgets/:id/revisions/:revisionId/submit': {
    summary: 'Submit a draft revision for review (operation: PROJECT_BUDGET_REVISE)',
    description:
      'Body: {expectedVersion?}. Workflow: DRAFT → SUBMITTED; writes audit + outbox ' +
      'in the same transaction. Idempotent by state — a retry by the same submitter ' +
      'returns replayed:true. 409 INVALID_STATUS_TRANSITION otherwise.',
    permission: 'FINANCE_BUDGET_MANAGE',
  },
  'POST /finance/budgets/:id/revisions/:revisionId/decisions': {
    summary:
      'Decide a submitted revision — self-approval forbidden (operation: PROJECT_BUDGET_APPROVE)',
    description:
      'Body: {action: APPROVE|REJECT|RETURN, reason?, expectedVersion?, idempotencyKey?}. ' +
      'Workflow: SUBMITTED → APPROVED|REJECTED|RETURNED (append-only decision row); ' +
      'APPROVE promotes budget.latestApprovedRevisionId. 403 SELF_APPROVAL_FORBIDDEN ' +
      'for the submitter. idempotencyKey replays on fingerprint match, ' +
      '409 IDEMPOTENCY_CONFLICT on mismatch.',
    permission: 'FINANCE_BUDGET_MANAGE',
  },
  'GET /finance/budgets/:id/revisions/:revisionId/decisions': {
    summary: 'List review decisions on a revision',
    description: 'Append-only history ordered by decidedAt — the approval outcome trail.',
    permission: 'FINANCE_BUDGET_READ',
  },
  'GET /finance/projects/:projectId/costs': {
    summary: 'Verified cost rollup: approved budgets + active forecasts (no fabricated actuals)',
    description:
      'Response: {budgets: [{id, code, name, currency, approvedRevision}], ' +
      'cashFlowForecasts: {count, totalInflow, totalOutflow, net}, commitments, actuals}. ' +
      'commitments/actuals are null until a Finance transaction ledger exists.',
    permission: 'FINANCE_BUDGET_READ',
  },
  'POST /finance/projects/:projectId/cash-flow-forecasts': {
    summary: 'Create a cash-flow forecast (operation: PROJECT_CASH_FLOW_FORECAST_SUBMIT)',
    description:
      'Body: {name, description?, currency, periodStart, periodEnd, idempotencyKey?, ' +
      'lines: [{direction: INFLOW|OUTFLOW, category, amount, expectedDate?, description?}]}. ' +
      'Category enums: inflow CLIENT_RECEIPT|ADVANCE_RECEIPT|RETENTION_RELEASE; ' +
      'outflow MATERIAL|LABOUR|EQUIPMENT|SUBCONTRACT|OVERHEAD|TAX|OTHER. ' +
      'Dates are YYYY-MM-DD, periodEnd >= periodStart.',
    permission: 'FINANCE_BUDGET_MANAGE',
  },
  'GET /finance/projects/:projectId/cash-flow-forecasts': {
    summary: 'List cash-flow forecasts for a project (operation: PROJECT_CASH_FLOW_REVIEW)',
    description:
      'Query: {status?, limit?, cursor?} — keyset pagination, ascending id, ' +
      'nextCursor in the response while more rows exist.',
    permission: 'FINANCE_BUDGET_READ',
  },
  'GET /finance/cash-flow-forecasts/:id': {
    summary: 'Get a cash-flow forecast with lines (operation: PROJECT_CASH_FLOW_REVIEW)',
    permission: 'FINANCE_BUDGET_READ',
  },
  'PATCH /finance/cash-flow-forecasts/:id': {
    summary:
      'Revise a forecast — version-guarded, bumps revision (operation: PROJECT_CASH_FLOW_FORECAST_REVISE)',
    description:
      'Body: {expectedVersion, reason?, name?, description?, currency?, periodStart?, ' +
      'periodEnd?, idempotencyKey?, lines?}. Header+lines replaced atomically; revision ' +
      'increments. 422 on stale version; 409 IDEMPOTENCY_CONFLICT on key reuse ' +
      'with a different command.',
    permission: 'FINANCE_BUDGET_MANAGE',
  },
  'GET /finance/projects': {
    summary: 'Finance project portfolio (operation: PROJECT_DASHBOARD_VIEW)',
    description:
      'Query: {status?: PLANNED|ACTIVE|ON_HOLD|COMPLETED|ARCHIVED, search?, limit?, cursor?} — ' +
      'keyset pagination on id; search matches code/name/city (case-insensitive). ' +
      'Each item embeds its headOffice {id, code, name}.',
    permission: 'FINANCE_PORTFOLIO_READ',
  },
  'GET /finance/projects/:projectId/sites': {
    summary: 'Sites of a project (operation: PROJECT_DASHBOARD_VIEW)',
    description:
      'Query: {status?, limit?, cursor?}. Exact geofence coordinates are withheld — ' +
      'address fields and geoFenceRadiusM are returned. 404 project/cross-company.',
    permission: 'FINANCE_PORTFOLIO_READ',
  },
  'GET /finance/employees': {
    summary: 'Employee directory for Finance (operation: FINANCE_EMPLOYEE_DIRECTORY_VIEW)',
    description:
      'Query: {projectId?, siteId?, departmentId?, status?, search?, limit?, cursor?} — ' +
      'placement filters match ACTIVE department memberships only; search matches ' +
      'displayName/employeeCode. Items: {id, employeeCode, displayName, status, ' +
      'createdAt, primaryMembership}.',
    permission: 'FINANCE_EMPLOYEE_READ',
  },
  'GET /finance/employees/:employeeId': {
    summary: 'Employee detail (operation: FINANCE_EMPLOYEE_DIRECTORY_VIEW)',
    description:
      'Directory fields + active department memberships. employmentDetails ' +
      '(engagement, designation, trade, contacts) is null unless the caller ALSO holds ' +
      'FINANCE_EMPLOYEE_SENSITIVE_READ + FINANCE_EMPLOYMENT_DETAILS_VIEW.',
    permission: 'FINANCE_EMPLOYEE_READ',
  },
  'GET /finance/employees/:employeeId/attendance-summary': {
    summary: 'Attendance aggregates for payroll input (operation: PAYROLL_INPUT_REVIEW)',
    description:
      'Query: {from, to} — YYYY-MM-DD business dates, inclusive. Returns unit/hour ' +
      'totals + session/flagged/site counts only; no GPS coordinates, remarks, or ' +
      'per-punch detail. 404 employee/cross-company; 422 bad range.',
    permission: 'FINANCE_EMPLOYEE_READ',
  },
  'GET /finance/employees/:employeeId/leave-summary': {
    summary: 'Leave balances and request stats (operation: FINANCE_EMPLOYMENT_DETAILS_VIEW)',
    description:
      'Query: {year}. Balances per leave type (allocated/used/pending/carried-over/' +
      'available) + requests grouped by status with day totals. Reasons and ' +
      'documents are never returned.',
    permission: 'FINANCE_EMPLOYEE_READ',
  },
  'GET /finance/dashboard': {
    summary: 'Finance dashboard — verified aggregates only (operation: PROJECT_DASHBOARD_VIEW)',
    description:
      'projects/sites byStatus + budgets totals & approved sums per currency + ' +
      'pendingBudgetReviews + active cash-flow sums per currency. workforce is null ' +
      'without FINANCE_EMPLOYEE_READ + FINANCE_EMPLOYEE_DIRECTORY_VIEW. Sections with ' +
      'no data model are listed in unavailable[] — never fabricated.',
    permission: 'FINANCE_DASHBOARD_READ',
  },
  'GET /audit-logs': {
    summary: 'List company audit logs with filtering and actor resolution',
    permission: 'AUDIT_LOG_VIEW',
  },
  'GET /audit-logs/:id': {
    summary: 'Get details of a company audit log entry',
    permission: 'AUDIT_LOG_VIEW',
  },
  'GET /mail/config': {
    summary: 'Get active mail server configuration',
  },
  'POST /mail/verify': {
    summary: 'Verify SMTP mail server connectivity and credentials',
  },
  'POST /mail/send': {
    summary: 'Send an email via SMTP server',
  },
};

export interface BuildAppOptions {
  env?: NodeJS.ProcessEnv;
  // Test hooks: substitute service boundaries without touching Prisma/Redis.
  services?: {
    authService?: AuthService;
    mfaService?: MfaService;
    accessControl?: AccessControlService;
    notificationService?: NotificationService;
    employeeService?: EmployeeService;
    employeeAccessService?: EmployeeAccessService;
    complianceService?: ComplianceService;
    platformService?: PlatformService;
    formService?: FormService;
    attendanceService?: AttendanceService;
    leaveService?: LeaveService;
    scheduleService?: ScheduleService;
    approvalService?: ApprovalService;
    financeService?: FinanceService;
    employeeDocumentService?: EmployeeDocumentService;
    documentService?: DocumentService;
    organizationService?: OrganizationService;
    delegationService?: DelegationService;
    departmentService?: DepartmentService;
    auditService?: AuditService;
    // Test hook: inject the sentinel platform-company id (null = none).
    platformCompanyId?: string | null;
  };
}

export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const logLevel = opts.env?.LOG_LEVEL ?? process.env.LOG_LEVEL ?? 'info';
  const nodeEnv = opts.env?.NODE_ENV ?? process.env.NODE_ENV ?? 'development';

  const app = Fastify({
    logger: {
      level: logLevel,
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers["x-api-key"]',
          'res.headers["set-cookie"]',
          'body.password',
          'body.refreshToken',
        ],
        censor: '[Redacted]',
      },
    },
    requestIdHeader: 'x-request-id',
    genReqId: () => crypto.randomUUID(),
    bodyLimit: 1_048_576,
    requestTimeout: 30_000,
  }).withTypeProvider<TypeBoxTypeProvider>();

  // Infrastructure plugins in explicit dependency order.
  await app.register(configPlugin, { ...(opts.env !== undefined ? { env: opts.env } : {}) });
  await app.register(requestContextPlugin);
  await app.register(multipartPlugin);
  await app.register(errorHandlerPlugin);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(cors, {
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'x-company-id',
      'x-request-id',
      'ngrok-skip-browser-warning',
    ],
  });

  // Rate limiting: Redis store in production (fails closed on outage — the
  // dedicated client connects eagerly and queues nothing offline, so a dead
  // Redis surfaces as an error, never a silent per-process fallback). The
  // in-memory store is acceptable for dev/test only.
  const rateLimitRedis = nodeEnv === 'production' ? app.redis.duplicate() : undefined;
  if (rateLimitRedis !== undefined) {
    rateLimitRedis.on('error', (err: unknown) => {
      app.log.error({ err }, 'rate-limit redis error');
    });
    // Connect during boot so requests always hit a ready client — a dead
    // Redis fails the app start outright rather than degrading to silent
    // per-process limits.
    app.addHook('onReady', async () => {
      await rateLimitRedis.connect();
    });
    app.addHook('onClose', async () => {
      rateLimitRedis.disconnect();
    });
  }
  await app.register(rateLimit, {
    global: false,
    ...(rateLimitRedis !== undefined ? { redis: rateLimitRedis } : {}),
  });

  // OpenAPI generation from the same TypeBox schemas used for validation —
  // single source of truth, no drifting contract. Swagger UI is a developer
  // tool: disabled in production unless SWAGGER_UI=true; /openapi.json is
  // always available (no secrets in generated examples).
  // OpenAPI generation from the same TypeBox schemas used for validation.
  // Exposure policy: documentation is a development tool — BOTH Swagger UI
  // (/docs) and the JSON spec are unavailable in production builds. No safe
  // verified access control exists for them yet, so production exposure is
  // impossible by construction (not merely disabled).
  const docsEnabled = nodeEnv !== 'production';
  if (docsEnabled) {
    await app.register(swagger, {
      openapi: {
        info: {
          title: 'Sarjan Construction ERP API',
          description:
            'Tenant-scoped Construction ERP API. Authentication: Authorization: Bearer <JWT> ({sub,sid}). Tenant routes additionally require the x-company-id header; platform routes and /auth/claim do not.\n\nWebSocket (separate from HTTP ops): GET /api/v1/notifications/stream upgrades to a WebSocket — not an HTTP JSON endpoint. Native clients send Authorization: Bearer <JWT>; browsers pass a single-use ticket (from POST /api/v1/notifications/ticket) in Sec-WebSocket-Protocol. Frames deliver notification payloads for the authenticated principal in its company scope.',
          version: '0.1.0',
        },
        components: {
          securitySchemes: {
            bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
          },
        },
        security: [{ bearerAuth: [] }],
        tags: [
          { name: 'auth', description: 'Unauthenticated — no company context' },
          {
            name: 'org',
            description: 'Tenant-scoped — requires Authorization + x-company-id',
          },
          { name: 'department' },
          { name: 'employee' },
          { name: 'compliance' },
          { name: 'notification' },
          {
            name: 'platform',
            description: 'Platform operator only — x-company-id is ignored/rejected',
          },
          { name: 'health', description: 'Unauthenticated liveness' },
        ],
      },
      transform: (args) => {
        // Per-operation metadata derived from the route's real registration —
        // public routes get security:[], tenant routes get x-company-id,
        // platform routes get bearerAuth only (never x-company-id).
        const { schema, url } = args;
        // Schema-less routes (GETs) still get security/summary metadata.
        const s = ((schema as Record<string, unknown> | undefined) ?? {}) as Record<
          string,
          unknown
        > & {
          summary?: string;
          description?: string;
          tags?: string[];
          security?: unknown[];
          headers?: Record<string, unknown>;
        };
        const rawMethod =
          (Array.isArray(args.route.method) ? args.route.method[0] : args.route.method) ?? '';
        // Fastify auto-registers HEAD for every GET — classify it with the GET.
        const method = rawMethod === 'HEAD' ? 'GET' : rawMethod;
        const path = url.replace(/^\/api\/v1/, '');
        const methodPath = `${method} ${path}`;
        const op = OPERATION_DOCS[methodPath];
        // The WebSocket route is NOT an HTTP JSON API — documented separately.
        const isWebSocket = methodPath === 'GET /notifications/stream';
        const PUBLIC = new Set([
          'GET /health',
          'GET /ready',
          'POST /auth/login',
          'POST /auth/refresh',
          'POST /auth/mfa/verify',
          'POST /auth/mfa/send-otp',
          'POST /auth/claim',
          'GET /auth/claim/verify',
          'POST /auth/claim/onboard',
        ]);
        const TENANT_TAGS: [string, string][] = [
          ['/org/', 'org'],
          ['/departments', 'department'],
          ['/employees', 'employee'],
          ['/roles', 'employee'],
          ['/compliance-records', 'compliance'],
          ['/notifications', 'notification'],
          ['/forms', 'form'],
          ['/audit-logs', 'audit'],
        ];
        if (PUBLIC.has(methodPath)) {
          s.security = []; // explicitly unauthenticated
        } else {
          s.security = [{ bearerAuth: [] }]; // protected — per-op, not inherited
        }
        if (path.startsWith('/platform/')) {
          s.security = [{ bearerAuth: [] }];
          s.tags = ['platform'];
        } else {
          const tenant = TENANT_TAGS.find(([p]) => path.startsWith(p));
          if (tenant !== undefined) {
            s.tags = [tenant[1]];
            s.headers = {
              type: 'object',
              required: ['x-company-id'],
              properties: {
                'x-company-id': {
                  type: 'string',
                  format: 'uuid',
                  description: 'Active tenant company (must match caller role assignments)',
                },
              },
            };
          }
        }
        if (isWebSocket) {
          // Documented contract: the handshake IS this GET — the client then
          // upgrades. Auth: Authorization header (native) OR single-use ticket
          // in Sec-WebSocket-Protocol (browser); message frames carry
          // notification payloads for the authenticated principal only.
          s.summary = 'Notification realtime stream (WebSocket upgrade)';
          s.description =
            'WebSocket upgrade endpoint — not an HTTP JSON API. Native clients send Authorization: Bearer; browsers pass a single-use ticket from POST /api/v1/notifications/ticket via Sec-WebSocket-Protocol. Frames deliver company-scoped notifications.';
        }
        s.summary = op?.summary ?? s.summary ?? methodPath;
        if (op?.description !== undefined) s.description = op.description;
        if (op?.permission !== undefined) {
          s.description = `${s.description ?? ''} (required permission: ${op.permission})`.trim();
        }
        // Deterministic unique operationId: lowerCamel(method + path); HEAD
        // keeps its own name so getX/headX never collide.
        s.operationId =
          rawMethod.toLowerCase() +
          path
            .replace(/[:/{}-]+/g, ' ')
            .trim()
            .split(' ')
            .filter(Boolean)
            .map((w, i) => (i === 0 ? w : w.charAt(0).toUpperCase() + w.slice(1)))
            .join('');
        const isPublic = PUBLIC.has(methodPath);
        const isWrite = rawMethod === 'POST' || rawMethod === 'PATCH';
        const hasPathParam = path.includes(':');
        // Response catalog matches the real error-handler shape
        // { error: { code, message, requestId } } — success schema left to the
        // route's own validator where present.
        const err = (desc: string) => ({
          description: desc,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  error: {
                    type: 'object',
                    properties: {
                      code: { type: 'string' },
                      message: { type: 'string' },
                      requestId: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        });
        if (s.responses === undefined) {
          s.responses = {
            200: { description: 'Success' },
            ...(isWrite ? { 400: err('Validation error (malformed body)') } : {}),
            ...(isPublic
              ? { 429: err('Rate limited') }
              : {
                  401: err('Missing/invalid Bearer token'),
                  403: err('Permission denied or platform/tenant boundary violation'),
                }),
            ...(hasPathParam ? { 404: err('Entity not found in company scope') } : {}),
            ...(isWrite
              ? {
                  409: err('Conflict (duplicate or stale version)'),
                  422: err('Domain validation error'),
                }
              : {}),
            500: err('Unexpected server error'),
          };
        }
        return { schema: s as unknown as typeof schema, url };
      },
    });
    if (app.config.SWAGGER_UI) {
      await app.register(swaggerUi, { routePrefix: '/docs', staticCSP: true });
    }
    app.get('/documentation/json', { schema: { hide: true } }, async () => app.swagger());
  }

  // Constructed lazily so tests can inject service doubles that never touch
  // PostgreSQL.
  const services = opts.services ?? {};
  let authService = services.authService;
  let accessControl = services.accessControl;
  let notificationService = services.notificationService;

  const userProfileCache =
    app.config.NODE_ENV === 'test'
      ? new InMemoryUserProfileCache()
      : new RedisUserProfileCache(app.redis);

  await app.register(authenticationPlugin, {
    buildActorContext: (claims, meta): Promise<PrincipalContext> => {
      if (!authService) throw new Error('auth service not initialized');
      return authService.buildActorContext(claims, meta);
    },
  });

  const mailService = new MailService();
  const mfaService =
    services.mfaService ??
    new MfaService(
      app.redis,
      mailService,
      (payload) => app.jwt.sign(payload, { expiresIn: '5m' }),
      (token) => app.jwt.verify<MfaTokenPayload>(token),
    );

  authService ??= new AuthService(
    new PrismaAuthUnitOfWork(app.prisma),
    app.tokenService,
    {
      accessTokenTtlS: app.config.ACCESS_TOKEN_TTL_S,
      refreshTokenTtlS: app.config.REFRESH_TOKEN_TTL_S,
    },
    () => new Date(),
    (companyId, employeeId) => opAssignment.getEffectiveOperations(companyId, employeeId),
    userProfileCache,
    mfaService,
  );
  accessControl ??= new AccessControlService({
    principals: makeAuthRepos(app.prisma).principals,
    access: makeAccessRepository(app.prisma),
  });
  // Late-bound for the auth login resolver: this const is referenced by the
  // AuthService closure above and dereferenced only at login time.
  const opAssignment = new OperationAssignmentService(app.prisma, {
    assertPermission: (pid: string, key: string, target: ScopeTarget) =>
      accessControl.assertPermission(pid, key, target),
  });

  const platformResolver = async (): Promise<string | null> => {
    if (services.platformCompanyId !== undefined) return services.platformCompanyId;
    const row = await app.prisma.company.findFirst({ where: { isPlatform: true } });
    return row?.id ?? null;
  };
  await app.register(authorizationPlugin, {
    accessControl,
    resolvePlatformCompanyId: platformResolver,
  });

  // Notifications: durable inbox + ticket + realtime stream. The service is
  // lazy-injectable for tests; the WS gateway subscribes lazily per principal.
  notificationService ??= new NotificationService({
    uow: new PrismaNotificationUnitOfWork(app.prisma),
    ticketStore: new RedisTicketStore(app.redis),
    publisher: new RedisNotificationPublisher(app.redis),
    signTicket: (claims) => app.jwt.sign(claims, { expiresIn: '30s' }),
    buildActorContext: (claims, meta) => authService.buildActorContext(claims, meta),
  });
  const notificationGateway = new NotificationGateway({
    subscriber: app.redis.duplicate(),
    revalidate: (sub, sid) => notificationService.revalidate(sub, sid),
  });
  app.addHook('onClose', async () => {
    await notificationGateway.closeAll();
  });

  await app.register(websocketPlugin);
  await app.register(
    notificationRoutes({
      service: notificationService,
      gateway: notificationGateway,
      verifyToken: (token) =>
        app.tokenService.verifyAccessToken(token) as unknown as Record<string, unknown>,
    }),
    { prefix: '/api/v1' },
  );
  // Relay worker — production lifecycle only ('auto'); never in unit tests.
  await app.register(notificationWorkerPlugin, {
    // BullMQ Worker requires maxRetriesPerRequest: null — dedicated client
    // separate from the rate-limit and publisher connections.
    worker: new NotificationWorker(
      notificationService,
      app.redis.duplicate({ maxRetriesPerRequest: null }),
      (msg, meta) => {
        app.log.info(meta ?? {}, msg);
      },
    ),
  });

  // Domain route plugins, versioned.
  const storageDir = app.config.DOCUMENT_STORAGE_DIR ?? join(tmpdir(), 'sarjan-docs');
  const documentStorage = new LocalDiskStorage(storageDir);
  const documentService =
    services.documentService ??
    new DocumentService({
      uow: new PrismaDocumentUnitOfWork(app.prisma),
      authorizer: accessControl,
      storage: documentStorage,
      maxBytes: 10 * 1024 * 1024,
      staleUploadingMinutes: 60,
    });
  const financeService =
    services.financeService ??
    new FinanceService(
      new PrismaFinanceUnitOfWork(app.prisma),
      {
        assertPermission: (pid: string, key: string, target: ScopeTarget) =>
          accessControl.assertPermission(pid, key, target),
        hasPermission: (pid: string, key: string, target: ScopeTarget) =>
          accessControl.hasPermission(pid, key, target),
      },
      (companyId, employeeId) => opAssignment.getEffectiveOperations(companyId, employeeId),
    );
  const delegationService =
    services.delegationService ??
    new DelegationService(app.prisma, {
      assertPermission: (pid: string, key: string, target: ScopeTarget) =>
        accessControl.assertPermission(pid, key, target),
    });
  await app.register(delegationRoutes(delegationService), { prefix: '/api/v1' });
  await app.register(
    organizationRoutes(
      services.organizationService ??
        new OrganizationService(new PrismaOrgUnitOfWork(app.prisma), {
          hasPermission: (pid: string, key: string, target: ScopeTarget) =>
            accessControl.hasPermission(pid, key, target),
          assertPermission: (pid: string, key: string, target: ScopeTarget) =>
            accessControl.assertPermission(pid, key, target),
          delegationEnabled: (companyId: string, flag) =>
            delegationService.isEnabled(companyId, flag),
          assertInitialBudgetAuthority: (actor, companyId) =>
            financeService.assertInitialBudgetAuthority(actor, companyId),
        }),
      { documentService },
    ),
    {
      prefix: '/api/v1',
    },
  );
  await app.register(
    departmentRoutes(
      services.departmentService ??
        new DepartmentService(new PrismaDepartmentUnitOfWork(app.prisma), {
          assertPermission: (pid: string, key: string, target: ScopeTarget) =>
            accessControl.assertPermission(pid, key, target),
          hasPermission: (pid: string, key: string, target: ScopeTarget) =>
            accessControl.hasPermission(pid, key, target),
          delegationEnabled: (companyId: string, flag) =>
            delegationService.isEnabled(companyId, flag),
        }),
    ),
    { prefix: '/api/v1' },
  );
  const employeeDocumentService =
    services.employeeDocumentService ??
    new EmployeeDocumentService({
      repo: new PrismaEmployeeDocumentRepository(app.prisma),
      documentService,
      prisma: app.prisma,
      authorizer: {
        assertPermission: (pid: string, key: string, target: ScopeTarget) =>
          accessControl.assertPermission(pid, key, target),
      },
    });

  await app.register(
    employeeRoutes(
      services.employeeService ??
        new EmployeeService(
          new PrismaEmployeeUnitOfWork(app.prisma),
          {
            assertPermission: (pid: string, key: string, target: ScopeTarget) =>
              accessControl.assertPermission(pid, key, target),
            hasPermission: (pid: string, key: string, target: ScopeTarget) =>
              accessControl.hasPermission(pid, key, target),
            delegationEnabled: (companyId: string, flag) =>
              delegationService.isEnabled(companyId, flag),
          },
          userProfileCache,
        ),
      services.employeeAccessService ??
        new EmployeeAccessService(
          app.prisma,
          userProfileCache,
          mailService,
          app.config.APP_BASE_URL,
          app.config.CLAIM_URL_ORIGINS.split(',')
            .map((o) => o.trim())
            .filter((o) => o !== ''),
          nodeEnv === 'production',
        ),
      employeeDocumentService,
    ),
    { prefix: '/api/v1' },
  );
  await app.register(operationAssignmentRoutes(opAssignment), { prefix: '/api/v1' });
  await app.register(
    complianceRoutes(services.complianceService ?? new ComplianceService(app.prisma)),
    { prefix: '/api/v1' },
  );
  await app.register(
    formRoutes(
      services.formService ??
        new FormService(new PrismaFormUnitOfWork(app.prisma), {
          assertPermission: (pid: string, key: string, target: ScopeTarget) =>
            accessControl.assertPermission(pid, key, target),
        }),
    ),
    { prefix: '/api/v1' },
  );
  const attendanceService =
    services.attendanceService ??
    new AttendanceService(new PrismaAttendanceUnitOfWork(app.prisma), {
      assertPermission: (pid: string, key: string, target: ScopeTarget) =>
        accessControl.assertPermission(pid, key, target),
      assertAnyScopePermission: (pid: string, key: string, cid: string) =>
        accessControl.assertAnyScopePermission(pid, key, cid),
    });
  await app.register(attendanceRoutes(attendanceService), { prefix: '/api/v1' });
  await app.register(attendanceWorkerPlugin, {
    worker: new AttendanceWorker(
      attendanceService,
      app.redis.duplicate({ maxRetriesPerRequest: null }),
      (msg, meta) => {
        app.log.info(meta ?? {}, msg);
      },
    ),
  });
  await app.register(mailRoutes(mailService), { prefix: '/api/v1' });
  const roleDispatcher = new RoleNotificationDispatcher(
    app.prisma,
    new RedisNotificationPublisher(app.redis),
    mailService,
  );
  await app.register(
    leaveRoutes(
      services.leaveService ??
        new LeaveService(
          new PrismaLeaveUnitOfWork(app.prisma),
          {
            assertPermission: (pid: string, key: string, target: ScopeTarget) =>
              accessControl.assertPermission(pid, key, target),
            assertAnyScopePermission: (pid: string, key: string, cid: string) =>
              accessControl.assertAnyScopePermission(pid, key, cid),
          },
          roleDispatcher,
        ),
    ),
    { prefix: '/api/v1' },
  );
  await app.register(
    scheduleRoutes(
      services.scheduleService ??
        new ScheduleService(new PrismaScheduleUnitOfWork(app.prisma), {
          assertPermission: (pid: string, key: string, target: ScopeTarget) =>
            accessControl.assertPermission(pid, key, target),
        }),
    ),
    { prefix: '/api/v1' },
  );
  await app.register(
    approvalRoutes(
      services.approvalService ??
        new ApprovalService(new PrismaApprovalUnitOfWork(app.prisma), {
          assertPermission: (pid: string, key: string, target: ScopeTarget) =>
            accessControl.assertPermission(pid, key, target),
          hasPermission: (pid: string, key: string, target: ScopeTarget) =>
            accessControl.hasPermission(pid, key, target),
        }),
    ),
    { prefix: '/api/v1' },
  );
  await app.register(financeRoutes(financeService), { prefix: '/api/v1' });
  await app.register(
    auditRoutes(
      services.auditService ??
        new AuditService(app.prisma, {
          assertPermission: (pid: string, key: string, target: ScopeTarget) =>
            accessControl.assertPermission(pid, key, target),
        }),
    ),
    { prefix: '/api/v1' },
  );
  await app.register(
    platformRoutes(
      services.platformService ??
        new PlatformService(
          new PrismaPlatformUnitOfWork(app.prisma),
          app.config.APP_BASE_URL,
          (actor, principalId, meta) =>
            authService.createImpersonationSession(actor, principalId, meta),
          nodeEnv === 'production',
        ),
      platformResolver,
    ),
    { prefix: '/api/v1' },
  );
  await app.register(healthRoutes, { prefix: '/api/v1' });
  await app.register(
    authRoutes({
      service: authService,
      rateLimit: {
        max: app.config.AUTH_RATE_LIMIT_MAX,
        timeWindow: app.config.AUTH_RATE_LIMIT_WINDOW_MS,
      },
    }),
    { prefix: '/api/v1' },
  );

  return app;
}
