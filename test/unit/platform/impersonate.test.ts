import { describe, it, expect, vi } from 'vitest';
import { PlatformService } from '../../../src/modules/platform/service.js';
import type {
  PlatformUnitOfWork,
  PlatformRepos,
} from '../../../src/modules/platform/repository.js';
import type { ActorContext, AuditRecord } from '../../../src/modules/organization/types.js';

describe('PlatformService - impersonateCompany', () => {
  const superAdminActor: ActorContext = {
    actorId: 'super-admin-1',
    actorType: 'USER',
    correlationId: 'req-1',
  };

  it('impersonates active tenant company owner and creates audit trail', async () => {
    let auditRecorded = false;
    let impersonationInvoked = false;

    const mockCompany = {
      id: 'c-1',
      code: 'ACME',
      name: 'Acme Infra',
      isPlatform: false,
      status: 'ACTIVE',
      version: 0,
    };

    const mockRepos: Partial<PlatformRepos> = {
      companies: {
        findById: vi.fn().mockResolvedValue(mockCompany),
        findOwnerPrincipalId: vi.fn().mockResolvedValue('owner-p-1'),
      } as unknown as PlatformRepos['companies'],
      audit: {
        record: vi.fn().mockImplementation(async (entry: AuditRecord) => {
          auditRecorded = true;
          expect(entry.action).toBe('SUPER_ADMIN_IMPERSONATION_STARTED');
          expect(entry.entityId).toBe('c-1');
        }),
      },
    };

    const mockUow: PlatformUnitOfWork = {
      run: async (fn) => fn(mockRepos as PlatformRepos),
    };

    const service = new PlatformService(
      mockUow,
      'http://localhost:3000',
      async (actor, principalId, meta) => {
        impersonationInvoked = true;
        expect(actor.actorId).toBe('super-admin-1');
        expect(principalId).toBe('owner-p-1');
        return {
          accessToken: 'tenant-owner-access-token',
          refreshToken: 'tenant-owner-refresh-token',
          impersonated: true,
          meta,
        };
      },
    );

    const result = (await service.impersonateCompany(superAdminActor, 'c-1', {
      ip: '127.0.0.1',
    })) as {
      accessToken: string;
      impersonated: boolean;
    };

    expect(result.accessToken).toBe('tenant-owner-access-token');
    expect(result.impersonated).toBe(true);
    expect(auditRecorded).toBe(true);
    expect(impersonationInvoked).toBe(true);
  });

  it('rejects impersonating a platform company', async () => {
    const mockCompany = {
      id: 'c-platform',
      code: 'SARJAN',
      name: 'Sarjan Platform',
      isPlatform: true,
      status: 'ACTIVE',
    };

    const mockRepos: Partial<PlatformRepos> = {
      companies: {
        findById: vi.fn().mockResolvedValue(mockCompany),
      } as unknown as PlatformRepos['companies'],
    };

    const mockUow: PlatformUnitOfWork = {
      run: async (fn) => fn(mockRepos as PlatformRepos),
    };

    const service = new PlatformService(mockUow, 'http://localhost:3000', vi.fn());

    await expect(service.impersonateCompany(superAdminActor, 'c-platform', {})).rejects.toThrow();
  });

  it('rejects impersonating a suspended company', async () => {
    const mockCompany = {
      id: 'c-suspended',
      code: 'SUSP',
      name: 'Suspended Co',
      isPlatform: false,
      status: 'SUSPENDED',
    };

    const mockRepos: Partial<PlatformRepos> = {
      companies: {
        findById: vi.fn().mockResolvedValue(mockCompany),
      } as unknown as PlatformRepos['companies'],
    };

    const mockUow: PlatformUnitOfWork = {
      run: async (fn) => fn(mockRepos as PlatformRepos),
    };

    const service = new PlatformService(mockUow, 'http://localhost:3000', vi.fn());

    await expect(service.impersonateCompany(superAdminActor, 'c-suspended', {})).rejects.toThrow(
      /Cannot impersonate suspended or archived company/,
    );
  });
});
