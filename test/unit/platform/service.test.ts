import { createHash } from 'node:crypto';
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
  operations: Row[];
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
        if (
          typeof data.version === 'object' &&
          data.version !== null &&
          'increment' in data.version
        ) {
          data.version = Number(c.version ?? 0) + 1;
        }
        Object.assign(c, data);
        return c as unknown as Company;
      },
      getDetails: async (cid) => {
        const c = store.companies.find((x) => x.id === cid && x.isPlatform !== true);
        if (!c) return null;
        const hos = store.headOffices.filter((h) => h.companyId === cid);
        const emps = store.employees
          .filter((e) => e.companyId === cid)
          .map((e) => ({
            ...e,
            principal: store.principals.find((p) => p.id === e.principalId) ?? null,
          }));
        return {
          ...c,
          headOffices: hos,
          employees: emps,
          _count: { projects: 0, employees: emps.length, departments: 0 },
        };
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
      findBound: async (companyId, employeeId) => {
        const e = store.employees.find((x) => x.id === employeeId && x.companyId === companyId);
        if (e === undefined) return null;
        return {
          id: e.id,
          status: e.status as string,
          principalId: (e.principalId ?? null) as string | null,
          displayName: (e.displayName ?? '') as string,
        };
      },
      findByPrincipalCompany: async (principalId, companyId) => {
        const e = store.employees.find(
          (x) => x.principalId === principalId && x.companyId === companyId,
        );
        if (e === undefined) return null;
        return { id: e.id, displayName: (e.displayName ?? '') as string };
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
        return {
          id: t.id,
          principalId: t.principalId as string,
          purpose: (t.purpose ?? null) as 'COMPANY_ONBOARD' | 'EMPLOYEE_INVITE' | null,
          companyId: (t.companyId ?? null) as string | null,
          employeeId: (t.employeeId ?? null) as string | null,
        };
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
        const comp = store.companies.find((x) => x.id === t.companyId);
        if (comp === undefined) return null; // unbound token → fail closed
        const emp =
          t.employeeId !== undefined && t.employeeId !== null
            ? store.employees.find((x) => x.id === t.employeeId)
            : store.employees.find(
                (x) => x.principalId === t.principalId && x.companyId === comp.id,
              );
        const loginId = typeof p?.loginId === 'string' ? p.loginId : '';
        const displayName = typeof emp?.displayName === 'string' ? emp.displayName : '';
        return {
          id: t.id,
          principalId: t.principalId as string,
          expiresAt: t.expiresAt as Date,
          purpose: (t.purpose ?? null) as 'COMPANY_ONBOARD' | 'EMPLOYEE_INVITE' | null,
          employeeId: (t.employeeId ?? null) as string | null,
          adminLoginId: loginId,
          adminDisplayName: displayName,
          companyId: comp.id,
          companyCode: comp.code as string,
          companyName: comp.name as string,
        };
      },
    },
    operations: {
      list: async () => store.operations,
      find: async (k: string) => store.operations.find((op) => op.key === k) ?? null,
      create: async (data: Record<string, unknown>) => {
        const row = { id: id(), ...data };
        store.operations.push(row);
        return row;
      },
      delete: async (k: string) => {
        const idx = store.operations.findIndex((op) => op.key === k);
        if (idx >= 0) {
          store.operations.splice(idx, 1);
          return 1;
        }
        return 0;
      },
      isInUse: async () => false,
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
    operations: [],
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
        legalName: 'Corp HO Pvt Ltd',
        addressLine1: '10 Corporate Rd',
        city: 'Pune',
        state: 'MH',
        pinCode: '411001',
        country: 'IN',
        contactName: 'Front Desk',
        contactEmail: 'front@example.test',
      },
    });

    expect(result.status).toBe('ONBOARDED');
    expect(result.companyId).toBe(created.companyId);
    expect(result.headOfficeId).toBeTruthy();
    const hoCreated = store.headOffices.find((h) => h.id === result.headOfficeId);
    // First HO is server-forced primary — client cannot demote it.
    expect(hoCreated?.isPrimary).toBe(true);
    expect(hoCreated?.addressLine1).toBe('10 Corporate Rd');
    expect(hoCreated?.contactEmail).toBe('front@example.test');

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
    const r = await svc.consumeClaim(`token${created.claimCode}`, 'new-password-1234');
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

