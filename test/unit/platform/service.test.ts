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
  headOffices: Row[];
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
      update: async (cid, data) => {
        const c = store.companies.find((x) => x.id === cid);
        if (!c) throw new Error('company not found');
        Object.assign(c, data);
        return c as unknown as Company;
      },
    },
    headOffices: {
      create: async (data) => {
        const row = { id: id(), status: 'ACTIVE', ...data };
        store.headOffices.push(row);
        return row as unknown as { id: string; code: string; name: string };
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
      updateByPrincipalId: async (principalId, data) => {
        let count = 0;
        for (const e of store.employees) {
          if (e.principalId === principalId) {
            Object.assign(e, data);
            count++;
          }
        }
        return count;
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
      findActive: async (tokenHash, now) => {
        const t = store.claimTokens.find(
          (c) => c.tokenHash === tokenHash && c.consumedAt === null && (c.expiresAt as Date) > now,
        );
        if (!t) return null;
        const p = store.principals.find((x) => x.id === t.principalId);
        const emp = store.employees.find((x) => x.principalId === t.principalId);
        const comp = store.companies.find((x) => x.id === emp?.companyId);
        const loginId = typeof p?.loginId === 'string' ? p.loginId : '';
        const displayName = typeof emp?.displayName === 'string' ? emp.displayName : '';
        const companyId = typeof comp?.id === 'string' ? comp.id : '';
        const companyCode = typeof comp?.code === 'string' ? comp.code : '';
        const companyName = typeof comp?.name === 'string' ? comp.name : '';
        return {
          id: t.id,
          principalId: t.principalId as string,
          expiresAt: t.expiresAt as Date,
          adminLoginId: loginId,
          adminDisplayName: displayName,
          companyId,
          companyCode,
          companyName,
        };
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
    headOffices: [],
    principals: [],
    employees: [],
    roles: [],
    permissions: [],
    rolePermissions: [],
    roleAssignments: [],
    claimTokens: [],
    auditLog: [],
  };
  svc = new PlatformService(makeUow(store), 'https://app.sarjan.local');
});

describe('createCompanyWithAdmin', () => {
  it('creates company, owner role, pending admin, employee, claim and returns claimUrl', async () => {
    const r = await svc.createCompanyWithAdmin(actor, {
      companyCode: 'acme',
      companyName: 'Acme Infra',
      adminLoginId: 'admin@acme.test',
      adminDisplayName: 'Acme Admin',
    });
    expect(r.companyCode).toBe('ACME');
    expect(r.claimUrl).toBe(`https://app.sarjan.local/onboard?token=${r.claimCode}`);
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

describe('claim verification and onboarding flow', () => {
  it('verifyClaim returns company and admin info for valid token and rejects invalid token', async () => {
    const created = await svc.createCompanyWithAdmin(actor, {
      companyCode: 'ACME',
      companyName: 'Acme Infra',
      adminLoginId: 'admin@acme.test',
      adminDisplayName: 'Acme Admin',
    });

    const info = await svc.verifyClaim(created.claimCode);
    expect(info.valid).toBe(true);
    expect(info.companyCode).toBe('ACME');
    expect(info.companyName).toBe('Acme Infra');
    expect(info.adminLoginId).toBe('admin@acme.test');
    expect(info.adminDisplayName).toBe('Acme Admin');

    await expect(svc.verifyClaim('non-existent-code')).rejects.toThrow();
  });

  it('consumeClaimAndOnboard completes onboarding with company details and head office', async () => {
    const created = await svc.createCompanyWithAdmin(actor, {
      companyCode: 'ACME',
      companyName: 'Acme Infra',
      adminLoginId: 'admin@acme.test',
      adminDisplayName: 'Acme Admin',
    });

    const result = await svc.consumeClaimAndOnboard(created.claimCode, {
      password: 'MyStrongPassword1234!',
      displayName: 'Rajesh Patel',
      company: {
        legalName: 'Acme Infrastructure Private Limited',
        pan: 'ABCDE1234F',
        regCity: 'Ahmedabad',
      },
      headOffice: {
        code: 'HQ',
        name: 'Corporate Head Office',
        isPrimary: true,
      },
    });

    expect(result.status).toBe('ONBOARDED');
    expect(result.companyId).toBe(created.companyId);
    expect(result.headOfficeId).toBeTruthy();

    // Verify company profile was updated
    const company = store.companies.find((c) => c.id === created.companyId);
    expect(company?.legalName).toBe('Acme Infrastructure Private Limited');
    expect(company?.pan).toBe('ABCDE1234F');

    // Verify primary HeadOffice was created
    const ho = store.headOffices.find((h) => h.id === result.headOfficeId);
    expect(ho?.code).toBe('HQ');
    expect(ho?.name).toBe('Corporate Head Office');
    expect(ho?.isPrimary).toBe(true);

    // Verify Admin Principal is ACTIVE with new password and updated employee display name
    const admin = store.principals.find((p) => p.id === created.adminPrincipalId);
    expect(admin?.status).toBe('ACTIVE');
    const emp = store.employees.find((e) => e.principalId === created.adminPrincipalId);
    expect(emp?.displayName).toBe('Rajesh Patel');

    // Replay with consumed code fails
    await expect(
      svc.consumeClaimAndOnboard(created.claimCode, {
        password: 'AnotherPassword1234!',
      }),
    ).rejects.toThrow();
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
