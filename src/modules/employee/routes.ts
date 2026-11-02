import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Type } from '@sinclair/typebox';
import type { EmployeeService } from './service.js';
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

export function employeeRoutes(service: EmployeeService) {
  return async function routes(app: FastifyInstance) {
    const perm = (key: string) => ({
      preHandler: [app.authenticate, app.requirePermission(key, atCompany)],
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
  };
}
