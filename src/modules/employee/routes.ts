import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Type } from '@sinclair/typebox';
import type { EmployeeService } from './service.js';
import type { EmployeeAccessService } from './access.js';
import type { ScopeTarget } from '../access-control/service.js';
import { UnauthorizedError } from '../../common/errors/app-error.js';
import type { ActorContext } from '../organization/types.js';

const EngagementType = Type.Union([
  Type.Literal('DIRECT_EMPLOYEE'),
  Type.Literal('CONTRACTOR_WORKER'),
  Type.Literal('DAILY_WAGE'),
  Type.Literal('APPRENTICE'),
  Type.Literal('CONSULTANT'),
  Type.Literal('OTHER'),
]);
const CreateEmployee = Type.Object({
  employeeCode: Type.String({ minLength: 1, maxLength: 40 }),
  displayName: Type.String({ minLength: 1, maxLength: 200 }),
  // Required on create; column is nullable for legacy rows.
  engagementType: EngagementType,
  designation: Type.Optional(Type.String({ maxLength: 120 })),
  tradeCategory: Type.Optional(Type.String({ maxLength: 80 })),
  joiningDate: Type.Optional(Type.String({ format: 'date' })),
  contactPhone: Type.Optional(Type.String({ maxLength: 20 })),
  contactEmail: Type.Optional(Type.String({ format: 'email' })),
  // Pair rule enforced in the service — both or neither.
  emergencyContactName: Type.Optional(Type.String({ maxLength: 120 })),
  emergencyContactPhone: Type.Optional(Type.String({ maxLength: 20 })),
});
const MembershipBody = Type.Object({
  departmentId: Type.String({ format: 'uuid' }),
  isPrimary: Type.Optional(Type.Boolean()),
  startedAt: Type.Optional(Type.String({ format: 'date-time' })),
});
const MembershipPatchBody = Type.Object({
  isPrimary: Type.Boolean(),
  expectedVersion: Type.Integer(),
});
// expectedVersion is REQUIRED on every mutation — stale writes must fail
// closed, not silently overwrite a concurrent change.
const UpdateEmployee = Type.Object({
  displayName: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  engagementType: Type.Optional(EngagementType),
  designation: Type.Optional(Type.Union([Type.String({ maxLength: 120 }), Type.Null()])),
  tradeCategory: Type.Optional(Type.Union([Type.String({ maxLength: 80 }), Type.Null()])),
  joiningDate: Type.Optional(Type.Union([Type.String({ format: 'date' }), Type.Null()])),
  contactPhone: Type.Optional(Type.Union([Type.String({ maxLength: 20 }), Type.Null()])),
  contactEmail: Type.Optional(Type.Union([Type.String({ format: 'email' }), Type.Null()])),
  emergencyContactName: Type.Optional(Type.Union([Type.String({ maxLength: 120 }), Type.Null()])),
  emergencyContactPhone: Type.Optional(Type.Union([Type.String({ maxLength: 20 }), Type.Null()])),
  expectedVersion: Type.Integer(),
});
const InviteBody = Type.Object({
  loginId: Type.String({ minLength: 3, maxLength: 320 }),
  loginIdType: Type.Literal('EMAIL'),
});
const AssignmentBody = Type.Object({
  roleKey: Type.String({ maxLength: 60 }),
  scopeType: Type.Union([Type.Literal('COMPANY'), Type.Literal('HEAD_OFFICE')]),
  scopeId: Type.Optional(Type.String({ format: 'uuid' })),
});
const StatusBody = Type.Object({
  to: Type.Union([Type.Literal('ACTIVE'), Type.Literal('INACTIVE')]),
  expectedVersion: Type.Integer(),
});
const ListQuery = Type.Object({
  status: Type.Optional(Type.String()),
  cursor: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});

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

