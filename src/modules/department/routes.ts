import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Type } from '@sinclair/typebox';
import type { DepartmentService } from './service.js';
import type { ScopeTarget } from '../access-control/service.js';
import { UnauthorizedError } from '../../common/errors/app-error.js';
import type { ActorContext } from '../organization/types.js';

const CreateDepartment = Type.Object({
  scopeType: Type.Union([Type.Literal('COMPANY'), Type.Literal('PROJECT'), Type.Literal('SITE')]),
  scopeId: Type.Optional(Type.String({ format: 'uuid' })),
  code: Type.String({ minLength: 1, maxLength: 40 }),
  name: Type.String({ minLength: 1, maxLength: 200 }),
  capabilityKey: Type.Optional(Type.String({ maxLength: 80 })),
  headEmployeeId: Type.Optional(Type.String({ format: 'uuid' })),
  baseHeadOfficeId: Type.Optional(Type.String({ format: 'uuid' })),
});
const UpdateDepartment = Type.Object({
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  capabilityKey: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  headEmployeeId: Type.Optional(Type.Union([Type.String({ format: 'uuid' }), Type.Null()])),
  baseHeadOfficeId: Type.Optional(Type.Union([Type.String({ format: 'uuid' }), Type.Null()])),
  expectedVersion: Type.Optional(Type.Integer()),
});
const StatusBody = Type.Object({
  to: Type.Union([
    Type.Literal('DRAFT'),
    Type.Literal('ACTIVE'),
    Type.Literal('SUSPENDED'),
    Type.Literal('ARCHIVED'),
  ]),
  expectedVersion: Type.Optional(Type.Integer()),
});
const ListQuery = Type.Object({
  status: Type.Optional(Type.String()),
  projectId: Type.Optional(Type.String({ format: 'uuid' })),
  siteId: Type.Optional(Type.String({ format: 'uuid' })),
});

function companyIdOf(request: FastifyRequest): string {
  const companyId = request.headers['x-company-id'];
  if (typeof companyId !== 'string' || companyId.length === 0) {
    throw new UnauthorizedError('COMPANY_REQUIRED', 'x-company-id header required');
  }
  return companyId;
}
const atCompany = (request: FastifyRequest): ScopeTarget => {
  const companyId = companyIdOf(request);
  return { companyId, scopeType: 'COMPANY', scopeId: companyId };
};
const actorOf = (request: FastifyRequest): ActorContext => ({
  actorId: (request.principal as { actorId: string }).actorId,
  actorType: 'USER',
});

export function departmentRoutes(service: DepartmentService) {
  return async function routes(app: FastifyInstance) {
    const auth = (key?: string) => ({
      preHandler:
        key === undefined
          ? [app.authenticate, app.tenantCompanyGuard]
          : [app.authenticate, app.tenantCompanyGuard, app.requirePermission(key, atCompany)],
    });

    // Writes: create is checked at the declared scope inside the service too;
    // update/status rely on the service's per-department scope check.
    app.post(
      '/departments',
      { schema: { body: CreateDepartment }, ...auth('DEPARTMENT_CONFIGURE') },
      async (req) => service.createDepartment(actorOf(req), companyIdOf(req), req.body as never),
    );
    app.get(
      '/departments',
      { schema: { querystring: ListQuery }, ...auth('DEPARTMENT_READ') },
      async (req) => {
        const q = req.query as { status?: never; projectId?: string; siteId?: string };
        return service.listDepartments(actorOf(req), companyIdOf(req), q);
      },
    );
    app.patch(
      '/departments/:id',
      { schema: { body: UpdateDepartment }, ...auth() },
      async (req) => {
        const { expectedVersion, ...patch } = req.body as Record<string, unknown> & {
          expectedVersion?: number;
        };
        return service.updateDepartment(
          actorOf(req),
          companyIdOf(req),
          (req.params as { id: string }).id,
          patch,
          expectedVersion,
        );
      },
    );
    app.post('/departments/:id/status', { schema: { body: StatusBody }, ...auth() }, async (req) =>
      service.transitionDepartmentStatus(
        actorOf(req),
        companyIdOf(req),
        (req.params as { id: string }).id,
        (req.body as { to: string }).to,
        (req.body as { expectedVersion?: number }).expectedVersion,
      ),
    );
  };
}
