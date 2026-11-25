import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Type } from '@sinclair/typebox';
import {
  WORKFLOW_APPROVAL_DECIDE,
  WORKFLOW_APPROVAL_READ,
  type ApprovalService,
} from './service.js';
import type { ActorContext } from '../organization/types.js';
import type { ScopeTarget } from '../access-control/service.js';
import { UnauthorizedError } from '../../common/errors/app-error.js';

const TaskListQuery = Type.Object({
  status: Type.Optional(
    Type.Union([
      Type.Literal('PENDING'),
      Type.Literal('APPROVED'),
      Type.Literal('REJECTED'),
      Type.Literal('RETURNED'),
      Type.Literal('CANCELLED'),
    ]),
  ),
  workflowInstanceId: Type.Optional(Type.String({ format: 'uuid' })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  cursor: Type.Optional(Type.String({ format: 'uuid' })),
});

const TaskParams = Type.Object({
  id: Type.String({ format: 'uuid' }),
});

const DecideBody = Type.Object(
  {
    action: Type.Union([Type.Literal('APPROVE'), Type.Literal('REJECT'), Type.Literal('RETURN')]),
    reason: Type.Optional(Type.String({ maxLength: 500 })),
    expectedVersion: Type.Optional(Type.Integer({ minimum: 0 })),
    decisionPayload: Type.Optional(
      Type.Record(Type.String(), Type.Unknown(), {
        description:
          'Action-specific structured payload. For wallet funding requests, APPROVE ' +
          'requires {"approvedAmount": "<decimal INR>"} — ≤ the submitted attempt ' +
          'amount. Forbidden on REJECT/RETURN for that workflow. Stored on the ' +
          'decision row and folded into the idempotency fingerprint.',
      }),
    ),
    idempotencyKey: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  },
  { additionalProperties: false },
);

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
  return { companyId, scopeType: 'COMPANY', scopeId: companyId };
};

/**
 * Approval-task REST surface. Every handler returns only tasks the caller can
 * decide under the pinned assignee rule — the service enforces assignee,
 * self-approval, version, and separation-of-duties checks.
 */
export function approvalRoutes(service: ApprovalService) {
  return async function routes(app: FastifyInstance) {
    const read = {
      preHandler: [
        app.authenticate,
        app.tenantCompanyGuard,
        app.requirePermission(WORKFLOW_APPROVAL_READ, atCompany),
      ],
    };
    const decide = {
      preHandler: [
        app.authenticate,
        app.tenantCompanyGuard,
        app.requirePermission(WORKFLOW_APPROVAL_DECIDE, atCompany),
      ],
    };

    app.get(
      '/approval-tasks',
      { ...read, schema: { querystring: TaskListQuery } },
      async (request) => {
        const q = request.query as {
          status?: string;
          workflowInstanceId?: string;
          limit?: number;
          cursor?: string;
        };
        return service.listAssignedTasks(
          actorOf(request),
          companyOf(request),
          {
            ...(q.status !== undefined ? { status: q.status } : {}),
            ...(q.workflowInstanceId !== undefined
              ? { workflowInstanceId: q.workflowInstanceId }
              : {}),
          },
          {
            ...(q.limit !== undefined ? { limit: q.limit } : {}),
            ...(q.cursor !== undefined ? { cursor: q.cursor } : {}),
          },
        );
      },
    );

    app.get('/approval-tasks/:id', { ...read, schema: { params: TaskParams } }, async (request) => {
      const { id } = request.params as { id: string };
      return service.getAssignedTask(actorOf(request), companyOf(request), id);
    });

    app.get(
      '/approval-tasks/:id/decisions',
      { ...read, schema: { params: TaskParams } },
      async (request) => {
        const { id } = request.params as { id: string };
        return service.listAssignedTaskDecisions(actorOf(request), companyOf(request), id);
      },
    );

    app.post(
      '/approval-tasks/:id/decisions',
      { ...decide, schema: { params: TaskParams, body: DecideBody } },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const body = request.body as {
          action: 'APPROVE' | 'REJECT' | 'RETURN';
          reason?: string;
          expectedVersion?: number;
          decisionPayload?: Record<string, unknown>;
          idempotencyKey?: string;
        };
        const result = await service.decideTask(actorOf(request), companyOf(request), id, {
          action: body.action,
          ...(body.reason !== undefined ? { reason: body.reason } : {}),
          ...(body.expectedVersion !== undefined ? { expectedVersion: body.expectedVersion } : {}),
          ...(body.decisionPayload !== undefined ? { decisionPayload: body.decisionPayload } : {}),
          ...(body.idempotencyKey !== undefined ? { idempotencyKey: body.idempotencyKey } : {}),
        });
        return reply.code(result.replayed ? 200 : 201).send({
          task: result.task,
          decision: result.decision,
          instance: result.instance,
          transition: result.transition,
          replayed: result.replayed,
        });
      },
    );
  };
}
