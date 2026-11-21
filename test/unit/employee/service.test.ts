import { describe, it, expect, beforeEach } from 'vitest';
import { EmployeeService } from '../../../src/modules/employee/service.js';
import { emptyEmpStore, fakeEmployee, FakeEmployeeUoW, type EmpStore } from './fakes.js';
import { fakeDepartment, FakeAuthorizer } from '../department/fakes.js';
import {
  DuplicateCodeError,
  OrgEntityNotFoundError,
  OrgValidationError,
} from '../../../src/modules/organization/errors.js';
import type { ActorContext } from '../../../src/modules/organization/types.js';

const actor: ActorContext = { actorId: 'admin1', actorType: 'USER' };

let store: EmpStore;
let svc: EmployeeService;
let auth: FakeAuthorizer;

beforeEach(() => {
  store = emptyEmpStore();
  auth = new FakeAuthorizer();
  svc = new EmployeeService(new FakeEmployeeUoW(store), auth);
});

const adminHolder = () =>
  store.roleAssignments.push({
    id: 'a-admin',
    companyId: 'c1',
    principalId: 'admin1',
    revokedAt: null,
    effectiveFrom: null,
    effectiveTo: null,
    permissionKeys: ['EMPLOYEE_MANAGE'],
  });

describe('create/list/update', () => {
  it('creates ACTIVE profile-only employee; duplicate code rejected', async () => {
    const e = await svc.create(actor, 'c1', {
      employeeCode: 'e-01',
      displayName: 'Ram',
      engagementType: 'DIRECT_EMPLOYEE',
    });
    expect(e.status).toBe('ACTIVE');
    expect(e.principalId).toBeNull();
    await expect(
      svc.create(actor, 'c1', {
        employeeCode: 'E-01',
        displayName: 'Dup',
        engagementType: 'DIRECT_EMPLOYEE',
      }),
    ).rejects.toThrow(DuplicateCodeError);
  });

  it('paginates deterministically by (createdAt, id)', async () => {
    for (let i = 0; i < 5; i++) {
      store.employees.push(
        fakeEmployee({
          companyId: 'c1',
          employeeCode: `E${i}`,
          createdAt: new Date(Date.now() - i * 1000),
        }),
      );
    }
    const p1 = await svc.list(actor, 'c1', { limit: 2 });
    const p2 = await svc.list(actor, 'c1', { limit: 2, cursor: p1.nextCursor ?? '' });
    expect(p1.employees).toHaveLength(2);
    expect(p2.employees).toHaveLength(2);
    const ids = new Set([...p1.employees, ...p2.employees].map((e) => e.id));
    expect(ids.size).toBe(4);
  });

  it('update enforces stale version; cross-company ids not found', async () => {
    const e = await svc.create(actor, 'c1', {
      employeeCode: 'E1',
      displayName: 'A',
      engagementType: 'DIRECT_EMPLOYEE',
    });
    await expect(svc.update(actor, 'c1', e.id, { displayName: 'B' }, 99)).rejects.toThrow();
    await expect(svc.update(actor, 'c2', e.id, { displayName: 'B' })).rejects.toThrow(
      OrgEntityNotFoundError,
    );
    const updated = await svc.update(actor, 'c1', e.id, { displayName: 'B' }, e.version);
    expect(updated.displayName).toBe('B');
  });
});

