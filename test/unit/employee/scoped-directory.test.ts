import { describe, it, expect, beforeEach } from 'vitest';
import type { DepartmentMembership } from '@prisma/client';
import { EmployeeService } from '../../../src/modules/employee/service.js';
import { emptyEmpStore, fakeEmployee, FakeEmployeeUoW, type EmpStore } from './fakes.js';
import { fakeDepartment, fakeProject, fakeSite, FakeAuthorizer } from '../department/fakes.js';
import { OrgEntityNotFoundError } from '../../../src/modules/organization/errors.js';
import { AccessDeniedError } from '../../../src/modules/access-control/errors.js';
import type { ActorContext } from '../../../src/modules/organization/types.js';

const actor: ActorContext = { actorId: 'pi1', actorType: 'USER' };

const P1 = '00000000-0000-4000-8000-0000000000a1';
const PX = '00000000-0000-4000-8000-0000000000a2';
const P_OTHER = '00000000-0000-4000-8000-0000000000a3';
const S1 = '00000000-0000-4000-8000-0000000000b1';
const S2 = '00000000-0000-4000-8000-0000000000b2';
const D1 = '00000000-0000-4000-8000-0000000000d1';
const D2 = '00000000-0000-4000-8000-0000000000d2';
const DX = '00000000-0000-4000-8000-0000000000d3';

let store: EmpStore;
let svc: EmployeeService;
let auth: FakeAuthorizer;

beforeEach(() => {
  store = emptyEmpStore();
  auth = new FakeAuthorizer();
  svc = new EmployeeService(new FakeEmployeeUoW(store), auth);
});

