import { describe, it, expect, beforeEach } from 'vitest';
import type { DepartmentMembership } from '@prisma/client';
import { EmployeeService } from '../../../src/modules/employee/service.js';
import { emptyEmpStore, fakeEmployee, FakeEmployeeUoW, type EmpStore } from './fakes.js';
import { fakeDepartment, fakeProject, fakeSite } from '../department/fakes.js';
import {
  AmbiguousPrimaryError,
  OrgEntityNotFoundError,
  OrgValidationError,
  PrimaryOutOfScopeError,
  VersionConflictError,
} from '../../../src/modules/organization/errors.js';
import { AccessDeniedError } from '../../../src/modules/access-control/errors.js';
import { ForbiddenError } from '../../../src/common/errors/app-error.js';
import type { ActorContext } from '../../../src/modules/organization/types.js';
import type { ScopeTarget } from '../../../src/modules/access-control/service.js';

const actor: ActorContext = { actorId: 'pi1', actorType: 'USER' };

const P1 = '00000000-0000-4000-8000-0000000000a1';
const P2 = '00000000-0000-4000-8000-0000000000a2';
const S1 = '00000000-0000-4000-8000-0000000000b1';
const DA = '00000000-0000-4000-8000-0000000000d1';
const DB = '00000000-0000-4000-8000-0000000000d2';
const DC = '00000000-0000-4000-8000-0000000000d3';
const M1 = '00000000-0000-4000-8000-0000000000e1';
const E1 = '00000000-0000-4000-8000-0000000000f1';
const E2 = '00000000-0000-4000-8000-0000000000f2';
const E_INACTIVE = '00000000-0000-4000-8000-0000000000f3';
const E_NONE = '00000000-0000-4000-8000-0000000000f4';

const must = <T>(v: T | undefined | null): T => {
  if (v === undefined || v === null) throw new Error('test fixture missing');
  return v;
};

/** Scope-aware authorizer: companyWide = holds a company-scope grant;
 *  scopes = the project/site ids the caller's scoped grants cover. */
class PlacementAuth {
  calls: { key: string; target: ScopeTarget }[] = [];

  constructor(
    private readonly opts: {
      companyWide?: boolean;
      scopes?: ReadonlySet<string>;
      flag?: boolean;
    } = {},
  ) {}

  async assertPermission(pid: string, key: string, target: ScopeTarget): Promise<void> {
    this.calls.push({ key, target });
    const ok =
      target.scopeType === 'COMPANY' ? this.opts.companyWide === true : this.hasScope(target);
    if (!ok) throw new AccessDeniedError();
  }

  async hasPermission(pid: string, key: string, target: ScopeTarget): Promise<boolean> {
    this.calls.push({ key, target });
    return target.scopeType === 'COMPANY' ? this.opts.companyWide === true : this.hasScope(target);
  }

  async delegationEnabled(): Promise<boolean> {
    return this.opts.flag === true;
  }

  private hasScope(target: ScopeTarget): boolean {
    return this.opts.scopes?.has(target.scopeId) === true;
  }
}

let store: EmpStore;
let auth: PlacementAuth;
let svc: EmployeeService;

beforeEach(() => {
  store = emptyEmpStore();
  auth = new PlacementAuth({ scopes: new Set([P1, S1]), flag: true });
  svc = new EmployeeService(new FakeEmployeeUoW(store), auth);
});

