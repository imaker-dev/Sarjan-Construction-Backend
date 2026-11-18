import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Type } from '@sinclair/typebox';
import { UnauthorizedError } from '../../common/errors/app-error.js';
import type { ScopeTarget } from '../access-control/service.js';
import type { ActorContext } from '../organization/types.js';
import {
  LEAVE_APPLY,
  LEAVE_APPROVE,
  LEAVE_MANAGE,
  LEAVE_READ,
  type LeaveService,
} from './service.js';
import {
  AllocateLeaveBalanceBody,
  CancelLeaveRequestBody,
  CreateLeavePolicyBody,
  LeaveTypeEnum,
  ListLeaveBalancesQuery,
  ListLeavePoliciesQuery,
  ListLeaveRequestsQuery,
  ReviewLeaveRequestBody,
  SubmitLeaveRequestBody,
  UpdateLeavePolicyBody,
  type AllocateLeaveBalanceInput,
  type CancelLeaveRequestInput,
  type CreateLeavePolicyInput,
  type ListLeaveBalancesFilter,
  type ListLeavePoliciesFilter,
  type ListLeaveRequestsFilter,
  type ReviewLeaveRequestInput,
  type SubmitLeaveRequestInput,
  type UpdateLeavePolicyInput,
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

const EffectivePolicyQuery = Type.Object({
  leaveType: LeaveTypeEnum,
  siteId: Type.Optional(Type.String({ format: 'uuid' })),
  projectId: Type.Optional(Type.String({ format: 'uuid' })),
  employeeId: Type.Optional(Type.String({ format: 'uuid' })),
});

export function leaveRoutes(service: LeaveService) {
  return async function routes(app: FastifyInstance) {
    const perm = (key: string) => ({
      preHandler: [app.authenticate, app.tenantCompanyGuard, app.requirePermission(key, atCompany)],
    });

    // -------------------------------------------------------------------------
    // Policies
    // -------------------------------------------------------------------------

    app.post(
      '/leave/policies',
      { schema: { body: CreateLeavePolicyBody }, ...perm(LEAVE_MANAGE) },
      async (req, reply) => {
        const policy = await service.createPolicy(
          actorOf(req),
          companyIdOf(req),
          req.body as CreateLeavePolicyInput,
        );
        reply.code(201);
        return policy;
      },
    );

    app.get(
      '/leave/policies',
      { schema: { querystring: ListLeavePoliciesQuery }, ...perm(LEAVE_READ) },
      async (req) => {
        return service.listPolicies(
          actorOf(req),
          companyIdOf(req),
          req.query as ListLeavePoliciesFilter,
        );
      },
    );

    app.patch(
      '/leave/policies/:id',
      {
        schema: {
          params: PolicyParams,
          body: UpdateLeavePolicyBody,
        },
        ...perm(LEAVE_MANAGE),
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

    app.get(
      '/leave/policies/effective',
      { schema: { querystring: EffectivePolicyQuery }, ...perm(LEAVE_READ) },
      async (req) => {
        const query = req.query as {
          leaveType: LeaveType;
          siteId?: string;
          projectId?: string;
          employeeId?: string;
        };
        return service.resolveEffectivePolicy(
          actorOf(req),
          companyIdOf(req),
          query.leaveType,
          {
            ...(query.siteId !== undefined ? { siteId: query.siteId } : {}),
            ...(query.projectId !== undefined ? { projectId: query.projectId } : {}),
            ...(query.employeeId !== undefined ? { employeeId: query.employeeId } : {}),
          },
        );
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
      { schema: { querystring: ListLeaveBalancesQuery }, ...perm(LEAVE_READ) },
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
        },
        ...perm(LEAVE_READ),
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
      { schema: { body: SubmitLeaveRequestBody }, ...perm(LEAVE_APPLY) },
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
      { schema: { querystring: ListLeaveRequestsQuery }, ...perm(LEAVE_READ) },
      async (req) => {
        return service.listRequests(
          actorOf(req),
          companyIdOf(req),
          req.query as ListLeaveRequestsFilter,
        );
      },
    );

    app.get(
      '/leave/requests/:id',
      { schema: { params: RequestParams }, ...perm(LEAVE_READ) },
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
        },
        ...perm(LEAVE_APPROVE),
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

    app.post(
      '/leave/requests/:id/cancel',
      {
        schema: {
          params: RequestParams,
          body: CancelLeaveRequestBody,
        },
        ...perm(LEAVE_APPLY),
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
