import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Type } from '@sinclair/typebox';
import type { ComplianceService } from './service.js';
import type { ScopeTarget } from '../access-control/service.js';
import type { ActorContext } from '../organization/types.js';
import { UnauthorizedError } from '../../common/errors/app-error.js';

const CATEGORIES = Type.Union(
  [
    'GST',
    'TAN',
    'UDYAM_MSME',
    'EPFO',
    'ESIC',
    'BOCW',
    'LABOUR_LICENCE',
    'CONTRACTOR_ENLISTMENT',
    'ISO_CERT',
    'TECHNICAL_LICENCE',
    'INSURANCE',
    'OTHER',
  ].map((c) => Type.Literal(c)),
);

const CreateBody = Type.Object({
  category: CATEGORIES,
  customLabel: Type.Optional(Type.String({ maxLength: 120 })),
  identifier: Type.String({ minLength: 1, maxLength: 80 }),
  jurisdiction: Type.Optional(Type.String({ maxLength: 120 })),
  issuingAuthority: Type.Optional(Type.String({ maxLength: 200 })),
  issueDate: Type.Optional(Type.String({ format: 'date' })),
  expiryDate: Type.Optional(Type.String({ format: 'date' })),
  documentId: Type.Optional(Type.String({ format: 'uuid' })),
});
const UpdateBody = Type.Object({
  customLabel: Type.Optional(Type.String({ maxLength: 120 })),
  identifier: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
  jurisdiction: Type.Optional(Type.String({ maxLength: 120 })),
  issuingAuthority: Type.Optional(Type.String({ maxLength: 200 })),
  issueDate: Type.Optional(Type.String({ format: 'date' })),
  expiryDate: Type.Optional(Type.String({ format: 'date' })),
  documentId: Type.Optional(Type.String({ format: 'uuid' })),
  expectedVersion: Type.Integer(),
});
const StatusBody = Type.Object({
  to: Type.Union(['ACTIVE', 'SUSPENDED', 'EXPIRED', 'ARCHIVED'].map((s) => Type.Literal(s))),
  expectedVersion: Type.Integer(),
});
const VerifyBody = Type.Object({
  documentId: Type.Optional(Type.String({ format: 'uuid' })),
  expectedVersion: Type.Integer(),
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

export function complianceRoutes(service: ComplianceService) {
  return async function routes(app: FastifyInstance) {
    const perm =
      (key: string) =>
      async (r: FastifyRequest): Promise<void> => {
        await app.authenticate(r);
        await app.tenantCompanyGuard(r);
        const companyId = companyOf(r);
        const target: ScopeTarget = { companyId, scopeType: 'COMPANY', scopeId: companyId };
        await app.requirePermission(key, () => target)(r);
      };

    app.get('/compliance-records', { preHandler: perm('COMPLIANCE_READ') }, (req) =>
      service.list(companyOf(req)),
    );
    app.post(
      '/compliance-records',
      { schema: { body: CreateBody }, preHandler: perm('COMPLIANCE_MANAGE') },
      (req) => service.create(actorOf(req), companyOf(req), req.body as never),
    );
    app.patch(
      '/compliance-records/:id',
      { schema: { body: UpdateBody }, preHandler: perm('COMPLIANCE_MANAGE') },
      (req) => {
        const { expectedVersion, ...patch } = req.body as { expectedVersion: number } & Record<
          string,
          never
        >;
        return service.update(
          actorOf(req),
          companyOf(req),
          (req.params as { id: string }).id,
          patch,
          expectedVersion,
        );
      },
    );
    app.post(
      '/compliance-records/:id/status',
      { schema: { body: StatusBody }, preHandler: perm('COMPLIANCE_MANAGE') },
      (req) => {
        const { to, expectedVersion } = req.body as { to: string; expectedVersion: number };
        return service.transition(
          actorOf(req),
          companyOf(req),
          (req.params as { id: string }).id,
          to,
          expectedVersion,
        );
      },
    );
    app.post(
      '/compliance-records/:id/verify',
      { schema: { body: VerifyBody }, preHandler: perm('COMPLIANCE_MANAGE') },
      (req) => {
        const { documentId, expectedVersion } = req.body as {
          documentId?: string;
          expectedVersion: number;
        };
        return service.verify(
          actorOf(req),
          companyOf(req),
          (req.params as { id: string }).id,
          documentId,
          expectedVersion,
        );
      },
    );
  };
}
