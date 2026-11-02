import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { UnauthorizedError } from '../common/errors/app-error.js';
import type { AccessControlService, ScopeTarget } from '../modules/access-control/service.js';

export interface AuthorizationPluginOptions {
  accessControl: AccessControlService;
}

declare module 'fastify' {
  interface FastifyInstance {
    requirePermission: (
      permissionKey: string,
      resolveScope: (request: FastifyRequest) => ScopeTarget,
    ) => (request: FastifyRequest) => Promise<void>;
  }
}

// Route helper: returns a preHandler that authenticates then checks a
// permission key against a route-resolved scope target. Service-level checks
// still apply inside domain services — this is the route boundary.
export default fp<AuthorizationPluginOptions>(
  async function authorizationPlugin(app: FastifyInstance, opts) {
    app.decorate('requirePermission', (permissionKey, resolveScope) => {
      return async (request: FastifyRequest) => {
        if (!request.principal) {
          throw new UnauthorizedError();
        }
        const target = resolveScope(request);
        await opts.accessControl.assertPermission(request.principal.actorId, permissionKey, target);
      };
    });
  },
  { name: 'authorization', dependencies: ['authentication'] },
);
