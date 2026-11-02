import { describe, it, expect } from 'vitest';
import {
  bootstrapPlatform,
  SYSTEM_PRINCIPAL_ID,
  PLATFORM_COMPANY_CODE,
  PLATFORM_ADMIN_ROLE_KEY,
  TENANT_OWNER_PERMISSIONS,
  PLATFORM_ADMIN_PERMISSIONS,
  type BootstrapTx,
} from '../../../src/modules/setup/bootstrap.js';

interface Row extends Record<string, unknown> {
  id: string;
}

interface BootStore {
  companies: Row[];
  principals: Row[];
  employees: Row[];
  roles: Row[];
  permissions: Row[];
  rolePermissions: Row[];
  roleAssignments: Row[];
  auditLog: Row[];
}

type Bucket = keyof BootStore;

function makeTx(): { tx: BootstrapTx; store: BootStore } {
  const store: BootStore = {
    companies: [],
    principals: [],
    employees: [],
    roles: [],
    permissions: [],
    rolePermissions: [],
    roleAssignments: [],
    auditLog: [],
  };
  let n = 0;
  const id = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  const push = (bucket: Bucket) => async (args: { data: Record<string, unknown> }) => {
    const row = { id: id(), ...args.data };
    store[bucket].push(row);
    return row;
  };
  const tx: BootstrapTx = {
    company: {
      findFirst: async (args) => {
        const match = store.companies.find((c) =>
          args !== undefined && 'isPlatform' in args.where
            ? c.isPlatform === args.where.isPlatform
            : true,
        );
        return (match as { id: string; code: string; isPlatform: boolean } | undefined) ?? null;
      },
      create: push('companies'),
    },
    principal: {
      findFirst: async ({ where }) => store.principals.find((p) => p.id === where.id) ?? null,
      create: push('principals'),
    },
    employee: { create: push('employees') },
    role: { create: push('roles') },
    permission: {
      upsert: async ({ where, create }) => {
        const existing = store.permissions.find((p) => p.key === where.key);
        if (existing !== undefined) return existing;
        const row = { id: id(), ...create };
        store.permissions.push(row);
        return row;
      },
    },
    rolePermission: { create: push('rolePermissions') },
    roleAssignment: { create: push('roleAssignments') },
    auditLog: { create: push('auditLog') },
  };
  return { tx, store };
}

const input = { adminLoginId: 'ops@platform.test', adminPassword: 'correct-horse-battery-staple' };

describe('permission allowlists', () => {
  it('owner/platform keysets are explicit — no prefix auto-grants', () => {
    // Exact sets — a future catalogue key is never silently granted.
    expect(PLATFORM_ADMIN_PERMISSIONS).toEqual([
      'PLATFORM_COMPANY_CREATE',
      'PLATFORM_COMPANY_READ',
    ]);
    expect(TENANT_OWNER_PERMISSIONS).toContain('COMPLIANCE_READ');
    expect(TENANT_OWNER_PERMISSIONS).toContain('COMPLIANCE_MANAGE');
    expect(TENANT_OWNER_PERMISSIONS).toContain('EMPLOYEE_MANAGE');
    // No platform key reaches a tenant owner, no tenant key a platform admin.
    expect(TENANT_OWNER_PERMISSIONS.some((k) => k.startsWith('PLATFORM_'))).toBe(false);
    expect(PLATFORM_ADMIN_PERMISSIONS.some((k) => !k.startsWith('PLATFORM_'))).toBe(false);
  });
});

describe('bootstrapPlatform', () => {
  it('creates the sentinel platform company + PLATFORM_ADMIN, no tenant structure', async () => {
    const { tx, store } = makeTx();
    const r = await bootstrapPlatform(tx, input);
    expect(r.status).toBe('CREATED');
    const platform = store.companies[0];
    expect(platform?.isPlatform).toBe(true);
    expect(platform?.code).toBe(PLATFORM_COMPANY_CODE);
    // No tenant HeadOffices/departments — those live in customer companies.
    const admin = store.principals.find((p) => p.loginId === 'ops@platform.test');
    expect(admin?.type).toBe('USER');
    expect(String(admin?.passwordHash)).not.toContain(input.adminPassword);
    expect(store.roles[0]?.key).toBe(PLATFORM_ADMIN_ROLE_KEY);
    const permKeys = store.rolePermissions.map(
      (rp) => store.permissions.find((p) => p.id === rp.permissionId)?.key,
    );
    expect(permKeys.length).toBeGreaterThan(0);
    expect(permKeys.every((k) => String(k).startsWith('PLATFORM_'))).toBe(true);
    const audit = store.auditLog[0];
    const system = store.principals.find((p) => p.id === SYSTEM_PRINCIPAL_ID);
    expect(audit?.action).toBe('PLATFORM_BOOTSTRAP_COMPLETED');
    expect(audit?.actorId).toBe(system?.id);
    expect(audit?.actorType).toBe('SYSTEM');
  });

  it('preserves existing customer companies and reports ALREADY_COMPLETE on rerun', async () => {
    const { tx, store } = makeTx();
    store.companies.push({ id: 'cust', code: 'ACME', isPlatform: false });
    await bootstrapPlatform(tx, input); // creates platform alongside customer
    expect(store.companies).toHaveLength(2);
    expect(store.companies.find((c) => c.id === 'cust')?.code).toBe('ACME');
    const counts = Object.fromEntries(
      Object.entries(store).map(([k, v]) => [k, (v as Row[]).length]),
    );
    const r = await bootstrapPlatform(tx, input);
    expect(r.status).toBe('ALREADY_COMPLETE');
    for (const [k, v] of Object.entries(store) as [Bucket, Row[]][]) {
      expect(v.length).toBe(counts[k]);
    }
  });
});