describe('claim token purpose and binding (Slice A)', () => {
  const hashOf = (raw: string) => createHash('sha256').update(raw).digest('hex');

  /** Seed a bound EMPLOYEE_INVITE scenario. */
  function seedInvite(opts: { employeeStatus?: string; relinked?: boolean } = {}) {
    store.companies.push({ id: 'co-A', code: 'COA', name: 'Co A', isPlatform: false });
    store.principals.push({ id: 'pri-emp', status: 'SUSPENDED', loginId: 'w@co.test' });
    store.employees.push({
      id: 'emp-1',
      companyId: 'co-A',
      principalId: opts.relinked === true ? 'pri-other' : 'pri-emp',
      status: opts.employeeStatus ?? 'ACTIVE',
      displayName: 'Worker',
    });
    const raw = 'ab'.repeat(32);
    store.claimTokens.push({
      id: 'tok-inv',
      principalId: 'pri-emp',
      tokenHash: hashOf(raw),
      expiresAt: new Date(Date.now() + 3_600_000),
      consumedAt: null,
      purpose: 'EMPLOYEE_INVITE',
      companyId: 'co-A',
      employeeId: 'emp-1',
    });
    return { raw };
  }

  const unconsumed = (id: string) =>
    (
      store.claimTokens.find((t) => t.id === id) as unknown as {
        consumedAt: Date | null;
      }
    ).consumedAt === null;

  it('EMPLOYEE_INVITE code claims at /auth/claim and audits the bound company', async () => {
    const { raw } = seedInvite();
    const r = await svc.consumeClaim(raw, 'worker-password-1');
    expect(r.status).toBe('CLAIMED');
    expect(unconsumed('tok-inv')).toBe(false);
    const audit = store.auditLog.find((a) => a.action === 'ACCOUNT_CLAIM_COMPLETED');
    expect(audit?.companyId).toBe('co-A');
    expect(store.principals.find((p) => p.id === 'pri-emp')?.status).toBe('ACTIVE');
  });

  it('EMPLOYEE_INVITE code is rejected at /auth/claim/onboard WITHOUT being consumed', async () => {
    const { raw } = seedInvite();
    await expect(
      svc.consumeClaimAndOnboard(raw, { password: 'worker-password-1' }),
    ).rejects.toThrow('claim code');
    expect(unconsumed('tok-inv')).toBe(true); // purpose mismatch never burns the code
    expect(store.principals.find((p) => p.id === 'pri-emp')?.status).toBe('SUSPENDED');
  });

  it('EMPLOYEE_INVITE claim fails closed when the bound employee is deactivated', async () => {
    const { raw } = seedInvite({ employeeStatus: 'INACTIVE' });
    await expect(svc.consumeClaim(raw, 'worker-password-1')).rejects.toThrow('claim code');
    expect(unconsumed('tok-inv')).toBe(true); // still reissuable after reactivation
  });

  it('EMPLOYEE_INVITE claim fails when the employee was relinked to another principal', async () => {
    const { raw } = seedInvite({ relinked: true });
    await expect(svc.consumeClaim(raw, 'worker-password-1')).rejects.toThrow('claim code');
    expect(unconsumed('tok-inv')).toBe(true);
  });

  it('live token with no purpose/company binding fails closed everywhere', async () => {
    store.principals.push({ id: 'pri-x', status: 'SUSPENDED', loginId: 'x@x.test' });
    const raw = 'cd'.repeat(32);
    store.claimTokens.push({
      id: 'tok-legacy',
      principalId: 'pri-x',
      tokenHash: hashOf(raw),
      expiresAt: new Date(Date.now() + 3_600_000),
      consumedAt: null,
      purpose: null,
      companyId: null,
      employeeId: null,
    });
    await expect(svc.verifyClaim(raw)).rejects.toThrow();
    await expect(svc.consumeClaim(raw, 'p'.repeat(12))).rejects.toThrow('claim code');
    await expect(svc.consumeClaimAndOnboard(raw, { password: 'p'.repeat(12) })).rejects.toThrow(
      'claim code',
    );
    expect(unconsumed('tok-legacy')).toBe(true);
  });

  it('verify resolves the BOUND company deterministically for multi-company principals', async () => {
    store.companies.push(
      { id: 'co-A', code: 'COA', name: 'Co A', isPlatform: false },
      { id: 'co-B', code: 'COB', name: 'Co B', isPlatform: false },
    );
    store.principals.push({ id: 'pri-m', status: 'SUSPENDED', loginId: 'm@x.test' });
    store.employees.push(
      {
        id: 'emp-A',
        companyId: 'co-A',
        principalId: 'pri-m',
        status: 'ACTIVE',
        displayName: 'Worker A',
      },
      {
        id: 'emp-B',
        companyId: 'co-B',
        principalId: 'pri-m',
        status: 'ACTIVE',
        displayName: 'Worker B',
      },
    );
    const raw = 'ef'.repeat(32);
    store.claimTokens.push({
      id: 'tok-B',
      principalId: 'pri-m',
      tokenHash: hashOf(raw),
      expiresAt: new Date(Date.now() + 3_600_000),
      consumedAt: null,
      purpose: 'EMPLOYEE_INVITE',
      companyId: 'co-B',
      employeeId: 'emp-B',
    });
    const info = await svc.verifyClaim(raw);
    expect(info.companyCode).toBe('COB'); // bound company, not employees[0]
    expect(info.adminDisplayName).toBe('Worker B');
  });
});

