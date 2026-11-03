import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Type } from '@sinclair/typebox';
import type { EmployeeService } from './service.js';
import type { EmployeeAccessService } from './access.js';
import type { ScopeTarget } from '../access-control/service.js';
import { UnauthorizedError } from '../../common/errors/app-error.js';
import type { ActorContext } from '../organization/types.js';

const CreateEmployee = Type.Object({
  employeeCode: Type.String({ minLength: 1, maxLength: 40 }),
  displayName: Type.String({ minLength: 1, maxLength: 200 }),
});
// expectedVersion is REQUIRED on every mutation — stale writes must fail
// closed, not silently overwrite a concurrent change.
const UpdateEmployee = Type.Object({
  displayName: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
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
          expectedVersion?: number;
        };
        return service.update(
          actorOf(req),
          companyIdOf(req),
          (req.params as { id: string }).id,
          patch,
          expectedVersion,
        );
      },
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
