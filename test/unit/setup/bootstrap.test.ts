import { describe, it, expect } from 'vitest';
import {
  bootstrapOrganization,
  SYSTEM_PRINCIPAL_ID,
  OWNER_ROLE_KEY,
  type BootstrapTx,
} from '../../../src/modules/setup/bootstrap.js';
import { AppError } from '../../../src/common/errors/app-error.js';

interface Row extends Record<string, unknown> {
  id: string;
}

interface BootStore {
  companies: Row[];
  headOffices: Row[];
  departments: Row[];
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
    headOffices: [],
    departments: [],
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
      findFirst: async () =>
        (store.companies[0] as { id: string; code: string } | undefined) ?? null,
      create: push('companies'),
    },
    headOffice: { create: push('headOffices') },
    department: { create: push('departments') },
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

const input = {
  companyCode: 'ACME',
  companyName: 'Acme Construction',
  ownerLoginId: 'owner@acme.test',
  ownerPassword: 'correct-horse-battery-staple',
};

describe('bootstrapOrganization', () => {
  it('creates company, primary HO, depts, owner, employee, owner role in one flow', async () => {
    const { tx, store } = makeTx();
    const r = await bootstrapOrganization(tx, input);
    expect(r.status).toBe('CREATED');
    expect(store.companies).toHaveLength(1);
    expect(store.headOffices[0]?.isPrimary).toBe(true);
    expect(store.departments.map((d) => d.code).sort()).toEqual(['ADMIN', 'FINANCE']);
    expect(store.departments.every((d) => d.baseHeadOfficeId === store.headOffices[0]?.id)).toBe(
      true,
    );
    expect(store.departments.every((d) => d.scopeType === 'COMPANY')).toBe(true);
    const owner = store.principals.find((p) => p.loginId === 'owner@acme.test');
    expect(owner?.type).toBe('USER');
    expect(owner?.passwordHash).toBeTypeOf('string');
    expect(String(owner?.passwordHash)).not.toContain(input.ownerPassword);
    expect(store.employees[0]?.principalId).toBe(owner?.id);
    expect(store.roles[0]?.key).toBe(OWNER_ROLE_KEY);
    expect(store.roleAssignments[0]?.scopeType).toBe('COMPANY');
    // least-privilege: only ORG_* + DEPARTMENT_* keys granted
    const permKeys = store.rolePermissions.map(
      (rp) => store.permissions.find((p) => p.id === rp.permissionId)?.key,
    );
    expect(permKeys.length).toBeGreaterThan(0);
    expect(
      permKeys.every(
        (k) =>
          String(k).startsWith('ORG_') ||
          String(k).startsWith('DEPARTMENT_') ||
          String(k).startsWith('EMPLOYEE_'),
      ),
    ).toBe(true);
    // audit uses the explicit SYSTEM principal
    const audit = store.auditLog[0];
    const system = store.principals.find((p) => p.id === SYSTEM_PRINCIPAL_ID);
    expect(audit?.action).toBe('SYSTEM_BOOTSTRAP_COMPLETED');
    expect(audit?.actorId).toBe(system?.id);
    expect(audit?.actorType).toBe('SYSTEM');
  });

  it('is idempotent: a second run reports ALREADY_COMPLETE without duplicating', async () => {
    const { tx, store } = makeTx();
    await bootstrapOrganization(tx, input);
    const counts = Object.fromEntries(
      Object.entries(store).map(([k, v]) => [k, (v as Row[]).length]),
    );
    const r = await bootstrapOrganization(tx, input);
    expect(r.status).toBe('ALREADY_COMPLETE');
    for (const [k, v] of Object.entries(store) as [Bucket, Row[]][]) {
      expect(v.length).toBe(counts[k]);
    }
  });

  it('refuses when an unrelated company exists', async () => {
    const { tx, store } = makeTx();
    store.companies.push({ id: 'other', code: 'OTHER' });
    await expect(bootstrapOrganization(tx, input)).rejects.toThrow(AppError);
    expect(store.departments).toHaveLength(0);
  });
});
