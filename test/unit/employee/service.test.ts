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
    const e = await svc.create(actor, 'c1', { employeeCode: 'e-01', displayName: 'Ram' });
    expect(e.status).toBe('ACTIVE');
    expect(e.principalId).toBeNull();
    await expect(
      svc.create(actor, 'c1', { employeeCode: 'E-01', displayName: 'Dup' }),
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
    const e = await svc.create(actor, 'c1', { employeeCode: 'E1', displayName: 'A' });
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
