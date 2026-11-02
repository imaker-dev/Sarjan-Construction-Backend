import type { RoleAssignment, ScopeType } from '@prisma/client';
import type { PrincipalRepository } from '../auth/repository.js';
import type { AccessRepository, ScopeChain } from './repository.js';
import { AccessDeniedError } from './errors.js';

export interface ScopeTarget {
  companyId: string;
  scopeType: ScopeType;
  scopeId: string; // headOfficeId | projectId | siteId — equals companyId when COMPANY
}

type ScopedAssignment = Pick<
  RoleAssignment,
  'scopeType' | 'headOfficeId' | 'projectId' | 'siteId' | 'companyId'
>;

function scopeRef(a: ScopedAssignment): { type: ScopeType; id: string } | null {
  switch (a.scopeType) {
    case 'COMPANY':
      return { type: 'COMPANY', id: a.companyId };
    case 'HEAD_OFFICE':
      // The migration CHECK constraint guarantees the matching column is set;
      // a null here would be data corruption — fail closed.
      return a.headOfficeId === null ? null : { type: 'HEAD_OFFICE', id: a.headOfficeId };
    case 'PROJECT':
      return a.projectId === null ? null : { type: 'PROJECT', id: a.projectId };
    case 'SITE':
      return a.siteId === null ? null : { type: 'SITE', id: a.siteId };
  }
}

// Downward inheritance: an assignment at an ancestor scope covers its
// descendants. Coverage = the assignment's scope ref is the target or one of
// its ancestors in the resolved chain.
export function scopeCovers(assignment: ScopedAssignment, chain: ScopeChain): boolean {
  const ref = scopeRef(assignment);
  if (ref === null) return false;
  const ancestors: { type: ScopeType; id: string }[] = [{ type: 'COMPANY', id: chain.companyId }];
  if (chain.headOfficeId !== undefined)
    ancestors.push({ type: 'HEAD_OFFICE', id: chain.headOfficeId });
  if (chain.projectId !== undefined) ancestors.push({ type: 'PROJECT', id: chain.projectId });
  if (chain.siteId !== undefined) ancestors.push({ type: 'SITE', id: chain.siteId });
  return ancestors.some((a) => a.type === ref.type && a.id === ref.id);
}

export interface AccessServiceDeps {
  principals: PrincipalRepository;
  access: AccessRepository;
}

export class AccessControlService {
  constructor(
    private readonly deps: AccessServiceDeps,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Deny-by-default permission evaluation. Resolves the target's ancestor
   * chain, loads the principal's effective assignments in one query, and
   * checks coverage. Returns true only on a full pass; throws nothing.
   */
  async hasPermission(
    principalId: string,
    permissionKey: string,
    target: ScopeTarget,
  ): Promise<boolean> {
    const principal = await this.deps.principals.findById(principalId);
    if (principal?.status !== 'ACTIVE') return false;

    const chain = await this.resolveChain(target);
    if (!chain) return false; // target doesn't exist in this company — deny

    const assignments = await this.deps.access.assignmentsForPrincipal(
      principalId,
      target.companyId,
      this.now(),
    );
    return assignments.some(
      (a) =>
        scopeCovers(a, chain) &&
        a.role.permissions.some((rp) => rp.permission.key === permissionKey),
    );
  }

  async assertPermission(
    principalId: string,
    permissionKey: string,
    target: ScopeTarget,
  ): Promise<void> {
    const allowed = await this.hasPermission(principalId, permissionKey, target);
    if (!allowed) throw new AccessDeniedError();
  }

  private resolveChain(target: ScopeTarget): Promise<ScopeChain | null> {
    const { companyId, scopeType, scopeId } = target;
    switch (scopeType) {
      case 'COMPANY':
        // Company scope target: chain is the company itself. Existence check
        // keeps deny-closed on a nonexistent company id.
        return this.deps.access.companyExists(companyId).then((ok) => (ok ? { companyId } : null));
      case 'HEAD_OFFICE':
        return this.deps.access.resolveHeadOfficeChain(companyId, scopeId);
      case 'PROJECT':
        return this.deps.access.resolveProjectChain(companyId, scopeId);
      case 'SITE':
        return this.deps.access.resolveSiteChain(companyId, scopeId);
    }
  }
}
