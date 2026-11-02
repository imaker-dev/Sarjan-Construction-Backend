import { describe, it, expect, beforeEach } from 'vitest';
import { PlatformService } from '../../../src/modules/platform/service.js';
import type {
  PlatformRepos,
  PlatformUnitOfWork,
} from '../../../src/modules/platform/repository.js';
import type { ActorContext } from '../../../src/modules/organization/types.js';
import type { Company } from '@prisma/client';

interface Row extends Record<string, unknown> {
  id: string;
}

interface Store {
  companies: Row[];
  principals: Row[];
  employees: Row[];
  roles: Row[];
  permissions: Row[];
  rolePermissions: Row[];
  roleAssignments: Row[];
  claimTokens: Row[];
  auditLog: Row[];
}

const actor: ActorContext = { actorId: 'platform-admin-1', actorType: 'USER' };

function makeUow(store: Store): PlatformUnitOfWork {
  let n = 0;
  const id = () => `id-${++n}`;
  const repos: PlatformRepos = {
    companies: {
      findById: async (cid, rid) =>
        (store.companies.find((c) => c.id === rid && c.id === cid) ?? null) as Company | null,
      findPlatform: async () =>
        (store.companies.find((c) => c.isPlatform === true) ?? null) as Company | null,
      findByCode: async (code) =>
        (store.companies.find((c) => c.code === code) ?? null) as Company | null,
      list: async () =>
        store.companies.filter((c) => c.isPlatform !== true) as unknown as Company[],
      create: async (data) => {
        const row = { id: id(), status: 'ACTIVE', ...data };
        store.companies.push(row);
        return row as unknown as Company;
      },
    },
    principals: {
      create: async (data) => {
        const row = { id: id(), ...data };
        store.principals.push(row);
        return row;
      },
      activateIfSuspended: async (pid, data) => {
        const p = store.principals.find((x) => x.id === pid);
        if (p?.status !== 'SUSPENDED') return false;
        Object.assign(p, data);
        return true;
      },
      update: async (pid, data) => {
        const p = store.principals.find((x) => x.id === pid);
        if (!p) throw new Error('not found');
        Object.assign(p, data);
        return p;
      },
      findByLoginId: async (l) => store.principals.find((p) => p.loginId === l) ?? null,
    },
    employees: {
      create: async (data) => {
        const row = { id: id(), ...data };
        store.employees.push(row);
        return row;
      },
    },
    roles: {
      create: async (data) => {
        const row = { id: id(), ...data };
        store.roles.push(row);
        return row;
      },
    },
    permissions: {
      upsert: async (key) => {
        const ex = store.permissions.find((p) => p.key === key);
        if (ex) return ex;
        const row = { id: id(), key };
        store.permissions.push(row);
        return row;
      },
    },
    rolePermissions: {
      create: async (roleId, permissionId) => {
        const row = { id: id(), roleId, permissionId };
        store.rolePermissions.push(row);
        return row;
      },
    },
    roleAssignments: {
      create: async (data) => {
        const row = { id: id(), ...data };
        store.roleAssignments.push(row);
        return row;
      },
    },
    claimTokens: {
      create: async (data) => {
        const row = { id: id(), consumedAt: null, ...data };
        store.claimTokens.push(row);
        return row;
      },
      consume: async (tokenHash, now) => {
        const t = store.claimTokens.find(
          (c) => c.tokenHash === tokenHash && c.consumedAt === null && (c.expiresAt as Date) > now,
        );
        if (!t) return null;
        t.consumedAt = now;
        return { id: t.id, principalId: t.principalId as string };
      },
      revokeActive: async (principalId, at) => {
        let count = 0;
        for (const c of store.claimTokens) {
          if (c.principalId === principalId && c.consumedAt === null) {
            c.consumedAt = at;
            count += 1;
          }
        }
        return count;
      },
    },
    audit: {
      record: async (entry) => {
        store.auditLog.push({ id: id(), ...entry });
      },
    },
  };
  return {
    run: async (fn) => {
      const snapshot = structuredClone(store);
      try {
        return await fn(repos);
      } catch (error) {
        Object.assign(store, structuredClone(snapshot));
        throw error;
      }
    },
  };
}

let store: Store;
let svc: PlatformService;
beforeEach(() => {
  store = {
    companies: [],
    principals: [],
    employees: [],
    roles: [],
    permissions: [],
    rolePermissions: [],
    roleAssignments: [],
    claimTokens: [],
    auditLog: [],
  };
  svc = new PlatformService(makeUow(store));
});