let mid = 0;
const membership = (over: Partial<DepartmentMembership>): DepartmentMembership => ({
  id: `00000000-0000-4000-8000-${String(++mid).padStart(12, '0')}`,
  companyId: 'c1',
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

const setup = () => {
  store.projects.push(fakeProject({ id: P1 }), fakeProject({ id: P2 }));
  store.sites.push(fakeSite({ id: S1, projectId: P1 }));
  const deptA = fakeDepartment({ id: DA, scopeType: 'PROJECT', projectId: P1, status: 'ACTIVE' });
  const deptB = fakeDepartment({ id: DB, scopeType: 'PROJECT', projectId: P2, status: 'ACTIVE' });
  const deptC = fakeDepartment({ id: DC, scopeType: 'COMPANY', status: 'ACTIVE' });
  store.departments.push(deptA, deptB, deptC);
  return { deptA, deptB, deptC };
};

const emp = (id = E1) => store.employees.push(fakeEmployee({ id, companyId: 'c1' }));

describe('addScopedMember', () => {
  it('adds a member inside the caller boundary', async () => {
    setup();
    emp();
    const out = await svc.addScopedMember(actor, 'c1', DA, { employeeId: E1 });
    expect(out.departmentId).toBe(DA);
    expect(store.memberships).toHaveLength(1);
    expect(store.auditLog.some((a) => a.action === 'MEMBERSHIP_CREATED')).toBe(true);
  });

  it('flag off or absent denies scoped holders with DELEGATION_DISABLED', async () => {
    setup();
    emp();
    const noFlag = new EmployeeService(
      new FakeEmployeeUoW(store),
      new PlacementAuth({ scopes: new Set([P1]), flag: false }),
    );
    await expect(noFlag.addScopedMember(actor, 'c1', DA, { employeeId: E1 })).rejects.toThrow(
      ForbiddenError,
    );
    const scoped = new PlacementAuth({ scopes: new Set([P1]), flag: true });
    const noProbe = new EmployeeService(new FakeEmployeeUoW(store), {
      assertPermission: scoped.assertPermission.bind(scoped),
      hasPermission: scoped.hasPermission.bind(scoped),
    });
    await expect(noProbe.addScopedMember(actor, 'c1', DA, { employeeId: E1 })).rejects.toThrow(
      ForbiddenError,
    );
  });

  it('company/HO departments are never delegated to scoped holders', async () => {
    setup();
    emp();
    await expect(svc.addScopedMember(actor, 'c1', DC, { employeeId: E1 })).rejects.toThrow(
      ForbiddenError,
    );
    // Company-wide EMPLOYEE_MANAGE holder keeps working on the same route.
    const admin = new EmployeeService(
      new FakeEmployeeUoW(store),
      new PlacementAuth({ companyWide: true }),
    );
    const out = await admin.addScopedMember(actor, 'c1', DC, { employeeId: E1 });
    expect(out.departmentId).toBe(DC);
  });

  it('sibling-project department is denied', async () => {
    setup();
    emp();
    await expect(svc.addScopedMember(actor, 'c1', DB, { employeeId: E1 })).rejects.toThrow(
      AccessDeniedError,
    );
  });

  it('404 on missing/cross-company rows; 422 on inactive employee/dept', async () => {
    setup();
    emp();
    store.departments.push(
      fakeDepartment({
        id: '00000000-0000-4000-8000-0000000000d9',
        companyId: 'c2',
        scopeType: 'PROJECT',
      }),
      fakeDepartment({
        id: '00000000-0000-4000-8000-0000000000d8',
        scopeType: 'PROJECT',
        projectId: P1,
        status: 'ARCHIVED',
      }),
    );
    store.employees.push(fakeEmployee({ id: E_INACTIVE, status: 'INACTIVE' }));
    await expect(
      svc.addScopedMember(actor, 'c1', '00000000-0000-4000-8000-0000000000d9', {
        employeeId: E1,
      }),
    ).rejects.toThrow(OrgEntityNotFoundError);
    await expect(
      svc.addScopedMember(actor, 'c1', '00000000-0000-4000-8000-0000000000ff', {
        employeeId: E1,
      }),
    ).rejects.toThrow(OrgEntityNotFoundError);
    await expect(svc.addScopedMember(actor, 'c1', DA, { employeeId: E_NONE })).rejects.toThrow(
      OrgEntityNotFoundError,
    );
    await expect(svc.addScopedMember(actor, 'c1', DA, { employeeId: E_INACTIVE })).rejects.toThrow(
      OrgValidationError,
    );
    await expect(
      svc.addScopedMember(actor, 'c1', '00000000-0000-4000-8000-0000000000d8', {
        employeeId: E1,
      }),
    ).rejects.toThrow(OrgValidationError);
  });

  it('startedAt must be future; future memberships cannot be primary', async () => {
    setup();
    emp();
    await expect(
      svc.addScopedMember(actor, 'c1', DA, {
        employeeId: E1,
        startedAt: new Date(Date.now() - 1000),
      }),
    ).rejects.toThrow(OrgValidationError);
    await expect(
      svc.addScopedMember(actor, 'c1', DA, {
        employeeId: E1,
        isPrimary: true,
        startedAt: new Date(Date.now() + 86_400_000),
      }),
    ).rejects.toThrow(OrgValidationError);
    const out = await svc.addScopedMember(actor, 'c1', DA, {
      employeeId: E1,
      startedAt: new Date(Date.now() + 86_400_000),
    });
    expect(out.isPrimary).toBe(false);
  });

  it('duplicate active membership is a deliberate 409', async () => {
    setup();
    emp();
    store.memberships.push(membership({ employeeId: E1, departmentId: DA }));
    await expect(svc.addScopedMember(actor, 'c1', DA, { employeeId: E1 })).rejects.toThrow(
      /active membership already exists/i,
    );
  });

  it('out-of-scope primary blocks isPrimary with an opaque 409', async () => {
    setup();
    emp();
    // Employee's primary lives in project B — outside the caller's boundary.
    store.memberships.push(membership({ employeeId: E1, departmentId: DB, isPrimary: true }));
    await expect(
      svc.addScopedMember(actor, 'c1', DA, { employeeId: E1, isPrimary: true }),
    ).rejects.toThrow(PrimaryOutOfScopeError);
    // Non-primary placement is still allowed.
    const out = await svc.addScopedMember(actor, 'c1', DA, { employeeId: E1 });
    expect(out.isPrimary).toBe(false);
    expect(store.memberships.find((m) => m.departmentId === DB)?.isPrimary).toBe(true);
  });

  it('in-scope primary demotion updates both rows', async () => {
    setup();
    emp();
    store.memberships.push(membership({ employeeId: E1, departmentId: DA, isPrimary: true }));
    const secondDept = fakeDepartment({
      id: '00000000-0000-4000-8000-0000000000d4',
      scopeType: 'SITE',
      siteId: S1,
      status: 'ACTIVE',
    });
    store.departments.push(secondDept);
    const out = await svc.addScopedMember(actor, 'c1', secondDept.id, {
      employeeId: E1,
      isPrimary: true,
    });
    expect(out.isPrimary).toBe(true);
    expect(store.memberships.find((m) => m.departmentId === DA)?.isPrimary).toBe(false);
  });

  it('rejects a second non-primary membership when no primary exists', async () => {
    setup();
    emp();
    store.memberships.push(membership({ employeeId: E1, departmentId: DA }));
    const secondDept = fakeDepartment({
      id: '00000000-0000-4000-8000-0000000000d5',
      scopeType: 'SITE',
      siteId: S1,
      status: 'ACTIVE',
    });
    store.departments.push(secondDept);
    await expect(
      svc.addScopedMember(actor, 'c1', secondDept.id, { employeeId: E1 }),
    ).rejects.toThrow(AmbiguousPrimaryError);
    // isPrimary:true resolves it.
    const out = await svc.addScopedMember(actor, 'c1', secondDept.id, {
      employeeId: E1,
      isPrimary: true,
    });
    expect(out.isPrimary).toBe(true);
  });
});

describe('updateScopedMember', () => {
  it('flips primary in/out with version guard', async () => {
    setup();
    emp();
    store.memberships.push(membership({ id: M1, employeeId: E1, departmentId: DA }));
    const out = await svc.updateScopedMember(actor, 'c1', DA, M1, {
      isPrimary: true,
      expectedVersion: 0,
    });
    expect(out.isPrimary).toBe(true);
    await expect(
      svc.updateScopedMember(actor, 'c1', DA, M1, { isPrimary: true, expectedVersion: 0 }),
    ).rejects.toThrow(VersionConflictError);
  });

  it('future membership cannot become primary; ended membership rejects', async () => {
    setup();
    emp();
    store.memberships.push(
      membership({
        id: M1,
        employeeId: E1,
        departmentId: DA,
        startedAt: new Date(Date.now() + 86_400_000),
      }),
      membership({
        id: '00000000-0000-4000-8000-0000000000e2',
        employeeId: E1,
        departmentId: DA,
        endedAt: new Date(),
      }),
    );
    await expect(
      svc.updateScopedMember(actor, 'c1', DA, M1, { isPrimary: true, expectedVersion: 0 }),
    ).rejects.toThrow(OrgValidationError);
    await expect(
      svc.updateScopedMember(actor, 'c1', DA, '00000000-0000-4000-8000-0000000000e2', {
        isPrimary: true,
        expectedVersion: 0,
      }),
    ).rejects.toThrow(OrgValidationError);
  });

  it('demoting the primary with >1 other memberships is rejected', async () => {
    setup();
    emp();
    const dept2 = fakeDepartment({
      id: '00000000-0000-4000-8000-0000000000d6',
      scopeType: 'SITE',
      siteId: S1,
      status: 'ACTIVE',
    });
    store.departments.push(dept2);
    store.memberships.push(
      membership({ id: M1, employeeId: E1, departmentId: DA, isPrimary: true }),
      membership({ employeeId: E1, departmentId: dept2.id }),
      membership({
        employeeId: E1,
        departmentId: DB,
        endedAt: new Date(Date.now() - 1000),
      }),
    );
    // e1 has DA(primary) + dept2 → demoting DA's primary leaves 1 → allowed.
    const ok = await svc.updateScopedMember(actor, 'c1', DA, M1, {
      isPrimary: false,
      expectedVersion: 0,
    });
    expect(ok.isPrimary).toBe(false);
    // Restore and add a third active membership — now demotion is ambiguous.
    must(store.memberships.find((m) => m.id === M1)).isPrimary = true;
    store.memberships.push(
      membership({ employeeId: E1, departmentId: DB, endedAt: null, isPrimary: false }),
    );
    await expect(
      svc.updateScopedMember(actor, 'c1', DA, M1, { isPrimary: false, expectedVersion: 1 }),
    ).rejects.toThrow(AmbiguousPrimaryError);
  });
});

describe('endScopedMember', () => {
  it('ends and clears a head reference atomically', async () => {
    setup();
    emp();
    const deptA = must(store.departments.find((d) => d.id === DA));
    deptA.headEmployeeId = E1;
    store.memberships.push(
      membership({ id: M1, employeeId: E1, departmentId: DA, isPrimary: true }),
    );
    const out = await svc.endScopedMember(actor, 'c1', DA, M1, { expectedVersion: 0 });
    expect(out.endedAt).not.toBeNull();
    expect(deptA.headEmployeeId).toBeNull();
    const actions = store.auditLog.map((a) => a.action);
    expect(actions).toContain('DEPT_HEAD_CLEARED');
    expect(actions).toContain('MEMBERSHIP_ENDED');
  });

  it('ending the primary with >1 remaining memberships is rejected', async () => {
    setup();
    emp();
    const dept2 = fakeDepartment({
      id: '00000000-0000-4000-8000-0000000000d7',
      scopeType: 'SITE',
      siteId: S1,
      status: 'ACTIVE',
    });
    store.departments.push(dept2);
    store.memberships.push(
      membership({ id: M1, employeeId: E1, departmentId: DA, isPrimary: true }),
      membership({ employeeId: E1, departmentId: dept2.id }),
      membership({ employeeId: E1, departmentId: DB }),
    );
    await expect(svc.endScopedMember(actor, 'c1', DA, M1, { expectedVersion: 0 })).rejects.toThrow(
      AmbiguousPrimaryError,
    );
    expect(store.memberships.find((m) => m.id === M1)?.endedAt).toBeNull();
  });

  it('stale version → 409; wrong department → 404', async () => {
    setup();
    emp();
    store.memberships.push(membership({ id: M1, employeeId: E1, departmentId: DA }));
    await expect(svc.endScopedMember(actor, 'c1', DA, M1, { expectedVersion: 9 })).rejects.toThrow(
      VersionConflictError,
    );
    // In-scope site department, but the membership belongs to DA → 404.
    const siteDept = fakeDepartment({
      id: '00000000-0000-4000-8000-0000000000d8',
      scopeType: 'SITE',
      siteId: S1,
      status: 'ACTIVE',
    });
    store.departments.push(siteDept);
    await expect(
      svc.endScopedMember(actor, 'c1', siteDept.id, M1, { expectedVersion: 0 }),
    ).rejects.toThrow(OrgEntityNotFoundError);
    // Out-of-scope department → authorization fails before the membership
    // is even looked up.
    await expect(svc.endScopedMember(actor, 'c1', DB, M1, { expectedVersion: 0 })).rejects.toThrow(
      AccessDeniedError,
    );
  });
});

describe('transferScopedMember', () => {
  const setupTransfer = () => {
    setup();
    emp();
    const deptB2 = fakeDepartment({
      id: '00000000-0000-4000-8000-0000000000d0',
      scopeType: 'SITE',
      siteId: S1,
      status: 'ACTIVE',
    });
    store.departments.push(deptB2);
    store.memberships.push(membership({ id: M1, employeeId: E1, departmentId: DA }));
    return deptB2;
  };

  it('ends source and creates destination atomically with one audit', async () => {
    const dest = setupTransfer();
    const out = await svc.transferScopedMember(actor, 'c1', DA, M1, {
      toDepartmentId: dest.id,
      expectedVersion: 0,
    });
    expect(out.departmentId).toBe(dest.id);
    const source = store.memberships.find((m) => m.id === M1);
    expect(source?.endedAt).not.toBeNull();
    const created = store.memberships.filter((m) => m.endedAt === null);
    expect(created).toHaveLength(1);
    const audits = store.auditLog.filter((a) => a.action === 'MEMBERSHIP_TRANSFERRED');
    expect(audits).toHaveLength(1);
    expect(audits[0]?.changedFields?.departmentId).toEqual({ before: DA, after: dest.id });
  });

  it('destination outside the boundary is denied; no writes occur', async () => {
    setup();
    emp();
    store.memberships.push(membership({ id: M1, employeeId: E1, departmentId: DA }));
    await expect(
      svc.transferScopedMember(actor, 'c1', DA, M1, {
        toDepartmentId: DB,
        expectedVersion: 0,
      }),
    ).rejects.toThrow(AccessDeniedError);
    expect(store.memberships.find((m) => m.id === M1)?.endedAt).toBeNull();
    expect(store.memberships).toHaveLength(1);
  });

  it('clears source head when the head transfers out', async () => {
    const dest = setupTransfer();
    const deptA = must(store.departments.find((d) => d.id === DA));
    deptA.headEmployeeId = E1;
    await svc.transferScopedMember(actor, 'c1', DA, M1, {
      toDepartmentId: dest.id,
      expectedVersion: 0,
    });
    expect(deptA.headEmployeeId).toBeNull();
    expect(store.auditLog.some((a) => a.action === 'DEPT_HEAD_CLEARED')).toBe(true);
  });

  it('carries primary across when isPrimary is set; blocks out-of-scope demote', async () => {
    const dest = setupTransfer();
    must(store.memberships.find((m) => m.id === M1)).isPrimary = true;
    const out = await svc.transferScopedMember(actor, 'c1', DA, M1, {
      toDepartmentId: dest.id,
      expectedVersion: 0,
      isPrimary: true,
    });
    expect(out.isPrimary).toBe(true);
    // A third-party primary in an out-of-scope dept blocks the transfer.
    const emp2 = fakeEmployee({ id: E2 });
    store.employees.push(emp2);
    store.memberships.push(membership({ employeeId: E2, departmentId: DB, isPrimary: true }));
    const m2 = membership({ employeeId: E2, departmentId: DA });
    store.memberships.push(m2);
    await expect(
      svc.transferScopedMember(actor, 'c1', DA, m2.id, {
        toDepartmentId: dest.id,
        expectedVersion: 0,
        isPrimary: true,
      }),
    ).rejects.toThrow(PrimaryOutOfScopeError);
  });

  it('same-department transfer and past start are 422', async () => {
    const dest = setupTransfer();
    await expect(
      svc.transferScopedMember(actor, 'c1', DA, M1, {
        toDepartmentId: DA,
        expectedVersion: 0,
      }),
    ).rejects.toThrow(OrgValidationError);
    await expect(
      svc.transferScopedMember(actor, 'c1', DA, M1, {
        toDepartmentId: dest.id,
        expectedVersion: 0,
        startedAt: new Date(Date.now() - 1000),
      }),
    ).rejects.toThrow(OrgValidationError);
  });

  it('rejects any caller startedAt — future or past — leaving everything unchanged', async () => {
    const dest = setupTransfer();
    const before = store.memberships.map((m) => ({ ...m }));
    const auditsBefore = store.auditLog.length;
    for (const startedAt of [
      new Date(Date.now() - 86_400_000),
      new Date(Date.now() + 86_400_000),
    ]) {
      await expect(
        svc.transferScopedMember(actor, 'c1', DA, M1, {
          toDepartmentId: dest.id,
          expectedVersion: 0,
          startedAt,
        }),
      ).rejects.toThrow(OrgValidationError);
    }
    // No gap, no write, no audit — memberships byte-for-byte identical.
    expect(store.memberships.map((m) => ({ ...m }))).toEqual(before);
    expect(store.auditLog).toHaveLength(auditsBefore);
  });
});
