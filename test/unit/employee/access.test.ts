import { describe, it, expect } from 'vitest';
const first = <T>(a: T[]): T => {
  const v = a[0];
  if (v === undefined) throw new Error('expected non-empty array');
  return v;
};
import { EmployeeAccessService } from '../../../src/modules/employee/access.js';

interface FakeStore {
  employees: Record<string, unknown>[];
  principals: Record<string, unknown>[];
  roles: Record<string, unknown>[];
  roleAssignments: Record<string, unknown>[];
  claimTokens: Record<string, unknown>[];
  headOffices: Record<string, unknown>[];
  auditLog: Record<string, unknown>[];
}

function fakePrisma(store: FakeStore) {
  let n = 0;
  const tx = {
    employee: {
      findFirst: async ({ where }: Record<string, unknown>) =>
        store.employees.find((e) => {
          const w = where as Record<string, unknown>;
          if (e.id !== w.id || e.companyId !== w.companyId) return false;
          if (
            'principalId' in w &&
            (w.principalId === null ? e.principalId !== null : e.principalId === null)
          )
            return false;
          return true;
        }) ?? null,
      updateMany: async ({ where, data }: Record<string, unknown>) => {
        const w = where as Record<string, unknown>;
        const d = data as Record<string, unknown>;
        const row = store.employees.find(
          (e) => e.id === w.id && e.companyId === w.companyId && e.principalId === w.principalId,
        );
        if (!row) return { count: 0 };
        row.principalId = d.principalId;
        return { count: 1 };
      },
    },
    principal: {
      findUnique: async ({ where }: Record<string, unknown>) => {
        const w = where as { id?: string; loginId?: string };
        return (
          store.principals.find((p) =>
            w.id !== undefined ? p.id === w.id : p.loginId === w.loginId,
          ) ?? null
        );
      },
      create: async ({ data }: Record<string, unknown>) => {
        const row = { id: `pri-${++n}`, ...(data as object) };
        store.principals.push(row);
        return row;
      },
    },
    claimToken: {
      create: async ({ data }: Record<string, unknown>) => {
        store.claimTokens.push({ id: `tok-${++n}`, ...(data as object), consumedAt: null });
      },
      updateMany: async ({ where, data }: Record<string, unknown>) => {
        let count = 0;
        const w = where as Record<string, unknown>;
        for (const t of store.claimTokens) {
          if (t.principalId === w.principalId && t.consumedAt === (w.consumedAt ?? null)) {
            t.consumedAt = (data as { consumedAt: Date }).consumedAt;
            count += 1;
          }
        }
        return { count };
      },
    },
    role: {
      findFirst: async ({ where }: Record<string, unknown>) => {
        const w = where as Record<string, unknown>;
        return (
          store.roles.find(
            (r) => r.companyId === w.companyId && r.key === w.key && r.isSystem === w.isSystem,
          ) ?? null
        );
      },
    },
    roleAssignment: {
      findMany: async ({ where }: Record<string, unknown>) => {
        const w = where as Record<string, unknown>;
        return store.roleAssignments.filter(
          (a) =>
            a.companyId === w.companyId && a.principalId === w.principalId && a.revokedAt === null,
        );
      },
      findFirst: async ({ where }: Record<string, unknown>) => {
        const w = where as Record<string, unknown>;
        return (
          store.roleAssignments.find((a) => {
            if ('id' in w)
              return a.id === w.id && a.companyId === w.companyId && a.revokedAt === null;
            return (
              a.companyId === w.companyId &&
              a.principalId === w.principalId &&
              a.roleId === w.roleId &&
              a.revokedAt === null
            );
          }) ?? null
        );
      },
      create: async ({ data }: Record<string, unknown>) => {
        const row = { id: `asg-${++n}`, ...(data as object), revokedAt: null };
        store.roleAssignments.push(row);
        return row;
      },
      update: async ({ where, data }: Record<string, unknown>) => {
        const row = store.roleAssignments.find((a) => a.id === (where as { id: string }).id);
        Object.assign(row ?? {}, data);
        return row;
      },
    },
    headOffice: {
      findFirst: async ({ where }: Record<string, unknown>) => {
        const w = where as Record<string, unknown>;
        return (
          store.headOffices.find(
            (h) =>
              h.id === w.id &&
              h.companyId === w.companyId &&
              h.isPrimary === w.isPrimary &&
              h.status === w.status,
          ) ?? null
        );
      },
    },
    auditLog: {
      create: async ({ data }: Record<string, unknown>) => {
        store.auditLog.push(data as Record<string, unknown>);
      },
    },
  };
  const prisma = {
    $transaction: (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    employee: tx.employee,
    roleAssignment: tx.roleAssignment,
  };
  return prisma as never;
}

const ACTOR = { actorId: 'own-1', actorType: 'USER' as const };
const COMPANY = 'co-1';
const EMP = { id: 'e-1', companyId: COMPANY, status: 'ACTIVE', principalId: null };

function store(over: Partial<FakeStore> = {}): FakeStore {
  return {
    employees: [{ ...EMP }],
    principals: [],
    roles: [{ id: 'r-ho', companyId: COMPANY, key: 'HO_ADMIN', isSystem: true }],
    roleAssignments: [],
    claimTokens: [],
    headOffices: [{ id: 'ho-1', companyId: COMPANY, isPrimary: true, status: 'ACTIVE' }],
    auditLog: [],
    ...over,
  };
}

describe('EmployeeAccessService.invite', () => {
  it('creates suspended principal + claim code atomically, audits once', async () => {
    const s = store();
    const svc = new EmployeeAccessService(fakePrisma(s));
    const res = await svc.invite(ACTOR, COMPANY, 'e-1', 'Worker@Co.test');
    expect(res.claimCode).toHaveLength(64);
    const pri = first(s.principals);
    expect(pri.status).toBe('SUSPENDED');
    expect(pri.loginId).toBe('worker@co.test');
    expect(first(s.employees).principalId).toBe(pri.id);
    expect(s.claimTokens[0]).toBeDefined();
    // Code is hashed — raw code never stored.
    expect(JSON.stringify(s.claimTokens)).not.toContain(res.claimCode);
    expect(JSON.stringify(s.auditLog)).toContain('EMPLOYEE_INVITED');
  });

  it('rejects duplicate global loginId with 409', async () => {
    const s = store({ principals: [{ id: 'x', loginId: 'dup@co.test' }] });
    const svc = new EmployeeAccessService(fakePrisma(s));
    await expect(svc.invite(ACTOR as never, COMPANY, 'e-1', 'dup@co.test')).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(s.principals).toHaveLength(1); // rollback-ish: no second principal created
  });

  it('rejects already-linked employee', async () => {
    const s = store();
    first(s.employees).principalId = 'pri-x';
    const svc = new EmployeeAccessService(fakePrisma(s));
    await expect(svc.invite(ACTOR as never, COMPANY, 'e-1', 'w@co.test')).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it('rejects inactive employee and cross-company employee', async () => {
    const s1 = store();
    first(s1.employees).status = 'INACTIVE';
    const svc1 = new EmployeeAccessService(fakePrisma(s1));
    await expect(svc1.invite(ACTOR as never, COMPANY, 'e-1', 'w@co.test')).rejects.toMatchObject({
      statusCode: 409,
    });
    const svc2 = new EmployeeAccessService(fakePrisma(store()));
    await expect(svc2.invite(ACTOR as never, 'OTHER', 'e-1', 'w@co.test')).rejects.toBeInstanceOf(
      Error,
    );
  });
});

describe('EmployeeAccessService.resend', () => {
  it('revokes prior code, mints new one — at most one active', async () => {
    const s = store();
    first(s.employees).principalId = 'pri-9';
    s.principals.push({ id: 'pri-9' });
    s.claimTokens.push({ id: 't1', principalId: 'pri-9', tokenHash: 'h1', consumedAt: null });
    const svc = new EmployeeAccessService(fakePrisma(s));
    const res = await svc.resend(ACTOR, COMPANY, 'e-1');
    expect(res.claimCode).toHaveLength(64);
    const active = s.claimTokens.filter(
      (t) => (t as { consumedAt: Date | null }).consumedAt === null,
    );
    expect(active).toHaveLength(1);
    expect((s.claimTokens[0] as { consumedAt: Date | null }).consumedAt).not.toBeNull();
  });
});

describe('EmployeeAccessService.grant', () => {
  function linkedStore() {
    const s = store();
    first(s.employees).principalId = 'pri-9';
    s.principals.push({ id: 'pri-9', status: 'ACTIVE', type: 'USER' });
    return s;
  }

  it('rejects non-whitelisted role keys incl. PLATFORM_ADMIN', async () => {
    const svc = new EmployeeAccessService(fakePrisma(linkedStore()));
    for (const key of ['PLATFORM_ADMIN', 'CUSTOM_X', 'PLATFORM_COMPANY_CREATE']) {
      await expect(
        svc.grant(ACTOR as never, COMPANY, {
          employeeId: 'e-1',
          roleKey: key,
          scopeType: 'COMPANY',
        }),
      ).rejects.toBeInstanceOf(Error);
    }
  });

  it('enforces scope shape — HO_ADMIN requires HEAD_OFFICE of the primary HO', async () => {
    const svc = new EmployeeAccessService(fakePrisma(linkedStore()));
    await expect(
      svc.grant(ACTOR as never, COMPANY, {
        employeeId: 'e-1',
        roleKey: 'HO_ADMIN',
        scopeType: 'COMPANY',
      }),
    ).rejects.toBeInstanceOf(Error);
    await expect(
      svc.grant(ACTOR as never, COMPANY, {
        employeeId: 'e-1',
        roleKey: 'HO_ADMIN',
        scopeType: 'HEAD_OFFICE',
        scopeId: 'ho-2',
      }),
    ).rejects.toBeInstanceOf(Error);
    const asg = await svc.grant(ACTOR, COMPANY, {
      employeeId: 'e-1',
      roleKey: 'HO_ADMIN',
      scopeType: 'HEAD_OFFICE',
      scopeId: 'ho-1',
    });
    expect((asg as Record<string, unknown>).headOfficeId).toBe('ho-1');
  });

  it('rejects unlinked employee and duplicate assignment', async () => {
    const unlinked = new EmployeeAccessService(fakePrisma(store()));
    await expect(
      unlinked.grant(ACTOR as never, COMPANY, {
        employeeId: 'e-1',
        roleKey: 'COMPANY_OWNER',
        scopeType: 'COMPANY',
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    const s = linkedStore();
    s.roles.push({ id: 'r-own', companyId: COMPANY, key: 'COMPANY_OWNER', isSystem: true });
    const svc = new EmployeeAccessService(fakePrisma(s));
    await svc.grant(ACTOR, COMPANY, {
      employeeId: 'e-1',
      roleKey: 'COMPANY_OWNER',
      scopeType: 'COMPANY',
    });
    await expect(
      svc.grant(ACTOR as never, COMPANY, {
        employeeId: 'e-1',
        roleKey: 'COMPANY_OWNER',
        scopeType: 'COMPANY',
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('EmployeeAccessService.revoke', () => {
  it('sets revokedAt + audits; unknown id fails', async () => {
    const s = store();
    s.roleAssignments.push({ id: 'a-1', companyId: COMPANY, revokedAt: null });
    const svc = new EmployeeAccessService(fakePrisma(s));
    const res = await svc.revoke(ACTOR, COMPANY, 'a-1');
    expect(res.revoked).toBe(true);
    expect(first(s.roleAssignments).revokedAt).not.toBeNull();
    await expect(svc.revoke(ACTOR as never, COMPANY, 'a-1')).rejects.toBeInstanceOf(Error);
  });
});