let mid = 0;
const membership = (over: Partial<DepartmentMembership>): DepartmentMembership => ({
  id: `m-${++mid}`,
  companyId: 'c1',
  employeeId: 'e1',
  departmentId: D1,
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

const EMP_KEYS = [
  'id',
  'employeeCode',
  'displayName',
  'engagementType',
  'designation',
  'tradeCategory',
  'status',
];

describe('listScopedTeam', () => {
  it('project team includes project + child-site depts, excludes other scopes', async () => {
    const proj = fakeProject({ id: P1 });
    const site = fakeSite({ id: S1, projectId: P1 });
    const projDept = fakeDepartment({ id: 'd-proj', scopeType: 'PROJECT', projectId: P1 });
    const siteDept = fakeDepartment({ id: 'd-site', scopeType: 'SITE', siteId: S1 });
    const companyDept = fakeDepartment({ id: 'd-co', scopeType: 'COMPANY' });
    const otherDept = fakeDepartment({ id: 'd-other', scopeType: 'PROJECT', projectId: PX });
    store.projects.push(proj);
    store.sites.push(site);
    store.departments.push(projDept, siteDept, companyDept, otherDept);
    const inProj = fakeEmployee({ id: 'e-proj', employeeCode: 'EP' });
    const inSite = fakeEmployee({ id: 'e-site', employeeCode: 'ES' });
    const inCompany = fakeEmployee({ id: 'e-co', employeeCode: 'EC' });
    const inOther = fakeEmployee({ id: 'e-other', employeeCode: 'EO' });
    const noMembership = fakeEmployee({ id: 'e-none', employeeCode: 'EN' });
    store.employees.push(inProj, inSite, inCompany, inOther, noMembership);
    store.memberships.push(
      membership({ employeeId: 'e-proj', departmentId: 'd-proj' }),
      membership({ employeeId: 'e-site', departmentId: 'd-site' }),
      membership({ employeeId: 'e-co', departmentId: 'd-co' }),
      membership({ employeeId: 'e-other', departmentId: 'd-other' }),
    );

    const out = await svc.listScopedTeam(actor, 'c1', { scopeType: 'PROJECT', scopeId: P1 }, {});
    expect(out.items.map((r) => r.id).sort()).toEqual(['e-proj', 'e-site']);
    const siteMember = out.items.find((r) => r.id === 'e-site');
    expect(siteMember?.memberships[0]?.department).toMatchObject({ scopeType: 'SITE' });
    expect(
      auth.calls.some(
        (c) =>
          c.permissionKey === 'EMPLOYEE_READ' &&
          c.target.scopeType === 'PROJECT' &&
          c.target.scopeId === P1,
      ),
    ).toBe(true);
  });

  it('site team includes only that site’s department members', async () => {
    store.projects.push(fakeProject({ id: P1 }));
    store.sites.push(fakeSite({ id: S1, projectId: P1 }), fakeSite({ id: S2, projectId: P1 }));
    store.departments.push(
      fakeDepartment({ id: 'd-proj', scopeType: 'PROJECT', projectId: P1 }),
      fakeDepartment({ id: 'd-s1', scopeType: 'SITE', siteId: S1 }),
      fakeDepartment({ id: 'd-s2', scopeType: 'SITE', siteId: S2 }),
    );
    store.employees.push(
      fakeEmployee({ id: 'e-proj' }),
      fakeEmployee({ id: 'e-s1' }),
      fakeEmployee({ id: 'e-s2' }),
    );
    store.memberships.push(
      membership({ employeeId: 'e-proj', departmentId: 'd-proj' }),
      membership({ employeeId: 'e-s1', departmentId: 'd-s1' }),
      membership({ employeeId: 'e-s2', departmentId: 'd-s2' }),
    );

    const out = await svc.listScopedTeam(actor, 'c1', { scopeType: 'SITE', scopeId: S1 }, {});
    expect(out.items.map((r) => r.id)).toEqual(['e-s1']);
    expect(
      auth.calls.some(
        (c) =>
          c.permissionKey === 'EMPLOYEE_READ' &&
          c.target.scopeType === 'SITE' &&
          c.target.scopeId === S1,
      ),
    ).toBe(true);
  });

  it('dedupes an employee with multiple in-scope memberships', async () => {
    store.projects.push(fakeProject({ id: P1 }));
    store.sites.push(fakeSite({ id: S1, projectId: P1 }));
    store.departments.push(
      fakeDepartment({ id: 'd-proj', scopeType: 'PROJECT', projectId: P1 }),
      fakeDepartment({ id: 'd-site', scopeType: 'SITE', siteId: S1 }),
    );
    store.employees.push(fakeEmployee({ id: 'e1' }));
    store.memberships.push(
      membership({ id: 'm-a', employeeId: 'e1', departmentId: 'd-proj', isPrimary: true }),
      membership({ id: 'm-b', employeeId: 'e1', departmentId: 'd-site' }),
    );

    const out = await svc.listScopedTeam(actor, 'c1', { scopeType: 'PROJECT', scopeId: P1 }, {});
    expect(out.items).toHaveLength(1);
    expect(out.items[0]?.memberships.map((m) => m.id).sort()).toEqual(['m-a', 'm-b']);
  });

  it('excludes future and ended memberships; future-only employees hidden', async () => {
    store.projects.push(fakeProject({ id: P1 }));
    store.departments.push(fakeDepartment({ id: 'd-proj', scopeType: 'PROJECT', projectId: P1 }));
    store.employees.push(
      fakeEmployee({ id: 'e-active' }),
      fakeEmployee({ id: 'e-ended' }),
      fakeEmployee({ id: 'e-future' }),
      fakeEmployee({ id: 'e-mixed' }),
    );
    store.memberships.push(
      membership({ employeeId: 'e-active', departmentId: 'd-proj' }),
      membership({
        employeeId: 'e-ended',
        departmentId: 'd-proj',
        endedAt: new Date(Date.now() - 1000),
      }),
      membership({
        employeeId: 'e-future',
        departmentId: 'd-proj',
        startedAt: new Date(Date.now() + 86_400_000),
      }),
      membership({
        employeeId: 'e-mixed',
        departmentId: 'd-proj',
        startedAt: new Date(Date.now() + 86_400_000),
      }),
      membership({ id: 'm-now', employeeId: 'e-mixed', departmentId: 'd-proj' }),
    );

    const out = await svc.listScopedTeam(actor, 'c1', { scopeType: 'PROJECT', scopeId: P1 }, {});
    expect(out.items.map((r) => r.id).sort()).toEqual(['e-active', 'e-mixed']);
    expect(out.items.find((r) => r.id === 'e-mixed')?.memberships).toHaveLength(1);
    expect(out.items.find((r) => r.id === 'e-mixed')?.memberships[0]?.id).toBe('m-now');
  });

  it('safe projection exposes only operational fields', async () => {
    store.projects.push(fakeProject({ id: P1 }));
    store.departments.push(fakeDepartment({ id: 'd-proj', scopeType: 'PROJECT', projectId: P1 }));
    store.employees.push(
      fakeEmployee({
        id: 'e1',
        principalId: 'prin-secret',
        contactPhone: '999',
        contactEmail: 'x@y.z',
        emergencyContactName: 'Kin',
        emergencyContactPhone: '911',
      }),
    );
    store.memberships.push(membership({ employeeId: 'e1', departmentId: 'd-proj' }));

    const out = await svc.listScopedTeam(actor, 'c1', { scopeType: 'PROJECT', scopeId: P1 }, {});
    const row = out.items[0] as unknown as Record<string, unknown>;
    for (const key of Object.keys(row)) {
      if (key !== 'memberships') expect(EMP_KEYS).toContain(key);
    }
    const json = JSON.stringify(out.items[0]);
    for (const forbidden of [
      'contactPhone',
      'contactEmail',
      'emergencyContactName',
      'emergencyContactPhone',
      'principalId',
      'loginId',
      'joiningDate',
    ]) {
      expect(json).not.toContain(forbidden);
    }
    const mKeys = Object.keys((out.items[0]?.memberships ?? [])[0] ?? {});
    for (const key of mKeys) {
      expect(['id', 'departmentId', 'isPrimary', 'startedAt', 'endedAt', 'department']).toContain(
        key,
      );
    }
  });

  it('searches by employee code or display name', async () => {
    store.projects.push(fakeProject({ id: P1 }));
    store.departments.push(fakeDepartment({ id: 'd-proj', scopeType: 'PROJECT', projectId: P1 }));
    store.employees.push(
      fakeEmployee({ id: 'e1', employeeCode: 'WK-001', displayName: 'Ravi Kumar' }),
      fakeEmployee({ id: 'e2', employeeCode: 'WK-002', displayName: 'Suresh' }),
    );
    store.memberships.push(
      membership({ employeeId: 'e1', departmentId: 'd-proj' }),
      membership({ employeeId: 'e2', departmentId: 'd-proj' }),
    );

    const byName = await svc.listScopedTeam(
      actor,
      'c1',
      { scopeType: 'PROJECT', scopeId: P1 },
      { q: 'ravi' },
    );
    expect(byName.items.map((r) => r.id)).toEqual(['e1']);
    const byCode = await svc.listScopedTeam(
      actor,
      'c1',
      { scopeType: 'PROJECT', scopeId: P1 },
      { q: 'wk-002' },
    );
    expect(byCode.items.map((r) => r.id)).toEqual(['e2']);
  });

  it('paginates with a stable keyset cursor', async () => {
    store.projects.push(fakeProject({ id: P1 }));
    store.departments.push(fakeDepartment({ id: 'd-proj', scopeType: 'PROJECT', projectId: P1 }));
    for (let i = 0; i < 3; i++) {
      store.employees.push(
        fakeEmployee({
          id: `e${i}`,
          employeeCode: `E${i}`,
          createdAt: new Date(Date.now() - i * 1000),
        }),
      );
      store.memberships.push(membership({ employeeId: `e${i}`, departmentId: 'd-proj' }));
    }

    const page1 = await svc.listScopedTeam(
      actor,
      'c1',
      { scopeType: 'PROJECT', scopeId: P1 },
      { limit: 2 },
    );
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await svc.listScopedTeam(
      actor,
      'c1',
      { scopeType: 'PROJECT', scopeId: P1 },
      { limit: 2, ...(page1.nextCursor !== null ? { cursor: page1.nextCursor } : {}) },
    );
    expect(page2.items).toHaveLength(1);
    const ids = [...page1.items, ...page2.items].map((r) => r.id);
    expect(new Set(ids).size).toBe(3);
  });

  it('404s on missing or cross-company scope target; denies propagate', async () => {
    await expect(
      svc.listScopedTeam(actor, 'c1', { scopeType: 'PROJECT', scopeId: 'nope' }, {}),
    ).rejects.toThrow(OrgEntityNotFoundError);
    store.projects.push(fakeProject({ id: P_OTHER, companyId: 'c2' }));
    await expect(
      svc.listScopedTeam(actor, 'c1', { scopeType: 'PROJECT', scopeId: P_OTHER }, {}),
    ).rejects.toThrow(OrgEntityNotFoundError);

    const denied = new EmployeeService(new FakeEmployeeUoW(store), new FakeAuthorizer(false));
    store.projects.push(fakeProject({ id: P1 }));
    await expect(
      denied.listScopedTeam(actor, 'c1', { scopeType: 'PROJECT', scopeId: P1 }, {}),
    ).rejects.toThrow(AccessDeniedError);
  });
});

describe('listDepartmentMembers', () => {
  const setupDept = () => {
    store.projects.push(fakeProject({ id: P1 }));
    const dept = fakeDepartment({
      id: D1,
      scopeType: 'PROJECT',
      projectId: P1,
      status: 'ACTIVE',
    });
    store.departments.push(dept);
    return dept;
  };

  it('returns members of that department only, authorized at dept scope', async () => {
    const dept = setupDept();
    store.departments.push(fakeDepartment({ id: D2, scopeType: 'PROJECT', projectId: P1 }));
    store.employees.push(fakeEmployee({ id: 'e1' }), fakeEmployee({ id: 'e2' }));
    store.memberships.push(
      membership({ employeeId: 'e1', departmentId: D1 }),
      membership({ employeeId: 'e2', departmentId: D2 }),
    );

    const out = await svc.listDepartmentMembers(actor, 'c1', dept.id, {});
    expect(out.items).toHaveLength(1);
    expect(out.items[0]?.employee?.id).toBe('e1');
    expect(
      auth.calls.some(
        (c) =>
          c.permissionKey === 'DEPARTMENT_READ' &&
          c.target.scopeType === 'PROJECT' &&
          c.target.scopeId === P1,
      ),
    ).toBe(true);
  });

  it('defaults to current memberships; includeEnded adds history rows', async () => {
    const dept = setupDept();
    store.employees.push(fakeEmployee({ id: 'e1' }), fakeEmployee({ id: 'e2' }));
    store.memberships.push(
      membership({ id: 'm-now', employeeId: 'e1', departmentId: D1 }),
      membership({
        id: 'm-old',
        employeeId: 'e2',
        departmentId: D1,
        endedAt: new Date(Date.now() - 1000),
      }),
    );

    const current = await svc.listDepartmentMembers(actor, 'c1', dept.id, {});
    expect(current.items.map((r) => r.membershipId)).toEqual(['m-now']);
    const history = await svc.listDepartmentMembers(actor, 'c1', dept.id, {
      includeEnded: true,
    });
    expect(history.items.map((r) => r.membershipId).sort()).toEqual(['m-now', 'm-old']);
  });

  it('never returns future memberships, even with includeEnded', async () => {
    const dept = setupDept();
    store.employees.push(fakeEmployee({ id: 'e1' }));
    store.memberships.push(
      membership({
        id: 'm-future',
        employeeId: 'e1',
        departmentId: D1,
        startedAt: new Date(Date.now() + 86_400_000),
      }),
    );
    const out = await svc.listDepartmentMembers(actor, 'c1', dept.id, { includeEnded: true });
    expect(out.items).toHaveLength(0);
  });

  it('404s on missing or cross-company department', async () => {
    await expect(svc.listDepartmentMembers(actor, 'c1', 'nope', {})).rejects.toThrow(
      OrgEntityNotFoundError,
    );
    store.departments.push(fakeDepartment({ id: DX, companyId: 'c2' }));
    await expect(svc.listDepartmentMembers(actor, 'c1', DX, {})).rejects.toThrow(
      OrgEntityNotFoundError,
    );
  });
});