describe('createCompanyWithAdmin', () => {
  it('creates company, owner role, pending admin, employee, claim in one flow', async () => {
    const r = await svc.createCompanyWithAdmin(actor, {
      companyCode: 'acme',
      companyName: 'Acme Infra',
      adminLoginId: 'admin@acme.test',
      adminDisplayName: 'Acme Admin',
    });
    expect(r.companyCode).toBe('ACME');
    expect(store.companies[0]?.isPlatform).toBe(false);
    expect(store.roles[0]?.key).toBe('COMPANY_OWNER');
    const permKeys = store.rolePermissions.map(
      (rp) => store.permissions.find((p) => p.id === rp.permissionId)?.key,
    );
    expect(permKeys.every((k) => !String(k).startsWith('PLATFORM_'))).toBe(true);
    const admin = store.principals[0];
    expect(admin?.status).toBe('SUSPENDED');
    expect(store.employees[0]?.companyId).toBe(r.companyId);
    expect(store.roleAssignments[0]?.scopeType).toBe('COMPANY');
    // claim token: hash stored, raw returned once
    const token = store.claimTokens[0];
    expect(token?.tokenHash).toBeTypeOf('string');
    expect(token?.tokenHash).not.toBe(r.claimCode);
    expect(r.claimCode.length).toBe(64);
    // audit names the platform admin, not SYSTEM
    const audit = store.auditLog[0];
    expect(audit?.action).toBe('PLATFORM_COMPANY_CREATED');
    expect(audit?.actorId).toBe('platform-admin-1');
    expect(audit?.actorType).toBe('USER');
    // raw code never in audit/DB
    expect(JSON.stringify(store.auditLog)).not.toContain(r.claimCode);
    expect(JSON.stringify(store.claimTokens)).not.toContain(r.claimCode);
  });
});

describe('claim lifecycle', () => {
  it('consume activates admin + audits; replay and unknown codes rejected', async () => {
    const created = await svc.createCompanyWithAdmin(actor, {
      companyCode: 'ACME',
      companyName: 'Acme',
      adminLoginId: 'a@a.test',
      adminDisplayName: 'A',
    });
    const r = await svc.consumeClaim(created.claimCode, 'new-password-1234');
    expect(r.status).toBe('CLAIMED');
    const admin = store.principals[0];
    expect(admin?.status).toBe('ACTIVE');
    expect(String(admin?.passwordHash)).not.toContain('new-password-1234');
    expect(store.auditLog.some((a) => a.action === 'ACCOUNT_CLAIM_COMPLETED')).toBe(true);
    await expect(svc.consumeClaim(created.claimCode, 'other-password')).rejects.toThrow();
    await expect(svc.consumeClaim('deadbeef', 'x'.repeat(12))).rejects.toThrow();
  });

  it('a claim on an already-active principal fails without consuming its code', async () => {
    const created = await svc.createCompanyWithAdmin(actor, {
      companyCode: 'ACME',
      companyName: 'Acme',
      adminLoginId: 'a@a.test',
      adminDisplayName: 'A',
    });
    await svc.consumeClaim(created.claimCode, 'x'.repeat(12)); // principal now ACTIVE
    // A second code issued before activation would now lose — simulate via
    // reissue minting a fresh code after principal is ACTIVE.
    const reissued = await svc.reissueClaim(actor, created.companyId, created.adminPrincipalId);
    await expect(svc.consumeClaim(reissued.claimCode, 'y'.repeat(12))).rejects.toThrow(
      'claim code',
    );
    // Token must remain unconsumed (rolled back) and password unchanged.
    const latest = store.claimTokens[store.claimTokens.length - 1];
    expect(latest?.consumedAt).toBeNull();
  });

  it('reissue invalidates prior codes; old code can no longer claim', async () => {
    const created = await svc.createCompanyWithAdmin(actor, {
      companyCode: 'ACME',
      companyName: 'Acme',
      adminLoginId: 'a@a.test',
      adminDisplayName: 'A',
    });
    const reissued = await svc.reissueClaim(actor, created.companyId, created.adminPrincipalId);
    await expect(svc.consumeClaim(created.claimCode, 'x'.repeat(12))).rejects.toThrow();
    const r = await svc.consumeClaim(reissued.claimCode, 'y'.repeat(12));
    expect(r.status).toBe('CLAIMED');
  });
});
