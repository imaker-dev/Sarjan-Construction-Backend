import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Type } from '@sinclair/typebox';
import type { DelegationService } from './delegation.js';
import type { ActorContext } from './types.js';
import type { ScopeTarget } from '../access-control/service.js';
import { DomainValidationError, UnauthorizedError } from '../../common/errors/app-error.js';

// Company-controlled delegation switches — every flag defaults OFF and only
// takes effect for holders of the matching SCOPED permission inside their
// assigned project/site scope. Company administrators keep their existing
// company-level paths regardless of these settings.

const PatchDelegations = Type.Object(
  {
    expectedVersion: Type.Integer({ minimum: 0 }),
    siteCreate: Type.Optional(Type.Boolean()),
    siteUpdate: Type.Optional(Type.Boolean()),
    deptManage: Type.Optional(Type.Boolean()),
    placement: Type.Optional(Type.Boolean()),
    employeeOnboard: Type.Optional(Type.Boolean()),
    memberSuspend: Type.Optional(Type.Boolean()),
    memberExit: Type.Optional(Type.Boolean()),
    scheduleManage: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

const actorOf = (r: FastifyRequest): ActorContext => ({
  actorId: (r.principal as { actorId: string }).actorId,
  actorType: 'USER',
});

const companyIdOf = (r: FastifyRequest): string => {
  const id = r.headers['x-company-id'];
  if (typeof id !== 'string' || id === '') throw new UnauthorizedError('COMPANY_REQUIRED');
  return id;
};

const atCompany = (r: FastifyRequest): ScopeTarget => ({
  companyId: companyIdOf(r),
  scopeType: 'COMPANY',
  scopeId: companyIdOf(r),
});

const ALLOWED_PATCH_KEYS = new Set([
  'expectedVersion',
  'siteCreate',
  'siteUpdate',
  'deptManage',
  'placement',
  'employeeOnboard',
  'memberSuspend',
  'memberExit',
  'scheduleManage',
]);

// The app's ajv config strips unknown properties during validation instead
// of rejecting them — delegation switches are security-sensitive, so unknown
// keys are rejected in preValidation (which sees the raw parsed body).
const rejectUnknownKeys = async (req: FastifyRequest): Promise<void> => {
  const unknown = Object.keys(req.body ?? {}).filter((k) => !ALLOWED_PATCH_KEYS.has(k));
  if (unknown.length > 0) {
    throw new DomainValidationError(
      'UNKNOWN_FIELD',
      `unknown delegation policy fields: ${unknown.join(', ')}`,
    );
  }
};

export function delegationRoutes(service: DelegationService) {
  return async function routes(app: FastifyInstance) {
    const perm = (key: string) => ({
      preHandler: [app.authenticate, app.tenantCompanyGuard, app.requirePermission(key, atCompany)],
    });

    app.get('/org/company/delegations', perm('ORG_COMPANY_READ'), async (req) =>
      service.getPolicy(actorOf(req), companyIdOf(req)),
    );

    app.patch(
      '/org/company/delegations',
      {
        schema: { body: PatchDelegations },
        preValidation: [rejectUnknownKeys],
        ...perm('ORG_COMPANY_UPDATE'),
      },
      async (req) =>
        service.updatePolicy(
          actorOf(req),
          companyIdOf(req),
          req.body as {
            expectedVersion: number;
            siteCreate?: boolean;
            siteUpdate?: boolean;
            deptManage?: boolean;
            placement?: boolean;
            employeeOnboard?: boolean;
            memberSuspend?: boolean;
            memberExit?: boolean;
            scheduleManage?: boolean;
          },
        ),
    );
  };
}