describe('status transitions', () => {
  it('deactivate revokes in-company assignments, clears heads, audits all', async () => {
    adminHolder();
    const emp = fakeEmployee({ companyId: 'c1', status: 'ACTIVE', principalId: 'p-emp' });
    store.employees.push(emp);
    store.roleAssignments.push({
      id: 'ra1',
      companyId: 'c1',
      principalId: 'p-emp',
      revokedAt: null,
      effectiveFrom: null,
      effectiveTo: null,
    });
    store.roleAssignments.push({
      id: 'ra-other-company',
      companyId: 'c2',
      principalId: 'p-emp',
      revokedAt: null,
      effectiveFrom: null,
      effectiveTo: null,
    });
    store.departments.push(fakeDepartment({ companyId: 'c1', headEmployeeId: emp.id }));
    const before = store.departments[0]?.version;

    const updated = await svc.changeStatus(actor, 'c1', emp.id, 'INACTIVE');
    expect(updated.status).toBe('INACTIVE');
    expect(store.roleAssignments.find((a) => a.id === 'ra1')?.revokedAt).not.toBeNull();
    expect(store.roleAssignments.find((a) => a.id === 'ra-other-company')?.revokedAt).toBeNull();
    expect(store.departments[0]?.headEmployeeId).toBeNull();
    expect(store.departments[0]?.version).toBe((before ?? 0) + 1);
    const actions = store.auditLog.map((a) => a.action);
    expect(actions).toContain('ACCESS_ROLE_REVOKED');
    expect(actions).toContain('DEPT_HEAD_CLEARED');
    expect(actions).toContain('EMPLOYEE_DEACTIVATED');
  });

  it('reactivation does not restore revoked assignments', async () => {
    adminHolder();
    const emp = fakeEmployee({ companyId: 'c1', status: 'INACTIVE', principalId: 'p-emp' });
    store.employees.push(emp);
    store.roleAssignments.push({
      id: 'ra1',
      companyId: 'c1',
      principalId: 'p-emp',
      revokedAt: new Date(),
      effectiveFrom: null,
      effectiveTo: null,
    });
    const updated = await svc.changeStatus(actor, 'c1', emp.id, 'ACTIVE');
    expect(updated.status).toBe('ACTIVE');
    expect(store.roleAssignments.find((a) => a.id === 'ra1')?.revokedAt).not.toBeNull();
  });

  it('blocks deactivating the last active administrator', async () => {
    adminHolder(); // only holder = admin1
    const emp = fakeEmployee({ companyId: 'c1', status: 'ACTIVE', principalId: 'admin1' });
    store.employees.push(emp);
    await expect(svc.changeStatus(actor, 'c1', emp.id, 'INACTIVE')).rejects.toThrow(
      OrgValidationError,
    );
  });
});

describe('audit rollback', () => {
  it('a tx failure leaves no partial writes or audits', async () => {
    adminHolder();
    const emp = fakeEmployee({ companyId: 'c1', status: 'ACTIVE', principalId: 'p-emp' });
    store.employees.push(emp);
    store.roleAssignments.push({
      id: 'ra1',
      companyId: 'c1',
      principalId: 'p-emp',
      revokedAt: null,
      effectiveFrom: null,
      effectiveTo: null,
    });
    store.departments.push(fakeDepartment({ companyId: 'c1', headEmployeeId: 'other' }));
    // corrupt the dept lookup to force a mid-tx failure
    const firstDept = store.departments[0];
    if (firstDept === undefined) throw new Error('missing dept');
    firstDept.headEmployeeId = emp.id;
    // force failure: stale expectedVersion
    await expect(svc.changeStatus(actor, 'c1', emp.id, 'INACTIVE', 42)).rejects.toThrow();
    expect(store.employees.find((e) => e.id === emp.id)?.status).toBe('ACTIVE');
    expect(store.auditLog).toHaveLength(0);
  });
});

