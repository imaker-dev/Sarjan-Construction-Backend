import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Type } from '@sinclair/typebox';
import { UnauthorizedError } from '../../common/errors/app-error.js';
import type { ScopeTarget } from '../access-control/service.js';
import { scopedOrAnyScope } from '../../common/auth/route-guards.js';
import { paginateArray, type OffsetQuery } from '../../common/http/pagination.js';
import type { ActorContext } from '../organization/types.js';
import {
  LEAVE_APPLY,
  LEAVE_APPROVE,
  LEAVE_MANAGE,
  LEAVE_READ,
  type LeaveService,
} from './service.js';
import {
  AddLeavePolicyVersionBody,
  AllocateLeaveBalanceBody,
  ArchiveLeavePolicyBody,
  ArchiveLeaveTypeDefBody,
  CancelLeaveRequestBody,
  CreateLeavePolicyBody,
  CreateLeaveTypeDefBody,
  EffectiveLeavePolicyQuery,
  LeaveTypeEnum,
  ListLeaveBalancesQuery,
  ListLeavePoliciesQuery,
  ListLeaveRequestsQuery,
  ListLeaveTypeDefsQuery,
  ResubmitLeaveRequestBody,
  ReviewLeaveRequestBody,
  SubmitLeaveRequestBody,
  UpdateLeavePolicyBody,
  UpdateLeaveTypeDefBody,
  type AddLeavePolicyVersionInput,
  type AllocateLeaveBalanceInput,
  type ArchiveLeavePolicyInput,
  type ArchiveLeaveTypeDefInput,
  type CancelLeaveRequestInput,
  type CreateLeavePolicyInput,
  type CreateLeaveTypeDefInput,
  type EffectiveLeavePolicyCriteria,
  type ListLeaveBalancesFilter,
  type ListLeavePoliciesFilter,
  type ListLeaveRequestsFilter,
  type ListLeaveTypeDefsFilter,
  type ResubmitLeaveRequestInput,
  type ReviewLeaveRequestInput,
  type SubmitLeaveRequestInput,
  type UpdateLeavePolicyInput,
  type UpdateLeaveTypeDefInput,
} from './types.js';
import type { LeaveType } from '@prisma/client';

function companyIdOf(request: FastifyRequest): string {
  const c = request.headers['x-company-id'];
  if (typeof c !== 'string' || c.length === 0) {
    throw new UnauthorizedError('COMPANY_REQUIRED', 'x-company-id header required');
  }
  return c;
}

const atCompany = (r: FastifyRequest): ScopeTarget => {
  const companyId = companyIdOf(r);
  return { companyId, scopeType: 'COMPANY', scopeId: companyId };
};

const actorOf = (r: FastifyRequest): ActorContext => ({
  actorId: (r.principal as { actorId: string }).actorId,
  actorType: 'USER',
});

const PolicyParams = Type.Object({
  id: Type.String({ format: 'uuid' }),
});

const RequestParams = Type.Object({
  id: Type.String({ format: 'uuid' }),
});

const EmployeeBalanceParams = Type.Object({
  employeeId: Type.String({ format: 'uuid' }),
});

const EmployeeBalanceQuery = Type.Object({
  leaveType: LeaveTypeEnum,
  year: Type.Optional(Type.Integer({ minimum: 2000, maximum: 2100 })),
});

const PolicyVersionParams = Type.Object({
  id: Type.String({ format: 'uuid' }),
  versionId: Type.String({ format: 'uuid' }),
});

