import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ScopeTarget } from '../../modules/access-control/service.js';

export type CompanyIdResolver = (req: FastifyRequest) => string;
export type ScopeTargetResolver = (req: FastifyRequest) => ScopeTarget | Promise<ScopeTarget>;

/**
 * Returns true when the request query specifies at least one explicit scope or
 * target filter (`siteId`, `projectId`, `headOfficeId`, `departmentId`, `employeeId`).
 */
export function hasQueryScopeFilter(req: FastifyRequest): boolean {
  const q = (req.query ?? {}) as Record<string, unknown>;
  return (
    q.siteId !== undefined ||
    q.projectId !== undefined ||
    q.headOfficeId !== undefined ||
    q.departmentId !== undefined ||
    q.employeeId !== undefined
  );
}

/**
 * Reusable Fastify route guard for endpoints accessible to all roles (COMPANY,
 * PROJECT/PI/PD, SITE, DEPARTMENT, EMPLOYEE, and future roles):
 * - When `hasExplicitScope(req)` is true (e.g. `?siteId=...`, `?projectId=...`),
 *   enforces `requirePermission(permissionKey, resolveScope)` at that exact target.
 * - When no explicit scope filter is provided, enforces
 *   `requireAnyScopePermission(permissionKey, resolveCompanyId)` so the service
 *   can auto-scope or return the caller's own records.
 */
export function scopedOrAnyScope(
  app: FastifyInstance,
  permissionKey: string,
  resolveCompanyId: CompanyIdResolver,
  resolveScope: ScopeTargetResolver,
  hasExplicitScope: (req: FastifyRequest) => boolean = hasQueryScopeFilter,
) {
  return {
    preHandler: [
      app.authenticate,
      app.tenantCompanyGuard,
      async (req: FastifyRequest) => {
        const guard = hasExplicitScope(req)
          ? app.requirePermission(permissionKey, resolveScope)
          : typeof app.requireAnyScopePermission === 'function'
            ? app.requireAnyScopePermission(permissionKey, resolveCompanyId)
            : app.requirePermission(permissionKey, (r) => {
                const companyId = resolveCompanyId(r);
                return { companyId, scopeType: 'COMPANY', scopeId: companyId };
              });
        return guard(req);
      },
    ],
  };
}