describe('memberships', () => {
  it('returns populated department and employee objects on addMembership and listMemberships', async () => {
    adminHolder();
    const emp = fakeEmployee({ companyId: 'c1', id: 'emp-101', displayName: 'Jane Builder' });
    store.employees.push(emp);
    const dept = fakeDepartment({
      companyId: 'c1',
      id: 'dept-202',
      name: 'Finance & Accounts',
      code: 'FIN',
      status: 'ACTIVE',
    });
    store.departments.push(dept);

    const created = await svc.addMembership(actor, 'c1', emp.id, {
      departmentId: dept.id,
      isPrimary: true,
    });
    expect(created.employeeId).toBe(emp.id);
    expect(created.departmentId).toBe(dept.id);
    expect(created.department).toBeDefined();
    expect(created.department?.name).toBe('Finance & Accounts');
    expect(created.employee).toBeDefined();
    expect(created.employee?.displayName).toBe('Jane Builder');

    const list = await svc.listMemberships('c1', emp.id);
    expect(list).toHaveLength(1);
    expect(list[0]?.department?.id).toBe(dept.id);
    expect(list[0]?.department?.name).toBe('Finance & Accounts');
    expect(list[0]?.employee?.id).toBe(emp.id);
    expect(list[0]?.employee?.displayName).toBe('Jane Builder');
  });

  describe('endMembership — Finance role cascade', () => {
    const seedMembership = (
      departmentId: string,
      over: Record<string, unknown> = {},
    ): import('@prisma/client').DepartmentMembership => ({
      id: `m-${departmentId}-${Math.random().toString(36).slice(2, 8)}`,
      companyId: 'c1',
      employeeId: 'emp-1',
      departmentId,
      isPrimary: false,
      startedAt: new Date('2020-01-01'),
      endedAt: null,
      version: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...over,
    });

    const financeSetup = () => {
      adminHolder();
      store.employees.push(
        fakeEmployee({ companyId: 'c1', id: 'emp-1', status: 'ACTIVE', principalId: 'p-emp' }),
      );
      store.departments.push(
        fakeDepartment({ companyId: 'c1', id: 'd-fin', category: 'FINANCE', status: 'ACTIVE' }),
        fakeDepartment({ companyId: 'c1', id: 'd-fin2', category: 'FINANCE', status: 'ACTIVE' }),
        fakeDepartment({ companyId: 'c1', id: 'd-ops', category: 'OPERATIONS', status: 'ACTIVE' }),
      );
      store.roleAssignments.push(
        {
          id: 'a-fin',
          companyId: 'c1',
          principalId: 'p-emp',
          revokedAt: null,
          effectiveFrom: null,
          effectiveTo: null,
          roleKey: 'FINANCE_STAFF',
        },
        {
          id: 'a-mgr',
          companyId: 'c1',
          principalId: 'p-emp',
          revokedAt: null,
          effectiveFrom: null,
          effectiveTo: null,
          roleKey: 'FINANCE_MANAGER',
        },
        {
          id: 'a-ops',
          companyId: 'c1',
          principalId: 'p-emp',
          revokedAt: null,
          effectiveFrom: null,
          effectiveTo: null,
          roleKey: 'HO_ADMIN',
        },
      );
    };

    const assignment = (id: string) => store.roleAssignments.find((a) => a.id === id);

    it('ending the last active FINANCE membership revokes only finance roles, audited', async () => {
      financeSetup();
      const m = seedMembership('d-fin');
      store.memberships.push(m);
      const res = await svc.endMembership(actor, 'c1', 'emp-1', m.id, 0);
      expect(res?.endedAt).not.toBeNull();
      expect(assignment('a-fin')?.revokedAt).not.toBeNull();
      expect(assignment('a-mgr')?.revokedAt).not.toBeNull();
      // Non-finance assignments are untouched.
      expect(assignment('a-ops')?.revokedAt).toBeNull();
      const revokes = store.auditLog.filter((a) => a.action === 'ACCESS_ROLE_REVOKED');
      expect(revokes).toHaveLength(2);
      expect(store.auditLog.some((a) => a.action === 'MEMBERSHIP_ENDED')).toBe(true);
    });

    it('ending one of two FINANCE memberships keeps finance roles until the last ends', async () => {
      financeSetup();
      const m1 = seedMembership('d-fin', { id: 'm-1' });
      const m2 = seedMembership('d-fin2', { id: 'm-2' });
      store.memberships.push(m1, m2);
      await svc.endMembership(actor, 'c1', 'emp-1', 'm-1', 0);
      expect(assignment('a-fin')?.revokedAt).toBeNull();
      expect(assignment('a-mgr')?.revokedAt).toBeNull();
      await svc.endMembership(actor, 'c1', 'emp-1', 'm-2', 0);
      expect(assignment('a-fin')?.revokedAt).not.toBeNull();
      expect(assignment('a-mgr')?.revokedAt).not.toBeNull();
      expect(assignment('a-ops')?.revokedAt).toBeNull();
    });

    it('ending a non-finance membership still revokes when no finance membership remains', async () => {
      financeSetup();
      const m = seedMembership('d-ops');
      store.memberships.push(m);
      await svc.endMembership(actor, 'c1', 'emp-1', m.id, 0);
      // Fail-closed: the assignment should never have existed without a
      // FINANCE membership; ending any membership re-checks and revokes.
      expect(assignment('a-fin')?.revokedAt).not.toBeNull();
      expect(assignment('a-ops')?.revokedAt).toBeNull();
    });

    it('leaves finance roles when a FINANCE membership survives elsewhere', async () => {
      financeSetup();
      const fin = seedMembership('d-fin');
      const ops = seedMembership('d-ops', { id: 'm-ops' });
      store.memberships.push(fin, ops);
      await svc.endMembership(actor, 'c1', 'emp-1', 'm-ops', 0);
      expect(assignment('a-fin')?.revokedAt).toBeNull();
      expect(assignment('a-mgr')?.revokedAt).toBeNull();
    });

    it('membership end without any role assignments is a no-op cascade', async () => {
      adminHolder();
      store.employees.push(
        fakeEmployee({ companyId: 'c1', id: 'emp-1', status: 'ACTIVE', principalId: 'p-emp' }),
      );
      store.departments.push(
        fakeDepartment({ companyId: 'c1', id: 'd-ops', category: 'OPERATIONS', status: 'ACTIVE' }),
      );
      const m = seedMembership('d-ops');
      store.memberships.push(m);
      const res = await svc.endMembership(actor, 'c1', 'emp-1', m.id, 0);
      expect(res?.endedAt).not.toBeNull();
      expect(store.auditLog.filter((a) => a.action === 'ACCESS_ROLE_REVOKED')).toHaveLength(0);
    });
  });
});
