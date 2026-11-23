import { describe, it, expect, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';
import type { DepartmentMembership } from '@prisma/client';
import { EmployeeService, mapMembershipRace } from '../../../src/modules/employee/service.js';
import { emptyEmpStore, fakeEmployee, FakeEmployeeUoW, type EmpStore } from './fakes.js';
import { fakeDepartment, fakeProject, fakeSite } from '../department/fakes.js';
import {
  ActiveMembershipExistsError,
  AlreadyExitedError,
  AmbiguousPrimaryError,
  OrgEntityNotFoundError,
  PrimaryConflictError,
} from '../../../src/modules/organization/errors.js';
import { ConflictError, ForbiddenError } from '../../../src/common/errors/app-error.js';
import { AccessDeniedError } from '../../../src/modules/access-control/errors.js';
import type { ActorContext } from '../../../src/modules/organization/types.js';
import type { ScopeTarget } from '../../../src/modules/access-control/service.js';

const actor: ActorContext = { actorId: 'pi-1', actorType: 'USER' };

const C1 = '00000000-0000-4000-8000-0000000000c1';
const P1 = '00000000-0000-4000-8000-0000000000a1';
const P2 = '00000000-0000-4000-8000-0000000000a2';
const S1 = '00000000-0000-4000-8000-0000000000b1';
const S2 = '00000000-0000-4000-8000-0000000000b2';
const DA = '00000000-0000-4000-8000-0000000000d1';
const DB = '00000000-0000-4000-8000-0000000000d2';
const DC = '00000000-0000-4000-8000-0000000000d3';
const DD = '00000000-0000-4000-8000-0000000000d4';
const E1 = '00000000-0000-4000-8000-0000000000f1';

/** Key- and scope-aware authorizer: companyWide = any COMPANY-scope grant;
 *  scopes = the project/site ids the caller's scoped grants cover; keys =
 *  optional permission-key filter (scoped checks must match a granted key). */
class LifecycleAuth {
  calls: { key: string; target: ScopeTarget }[] = [];

  constructor(
    private readonly opts: {
      companyWide?: boolean;
      scopes?: ReadonlySet<string>;
      keys?: ReadonlySet<string>;
      flag?: boolean;
    } = {},
  ) {}

  async assertPermission(pid: string, key: string, target: ScopeTarget): Promise<void> {
    this.calls.push({ key, target });
    if (!(await this.hasPermission(pid, key, target))) throw new AccessDeniedError();
  }

  async hasPermission(pid: string, key: string, target: ScopeTarget): Promise<boolean> {
    if (target.scopeType === 'COMPANY') return this.opts.companyWide === true;
    if (!this.opts.scopes?.has(target.scopeId)) return false;
    return this.opts.keys === undefined || this.opts.keys.has(key);
  }

  async delegationEnabled(): Promise<boolean> {
    return this.opts.flag === true;
  }
}

let store: EmpStore;
let svc: EmployeeService;
const svcFor = (a: LifecycleAuth) => new EmployeeService(new FakeEmployeeUoW(store), a);
const must = <T>(v: T | undefined): T => {
  if (v === undefined) throw new Error('fixture missing');
  return v;
};

let mid = 0;
const membership = (over: Partial<DepartmentMembership>): DepartmentMembership => ({
  id: `00000000-0000-4000-8000-${String(++mid).padStart(12, '0')}`,
  companyId: C1,
  employeeId: E1,
  departmentId: DA,
  isPrimary: false,
  startedAt: new Date(Date.now() - 30 * 86_400_000),
  endedAt: null,
  endReason: null,
  endNote: null,
  suspendUntil: null,
  supersededBy: null,
  version: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

const siteScope = { scopeType: 'SITE' as const, scopeId: S1 };
const projectScope = { scopeType: 'PROJECT' as const, scopeId: P1 };

beforeEach(() => {
  store = emptyEmpStore();
  store.projects.push(
    fakeProject({ id: P1, companyId: C1 }),
    fakeProject({ id: P2, companyId: C1 }),
  );
  store.sites.push(
    fakeSite({ id: S1, companyId: C1, projectId: P1 }),
    fakeSite({ id: S2, companyId: C1, projectId: P1 }),
  );
  // DA: site dept at S1; DB: site dept at S2 (sibling); DC: project dept P1;
  // DD: project dept P2 (other project).
  store.departments.push(
    fakeDepartment({ id: DA, companyId: C1, scopeType: 'SITE', siteId: S1, status: 'ACTIVE' }),
    fakeDepartment({ id: DB, companyId: C1, scopeType: 'SITE', siteId: S2, status: 'ACTIVE' }),
    fakeDepartment({
      id: DC,
      companyId: C1,
      scopeType: 'PROJECT',
      projectId: P1,
      status: 'ACTIVE',
    }),
    fakeDepartment({
      id: DD,
      companyId: C1,
      scopeType: 'PROJECT',
      projectId: P2,
      status: 'ACTIVE',
    }),
  );
  store.employees.push(fakeEmployee({ id: E1, companyId: C1, status: 'ACTIVE' }));
  svc = svcFor(new LifecycleAuth({ scopes: new Set([P1, S1, S2]), flag: true }));
});

// --------------------------------------------------------------- suspend --

describe('suspendWorkforce', () => {
  it("site scope ends only that site's active memberships with SUSPENDED", async () => {
    store.memberships.push(
      membership({ departmentId: DA }),
      membership({ departmentId: DB }), // sibling site — untouched
      membership({ departmentId: DD, isPrimary: true }), // out-of-scope primary — untouched
    );
    const res = await svc.suspendWorkforce(actor, C1, siteScope, E1, {
      reason: 'Safety hold',
      expectedReturnDate: new Date('2026-02-01'),
    });
    expect(res.action).toBe('SUSPEND');
    expect(res.ended).toHaveLength(1);
    const mA = must(store.memberships[0]);
    const mB = must(store.memberships[1]);
    const mD = must(store.memberships[2]);
    expect(mA.endedAt).not.toBeNull();
    expect(mA.endReason).toBe('SUSPENDED');
    expect(mA.endNote).toBe('Safety hold');
    expect(mA.suspendUntil).toEqual(new Date('2026-02-01'));
    expect(mB.endedAt).toBeNull();
    expect(mB.endReason).toBeNull();
    expect(mD.endedAt).toBeNull();
    expect(mD.isPrimary).toBe(true);
  });

  it('project scope ends project AND child-site memberships only', async () => {
    store.memberships.push(
      membership({ departmentId: DA }), // S1 — child of P1
      membership({ departmentId: DB }), // S2 — child of P1
      membership({ departmentId: DC, isPrimary: true }), // project dept P1
      membership({ departmentId: DD }), // P2 — untouched
    );
    const res = await svc.suspendWorkforce(actor, C1, projectScope, E1, {
      reason: 'Rotation',
    });
    expect(res.ended).toHaveLength(3);
    expect(store.memberships[3]?.endedAt).toBeNull();
    expect(
      store.memberships
        .filter((m) => m.departmentId !== DD)
        .every((m) => m.endReason === 'SUSPENDED'),
    ).toBe(true);
  });

  it('delegation flag off → 403 DELEGATION_DISABLED; flag on → proceeds', async () => {
    store.memberships.push(membership({ departmentId: DA }));
    const off = svcFor(new LifecycleAuth({ scopes: new Set([S1]), flag: false }));
    await expect(off.suspendWorkforce(actor, C1, siteScope, E1, { reason: 'x' })).rejects.toThrow(
      ForbiddenError,
    );
    const res = await svc.suspendWorkforce(actor, C1, siteScope, E1, { reason: 'x' });
    expect(res.ended).toHaveLength(1);
  });

  it('company-wide EMPLOYEE_MEMBER_MANAGE bypasses the delegation flag', async () => {
    store.memberships.push(membership({ departmentId: DA }));
    const admin = svcFor(new LifecycleAuth({ companyWide: true, flag: false }));
    const res = await admin.suspendWorkforce(actor, C1, siteScope, E1, { reason: 'x' });
    expect(res.ended).toHaveLength(1);
  });

  it('no active in-scope memberships → 409 WORKFORCE_NOT_ACTIVE', async () => {
    store.memberships.push(membership({ departmentId: DD }));
    await expect(svc.suspendWorkforce(actor, C1, siteScope, E1, { reason: 'x' })).rejects.toThrow(
      ConflictError,
    );
    // Sibling membership untouched.
    expect(store.memberships[0]?.endedAt).toBeNull();
  });

  it('repeat suspend after suspension → 409 (nothing left to suspend)', async () => {
    store.memberships.push(membership({ departmentId: DA }));
    await svc.suspendWorkforce(actor, C1, siteScope, E1, { reason: 'x' });
    await expect(svc.suspendWorkforce(actor, C1, siteScope, E1, { reason: 'x' })).rejects.toThrow(
      ConflictError,
    );
  });

  it('blocks when the remaining effective set would lack a primary', async () => {
    // Worker: DA (in-scope, primary) + DB + DD non-primary → after ending DA
    // two non-primary effective rows remain → ambiguous → whole action fails.
    store.memberships.push(
      membership({ departmentId: DA, isPrimary: true }),
      membership({ departmentId: DB }),
      membership({ departmentId: DD }),
    );
    await expect(svc.suspendWorkforce(actor, C1, siteScope, E1, { reason: 'x' })).rejects.toThrow(
      AmbiguousPrimaryError,
    );
    expect(store.memberships.every((m) => m.endedAt === null)).toBe(true);
  });

  it('allowed when the out-of-scope remainder has a primary', async () => {
    store.memberships.push(
      membership({ departmentId: DA }),
      membership({ departmentId: DD, isPrimary: true }), // out-of-scope primary preserved
    );
    await svc.suspendWorkforce(actor, C1, siteScope, E1, { reason: 'x' });
    expect(store.memberships[1]?.isPrimary).toBe(true);
    expect(store.memberships[1]?.endedAt).toBeNull();
  });

  it('clears department head reference + writes DEPT_HEAD_CLEARED audit', async () => {
    const dept = store.departments.find((d) => d.id === DA);
    if (dept === undefined) throw new Error('fixture');
    dept.headEmployeeId = E1;
    store.memberships.push(membership({ departmentId: DA }));
    const res = await svc.suspendWorkforce(actor, C1, siteScope, E1, { reason: 'x' });
    expect(dept.headEmployeeId).toBeNull();
    expect(res.headsCleared).toEqual([DA]);
    // Sibling dept headed by someone else is untouched.
    const sibling = must(store.departments.find((d) => d.id === DB));
    sibling.headEmployeeId = 'other';
    expect(sibling.headEmployeeId).toBe('other');
  });

  it('emits one outbox notification to the employee principal', async () => {
    must(store.employees.find((e) => e.id === E1)).principalId =
      '00000000-0000-4000-8000-0000000000a1';
    store.memberships.push(membership({ departmentId: DA, isPrimary: true }));
    await svc.suspendWorkforce(actor, C1, siteScope, E1, { reason: 'x' });
    expect(store.outbox).toHaveLength(1);
    expect(store.outbox[0]?.eventType).toBe('WORKFORCE_SUSPENDED');
    expect(store.outbox[0]?.recipientPrincipalIds).toEqual([
      '00000000-0000-4000-8000-0000000000a1',
    ]);
  });

  it('cross-company site id → 404', async () => {
    await expect(
      svc.suspendWorkforce(
        actor,
        C1,
        { scopeType: 'SITE', scopeId: '00000000-0000-4000-8000-000000009999' },
        E1,
        { reason: 'x' },
      ),
    ).rejects.toThrow(OrgEntityNotFoundError);
  });
});

// ------------------------------------------------------------------ exit --

describe('exitWorkforce', () => {
  it('ends actives with EXITED and appends the site marker', async () => {
    store.memberships.push(membership({ departmentId: DA }));
    const res = await svc.exitWorkforce(actor, C1, siteScope, E1, { reason: 'Contract end' });
    expect(res.action).toBe('EXIT');
    expect(res.ended).toHaveLength(1);
    expect(res.exitMarkerId).not.toBeNull();
    expect(store.memberships[0]?.endReason).toBe('EXITED');
    expect(store.siteWorkforceExits).toHaveLength(1);
    expect(store.siteWorkforceExits[0]?.siteId).toBe(S1);
  });

  it('exit after suspension preserves SUSPENDED rows and adds the marker', async () => {
    store.memberships.push(membership({ departmentId: DA }));
    await svc.suspendWorkforce(actor, C1, siteScope, E1, { reason: 'hold' });
    const res = await svc.exitWorkforce(actor, C1, siteScope, E1, { reason: 'exit' });
    // No actives were ended — the marker alone is the exit.
    expect(res.ended).toHaveLength(0);
    expect(store.memberships[0]?.endReason).toBe('SUSPENDED'); // never rewritten
    expect(store.siteWorkforceExits).toHaveLength(1);
  });

  it('repeat exit → 409 ALREADY_EXITED', async () => {
    store.memberships.push(membership({ departmentId: DA }));
    await svc.exitWorkforce(actor, C1, siteScope, E1, { reason: 'x' });
    await expect(svc.exitWorkforce(actor, C1, siteScope, E1, { reason: 'x' })).rejects.toThrow(
      AlreadyExitedError,
    );
  });

  it('project marker covers child sites — site-level repeat exit conflicts', async () => {
    store.memberships.push(membership({ departmentId: DA }));
    await svc.exitWorkforce(actor, C1, projectScope, E1, { reason: 'x' });
    await expect(svc.exitWorkforce(actor, C1, siteScope, E1, { reason: 'x' })).rejects.toThrow(
      AlreadyExitedError,
    );
  });

  it('no in-scope rows at all → 404 SITE_WORKFORCE', async () => {
    store.memberships.push(membership({ departmentId: DD }));
    await expect(svc.exitWorkforce(actor, C1, siteScope, E1, { reason: 'x' })).rejects.toThrow(
      OrgEntityNotFoundError,
    );
  });

  it('exit requires memberExit — memberSuspend alone does not suffice', async () => {
    store.memberships.push(membership({ departmentId: DA }));
    const off = svcFor(new LifecycleAuth({ scopes: new Set([S1]), flag: false }));
    await expect(off.exitWorkforce(actor, C1, siteScope, E1, { reason: 'x' })).rejects.toThrow(
      ForbiddenError,
    );
  });

  it('re-placed worker after exit: actives end EXITED, marker stays one', async () => {
    store.memberships.push(membership({ departmentId: DA }));
    await svc.exitWorkforce(actor, C1, siteScope, E1, { reason: 'x' });
    // Fresh placement (M3) is not blocked by the marker.
    store.memberships.push(membership({ departmentId: DA }));
    const res = await svc.exitWorkforce(actor, C1, siteScope, E1, { reason: 'again' });
    expect(res.ended).toHaveLength(1);
    expect(res.exitMarkerId).toBeNull(); // existing marker records the episode
    expect(store.siteWorkforceExits).toHaveLength(1);
    expect(store.memberships[1]?.endReason).toBe('EXITED');
  });
});

// ------------------------------------------------------------- reinstate --

describe('reinstateWorkforce', () => {
  it('creates new rows linked via supersededBy; old rows never reopen', async () => {
    store.memberships.push(membership({ departmentId: DA, isPrimary: true }));
    await svc.suspendWorkforce(actor, C1, siteScope, E1, { reason: 'x' });
    const old = must(store.memberships[0]);
    const res = await svc.reinstateWorkforce(actor, C1, siteScope, E1, {});
    expect(res.restored).toHaveLength(1);
    const created = must(store.memberships[1]);
    expect(created.id).not.toBe(old.id);
    expect(created.endedAt).toBeNull();
    expect(created.isPrimary).toBe(true); // original flag restored
    expect(old.supersededBy).toBe(created.id);
    expect(old.endedAt).not.toBeNull();
    expect(old.endReason).toBe('SUSPENDED');
  });

  it('restores non-primary when another primary already exists', async () => {
    store.memberships.push(membership({ departmentId: DA, isPrimary: true }));
    await svc.suspendWorkforce(actor, C1, siteScope, E1, { reason: 'x' });
    // Meanwhile another placement became the active primary.
    store.memberships.push(membership({ departmentId: DD, isPrimary: true }));
    const res = await svc.reinstateWorkforce(actor, C1, siteScope, E1, {});
    expect(res.restored[0]?.isPrimary).toBe(false);
    expect(store.memberships[1]?.isPrimary).toBe(true); // never demoted
  });

  it('repeat reinstate → 409 NOTHING_TO_REINSTATE (rows superseded)', async () => {
    store.memberships.push(membership({ departmentId: DA }));
    await svc.suspendWorkforce(actor, C1, siteScope, E1, { reason: 'x' });
    await svc.reinstateWorkforce(actor, C1, siteScope, E1, {});
    await expect(svc.reinstateWorkforce(actor, C1, siteScope, E1, {})).rejects.toThrow(
      ConflictError,
    );
  });

  it('exit marker blocks reinstatement → 409 ALREADY_EXITED', async () => {
    store.memberships.push(membership({ departmentId: DA }));
    await svc.suspendWorkforce(actor, C1, siteScope, E1, { reason: 'x' });
    await svc.exitWorkforce(actor, C1, siteScope, E1, { reason: 'x' });
    await expect(svc.reinstateWorkforce(actor, C1, siteScope, E1, {})).rejects.toThrow(
      AlreadyExitedError,
    );
    // Old row preserved, no new row created.
    expect(store.memberships).toHaveLength(1);
  });

  it('inactive department → all-or-nothing rollback', async () => {
    store.memberships.push(membership({ departmentId: DA }), membership({ departmentId: DC }));
    await svc.suspendWorkforce(actor, C1, projectScope, E1, { reason: 'x' });
    must(store.departments.find((d) => d.id === DA)).status = 'INACTIVE';
    const before = store.memberships.length;
    await expect(svc.reinstateWorkforce(actor, C1, projectScope, E1, {})).rejects.toThrow(
      ConflictError,
    );
    // Fake UoW rolls back on throw — nothing created.
    expect(store.memberships.length).toBe(before);
    expect(store.memberships.every((m) => m.supersededBy === null)).toBe(true);
  });

  it('ambiguous post-restore state without primary → blocked', async () => {
    // One suspended non-primary row in scope + two non-primary actives out
    // of scope → restoring leaves >1 effective with no primary → blocked.
    store.memberships.push(
      membership({ departmentId: DA, endedAt: new Date(), endReason: 'SUSPENDED' }),
      membership({ departmentId: DB }),
      membership({ departmentId: DD }),
    );
    await expect(svc.reinstateWorkforce(actor, C1, siteScope, E1, {})).rejects.toThrow(
      AmbiguousPrimaryError,
    );
  });

  it('active duplicate in the same department → conflict, no writes', async () => {
    store.memberships.push(
      membership({
        departmentId: DA,
        endedAt: new Date(),
        endReason: 'SUSPENDED',
      }),
      membership({ departmentId: DA }), // fresh placement already active
    );
    await expect(svc.reinstateWorkforce(actor, C1, siteScope, E1, {})).rejects.toThrow(
      ActiveMembershipExistsError,
    );
  });

  it('site reinstatement does not restore project-dept suspended rows', async () => {
    store.memberships.push(membership({ departmentId: DA }), membership({ departmentId: DC }));
    await svc.suspendWorkforce(actor, C1, projectScope, E1, { reason: 'x' });
    const res = await svc.reinstateWorkforce(actor, C1, siteScope, E1, {});
    expect(res.restored).toHaveLength(1);
    expect(res.restored[0]?.departmentId).toBe(DA);
    // DC's suspended row remains suspended — still restorable at project scope.
    expect(store.memberships[1]?.endReason).toBe('SUSPENDED');
  });
});

// ------------------------------------------------- contact-read gate (PF) --

describe('getScopedMember contact gate (EMPLOYEE_CONTACT_READ)', () => {
  beforeEach(() => {
    store.memberships.push(membership({ departmentId: DA, isPrimary: true }));
  });

  it('scoped holder with the contact key reads member detail', async () => {
    const a = svcFor(
      new LifecycleAuth({ scopes: new Set([S1]), keys: new Set(['EMPLOYEE_CONTACT_READ']) }),
    );
    const m = must(store.memberships[0]);
    const out = await a.getScopedMember(actor, C1, DA, m.id);
    expect(out.membershipId).toBe(m.id);
  });

  it('scoped holder WITHOUT the contact key is denied — DEPARTMENT_READ insufficient', async () => {
    const a = svcFor(
      new LifecycleAuth({ scopes: new Set([S1]), keys: new Set(['DEPARTMENT_READ']) }),
    );
    await expect(a.getScopedMember(actor, C1, DA, must(store.memberships[0]).id)).rejects.toThrow(
      AccessDeniedError,
    );
  });

  it('company-wide EMPLOYEE_MANAGE bypasses the scoped contact key', async () => {
    const a = svcFor(new LifecycleAuth({ companyWide: true }));
    const m = must(store.memberships[0]);
    const out = await a.getScopedMember(actor, C1, DA, m.id);
    expect(out.membershipId).toBe(m.id);
  });
});

// ------------------------------------------- mapMembershipRace (PF fix) --

describe('mapMembershipRace — real P2002 metadata shapes', () => {
  const p2002 = (meta: unknown) =>
    new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: 'test',
      meta: meta as never,
    });

  it('active-primary index (constraint.index object) → PRIMARY_CONFLICT', () => {
    expect(() =>
      mapMembershipRace(p2002({ constraint: { index: 'DepartmentMembership_active_primary_uq' } })),
    ).toThrow(PrimaryConflictError);
  });

  it('active emp-dept index (constraint.name object) → ACTIVE_MEMBERSHIP_EXISTS', () => {
    expect(() =>
      mapMembershipRace(p2002({ constraint: { name: 'DepartmentMembership_active_emp_dept_uq' } })),
    ).toThrow(ActiveMembershipExistsError);
  });

  it('constraint as a plain string still matches the verified indexes', () => {
    expect(() =>
      mapMembershipRace(p2002({ constraint: 'DepartmentMembership_active_primary_uq' })),
    ).toThrow(PrimaryConflictError);
  });

  it('index name surfaced via meta.target array → matched', () => {
    expect(() =>
      mapMembershipRace(p2002({ target: ['DepartmentMembership_active_emp_dept_uq'] })),
    ).toThrow(ActiveMembershipExistsError);
  });

  it('unrelated uniqueness (employeeCode fields) → generic 409, never mislabeled', () => {
    try {
      mapMembershipRace(p2002({ constraint: { fields: ['employeeCode'] } }));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConflictError);
      expect(e).not.toBeInstanceOf(PrimaryConflictError);
      expect(e).not.toBeInstanceOf(ActiveMembershipExistsError);
    }
  });

  it('foreign-key named constraint → generic 409', () => {
    try {
      mapMembershipRace(p2002({ constraint: { name: 'Employee_companyId_employeeCode_key' } }));
      expect.unreachable();
    } catch (e) {
      expect((e as ConflictError).code).toBe('UNIQUE_CONFLICT');
    }
  });

  it('non-P2002 errors rethrow untouched', () => {
    const other = new Prisma.PrismaClientKnownRequestError('fk', {
      code: 'P2003',
      clientVersion: 'test',
    });
    expect(() => mapMembershipRace(other)).toThrow(other);
    const plain = new Error('boom');
    expect(() => mapMembershipRace(plain)).toThrow(plain);
  });
});
