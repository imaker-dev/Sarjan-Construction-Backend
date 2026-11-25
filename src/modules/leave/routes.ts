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
    const perm = (key: string) => ({
      preHandler: [app.authenticate, app.tenantCompanyGuard, app.requirePermission(key, atCompany)],
    });
    const anyScopePerm = (key: string) => ({
      preHandler: [
        app.authenticate,
        app.tenantCompanyGuard,
        app.requireAnyScopePermission(key, companyIdOf),
      ],
    });

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
      { schema: { body: CreateLeavePolicyBody }, ...perm(LEAVE_MANAGE) },
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
      { schema: { querystring: ListLeavePoliciesQuery }, ...anyScopePerm(LEAVE_READ) },
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
      { schema: { querystring: EffectiveLeavePolicyQuery }, ...anyScopePerm(LEAVE_READ) },
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
      { schema: { params: PolicyParams }, ...anyScopePerm(LEAVE_READ) },
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

    app.post(
      '/leave/policies/:id/archive',
      {
        schema: { params: PolicyParams, body: ArchiveLeavePolicyBody },
        ...perm(LEAVE_MANAGE),
      },
      async (req) => {
        const { id } = req.params as { id: string };
        const body = req.body as ArchiveLeavePolicyInput;
        return service.archivePolicy(actorOf(req), companyIdOf(req), id, body.expectedVersion);
      },
    );

    app.get(
      '/leave/policies/:id/versions',
      { schema: { params: PolicyParams }, ...anyScopePerm(LEAVE_READ) },
      async (req) => {
        const { id } = req.params as { id: string };
        return service.listVersions(actorOf(req), companyIdOf(req), id);
      },
    );

    app.post(
      '/leave/policies/:id/versions',
      {
        schema: { params: PolicyParams, body: AddLeavePolicyVersionBody },
        ...perm(LEAVE_MANAGE),
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
      { schema: { params: PolicyVersionParams, body: Type.Object({}) }, ...perm(LEAVE_MANAGE) },
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
      { schema: { querystring: ListLeaveBalancesQuery }, ...anyScopePerm(LEAVE_READ) },
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
        ...anyScopePerm(LEAVE_READ),
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
      { schema: { querystring: ListLeaveRequestsQuery }, ...anyScopePerm(LEAVE_READ) },
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
      { schema: { params: RequestParams }, ...anyScopePerm(LEAVE_READ) },
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
        ...anyScopePerm(LEAVE_APPROVE),
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
        ...anyScopePerm(LEAVE_APPLY),
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
