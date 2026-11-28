import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Type } from '@sinclair/typebox';
import type { DepartmentService } from './service.js';
import type { ScopeTarget } from '../access-control/service.js';
import { scopedOrAnyScope } from '../../common/auth/route-guards.js';
import { UnauthorizedError } from '../../common/errors/app-error.js';
import { paginateArray, type OffsetQuery } from '../../common/http/pagination.js';
import type { ActorContext } from '../organization/types.js';

const CreateDepartment = Type.Object({
  scopeType: Type.Union([Type.Literal('COMPANY'), Type.Literal('PROJECT'), Type.Literal('SITE')]),
  scopeId: Type.Optional(Type.String({ format: 'uuid' })),
  code: Type.String({ minLength: 1, maxLength: 40 }),
  name: Type.String({ minLength: 1, maxLength: 200 }),
  category: Type.Union([
    Type.Literal('FINANCE'),
    Type.Literal('ADMINISTRATION'),
    Type.Literal('HR'),
    Type.Literal('PROCUREMENT'),
    Type.Literal('STORE'),
    Type.Literal('MACHINERY'),
    Type.Literal('SAFETY'),
    Type.Literal('QUALITY'),
    Type.Literal('SITE_ENGINEERING'),
    Type.Literal('KITCHEN'),
    Type.Literal('OPERATIONS'),
    Type.Literal('CUSTOM'),
  ]),
  categoryLabel: Type.Optional(Type.String({ maxLength: 80 })),
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
    Type.Literal('INACTIVE'),
    Type.Literal('SUSPENDED'),
    Type.Literal('ARCHIVED'),
  ]),
  expectedVersion: Type.Optional(Type.Integer()),
});
const ListQuery = Type.Object({
  status: Type.Optional(Type.String()),
  projectId: Type.Optional(Type.String({ format: 'uuid' })),
  siteId: Type.Optional(Type.String({ format: 'uuid' })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  offset: Type.Optional(Type.Integer({ minimum: 0 })),
  page: Type.Optional(Type.Integer({ minimum: 1 })),
  paginated: Type.Optional(Type.Boolean()),
  q: Type.Optional(Type.String({ maxLength: 100 })),
});
const Params = Type.Object({
  id: Type.String({ format: 'uuid' }),
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

// Route-level scope for department creation follows the body's declared
// scopeType — a project/site-scoped grant authorizes its own departments; a
// company grant covers all via scope chains. The service re-asserts at the
// resolved scope and additionally enforces the deptManage delegation switch.
const atDeclaredScope = (request: FastifyRequest): ScopeTarget => {
  const companyId = companyIdOf(request);
  const body = request.body as { scopeType?: string; scopeId?: string };
  switch (body.scopeType) {
    case 'PROJECT':
      return { companyId, scopeType: 'PROJECT', scopeId: body.scopeId ?? '' };
    case 'SITE':
      return { companyId, scopeType: 'SITE', scopeId: body.scopeId ?? '' };
    default:
      return { companyId, scopeType: 'COMPANY', scopeId: companyId };
  }
};

// List queries authorize at the requested scope filter — a project/site
// scoped grant lists its own departments; no filter means company-wide, which
// stays company-scope only. The service re-asserts the same target.
const atListScope = (request: FastifyRequest): ScopeTarget => {
  const companyId = companyIdOf(request);
  const q = request.query as { projectId?: string; siteId?: string };
  if (q.siteId !== undefined) return { companyId, scopeType: 'SITE', scopeId: q.siteId };
  if (q.projectId !== undefined) return { companyId, scopeType: 'PROJECT', scopeId: q.projectId };
  return { companyId, scopeType: 'COMPANY', scopeId: companyId };
};

export function departmentRoutes(service: DepartmentService) {
  return async function routes(app: FastifyInstance) {
    const auth = (key?: string, target: (r: FastifyRequest) => ScopeTarget = atCompany) => ({
      preHandler:
        key === undefined
          ? [app.authenticate, app.tenantCompanyGuard]
          : [app.authenticate, app.tenantCompanyGuard, app.requirePermission(key, target)],
    });

    // Writes: create is checked at the declared scope inside the service too;
    // update/status rely on the service's per-department scope check.
    app.post(
      '/departments',
      { schema: { body: CreateDepartment }, ...auth('DEPARTMENT_CONFIGURE', atDeclaredScope) },
      async (req) => service.createDepartment(actorOf(req), companyIdOf(req), req.body as never),
    );
    app.get(
      '/departments',
      {
        schema: { querystring: ListQuery },
        ...scopedOrAnyScope(app, 'DEPARTMENT_READ', companyIdOf, atListScope),
      },
      async (req) => {
        const q = req.query as { status?: never; projectId?: string; siteId?: string } & OffsetQuery;
        const rows = await service.listDepartments(actorOf(req), companyIdOf(req), q);
        return paginateArray(
          rows,
          q,
          (r, term) =>
            r.name.toLowerCase().includes(term) || r.code.toLowerCase().includes(term),
        );
      },
    );
    // Detail uses auth() only — the service applies the per-department scope
    // check (a SITE/PROJECT grant reads its own departments, not company ones).
    app.get('/departments/:id', { schema: { params: Params }, ...auth() }, async (req) =>
      service.getDepartment(actorOf(req), companyIdOf(req), (req.params as { id: string }).id),
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
        ((req.body as { to: string }).to === 'SUSPENDED'
          ? 'INACTIVE'
          : (req.body as { to: string }).to) as never,
        (req.body as { expectedVersion?: number }).expectedVersion,
      ),
    );
  };
}
