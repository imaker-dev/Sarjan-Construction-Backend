import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Type } from '@sinclair/typebox';
import type { ActorContext } from '../organization/types.js';
import type { OperationAssignmentService } from './assignment.js';
import { UnauthorizedError } from '../../common/errors/app-error.js';

const OpKeyBody = Type.Object({
  operationKey: Type.String({ minLength: 1, maxLength: 80 }),
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

export function operationAssignmentRoutes(service: OperationAssignmentService) {
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

    // Global operation catalogue — admin reads the master list.
    app.get('/operations', { ...perm('OPERATION_READ') }, async (req) =>
      service.listCatalogue(actorOf(req), companyIdOf(req)),
    );

    // Department enablement — which ops this dept can perform.
    app.get('/departments/:id/operations', { ...perm('DEPARTMENT_READ') }, async (req) =>
      service.listDeptOperations(actorOf(req), companyIdOf(req), (req.params as { id: string }).id),
    );
    app.post(
      '/departments/:id/operations',
      { schema: { body: OpKeyBody }, ...perm('OPERATION_CONFIGURE') },
      async (req) =>
        service.enableDeptOperation(
          actorOf(req),
          companyIdOf(req),
          (req.params as { id: string }).id,
          (req.body as { operationKey: string }).operationKey,
        ),
    );
    app.delete(
      '/departments/:id/operations/:operationKey',
      { ...perm('OPERATION_CONFIGURE') },
      async (req) => {
        const { id, operationKey } = req.params as { id: string; operationKey: string };
        return service.disableDeptOperation(actorOf(req), companyIdOf(req), id, operationKey);
      },
    );

    // Employee assignment — subset of the employee's active-dept enabled ops.
    app.get('/employees/:id/operations', { ...perm('EMPLOYEE_READ') }, async (req) =>
      service.listEmployeeOperations(
        actorOf(req),
        companyIdOf(req),
        (req.params as { id: string }).id,
      ),
    );
    app.post(
      '/employees/:id/operations',
      { schema: { body: OpKeyBody }, ...perm('OPERATION_EMPLOYEE_ASSIGN') },
      async (req) =>
        service.assignEmployeeOperation(
          actorOf(req),
          companyIdOf(req),
          (req.params as { id: string }).id,
          (req.body as { operationKey: string }).operationKey,
        ),
    );
    app.delete(
      '/employees/:id/operations/:operationKey',
      { ...perm('OPERATION_EMPLOYEE_ASSIGN') },
      async (req) => {
        const { id, operationKey } = req.params as { id: string; operationKey: string };
        return service.revokeEmployeeOperation(actorOf(req), companyIdOf(req), id, operationKey);
      },
    );
  };
}
