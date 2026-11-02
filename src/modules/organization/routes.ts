import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Type } from '@sinclair/typebox';
import type { OrganizationService } from './service.js';
import type { ScopeTarget } from '../access-control/service.js';
import { UnauthorizedError } from '../../common/errors/app-error.js';
import type { ActorContext } from './types.js';

const CreateHeadOffice = Type.Object({
  code: Type.String({ minLength: 1, maxLength: 40 }),
  name: Type.String({ minLength: 1, maxLength: 200 }),
  isPrimary: Type.Optional(Type.Boolean()),
});
const UpdateHeadOffice = Type.Object({
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  isPrimary: Type.Optional(Type.Boolean()),
  expectedVersion: Type.Optional(Type.Integer()),
});
const StatusBody = Type.Object({
  to: Type.Union([Type.Literal('ACTIVE'), Type.Literal('SUSPENDED'), Type.Literal('ARCHIVED')]),
  expectedVersion: Type.Optional(Type.Integer()),
});
const UpdateCompany = Type.Object({
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  legalName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  expectedVersion: Type.Optional(Type.Integer()),
});
const CreateProject = Type.Object({
  headOfficeId: Type.String({ format: 'uuid' }),
  code: Type.String({ minLength: 1, maxLength: 40 }),
  name: Type.String({ minLength: 1, maxLength: 200 }),
  timezone: Type.String({ minLength: 1 }),
  description: Type.Optional(Type.String()),
  startDate: Type.Optional(Type.String({ format: 'date' })),
  endDate: Type.Optional(Type.String({ format: 'date' })),
});
const UpdateProject = Type.Object({
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  description: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  timezone: Type.Optional(Type.String({ minLength: 1 })),
  startDate: Type.Optional(Type.Union([Type.String({ format: 'date' }), Type.Null()])),
  endDate: Type.Optional(Type.Union([Type.String({ format: 'date' }), Type.Null()])),
  expectedVersion: Type.Optional(Type.Integer()),
});
const ProjectStatusBody = Type.Object({
  to: Type.Union([
    Type.Literal('ACTIVE'),
    Type.Literal('SUSPENDED'),
    Type.Literal('ARCHIVED'),
    Type.Literal('COMPLETED'),
  ]),
  expectedVersion: Type.Optional(Type.Integer()),
});
const CreateSite = Type.Object({
  projectId: Type.String({ format: 'uuid' }),
  code: Type.String({ minLength: 1, maxLength: 40 }),
  name: Type.String({ minLength: 1, maxLength: 200 }),
  address: Type.Optional(Type.String()),
  geoLatitude: Type.Optional(Type.Number()),
  geoLongitude: Type.Optional(Type.Number()),
  geoFenceRadiusM: Type.Optional(Type.Integer()),
  timezone: Type.Optional(Type.String()),
});
const UpdateSite = Type.Object({
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  address: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  geoLatitude: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
  geoLongitude: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
  geoFenceRadiusM: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
  timezone: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  expectedVersion: Type.Optional(Type.Integer()),
});
const ListQuery = Type.Object({
  status: Type.Optional(Type.String()),
  headOfficeId: Type.Optional(Type.String({ format: 'uuid' })),
  projectId: Type.Optional(Type.String({ format: 'uuid' })),
});

/** Company scope comes from the header + permission check, never the body. */
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
  ...(request.principal?.correlationId !== undefined
    ? { correlationId: request.principal.correlationId }
    : {}),
});

