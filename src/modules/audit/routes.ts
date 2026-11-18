import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Type } from '@sinclair/typebox';
import { AUDIT_LOG_VIEW, type AuditService } from './service.js';
import type { ActorContext } from '../organization/types.js';
import type { ScopeTarget } from '../access-control/service.js';
import { UnauthorizedError } from '../../common/errors/app-error.js';

const QuerySchema = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  cursor: Type.Optional(Type.String({ format: 'uuid' })),
  entityType: Type.Optional(Type.String()),
  entityId: Type.Optional(Type.String({ format: 'uuid' })),
  action: Type.Optional(Type.String()),
  actorId: Type.Optional(Type.String()),
  fromDate: Type.Optional(Type.String()),
  toDate: Type.Optional(Type.String()),
});

const ParamsSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
});

const actorOf = (r: FastifyRequest): ActorContext => ({
  actorId: (r.principal as { actorId: string }).actorId,
  actorType: 'USER',
});

const companyOf = (r: FastifyRequest): string => {
  const id = r.headers['x-company-id'];
  if (typeof id !== 'string' || id === '') throw new UnauthorizedError('COMPANY_REQUIRED');
  return id;
};

const atCompany = (r: FastifyRequest): ScopeTarget => {
  const companyId = companyOf(r);
  return {
    companyId,
    scopeType: 'COMPANY',
    scopeId: companyId,
  };
};

export function auditRoutes(service: AuditService) {
  return async function routes(app: FastifyInstance) {
    const auth = {
      preHandler: [
        app.authenticate,
        app.tenantCompanyGuard,
        app.requirePermission(AUDIT_LOG_VIEW, atCompany),
      ],
    };

    app.get(
      '/audit-logs',
      {
        ...auth,
        schema: {
          querystring: QuerySchema,
        },
      },
      async (req) => {
        const actor = actorOf(req);
        const companyId = companyOf(req);
        const query = req.query as {
          limit?: number;
          cursor?: string;
          entityType?: string;
          entityId?: string;
          action?: string;
          actorId?: string;
          fromDate?: string;
          toDate?: string;
        };
        return service.listCompanyLogs(actor, companyId, query);
      },
    );

    app.get(
      '/audit-logs/:id',
      {
        ...auth,
        schema: {
          params: ParamsSchema,
        },
      },
      async (req) => {
        const actor = actorOf(req);
        const companyId = companyOf(req);
        const { id } = req.params as { id: string };
        return service.getCompanyLogById(actor, companyId, id);
      },
    );
  };
}