export function employeeRoutes(service: EmployeeService, accessService?: EmployeeAccessService) {
  return async function routes(app: FastifyInstance) {
    const perm = (key: string) => ({
      preHandler: [app.authenticate, app.tenantCompanyGuard, app.requirePermission(key, atCompany)],
    });

    app.get(
      '/employees',
      { schema: { querystring: ListQuery }, ...perm('EMPLOYEE_READ') },
      async (req) =>
        service.list(
          actorOf(req),
          companyIdOf(req),
          req.query as {
            status?: string;
            cursor?: string;
            limit?: number;
          },
        ),
    );
    app.post(
      '/employees',
      { schema: { body: CreateEmployee }, ...perm('EMPLOYEE_MANAGE') },
      async (req) => service.create(actorOf(req), companyIdOf(req), req.body as never),
    );
    app.patch(
      '/employees/:id',
      { schema: { body: UpdateEmployee }, ...perm('EMPLOYEE_MANAGE') },
      async (req) => {
        const { expectedVersion, ...patch } = req.body as {
          displayName?: string;
          engagementType?: string | null;
          designation?: string | null;
          tradeCategory?: string | null;
          joiningDate?: string | null;
          contactPhone?: string | null;
          contactEmail?: string | null;
          emergencyContactName?: string | null;
          emergencyContactPhone?: string | null;
          expectedVersion?: number;
        };
        return service.update(
          actorOf(req),
          companyIdOf(req),
          (req.params as { id: string }).id,
          {
            ...patch,
            ...(patch.joiningDate !== undefined && patch.joiningDate !== null
              ? { joiningDate: new Date(patch.joiningDate) }
              : {}),
          } as never,
          expectedVersion,
        );
      },
    );
    app.get('/employees/:id', { ...perm('EMPLOYEE_READ') }, async (req) =>
      service.getById(actorOf(req), companyIdOf(req), (req.params as { id: string }).id),
    );
    app.post(
      '/employees/:id/status',
      { schema: { body: StatusBody }, ...perm('EMPLOYEE_MANAGE') },
      async (req) =>
        service.changeStatus(
          actorOf(req),
          companyIdOf(req),
          (req.params as { id: string }).id,
          (req.body as { to: 'ACTIVE' | 'INACTIVE' }).to,
          (req.body as { expectedVersion?: number }).expectedVersion,
        ),
    );

    // --------------------------------------------------------- Memberships
    // Organizational placement only — membership never satisfies permissions.
    app.get('/employees/:id/memberships', { ...perm('EMPLOYEE_READ') }, async (req) =>
      service.listMemberships(companyIdOf(req), (req.params as { id: string }).id),
    );
    app.post(
      '/employees/:id/memberships',
      { schema: { body: MembershipBody }, ...perm('EMPLOYEE_MANAGE') },
      async (req) => {
        const body = req.body as {
          departmentId: string;
          isPrimary?: boolean;
          startedAt?: string;
        };
        return service.addMembership(
          actorOf(req),
          companyIdOf(req),
          (req.params as { id: string }).id,
          {
            departmentId: body.departmentId,
            ...(body.isPrimary !== undefined ? { isPrimary: body.isPrimary } : {}),
            ...(body.startedAt !== undefined ? { startedAt: new Date(body.startedAt) } : {}),
          },
        );
      },
    );
    app.patch(
      '/employees/:id/memberships/:membershipId',
      { schema: { body: MembershipPatchBody }, ...perm('EMPLOYEE_MANAGE') },
      async (req) => {
        const { membershipId } = req.params as { id: string; membershipId: string };
        const { isPrimary, expectedVersion } = req.body as {
          isPrimary: boolean;
          expectedVersion: number;
        };
        return service.updateMembership(
          actorOf(req),
          companyIdOf(req),
          (req.params as { id: string }).id,
          membershipId,
          { isPrimary },
          expectedVersion,
        );
      },
    );
    app.post(
      '/employees/:id/memberships/:membershipId/end',
      {
        schema: { body: Type.Object({ expectedVersion: Type.Integer() }) },
        ...perm('EMPLOYEE_MANAGE'),
      },
      async (req) =>
        service.endMembership(
          actorOf(req),
          companyIdOf(req),
          (req.params as { id: string }).id,
          (req.params as { membershipId: string }).membershipId,
          (req.body as { expectedVersion: number }).expectedVersion,
        ),
    );

    // Phase 1 — account invite + whitelisted role assignments (Company Owner).
    if (accessService !== undefined) {
      app.post(
        '/employees/:id/invite',
        { schema: { body: InviteBody }, ...perm('EMPLOYEE_INVITE') },
        async (req) => {
          const { loginId, loginIdType } = req.body as {
            loginId: string;
            loginIdType?: string;
          };
          return accessService.invite(
            actorOf(req),
            companyIdOf(req),
            (req.params as { id: string }).id,
            loginId,
            loginIdType,
          );
        },
      );
      app.post('/employees/:id/invite/resend', { ...perm('EMPLOYEE_INVITE') }, async (req) =>
        accessService.resend(actorOf(req), companyIdOf(req), (req.params as { id: string }).id),
      );
      app.get('/employees/:id/assignments', { ...perm('ROLE_ASSIGNMENT_READ') }, async (req) =>
        accessService.listAssignments(companyIdOf(req), (req.params as { id: string }).id),
      );
      app.post(
        '/employees/:id/assignments',
        { schema: { body: AssignmentBody }, ...perm('ACCESS_ROLE_ASSIGN') },
        async (req) =>
          accessService.grant(actorOf(req), companyIdOf(req), {
            employeeId: (req.params as { id: string }).id,
            ...(req.body as { roleKey: string; scopeType: string; scopeId?: string }),
          }),
      );
      app.delete(
        '/employees/:id/assignments/:assignmentId',
        { ...perm('ACCESS_ROLE_REVOKE') },
        async (req) =>
          accessService.revoke(
            actorOf(req),
            companyIdOf(req),
            (req.params as { assignmentId: string }).assignmentId,
          ),
      );
    }
  };
}