export function leaveRoutes(service: LeaveService) {
  return async function routes(app: FastifyInstance) {
    // Route gates resolve the permission target from server-loaded entities —
    // the same contract as attendance. Scoped approvers (PI/PD/PM/SE) pass
    // only for requests/employees/departments inside their grant; anything
    // unresolvable falls back to COMPANY and fails closed.
    const perm = (
      key: string,
      resolveScope: (r: FastifyRequest) => ScopeTarget | Promise<ScopeTarget> = atCompany,
    ) => ({
      preHandler: [
        app.authenticate,
        app.tenantCompanyGuard,
        app.requirePermission(key, resolveScope),
      ],
    });
    const anyScopePerm = (key: string) => ({
      preHandler: [
        app.authenticate,
        app.tenantCompanyGuard,
        app.requireAnyScopePermission(key, companyIdOf),
      ],
    });

    const atRequest = (r: FastifyRequest): Promise<ScopeTarget> =>
      service.resolveScope(companyIdOf(r), 'request', (r.params as { id: string }).id);
    const atEmployeeParam = (r: FastifyRequest): Promise<ScopeTarget> =>
      service.resolveScope(
        companyIdOf(r),
        'employee',
        (r.params as { employeeId: string }).employeeId,
      );
    const atPolicy = (r: FastifyRequest): Promise<ScopeTarget> =>
      service.resolveScope(companyIdOf(r), 'policy', (r.params as { id: string }).id);

    /** Query-driven scope — explicit scope filters resolve to their own
     *  target; absent filters fall back to COMPANY (company administration
     *  and every employee's company-scope LEAVE_READ both satisfy it). */
    const queryScope = (r: FastifyRequest): Promise<ScopeTarget> | ScopeTarget => {
      const companyId = companyIdOf(r);
      const q = (r.query ?? {}) as {
        siteId?: string;
        projectId?: string;
        departmentId?: string;
        employeeId?: string;
      };
      if (q.siteId !== undefined) return { companyId, scopeType: 'SITE', scopeId: q.siteId };
      if (q.projectId !== undefined)
        return { companyId, scopeType: 'PROJECT', scopeId: q.projectId };
      if (q.departmentId !== undefined)
        return service.resolveScope(companyId, 'department', q.departmentId);
      if (q.employeeId !== undefined)
        return service.resolveScope(companyId, 'employee', q.employeeId);
      return atCompany(r);
    };

    /** Body-driven scope for policy creation — a DEPARTMENT-scope policy
     *  resolves through the real Department record (site departments → SITE,
     *  project departments → PROJECT, HO departments → HEAD_OFFICE) so a
     *  delegated PI's scoped LEAVE_MANAGE grant is checked at the right
     *  target. COMPANY/EMPLOYEE scopes are company administration and always
     *  resolve to the company target. The service performs the authoritative
     *  delegation-flag check after the gate. */
    const policyCreateScope = (r: FastifyRequest): Promise<ScopeTarget> | ScopeTarget => {
      const companyId = companyIdOf(r);
      const body = (r.body ?? {}) as { scopeType?: string; departmentId?: string };
      if (body.scopeType === 'DEPARTMENT' && body.departmentId !== undefined) {
        return service.resolveScope(companyId, 'department', body.departmentId);
      }
      return atCompany(r);
    };

    // -------------------------------------------------------------------------
    // Leave type definitions (administrator-configured vocabulary)
    // -------------------------------------------------------------------------

    app.post(
      '/leave/types',
      { schema: { body: CreateLeaveTypeDefBody }, ...perm(LEAVE_MANAGE) },
      async (req, reply) => {
        const created = await service.createTypeDef(
          actorOf(req),
          companyIdOf(req),
          req.body as CreateLeaveTypeDefInput,
        );
        reply.code(201);
        return created;
      },
    );

    app.get(
      '/leave/types',
      { schema: { querystring: ListLeaveTypeDefsQuery }, ...anyScopePerm(LEAVE_READ) },
      async (req) => {
        return service.listTypeDefs(
          actorOf(req),
          companyIdOf(req),
          req.query as ListLeaveTypeDefsFilter,
        );
      },
    );

    app.patch(
      '/leave/types/:id',
      { schema: { params: PolicyParams, body: UpdateLeaveTypeDefBody }, ...perm(LEAVE_MANAGE) },
      async (req) => {
        const { id } = req.params as { id: string };
        return service.updateTypeDef(
          actorOf(req),
          companyIdOf(req),
          id,
          req.body as UpdateLeaveTypeDefInput,
        );
      },
    );

    app.post(
      '/leave/types/:id/archive',
      {
        schema: { params: PolicyParams, body: ArchiveLeaveTypeDefBody },
        ...perm(LEAVE_MANAGE),
      },
      async (req) => {
        const { id } = req.params as { id: string };
        const body = req.body as ArchiveLeaveTypeDefInput;
        return service.archiveTypeDef(actorOf(req), companyIdOf(req), id, body.expectedVersion);
      },
    );

    // -------------------------------------------------------------------------
    // Policies
    // -------------------------------------------------------------------------

    app.post(
      '/leave/policies',
      {
        schema: {
          body: CreateLeavePolicyBody,
          description:
            'Create a leave policy. scopeType resolves the write target: DEPARTMENT resolves ' +
            'through the real Department (site → SITE, project → PROJECT, head office → ' +
            'HEAD_OFFICE); COMPANY/EMPLOYEE are company administration only. A scoped holder ' +
            '(PI/PM) may author site/project-department policies inside their grant only when ' +
            'the company enables the `leavePolicyManage` delegation switch.',
        },
        ...perm(LEAVE_MANAGE, policyCreateScope),
      },
      async (req, reply) => {
        const result = await service.createPolicy(
          actorOf(req),
          companyIdOf(req),
          req.body as CreateLeavePolicyInput,
        );
        reply.code(201);
        return result;
      },
    );

    app.get(
      '/leave/policies',
      {
        schema: {
          querystring: ListLeavePoliciesQuery,
          description:
            'List leave policies. siteId/projectId/departmentId/employeeId filters resolve to their ' +
            'permission target — scoped callers (PI/PD) may filter only inside their grant.',
        },
        ...scopedOrAnyScope(app, LEAVE_READ, companyIdOf, queryScope),
      },
      async (req) => {
        return service.listPolicies(
          actorOf(req),
          companyIdOf(req),
          req.query as ListLeavePoliciesFilter,
        );
      },
    );

    app.get(
      '/leave/policies/effective',
      {
        schema: {
          querystring: EffectiveLeavePolicyQuery,
          description:
            'Preview the effective policy for an employee/type/date. Previewing another employee ' +
            'resolves their department scope — scoped approvers see only in-scope employees.',
        },
        ...scopedOrAnyScope(app, LEAVE_READ, companyIdOf, queryScope),
      },
      async (req) => {
        return service.resolveEffectiveConfig(
          actorOf(req),
          companyIdOf(req),
          req.query as EffectiveLeavePolicyCriteria,
        );
      },
    );

    app.get(
      '/leave/policies/:id',
      { schema: { params: PolicyParams }, ...perm(LEAVE_READ, atPolicy) },
      async (req) => {
        const { id } = req.params as { id: string };
        return service.getPolicy(actorOf(req), companyIdOf(req), id);
      },
    );

    app.patch(
      '/leave/policies/:id',
      {
        schema: {
          params: PolicyParams,
          body: UpdateLeavePolicyBody,
          description:
            'Update a leave policy. The persisted policy resolves the write target — ' +
            'DEPARTMENT/SITE/PROJECT policies at SITE/PROJECT targets may be edited by a ' +
            'delegated scoped holder (`leavePolicyManage` switch); COMPANY/EMPLOYEE policies ' +
            'stay company-only.',
        },
        ...perm(LEAVE_MANAGE, atPolicy),
      },
      async (req) => {
        const { id } = req.params as { id: string };
        return service.updatePolicy(
          actorOf(req),
          companyIdOf(req),
          id,
          req.body as UpdateLeavePolicyInput,
        );
      },
    );

    app.post(
      '/leave/policies/:id/archive',
      {
        schema: {
          params: PolicyParams,
          body: ArchiveLeavePolicyBody,
          description:
            'Archive (deactivate) a leave policy. Same scoped authorization as update — ' +
            'delegated site/project policy writes require `leavePolicyManage`.',
        },
        ...perm(LEAVE_MANAGE, atPolicy),
      },
      async (req) => {
        const { id } = req.params as { id: string };
        const body = req.body as ArchiveLeavePolicyInput;
        return service.archivePolicy(actorOf(req), companyIdOf(req), id, body.expectedVersion);
      },
    );

    app.get(
      '/leave/policies/:id/versions',
      { schema: { params: PolicyParams }, ...perm(LEAVE_READ, atPolicy) },
      async (req) => {
        const { id } = req.params as { id: string };
        return service.listVersions(actorOf(req), companyIdOf(req), id);
      },
    );

    app.post(
      '/leave/policies/:id/versions',
      {
        schema: {
          params: PolicyParams,
          body: AddLeavePolicyVersionBody,
          description:
            'Append an immutable accrual version (effectiveFrom ≥ today). Same scoped ' +
            'authorization as update — delegated site/project policy writes require ' +
            '`leavePolicyManage`.',
        },
        ...perm(LEAVE_MANAGE, atPolicy),
      },
      async (req, reply) => {
        const { id } = req.params as { id: string };
        const version = await service.addVersion(
          actorOf(req),
          companyIdOf(req),
          id,
          req.body as AddLeavePolicyVersionInput,
        );
        reply.code(201);
        return version;
      },
    );

    app.post(
      '/leave/policies/:id/versions/:versionId/cancel',
      {
        schema: {
          params: PolicyVersionParams,
          body: Type.Object({}),
          description:
            'Cancel a mistaken accrual version (never the sole ACTIVE one). Same scoped ' +
            'authorization as update — delegated site/project policy writes require ' +
            '`leavePolicyManage`.',
        },
        ...perm(LEAVE_MANAGE, atPolicy),
      },
      async (req) => {
        const { id, versionId } = req.params as { id: string; versionId: string };
        return service.cancelVersion(actorOf(req), companyIdOf(req), id, versionId);
      },
    );

    // -------------------------------------------------------------------------
    // Balances & Allocations
    // -------------------------------------------------------------------------

    app.post(
      '/leave/allocations',
      { schema: { body: AllocateLeaveBalanceBody }, ...perm(LEAVE_MANAGE) },
      async (req, reply) => {
        const balance = await service.allocateBalance(
          actorOf(req),
          companyIdOf(req),
          req.body as AllocateLeaveBalanceInput,
        );
        reply.code(201);
        return balance;
      },
    );

    app.get(
      '/leave/balances',
      {
        schema: {
          querystring: ListLeaveBalancesQuery,
          description:
            'List leave balances. Unfiltered lists show the caller’s own balance; employeeId or ' +
            'siteId/projectId/departmentId filters require approver authority at the resolved scope.',
        },
        ...scopedOrAnyScope(app, LEAVE_READ, companyIdOf, queryScope),
      },
      async (req) => {
        return service.listBalances(
          actorOf(req),
          companyIdOf(req),
          req.query as ListLeaveBalancesFilter,
        );
      },
    );

    app.get(
      '/leave/balances/:employeeId',
      {
        schema: {
          params: EmployeeBalanceParams,
          querystring: EmployeeBalanceQuery,
          description:
            'Read one employee’s balance for a leave type/year. The owner may read their own; ' +
            'anyone else needs approver authority at the employee’s resolved department scope.',
        },
        ...perm(LEAVE_READ, atEmployeeParam),
      },
      async (req) => {
        const { employeeId } = req.params as { employeeId: string };
        const query = req.query as { leaveType: LeaveType; year?: number };
        const year = query.year ?? new Date().getUTCFullYear();
        return service.getEmployeeBalance(
          actorOf(req),
          companyIdOf(req),
          employeeId,
          query.leaveType,
          year,
        );
      },
    );

    // -------------------------------------------------------------------------
    // Requests & Lifecycle
    // -------------------------------------------------------------------------

    app.post(
      '/leave/requests',
      { schema: { body: SubmitLeaveRequestBody }, ...anyScopePerm(LEAVE_APPLY) },
      async (req, reply) => {
        const request = await service.submitRequest(
          actorOf(req),
          companyIdOf(req),
          req.body as SubmitLeaveRequestInput,
        );
        reply.code(201);
        return request;
      },
    );

    app.get(
      '/leave/requests',
      {
        schema: {
          querystring: ListLeaveRequestsQuery,
          description:
            'List leave requests. Unfiltered lists show the caller’s own requests; employeeId or ' +
            'siteId/projectId/departmentId filters require approver authority at the resolved scope ' +
            '(PI/PD see only their site/project workforce).',
        },
        ...scopedOrAnyScope(app, LEAVE_READ, companyIdOf, queryScope),
      },
      async (req) => {
        const q = req.query as ListLeaveRequestsFilter & OffsetQuery;
        const rows = await service.listRequests(actorOf(req), companyIdOf(req), q);
        return paginateArray(rows, q, (r, term) => {
          const emp = (r as { employee?: { displayName?: string; employeeCode?: string } }).employee;
          return (
            r.leaveType.toLowerCase().includes(term) ||
            r.reason.toLowerCase().includes(term) ||
            (emp?.displayName?.toLowerCase().includes(term) ?? false) ||
            (emp?.employeeCode?.toLowerCase().includes(term) ?? false)
          );
        });
      },
    );

    app.get(
      '/leave/requests/:id',
      {
        schema: {
          params: RequestParams,
          description:
            'Read one leave request. The requester may read their own; others need approver ' +
            'authority at the requester department’s resolved scope (evaluated at the request start).',
        },
        ...perm(LEAVE_READ, atRequest),
      },
      async (req) => {
        const { id } = req.params as { id: string };
        return service.getRequestById(actorOf(req), companyIdOf(req), id);
      },
    );

    app.post(
      '/leave/requests/:id/review',
      {
        schema: {
          params: RequestParams,
          body: ReviewLeaveRequestBody,
          description:
            'Approve, reject, or return a pending request. Scope resolves from the requester’s ' +
            'department at the request start — PI/PD approve site/project-dept requests inside their ' +
            'grant. REJECT and RETURN require remarks. A requester who is themselves a scoped ' +
            'approver (PI/PD/PM/SE) may only be reviewed by company-level approvers; self-approval ' +
            'is always rejected.',
        },
        ...perm(LEAVE_APPROVE, atRequest),
      },
      async (req) => {
        const { id } = req.params as { id: string };
        return service.reviewRequest(
          actorOf(req),
          companyIdOf(req),
          id,
          req.body as ReviewLeaveRequestInput,
        );
      },
    );

    /** Owner resubmission of a RETURNED request — corrects dates/reason/
     *  document and re-enters PENDING with a fresh review cycle. */
    app.post(
      '/leave/requests/:id/resubmit',
      {
        schema: {
          params: RequestParams,
          body: ResubmitLeaveRequestBody,
          description:
            'Owner resubmission of a RETURNED request — corrects dates/reason/document and ' +
            're-enters PENDING with a fresh review cycle. The full submission pipeline ' +
            '(boundary, notice, conflict, balance reservation) is re-validated.',
        },
        ...perm(LEAVE_APPLY, atRequest),
      },
      async (req) => {
        const { id } = req.params as { id: string };
        return service.resubmitRequest(
          actorOf(req),
          companyIdOf(req),
          id,
          req.body as ResubmitLeaveRequestInput,
        );
      },
    );

    app.post(
      '/leave/requests/:id/cancel',
      {
        schema: {
          params: RequestParams,
          body: CancelLeaveRequestBody,
          description:
            'Cancel a PENDING/RETURNED/APPROVED request — releases reserved or refunds used ' +
            'balance. The owner may cancel their own; others need LEAVE_MANAGE at the resolved scope.',
        },
        ...perm(LEAVE_APPLY, atRequest),
      },
      async (req) => {
        const { id } = req.params as { id: string };
        return service.cancelRequest(
          actorOf(req),
          companyIdOf(req),
          id,
          req.body as CancelLeaveRequestInput,
        );
      },
    );
  };
}
