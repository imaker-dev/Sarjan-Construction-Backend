import { describe, it, expect } from 'vitest';
import {
  reconcileOwnerPermissions,
  RECONCILE_KEYS,
  type ReconcileTx,
} from '../../../src/modules/setup/reconcile.js';
import { SYSTEM_PRINCIPAL_ID } from '../../../src/modules/setup/bootstrap.js';

interface Row extends Record<string, unknown> {
  id: string;
}

interface RecStore {
  principals: Row[];
  companies: Row[];
  roles: Row[];
  permissions: Row[];
  rolePermissions: Row[];
  auditLog: Row[];
}

function makeTx(): { tx: ReconcileTx; store: RecStore } {
  const store: RecStore = {
    principals: [{ id: SYSTEM_PRINCIPAL_ID }],
    companies: [],
    roles: [],
    permissions: [],
    rolePermissions: [],
    auditLog: [],
  };
  let n = 0;
  const id = () => `r${++n}`;
  const tx: ReconcileTx = {
    principal: {
      findFirst: async ({ where }) => store.principals.find((p) => p.id === where.id) ?? null,
    },
    company: {
      findMany: async ({ where }) =>
        store.companies.filter((c) => c.isPlatform === where.isPlatform).map((c) => ({ id: c.id })),
    },
    role: {
      findMany: async ({ where }) =>
        store.roles
          .filter((r) => r.key === where.key && r.isSystem === where.isSystem)
          .map((r) => ({ id: r.id, companyId: r.companyId as string })),
      findFirst: async ({ where }) =>
        store.roles.find(
          (r) =>
            r.companyId === where.companyId && r.key === where.key && r.isSystem === where.isSystem,
        ) ?? null,
      create: async ({ data }) => {
        const row = { id: id(), ...data, isSystem: true };
        store.roles.push(row);
        return row;
      },
    },
    permission: {
      upsert: async ({ where, create }) => {
        const existing = store.permissions.find((p) => p.key === where.key);
        if (existing !== undefined) return existing;
        const row = { id: id(), ...create };
        store.permissions.push(row);
        return row;
      },
    },
    rolePermission: {
      findUnique: async ({ where }) =>
        store.rolePermissions.find(
          (rp) =>
            rp.roleId === where.roleId_permissionId.roleId &&
            rp.permissionId === where.roleId_permissionId.permissionId,
        ) ?? null,
      create: async ({ data }) => {
        const row = { id: id(), ...data };
        store.rolePermissions.push(row);
        return row;
      },
    },
    auditLog: {
      create: async ({ data }) => {
        const row = { id: id(), ...data };
        store.auditLog.push(row);
        return row;
      },
    },
  };
  return { tx, store };
}

describe('reconcileOwnerPermissions', () => {
  it('grants the leave keys (LEAVE_READ/MANAGE/APPLY/APPROVE) to Company Owner', async () => {
    const { tx, store } = makeTx();
    store.companies.push({ id: 'c1', isPlatform: false });
    store.roles.push({ id: 'r-owner', key: 'COMPANY_OWNER', isSystem: true, companyId: 'c1' });
    await reconcileOwnerPermissions(tx);
    const permIds = new Map(store.permissions.map((p) => [p.id, p.key]));
    const granted = new Set(
      store.rolePermissions.map((rp) => permIds.get(rp.permissionId as string)),
    );
    expect(granted).toEqual(new Set(RECONCILE_KEYS));
    expect(granted).toContain('LEAVE_READ');
    expect(granted).toContain('LEAVE_MANAGE');
    expect(granted).toContain('LEAVE_APPLY');
    expect(granted).toContain('LEAVE_APPROVE');
  });

  it('adds only the employee+compliance grants to COMPANY_OWNER system roles', async () => {
    const { tx, store } = makeTx();
    store.companies.push({ id: 'c1', isPlatform: false });
    store.roles.push({ id: 'r-owner', key: 'COMPANY_OWNER', isSystem: true, companyId: 'c1' });
    store.roles.push({ id: 'r-other', key: 'SITE_MANAGER', isSystem: true, companyId: 'c1' });
    store.roles.push({ id: 'r-custom', key: 'COMPANY_OWNER', isSystem: false, companyId: 'c1' });
    const changed = await reconcileOwnerPermissions(tx);
    expect(changed).toBe(RECONCILE_KEYS.length);
    const permIds = new Map(store.permissions.map((p) => [p.id, p.key]));
    for (const rp of store.rolePermissions) {
      expect(rp.roleId).toBe('r-owner');
      expect(RECONCILE_KEYS).toContain(permIds.get(rp.permissionId as string));
    }
    expect(store.auditLog).toHaveLength(RECONCILE_KEYS.length);
    expect(
      store.auditLog.every((a) => a.actorId === SYSTEM_PRINCIPAL_ID && a.actorType === 'SYSTEM'),
    ).toBe(true);
  });

  it('excludes COMPANY_OWNER roles on the platform company', async () => {
    const { tx, store } = makeTx();
    store.companies.push({ id: 'plat', isPlatform: true });
    store.companies.push({ id: 'c1', isPlatform: false });
    store.roles.push({ id: 'r-plat', key: 'COMPANY_OWNER', isSystem: true, companyId: 'plat' });
    store.roles.push({ id: 'r-owner', key: 'COMPANY_OWNER', isSystem: true, companyId: 'c1' });
    await reconcileOwnerPermissions(tx);
    expect(store.rolePermissions.every((rp) => rp.roleId === 'r-owner')).toBe(true);
    expect(store.auditLog.every((a) => a.entityId === 'r-owner')).toBe(true);
  });

  it('is idempotent: second run adds no grants and writes no audit', async () => {
    const { tx, store } = makeTx();
    store.companies.push({ id: 'c1', isPlatform: false });
    store.roles.push({ id: 'r-owner', key: 'COMPANY_OWNER', isSystem: true, companyId: 'c1' });
    await reconcileOwnerPermissions(tx);
    const grants = store.rolePermissions.length;
    const audits = store.auditLog.length;
    expect(await reconcileOwnerPermissions(tx)).toBe(0);
    expect(store.rolePermissions).toHaveLength(grants);
    expect(store.auditLog).toHaveLength(audits);
  });

  it('fails closed when the SYSTEM principal is missing', async () => {
    const { tx, store } = makeTx();
    store.principals.length = 0;
    await expect(reconcileOwnerPermissions(tx)).rejects.toThrow('SYSTEM bootstrap principal');
  });
});
