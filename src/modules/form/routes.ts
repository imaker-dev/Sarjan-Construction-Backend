import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Type } from '@sinclair/typebox';
import type { ActorContext } from '../organization/types.js';
import type { FormService } from './service.js';
import { UnauthorizedError } from '../../common/errors/app-error.js';
import type { FormStatus } from '@prisma/client';

const CreateFormBody = Type.Object({
  operationId: Type.String({ format: 'uuid' }),
  key: Type.String({ minLength: 1, maxLength: 60 }),
  name: Type.String({ minLength: 1, maxLength: 200 }),
  description: Type.Optional(Type.String({ maxLength: 1000 })),
  schema: Type.Optional(Type.Unknown()),
});

const UpdateFormBody = Type.Object({
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  description: Type.Optional(Type.Union([Type.String({ maxLength: 1000 }), Type.Null()])),
  schema: Type.Optional(Type.Union([Type.Unknown(), Type.Null()])),
  expectedVersion: Type.Optional(Type.Integer()),
});

const StatusFormBody = Type.Object({
  to: Type.Union([Type.Literal('DRAFT'), Type.Literal('ACTIVE'), Type.Literal('ARCHIVED')]),
  expectedVersion: Type.Optional(Type.Integer()),
});

const PublishFormBody = Type.Object({
  expectedVersion: Type.Optional(Type.Integer()),
});

const ListFormsQuery = Type.Object({
  status: Type.Optional(Type.Union([Type.Literal('DRAFT'), Type.Literal('ACTIVE'), Type.Literal('ARCHIVED')])),
  operationId: Type.Optional(Type.String({ format: 'uuid' })),
});

function companyIdOf(request: FastifyRequest): string {
  const companyId = request.headers['x-company-id'];
  if (typeof companyId !== 'string' || companyId.length === 0) {
    throw new UnauthorizedError('COMPANY_REQUIRED', 'x-company-id header required');
  }
  return companyId;
}

const actorOf = (request: FastifyRequest): ActorContext => ({
  actorId: (request.principal as { actorId: string }).actorId,
  actorType: 'USER',
});

export function formRoutes(service: FormService) {
  return async function routes(app: FastifyInstance) {
    const perm = (key: string) => ({
      preHandler: [
        app.authenticate,
        app.tenantCompanyGuard,
        app.requirePermission(key, (r) => ({
          companyId: companyIdOf(r),
          scopeType: 'COMPANY' as const,
          scopeId: companyIdOf(r),
        })),
      ],
    });

    app.get(
      '/forms',
      { schema: { querystring: ListFormsQuery }, ...perm('FORM_READ') },
      async (req) =>
        service.listForms(
          actorOf(req),
          companyIdOf(req),
          req.query as { status?: FormStatus; operationId?: string },
        ),
    );

    app.post(
      '/forms',
      { schema: { body: CreateFormBody }, ...perm('FORM_CONFIGURE') },
      async (req) => {
        const body = req.body as {
          operationId: string;
          key: string;
          name: string;
          description?: string;
          schema?: unknown;
        };
        return service.createForm(actorOf(req), companyIdOf(req), body.operationId, {
          key: body.key,
          name: body.name,
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(body.schema !== undefined ? { schema: body.schema } : {}),
        });
      },
    );

    app.get('/forms/:id', { ...perm('FORM_READ') }, async (req) =>
      service.getForm(actorOf(req), companyIdOf(req), (req.params as { id: string }).id),
    );

    app.patch(
      '/forms/:id',
      { schema: { body: UpdateFormBody }, ...perm('FORM_CONFIGURE') },
      async (req) => {
        const { expectedVersion, ...patch } = req.body as {
          name?: string;
          description?: string | null;
          schema?: unknown;
          expectedVersion?: number;
        };
        return service.updateForm(
          actorOf(req),
          companyIdOf(req),
          (req.params as { id: string }).id,
          patch,
          expectedVersion,
        );
      },
    );

    app.post(
      '/forms/:id/status',
      { schema: { body: StatusFormBody }, ...perm('FORM_CONFIGURE') },
      async (req) => {
        const { to, expectedVersion } = req.body as { to: string; expectedVersion?: number };
        return service.transitionFormStatus(
          actorOf(req),
          companyIdOf(req),
          (req.params as { id: string }).id,
          to,
          expectedVersion,
        );
      },
    );

    app.post(
      '/forms/:id/publish',
      { schema: { body: PublishFormBody }, ...perm('FORM_PUBLISH') },
      async (req) => {
        const { expectedVersion } = (req.body ?? {}) as { expectedVersion?: number };
        return service.publishForm(
          actorOf(req),
          companyIdOf(req),
          (req.params as { id: string }).id,
          expectedVersion,
        );
      },
    );

    app.get('/forms/:id/versions', { ...perm('FORM_READ') }, async (req) =>
      service.listVersions(actorOf(req), companyIdOf(req), (req.params as { id: string }).id),
    );
  };
}