export function organizationRoutes(service: OrganizationService) {
  return async function routes(app: FastifyInstance) {
    const perm = (key: string, scope: (r: FastifyRequest) => ScopeTarget) => ({
      preHandler: [app.authenticate, app.requirePermission(key, scope)],
    });

    // -------------------------------------------------------------- company
    app.get('/org/company', perm('ORG_COMPANY_READ', atCompany), async (req) =>
      service.getCompany(companyIdOf(req), companyIdOf(req)),
    );
    app.patch(
      '/org/company',
      { schema: { body: UpdateCompany }, ...perm('ORG_COMPANY_UPDATE', atCompany) },
      async (req) => {
        const { expectedVersion, ...patch } = req.body as {
          name?: string;
          legalName?: string | null;
          expectedVersion?: number;
        };
        return service.updateCompany(actorOf(req), companyIdOf(req), patch, expectedVersion);
      },
    );

    // ---------------------------------------------------------- head offices
    app.post(
      '/org/head-offices',
      { schema: { body: CreateHeadOffice }, ...perm('ORG_HEAD_OFFICE_CREATE', atCompany) },
      async (req) => service.createHeadOffice(actorOf(req), companyIdOf(req), req.body as never),
    );
    app.get(
      '/org/head-offices',
      { schema: { querystring: ListQuery }, ...perm('ORG_HEAD_OFFICE_READ', atCompany) },
      async (req) => {
        const q = req.query as { status?: never };
        return service.listHeadOffices(companyIdOf(req), q);
      },
    );
    app.patch(
      '/org/head-offices/:id',
      { schema: { body: UpdateHeadOffice }, ...perm('ORG_HEAD_OFFICE_UPDATE', atCompany) },
      async (req) => {
        const { expectedVersion, ...patch } = req.body as {
          name?: string;
          isPrimary?: boolean;
          expectedVersion?: number;
        };
        return service.updateHeadOffice(
          actorOf(req),
          companyIdOf(req),
          (req.params as { id: string }).id,
          patch,
          expectedVersion,
        );
      },
    );
    app.post(
      '/org/head-offices/:id/status',
      { schema: { body: StatusBody }, ...perm('ORG_HEAD_OFFICE_STATUS', atCompany) },
      async (req) =>
        service.transitionHeadOfficeStatus(
          actorOf(req),
          companyIdOf(req),
          (req.params as { id: string }).id,
          (req.body as { to: string }).to,
          (req.body as { expectedVersion?: number }).expectedVersion,
        ),
    );

    // -------------------------------------------------------------- projects
    app.post(
      '/org/projects',
      { schema: { body: CreateProject }, ...perm('ORG_PROJECT_CREATE', atCompany) },
      async (req) => {
        const { headOfficeId, ...input } = req.body as {
          headOfficeId: string;
          code: string;
          name: string;
          timezone: string;
          description?: string;
          startDate?: string;
          endDate?: string;
        };
        return service.createProject(actorOf(req), companyIdOf(req), headOfficeId, {
          code: input.code,
          name: input.name,
          timezone: input.timezone,
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.startDate !== undefined ? { startDate: new Date(input.startDate) } : {}),
          ...(input.endDate !== undefined ? { endDate: new Date(input.endDate) } : {}),
        });
      },
    );
    app.get(
      '/org/projects',
      { schema: { querystring: ListQuery }, ...perm('ORG_PROJECT_READ', atCompany) },
      async (req) => {
        const q = req.query as { status?: never; headOfficeId?: string };
        return service.listProjects(companyIdOf(req), q);
      },
    );
    app.patch(
      '/org/projects/:id',
      { schema: { body: UpdateProject }, ...perm('ORG_PROJECT_UPDATE', atCompany) },
      async (req) => {
        const { expectedVersion, startDate, endDate, ...patch } = req.body as {
          expectedVersion?: number;
          startDate?: string | null;
          endDate?: string | null;
          name?: string;
          description?: string | null;
          timezone?: string;
        };
        return service.updateProject(
          actorOf(req),
          companyIdOf(req),
          (req.params as { id: string }).id,
          {
            ...patch,
            ...(startDate !== undefined
              ? { startDate: startDate === null ? null : new Date(startDate) }
              : {}),
            ...(endDate !== undefined
              ? { endDate: endDate === null ? null : new Date(endDate) }
              : {}),
          },
          expectedVersion,
        );
      },
    );
    app.post(
      '/org/projects/:id/status',
      { schema: { body: ProjectStatusBody }, ...perm('ORG_PROJECT_STATUS', atCompany) },
      async (req) =>
        service.transitionProjectStatus(
          actorOf(req),
          companyIdOf(req),
          (req.params as { id: string }).id,
          (req.body as { to: string }).to,
          (req.body as { expectedVersion?: number }).expectedVersion,
        ),
    );

    // ----------------------------------------------------------------- sites
    app.post(
      '/org/sites',
      { schema: { body: CreateSite }, ...perm('ORG_SITE_CREATE', atCompany) },
      async (req) => {
        const { projectId, ...input } = req.body as { projectId: string } & Record<string, unknown>;
        return service.createSite(actorOf(req), companyIdOf(req), projectId, input as never);
      },
    );
    app.get(
      '/org/sites',
      { schema: { querystring: ListQuery }, ...perm('ORG_SITE_READ', atCompany) },
      async (req) => {
        const q = req.query as { status?: never; projectId?: string };
        return service.listSites(companyIdOf(req), q);
      },
    );
    app.patch(
      '/org/sites/:id',
      { schema: { body: UpdateSite }, ...perm('ORG_SITE_UPDATE', atCompany) },
      async (req) => {
        const { expectedVersion, ...patch } = req.body as Record<string, unknown> & {
          expectedVersion?: number;
        };
        return service.updateSite(
          actorOf(req),
          companyIdOf(req),
          (req.params as { id: string }).id,
          patch,
          expectedVersion,
        );
      },
    );
    app.post(
      '/org/sites/:id/status',
      { schema: { body: StatusBody }, ...perm('ORG_SITE_STATUS', atCompany) },
      async (req) =>
        service.transitionSiteStatus(
          actorOf(req),
          companyIdOf(req),
          (req.params as { id: string }).id,
          (req.body as { to: string }).to,
          (req.body as { expectedVersion?: number }).expectedVersion,
        ),
    );
  };
}
