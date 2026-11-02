import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Type } from '@sinclair/typebox';
import type { NotificationSocket } from './ws-gateway.js';
import type { NotificationService } from './service.js';
import { NotificationGateway } from './ws-gateway.js';
import { NotificationTicketError } from './errors.js';
import { UnauthorizedError } from '../../common/errors/app-error.js';
import { TICKET_TYPE } from './service.js';

const TicketBody = Type.Object({ companyId: Type.String({ format: 'uuid' }) });
const TicketResponse = Type.Object({
  ticket: Type.String(),
  expiresInSeconds: Type.Integer(),
});
const ListQuery = Type.Object({
  cursor: Type.Optional(Type.String()),
  unreadOnly: Type.Optional(Type.Boolean()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});

export interface NotificationRoutesDeps {
  service: NotificationService;
  gateway: NotificationGateway;
  /** Verifies access tokens AND ticket JWTs — returns raw claims. */
  verifyToken: (token: string) => Record<string, unknown>;
}

/**
 * /notifications — durable inbox + ticket + realtime stream.
 * Stream auth: `Authorization: Bearer` (native) or
 * `Sec-WebSocket-Protocol: sarjan-ticket.<jwt>` (browser).
 * Never tokens in URLs.
 */
export function notificationRoutes(deps: NotificationRoutesDeps) {
  return async function routes(app: FastifyInstance) {
    app.post(
      '/notifications/ticket',
      { schema: { body: TicketBody, response: { 200: TicketResponse } } },
      async (request) => {
        await app.authenticate(request);
        await app.tenantCompanyGuard(request);
        const { companyId } = request.body as { companyId: string };
        const principal = request.principal as { actorId: string; sessionId: string };
        return deps.service.issueTicket(
          { actorId: principal.actorId, actorType: 'USER', sessionId: principal.sessionId },
          companyId,
        );
      },
    );

    app.get('/notifications', { schema: { querystring: ListQuery } }, async (request) => {
      await app.authenticate(request);
      await app.tenantCompanyGuard(request);
      const q = request.query as {
        cursor?: string;
        unreadOnly?: boolean;
        limit?: number;
        companyId?: string;
      };
      const companyId = request.headers['x-company-id'];
      if (typeof companyId !== 'string' || companyId.length === 0) {
        throw new UnauthorizedError('COMPANY_REQUIRED', 'x-company-id header required');
      }
      const principal = request.principal as { actorId: string };
      return deps.service.list({ actorId: principal.actorId, actorType: 'USER' }, companyId, {
        ...(q.cursor !== undefined ? { cursor: q.cursor } : {}),
        ...(q.unreadOnly !== undefined ? { unreadOnly: q.unreadOnly } : {}),
        ...(q.limit !== undefined ? { limit: q.limit } : {}),
      });
    });

    app.post('/notifications/:id/read', async (request) => {
      await app.authenticate(request);
      await app.tenantCompanyGuard(request);
      const { id } = request.params as { id: string };
      const companyId = request.headers['x-company-id'];
      if (typeof companyId !== 'string' || companyId.length === 0) {
        throw new UnauthorizedError('COMPANY_REQUIRED', 'x-company-id header required');
      }
      const principal = request.principal as { actorId: string };
      const n = await deps.service.markRead(
        { actorId: principal.actorId, actorType: 'USER' },
        companyId,
        id,
      );
      return { id: n.id, readAt: n.readAt };
    });

    // Authenticated realtime stream — upgrade-time auth only.
    app.get('/notifications/stream', { websocket: true } as never, async (socket, request) => {
      const ws = socket as NotificationSocket;
      try {
        const binding = await authenticateSocket(request, deps);
        deps.gateway.attach(binding, ws);
      } catch (error) {
        request.log.warn({ err: error }, 'ws auth failed');
        ws.close(4401, 'unauthorized');
      }
    });
  };
}

const TICKET_PROTOCOL = 'sarjan-ticket.';

async function authenticateSocket(
  request: FastifyRequest,
  deps: NotificationRoutesDeps,
): Promise<{ principalId: string; companyId: string; sessionId: string }> {
  // Browser path: single-use ticket in the subprotocol header.
  const protocol = request.headers['sec-websocket-protocol'];
  if (typeof protocol === 'string' && protocol.startsWith(TICKET_PROTOCOL)) {
    const token = protocol.slice(TICKET_PROTOCOL.length);
    const claims = deps.verifyToken(token) as {
      sub: string;
      sid: string;
      companyId: string;
      jti: string;
      typ?: string;
    };
    if (claims.typ !== TICKET_TYPE) throw new NotificationTicketError('wrong token type');
    const actor = await deps.service.consumeTicket({
      sub: claims.sub,
      sid: claims.sid,
      companyId: claims.companyId,
      jti: claims.jti,
    });
    return { principalId: actor.actorId, companyId: claims.companyId, sessionId: claims.sid };
  }
  // Native path: Bearer access token + verified company header.
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    throw new UnauthorizedError('TOKEN_MISSING', 'Bearer token or ticket protocol required');
  }
  const claims = deps.verifyToken(header.slice('Bearer '.length)) as { sub: string; sid: string };
  const companyId = request.headers['x-company-id'];
  if (typeof companyId !== 'string' || companyId.length === 0) {
    throw new UnauthorizedError('COMPANY_REQUIRED', 'x-company-id header required');
  }
  const actor = await deps.service.revalidateActor(claims.sub, claims.sid);
  await deps.service.verifyMembership(actor.actorId, companyId);
  return { principalId: actor.actorId, companyId, sessionId: claims.sid };
}
