import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { UnauthorizedError } from '../common/errors/app-error.js';
import { AccessDeniedError } from '../modules/access-control/errors.js';
import type { AccessControlService, ScopeTarget } from '../modules/access-control/service.js';

export interface AuthorizationPluginOptions {
  accessControl: AccessControlService;
  // Platform-company marker for tenant-route exclusion — lazily resolved
  // from the database (or injected in tests), never from the request.
  resolvePlatformCompanyId: () => Promise<string | null>;
}

declare module 'fastify' {
  interface FastifyInstance {
    requirePermission: (
      permissionKey: string,
      resolveScope: (request: FastifyRequest) => ScopeTarget,
    ) => (request: FastifyRequest) => Promise<void>;
    /** Rejects requests whose x-company-id targets the platform company. */
    tenantCompanyGuard: (request: FastifyRequest) => Promise<void>;
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

    // Explicit tenant boundary: the platform company is never a valid tenant
    // target, regardless of permissions the caller happens to hold there.
    app.decorate('tenantCompanyGuard', async (request: FastifyRequest) => {
      const companyId = request.headers['x-company-id'];
      if (typeof companyId !== 'string' || companyId.length === 0) return;
      const platformId = await opts.resolvePlatformCompanyId();
      if (platformId !== null && companyId === platformId) {
        throw new AccessDeniedError();
      }
    });
  },
  { name: 'authorization', dependencies: ['authentication'] },
);
