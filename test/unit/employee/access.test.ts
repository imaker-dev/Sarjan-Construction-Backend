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
  projects: Record<string, unknown>[];
  sites: Record<string, unknown>[];
  departments: Record<string, unknown>[];
  memberships: Record<string, unknown>[];
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
          const match = ['principalId', 'consumedAt', 'purpose', 'companyId', 'employeeId'].every(
            (k) => !(k in w) || t[k] === w[k],
          );
          if (match) {
            t.consumedAt = (data as { consumedAt: Date }).consumedAt;
            count += 1;
          }
        }
        return { count };
      },
    },
    company: {
      findUnique: async ({ where }: Record<string, unknown>) =>
        (where as { id: string }).id === COMPANY ? { name: 'Test Co' } : null,
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
        return store.roleAssignments.filter((a) => {
          if (a.companyId !== w.companyId) return false;
          if ('principalId' in w && a.principalId !== w.principalId) return false;
          if ('roleId' in w && a.roleId !== w.roleId) return false;
          if ('scopeType' in w && a.scopeType !== w.scopeType) return false;
          if ('projectId' in w && a.projectId !== w.projectId) return false;
          return a.revokedAt === null;
        });
      },
      findFirst: async ({ where }: Record<string, unknown>) => {
        const w = where as Record<string, unknown>;
        return (
          store.roleAssignments.find((a) => {
            if ('id' in w)
              return a.id === w.id && a.companyId === w.companyId && a.revokedAt === null;
            for (const key of [
              'companyId',
              'principalId',
              'roleId',
              'scopeType',
              'headOfficeId',
              'projectId',
              'siteId',
            ] as const) {
              if (key in w && (a[key] ?? null) !== w[key]) return false;
            }
            return a.revokedAt === null;
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
              (w.id === undefined || h.id === w.id) &&
              h.companyId === w.companyId &&
              h.isPrimary === w.isPrimary &&
              h.status === w.status,
          ) ?? null
        );
      },
    },
    project: {
      findFirst: async ({ where }: Record<string, unknown>) => {
        const w = where as Record<string, unknown>;
        return store.projects.find((p) => p.id === w.id && p.companyId === w.companyId) ?? null;
      },
    },
    site: {
      findFirst: async ({ where }: Record<string, unknown>) => {
        const w = where as Record<string, unknown>;
        return store.sites.find((s) => s.id === w.id && s.companyId === w.companyId) ?? null;
      },
    },
    departmentMembership: {
      findFirst: async ({ where }: Record<string, unknown>) => {
        const w = where as {
          companyId: string;
          employeeId: string;
          startedAt?: { lte?: Date };
          OR?: { endedAt: null | { gt?: Date } }[];
          department?: { is?: { category?: string; status?: string } };
        };
        return (
          store.memberships.find((m) => {
            if (m.companyId !== w.companyId || m.employeeId !== w.employeeId) return false;
            if (w.startedAt?.lte !== undefined && (m.startedAt as Date) > w.startedAt.lte) {
              return false;
            }
            if (w.OR !== undefined) {
              const ok = w.OR.some((c) => {
                if (c.endedAt === null) return m.endedAt === null;
                const gt = c.endedAt.gt;
                return gt !== undefined && (m.endedAt as Date) > gt;
              });
              if (!ok) return false;
            }
            const deptCond = w.department?.is;
            if (deptCond !== undefined) {
              const dept = store.departments.find((d) => d.id === m.departmentId);
              if (deptCond.category !== undefined && dept?.category !== deptCond.category) {
                return false;
              }
              if (deptCond.status !== undefined && dept?.status !== deptCond.status) {
                return false;
              }
            }
            return true;
          }) ?? null
        );
      },
    },
    auditLog: {
      create: async ({ data }: Record<string, unknown>) => {
        store.auditLog.push(data as Record<string, unknown>);
      },
    },
    // FOR UPDATE project lock — no-op in the fake; serialization is covered
    // by the real-DB integration suite.
    $queryRaw: async () => [],
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
    projects: [
      { id: 'pr-1', companyId: COMPANY, status: 'ACTIVE' },
      { id: 'pr-2', companyId: COMPANY, status: 'ACTIVE' },
      { id: 'pr-inactive', companyId: COMPANY, status: 'ARCHIVED' },
      { id: 'pr-other', companyId: 'OTHER', status: 'ACTIVE' },
    ],
    sites: [{ id: 'st-1', companyId: COMPANY, projectId: 'pr-1', status: 'ACTIVE' }],
    departments: [
      { id: 'd-fin', companyId: COMPANY, category: 'FINANCE', status: 'ACTIVE' },
      { id: 'd-ops', companyId: COMPANY, category: 'OPERATIONS', status: 'ACTIVE' },
      // Name trap: says "Finance" but is not the controlled FINANCE category.
      {
        id: 'd-name-trap',
        companyId: COMPANY,
        category: 'OPERATIONS',
        status: 'ACTIVE',
        name: 'Finance',
      },
      { id: 'd-fin-inactive', companyId: COMPANY, category: 'FINANCE', status: 'INACTIVE' },
      { id: 'd-fin-other', companyId: 'OTHER', category: 'FINANCE', status: 'ACTIVE' },
    ],
    memberships: [],
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

  it('mints a purpose-bound EMPLOYEE_INVITE token tied to company + employee', async () => {
    const s = store();
    const svc = new EmployeeAccessService(fakePrisma(s), undefined, undefined, 'https://app.test');
    await svc.invite(ACTOR, COMPANY, 'e-1', 'w@co.test');
    const tok = s.claimTokens[0] as {
      purpose?: string;
      companyId?: string;
      employeeId?: string;
      principalId?: string;
    };
    expect(tok.purpose).toBe('EMPLOYEE_INVITE');
    expect(tok.companyId).toBe(COMPANY);
    expect(tok.employeeId).toBe('e-1');
    expect(tok.principalId).toBe(first(s.principals).id);
  });

  it('ignores a hostile x-frontend-url and uses the configured base', async () => {
    const s = store();
    const svc = new EmployeeAccessService(fakePrisma(s), undefined, undefined, 'https://app.test', [
      'https://app.test',
    ]);
    const res = await svc.invite(
      ACTOR,
      COMPANY,
      'e-1',
      'w@co.test',
      'EMAIL',
      'https://evil.example/phish',
    );
    expect(res.claimUrl).toBe(`https://app.test/verify-employee?token=${res.claimCode}`);
    expect(String(res.claimUrl)).not.toContain('evil.example');
  });

  it('honours an exactly-allowlisted request origin', async () => {
    const s = store();
    const svc = new EmployeeAccessService(fakePrisma(s), undefined, undefined, 'https://app.test', [
      'https://erp.test',
    ]);
    const res = await svc.invite(ACTOR, COMPANY, 'e-1', 'w@co.test', 'EMAIL', 'https://erp.test');
    expect(res.claimUrl).toBe(`https://erp.test/verify-employee?token=${res.claimCode}`);
  });

  it('returns no URL when no trusted origin resolves (https required, http base)', async () => {
    const s = store();
    const svc = new EmployeeAccessService(
      fakePrisma(s),
      undefined,
      undefined,
      'http://insecure.test',
      [],
      true, // production-style HTTPS requirement
    );
    const res = await svc.invite(ACTOR, COMPANY, 'e-1', 'w@co.test');
    expect(res.claimUrl).toBeNull(); // manual claim-code handoff only
    expect(res.claimCode).toHaveLength(64);
  });

  it('reports honest delivery status — NOT_ATTEMPTED without mail, SENT/FAILED per outcome', async () => {
    // No mail service wired → NOT_ATTEMPTED.
    const s1 = store();
    const noMail = new EmployeeAccessService(
      fakePrisma(s1),
      undefined,
      undefined,
      'https://a.test',
    );
    const r1 = await noMail.invite(ACTOR, COMPANY, 'e-1', 'w@co.test');
    expect(r1.delivery).toBe('NOT_ATTEMPTED');

    const mkMail = (success: boolean, throws = false) =>
      ({
        sendEmployeeInvitation: async (p: Record<string, unknown>) => {
          if (throws) throw new Error('smtp down');
          captured.push(p);
          return { success };
        },
      }) as never;
    const captured: Record<string, unknown>[] = [];

    const s2 = store();
    const okMail = new EmployeeAccessService(
      fakePrisma(s2),
      undefined,
      mkMail(true),
      'https://a.test',
    );
    const r2 = await okMail.invite(ACTOR, COMPANY, 'e-1', 'w@co.test');
    expect(r2.delivery).toBe('EMAIL_SENT');
    // The raw code reaches the mail channel once — never persisted in the DB.
    expect(captured[0]?.claimCode).toBe(r2.claimCode);
    expect(captured[0]?.claimUrl).toBe(`https://a.test/verify-employee?token=${r2.claimCode}`);

    const s3 = store();
    const failMail = new EmployeeAccessService(
      fakePrisma(s3),
      undefined,
      mkMail(false),
      'https://a.test',
    );
    expect((await failMail.invite(ACTOR, COMPANY, 'e-1', 'w@co.test')).delivery).toBe(
      'EMAIL_FAILED',
    );

    const s4 = store();
    const throwMail = new EmployeeAccessService(
      fakePrisma(s4),
      undefined,
      mkMail(false, true),
      'https://a.test',
    );
    expect((await throwMail.invite(ACTOR, COMPANY, 'e-1', 'w@co.test')).delivery).toBe(
      'EMAIL_FAILED',
    );
  });
});

