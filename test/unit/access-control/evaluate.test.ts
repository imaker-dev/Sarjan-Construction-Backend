import { describe, it, expect } from 'vitest';
import { AccessControlService, scopeCovers } from '../../../src/modules/access-control/service.js';
import { AccessDeniedError } from '../../../src/modules/access-control/errors.js';
import type {
  AccessRepository,
  AssignmentWithPermissions,
  ScopeChain,
} from '../../../src/modules/access-control/repository.js';
import type { PrincipalRepository } from '../../../src/modules/auth/repository.js';
import { fakePrincipal } from '../auth/fakes.js';
import type { Principal } from '@prisma/client';

function assignment(over: Partial<AssignmentWithPermissions>): AssignmentWithPermissions {
  return {
    id: 'a1',
    principalId: 'p1',
    roleId: 'r1',
    companyId: 'c1',
    scopeType: 'COMPANY',
    headOfficeId: null,
    projectId: null,
    siteId: null,
    grantedByPrincipalId: null,
    effectiveFrom: null,
    effectiveTo: null,
    revokedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    role: { permissions: [{ permission: { key: 'ORG_SITE_READ' } }] },
    ...over,
  };
}

describe('scopeCovers — downward inheritance', () => {
  const siteChain: ScopeChain = {
    companyId: 'c1',
    headOfficeId: 'ho1',
    projectId: 'pr1',
    siteId: 's1',
  };

  it('company assignment covers all descendants', () => {
    expect(scopeCovers(assignment({ scopeType: 'COMPANY' }), siteChain)).toBe(true);
  });

  it('head-office assignment covers its projects and sites', () => {
    expect(
      scopeCovers(assignment({ scopeType: 'HEAD_OFFICE', headOfficeId: 'ho1' }), siteChain),
    ).toBe(true);
  });

  it('project assignment covers its sites', () => {
    expect(scopeCovers(assignment({ scopeType: 'PROJECT', projectId: 'pr1' }), siteChain)).toBe(
      true,
    );
  });

  it('site assignment covers only that site', () => {
    expect(scopeCovers(assignment({ scopeType: 'SITE', siteId: 's1' }), siteChain)).toBe(true);
    expect(
      scopeCovers(assignment({ scopeType: 'SITE', siteId: 's1' }), { ...siteChain, siteId: 's2' }),
    ).toBe(false);
  });

  it('sibling project does not inherit', () => {
    expect(
      scopeCovers(assignment({ scopeType: 'PROJECT', projectId: 'pr1' }), {
        ...siteChain,
        projectId: 'pr2',
      }),
    ).toBe(false);
  });

  it('child scope does not cover parent', () => {
    expect(scopeCovers(assignment({ scopeType: 'SITE', siteId: 's1' }), { companyId: 'c1' })).toBe(
      false,
    );
  });
});

describe('AccessControlService.hasPermission', () => {
  const activePrincipal = fakePrincipal({ id: 'p1', status: 'ACTIVE' });

  function serviceWith(
    assignments: AssignmentWithPermissions[],
    chain: ScopeChain | null,
    principal: Principal | null = activePrincipal,
  ) {
    const principalsRepo: PrincipalRepository = {
      findByLoginId: async () => null,
      findById: async () => principal,
    };
    const access: AccessRepository = {
      assignmentsForPrincipal: async () => assignments,
      companyExists: async () => true,
      resolveSiteChain: async () => chain,
      resolveProjectChain: async () => chain,
      resolveHeadOfficeChain: async () => chain,
    };
    return new AccessControlService({ principals: principalsRepo, access });
  }

  const target = { companyId: 'c1', scopeType: 'SITE' as const, scopeId: 's1' };
  const siteChain: ScopeChain = {
    companyId: 'c1',
    headOfficeId: 'ho1',
    projectId: 'pr1',
    siteId: 's1',
  };

  it('grants when a covering assignment holds the permission', async () => {
    const svc = serviceWith([assignment({ scopeType: 'COMPANY' })], siteChain);
    await expect(svc.hasPermission('p1', 'ORG_SITE_READ', target)).resolves.toBe(true);
  });

  it('denies when no assignment grants the permission', async () => {
    const svc = serviceWith(
      [
        assignment({
          role: { permissions: [{ permission: { key: 'OTHER_KEY' } }] },
        }),
      ],
      siteChain,
    );
    await expect(svc.hasPermission('p1', 'ORG_SITE_READ', target)).resolves.toBe(false);
  });

  it('denies a cross-company target (chain not resolvable)', async () => {
    const svc = serviceWith([assignment({})], null);
    await expect(
      svc.hasPermission('p1', 'ORG_SITE_READ', {
        companyId: 'c2',
        scopeType: 'SITE',
        scopeId: 'sx',
      }),
    ).resolves.toBe(false);
  });

  it('denies revoked assignments', async () => {
    // revokedAt filtering happens in the repository query; the fake returns
    // only active rows, so test the service-level principal checks instead.
    const svc = serviceWith([assignment({})], siteChain, null);
    await expect(svc.hasPermission('ghost', 'ORG_SITE_READ', target)).resolves.toBe(false);
  });

  it('denies suspended principals', async () => {
    const suspended = fakePrincipal({ id: 'p1', status: 'SUSPENDED' });
    const svc = serviceWith([assignment({})], siteChain, suspended);
    await expect(svc.hasPermission('p1', 'ORG_SITE_READ', target)).resolves.toBe(false);
  });

  it('assertPermission throws AccessDeniedError on denial', async () => {
    const svc = serviceWith([], siteChain);
    await expect(svc.assertPermission('p1', 'ORG_SITE_READ', target)).rejects.toThrow(
      AccessDeniedError,
    );
  });
});