describe('platform management operations', () => {
  it('getCompanyDetails, updateCompany, transitionCompanyStatus and catalogue operations', async () => {
    const created = await svc.createCompanyWithAdmin(actor, {
      companyCode: 'SARJAN',
      companyName: 'Sarjan Construction',
      adminLoginId: 'admin@sarjan.test',
      adminDisplayName: 'Sarjan Admin',
    });

    // 1. Get Details
    const details = (await svc.getCompanyDetails(created.companyId)) as {
      id: string;
      code: string;
      admin: { loginId: string; claimPending: boolean } | null;
    };
    expect(details.id).toBe(created.companyId);
    expect(details.code).toBe('SARJAN');
    expect(details.admin?.loginId).toBe('admin@sarjan.test');
    expect(details.admin?.claimPending).toBe(true);

    // 2. Update Company
    const updated = await svc.updateCompany(actor, created.companyId, {
      legalName: 'Sarjan Construction Private Limited',
      pan: 'ABCDE1234F',
      website: 'https://sarjan.test',
    });
    expect(updated.legalName).toBe('Sarjan Construction Private Limited');
    expect(updated.pan).toBe('ABCDE1234F');

    // 3. Status Transition: ACTIVE -> SUSPENDED -> ACTIVE
    const suspended = await svc.transitionCompanyStatus(actor, created.companyId, 'SUSPENDED');
    expect(suspended.status).toBe('SUSPENDED');

    const reactivated = await svc.transitionCompanyStatus(actor, created.companyId, 'ACTIVE');
    expect(reactivated.status).toBe('ACTIVE');

    // Invalid transition throws
    await expect(
      svc.transitionCompanyStatus(actor, created.companyId, 'UNKNOWN'),
    ).rejects.toThrow();

    // 4. Catalogue Operations
    const op = (await svc.createCatalogueOperation(actor, {
      key: 'TEST_OPERATION',
      domain: 'QUALITY',
      name: 'Test Quality Check',
      description: 'Periodic quality verification',
    })) as { key: string };
    expect(op.key).toBe('TEST_OPERATION');

    // Duplicate key throws 409
    await expect(
      svc.createCatalogueOperation(actor, {
        key: 'TEST_OPERATION',
        domain: 'QUALITY',
        name: 'Another',
      }),
    ).rejects.toThrow();

    // Delete operation
    const del = await svc.deleteCatalogueOperation(actor, 'TEST_OPERATION');
    expect(del.deleted).toBe(true);
  });
});