describe('EmployeeAccessService.resend', () => {
  it('revokes prior code, mints new one — at most one active', async () => {
    const s = store();
    first(s.employees).principalId = 'pri-9';
    s.principals.push({ id: 'pri-9', status: 'SUSPENDED', loginId: 'w@co.test' });
    s.claimTokens.push({
      id: 't1',
      principalId: 'pri-9',
      tokenHash: 'h1',
      consumedAt: null,
      purpose: 'EMPLOYEE_INVITE',
      companyId: COMPANY,
    });
    const svc = new EmployeeAccessService(fakePrisma(s));
    const res = await svc.resend(ACTOR, COMPANY, 'e-1');
    expect(res.claimCode).toHaveLength(64);
    const active = s.claimTokens.filter(
      (t) => (t as { consumedAt: Date | null }).consumedAt === null,
    );
    expect(active).toHaveLength(1);
    expect((s.claimTokens[0] as { consumedAt: Date | null }).consumedAt).not.toBeNull();
  });

  it('closes only EMPLOYEE_INVITE tokens for this company — other purposes survive', async () => {
    const s = store();
    first(s.employees).principalId = 'pri-9';
    s.principals.push({ id: 'pri-9', status: 'SUSPENDED', loginId: 'w@co.test' });
    s.claimTokens.push(
      {
        id: 't-inv',
        principalId: 'pri-9',
        tokenHash: 'h-inv',
        consumedAt: null,
        purpose: 'EMPLOYEE_INVITE',
        companyId: COMPANY,
      },
      {
        id: 't-onb',
        principalId: 'pri-9',
        tokenHash: 'h-onb',
        consumedAt: null,
        purpose: 'COMPANY_ONBOARD',
        companyId: 'co-other',
      },
      {
        id: 't-xco',
        principalId: 'pri-9',
        tokenHash: 'h-xco',
        consumedAt: null,
        purpose: 'EMPLOYEE_INVITE',
        companyId: 'co-other',
      },
    );
    const svc = new EmployeeAccessService(fakePrisma(s));
    await svc.resend(ACTOR, COMPANY, 'e-1');
    const byId = (id: string) =>
      s.claimTokens.find((t) => t.id === id) as { consumedAt: Date | null };
    expect(byId('t-inv').consumedAt).not.toBeNull(); // revoked — same scope
    expect(byId('t-onb').consumedAt).toBeNull(); // onboard token untouched
    expect(byId('t-xco').consumedAt).toBeNull(); // other company's invite untouched
  });

  it('rejects resend for an already-claimed (ACTIVE) account', async () => {
    const s = store();
    first(s.employees).principalId = 'pri-9';
    s.principals.push({ id: 'pri-9', status: 'ACTIVE', loginId: 'w@co.test' });
    const svc = new EmployeeAccessService(fakePrisma(s));
    await expect(svc.resend(ACTOR, COMPANY, 'e-1')).rejects.toMatchObject({
      statusCode: 409,
      code: 'ACCOUNT_ALREADY_CLAIMED',
    });
    expect(s.claimTokens).toHaveLength(0); // nothing minted
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

  it('accepts role name aliases like "Head Office Admin" and auto-resolves primary HO when scopeId omitted or null', async () => {
    const svc = new EmployeeAccessService(fakePrisma(linkedStore()));
    const asg = await svc.grant(ACTOR, COMPANY, {
      employeeId: 'e-1',
      roleKey: 'Head Office Admin',
      scopeType: 'HEAD_OFFICE',
      scopeId: null,
    });
    expect((asg as Record<string, unknown>).headOfficeId).toBe('ho-1');
  });

  it('accepts scopeId: null for COMPANY scope without error', async () => {
    const s = linkedStore();
    s.roles.push({ id: 'r-own', companyId: COMPANY, key: 'COMPANY_OWNER', isSystem: true });
    const svc = new EmployeeAccessService(fakePrisma(s));
    const asg = await svc.grant(ACTOR, COMPANY, {
      employeeId: 'e-1',
      roleKey: 'COMPANY_OWNER',
      scopeType: 'COMPANY',
      scopeId: null,
    });
    expect((asg as Record<string, unknown>).companyId).toBe(COMPANY);
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

describe('EmployeeAccessService.grant — project leadership (PD/PI)', () => {
  function linkedStoreWithLeadership() {
    const s = store();
    first(s.employees).principalId = 'pri-9';
    s.principals.push({ id: 'pri-9', status: 'ACTIVE', type: 'USER' });
    s.roles.push(
      { id: 'r-pd', companyId: COMPANY, key: 'PROJECT_DIRECTOR', isSystem: true },
      { id: 'r-pi', companyId: COMPANY, key: 'PROJECT_INCHARGE', isSystem: true },
    );
    return s;
  }
  const pd = (projectId: string) => ({
    employeeId: 'e-1',
    roleKey: 'PROJECT_DIRECTOR',
    scopeType: 'PROJECT',
    scopeId: projectId,
  });

  it('grants PROJECT_DIRECTOR at PROJECT scope with project UUID', async () => {
    const svc = new EmployeeAccessService(fakePrisma(linkedStoreWithLeadership()));
    const asg = await svc.grant(ACTOR, COMPANY, pd('pr-1'));
    expect((asg as Record<string, unknown>).projectId).toBe('pr-1');
    expect((asg as Record<string, unknown>).scopeType).toBe('PROJECT');
  });

  it('rejects wrong scope type and site-scoped leadership', async () => {
    const svc = new EmployeeAccessService(fakePrisma(linkedStoreWithLeadership()));
    for (const scopeType of ['COMPANY', 'HEAD_OFFICE', 'SITE']) {
      await expect(
        svc.grant(ACTOR as never, COMPANY, { ...pd('pr-1'), scopeType }),
      ).rejects.toBeInstanceOf(Error);
    }
  });

  it('rejects missing, invalid, and cross-company project scopeId', async () => {
    const svc = new EmployeeAccessService(fakePrisma(linkedStoreWithLeadership()));
    for (const scopeId of [undefined, 'nope', 'pr-other']) {
      await expect(
        svc.grant(ACTOR as never, COMPANY, {
          employeeId: 'e-1',
          roleKey: 'PROJECT_DIRECTOR',
          scopeType: 'PROJECT',
          ...(scopeId !== undefined ? { scopeId } : {}),
        }),
      ).rejects.toBeInstanceOf(Error);
    }
  });

  it('rejects inactive project and inactive/unlinked employee', async () => {
    const svc = new EmployeeAccessService(fakePrisma(linkedStoreWithLeadership()));
    await expect(svc.grant(ACTOR as never, COMPANY, pd('pr-inactive'))).rejects.toBeInstanceOf(
      Error,
    );
    const unlinked = new EmployeeAccessService(fakePrisma(store()));
    await expect(unlinked.grant(ACTOR as never, COMPANY, pd('pr-1'))).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it('one PD may hold multiple projects', async () => {
    const svc = new EmployeeAccessService(fakePrisma(linkedStoreWithLeadership()));
    await svc.grant(ACTOR, COMPANY, pd('pr-1'));
    await svc.grant(ACTOR, COMPANY, pd('pr-2'));
    const mine = (await svc.listAssignments(COMPANY, 'e-1')) as Record<string, unknown>[];
    expect(mine.filter((a) => a.projectId !== undefined && a.projectId !== null)).toHaveLength(2);
  });

  it('granting a second PD on a project replaces the incumbent', async () => {
    const s = linkedStoreWithLeadership();
    s.employees.push({ id: 'e-2', companyId: COMPANY, status: 'ACTIVE', principalId: 'pri-10' });
    s.principals.push({ id: 'pri-10', status: 'ACTIVE', type: 'USER' });
    const svc = new EmployeeAccessService(fakePrisma(s));
    const firstAsg = (await svc.grant(ACTOR, COMPANY, pd('pr-1'))) as { id: string };
    const secondAsg = await svc.grant(ACTOR, COMPANY, { ...pd('pr-1'), employeeId: 'e-2' });
    expect(secondAsg).toBeTruthy();
    const oldRow = s.roleAssignments.find((a) => a.id === firstAsg.id) as
      { revokedAt: Date | null } | undefined;
    expect(oldRow?.revokedAt).not.toBeNull();
    expect(JSON.stringify(s.auditLog)).toContain('ROLE_ASSIGNMENT_REPLACED');
    // incumbent on a DIFFERENT project is untouched
    await svc.grant(ACTOR, COMPANY, { ...pd('pr-2'), employeeId: 'e-2' });
    const pr1Holders = s.roleAssignments.filter(
      (a) => a.projectId === 'pr-1' && a.roleId === 'r-pd' && a.revokedAt === null,
    );
    expect(pr1Holders).toHaveLength(1);
  });

  it('same-employee duplicate grant still conflicts (409)', async () => {
    const svc = new EmployeeAccessService(fakePrisma(linkedStoreWithLeadership()));
    await svc.grant(ACTOR, COMPANY, pd('pr-1'));
    await expect(svc.grant(ACTOR as never, COMPANY, pd('pr-1'))).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it('rejects self-grant — admin cannot appoint themselves', async () => {
    const s = linkedStoreWithLeadership();
    first(s.employees).principalId = 'own-1'; // actor.actorId === principalId
    const svc = new EmployeeAccessService(fakePrisma(s));
    await expect(svc.grant(ACTOR as never, COMPANY, pd('pr-1'))).rejects.toBeInstanceOf(Error);
  });

  it('PD/PI grant requires ACTIVE linked employee — suspended principal rejected', async () => {
    const s = linkedStoreWithLeadership();
    const [firstPrincipal] = s.principals;
    if (firstPrincipal !== undefined) firstPrincipal.status = 'SUSPENDED';
    const svc = new EmployeeAccessService(fakePrisma(s));
    await expect(svc.grant(ACTOR as never, COMPANY, pd('pr-1'))).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it('PD and PI are independent slots on the same project', async () => {
    const s = linkedStoreWithLeadership();
    s.employees.push({ id: 'e-2', companyId: COMPANY, status: 'ACTIVE', principalId: 'pri-10' });
    s.principals.push({ id: 'pri-10', status: 'ACTIVE', type: 'USER' });
    const svc = new EmployeeAccessService(fakePrisma(s));
    await svc.grant(ACTOR, COMPANY, pd('pr-1'));
    await svc.grant(ACTOR, COMPANY, {
      employeeId: 'e-2',
      roleKey: 'PROJECT_INCHARGE',
      scopeType: 'PROJECT',
      scopeId: 'pr-1',
    });
    const pdHolders = s.roleAssignments.filter(
      (a) => a.projectId === 'pr-1' && a.roleId === 'r-pd' && a.revokedAt === null,
    );
    const piHolders = s.roleAssignments.filter(
      (a) => a.projectId === 'pr-1' && a.roleId === 'r-pi' && a.revokedAt === null,
    );
    expect(pdHolders).toHaveLength(1);
    expect(piHolders).toHaveLength(1);
  });
});

describe('EmployeeAccessService.grant — Finance role eligibility', () => {
  function finStore(memberships: Record<string, unknown>[] = []) {
    const s = store();
    first(s.employees).principalId = 'pri-9';
    s.principals.push({ id: 'pri-9', status: 'ACTIVE', type: 'USER' });
    s.roles.push(
      { id: 'r-fm', companyId: COMPANY, key: 'FINANCE_MANAGER', isSystem: true },
      { id: 'r-fs', companyId: COMPANY, key: 'FINANCE_STAFF', isSystem: true },
      { id: 'r-own', companyId: COMPANY, key: 'COMPANY_OWNER', isSystem: true },
    );
    s.memberships = memberships;
    return s;
  }

  const membership = (departmentId: string, over: Record<string, unknown> = {}) => ({
    id: `mem-${departmentId}`,
    companyId: COMPANY,
    employeeId: 'e-1',
    departmentId,
    startedAt: new Date('2020-01-01'),
    endedAt: null,
    ...over,
  });

  const grant = (roleKey: string) => ({
    employeeId: 'e-1',
    roleKey,
    scopeType: 'COMPANY' as const,
  });

  it('allows FINANCE_MANAGER and FINANCE_STAFF with an active FINANCE-dept membership', async () => {
    const s = finStore([membership('d-fin')]);
    const svc = new EmployeeAccessService(fakePrisma(s));
    const a1 = await svc.grant(ACTOR, COMPANY, grant('FINANCE_MANAGER'));
    expect((a1 as Record<string, unknown>).roleId).toBe('r-fm');
    const a2 = await svc.grant(ACTOR, COMPANY, grant('FINANCE_STAFF'));
    expect((a2 as Record<string, unknown>).roleId).toBe('r-fs');
  });

  it('denies when the employee has no active FINANCE membership', async () => {
    const svc = new EmployeeAccessService(fakePrisma(finStore()));
    await expect(
      svc.grant(ACTOR as never, COMPANY, grant('FINANCE_MANAGER')),
    ).rejects.toMatchObject({ statusCode: 409, code: 'FINANCE_MEMBERSHIP_REQUIRED' });
  });

  it('denies when the FINANCE membership already ended', async () => {
    const s = finStore([membership('d-fin', { endedAt: new Date('2021-01-01') })]);
    const svc = new EmployeeAccessService(fakePrisma(s));
    await expect(svc.grant(ACTOR as never, COMPANY, grant('FINANCE_STAFF'))).rejects.toMatchObject({
      statusCode: 409,
      code: 'FINANCE_MEMBERSHIP_REQUIRED',
    });
  });

  it('denies a future-dated FINANCE membership (not yet effective)', async () => {
    const s = finStore([membership('d-fin', { startedAt: new Date('2999-01-01') })]);
    const svc = new EmployeeAccessService(fakePrisma(s));
    await expect(
      svc.grant(ACTOR as never, COMPANY, grant('FINANCE_MANAGER')),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('denies non-FINANCE category — department named "Finance" does not count', async () => {
    const s = finStore([membership('d-name-trap')]);
    const svc = new EmployeeAccessService(fakePrisma(s));
    await expect(
      svc.grant(ACTOR as never, COMPANY, grant('FINANCE_MANAGER')),
    ).rejects.toMatchObject({ statusCode: 409, code: 'FINANCE_MEMBERSHIP_REQUIRED' });
  });

  it('denies when the FINANCE department itself is inactive', async () => {
    const s = finStore([membership('d-fin-inactive')]);
    const svc = new EmployeeAccessService(fakePrisma(s));
    await expect(
      svc.grant(ACTOR as never, COMPANY, grant('FINANCE_MANAGER')),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('denies cross-company employees', async () => {
    const s = finStore([membership('d-fin')]);
    const svc = new EmployeeAccessService(fakePrisma(s));
    await expect(
      svc.grant(ACTOR as never, 'OTHER', grant('FINANCE_MANAGER')),
    ).rejects.toBeInstanceOf(Error);
  });

  it('COMPANY_OWNER grants without any Finance membership', async () => {
    const s = finStore();
    const svc = new EmployeeAccessService(fakePrisma(s));
    const a = await svc.grant(ACTOR, COMPANY, grant('COMPANY_OWNER'));
    expect((a as Record<string, unknown>).roleId).toBe('r-own');
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
