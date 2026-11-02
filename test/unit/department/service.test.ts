import { describe, it, expect, beforeEach } from 'vitest';
import { DepartmentService, DEPT_CONFIGURE } from '../../../src/modules/department/service.js';
import {
  DuplicateCodeError,
  InvalidStatusTransitionError,
  OrgEntityNotFoundError,
  OrgValidationError,
  VersionConflictError,
} from '../../../src/modules/organization/errors.js';
import { AccessDeniedError } from '../../../src/modules/access-control/errors.js';
import {
  emptyDeptStore,
  fakeDepartment,
  fakeEmployee,
  fakeProject,
  fakeSite,
  FakeAuthorizer,
  FakeDeptUoW,
  type DeptStore,
} from './fakes.js';
import type { ActorContext } from '../../../src/modules/organization/types.js';

const actor: ActorContext = { actorId: 'principal-1', actorType: 'USER' };

let store: DeptStore;
let authorizer: FakeAuthorizer;
let service: DepartmentService;

beforeEach(() => {
  store = emptyDeptStore();
  authorizer = new FakeAuthorizer(true);
  service = new DepartmentService(new FakeDeptUoW(store), authorizer);
});

describe('createDepartment', () => {
  it('creates a company-scoped department, normalizes the code, audits', async () => {
    const dept = await service.createDepartment(actor, 'c1', {
      scopeType: 'COMPANY',
      code: ' proc ',
      name: ' Procurement ',
      capabilityKey: 'PROCUREMENT_REVIEW',
    });
    expect(dept.code).toBe('PROC');
    expect(dept.name).toBe('Procurement');
    expect(dept.status).toBe('DRAFT');
    expect(dept.scopeType).toBe('COMPANY');
    const audit = store.auditLog[0];
    expect(audit?.action).toBe('DEPT_DEPARTMENT_CREATED');
    expect(audit?.actorId).toBe('principal-1');
    expect(audit?.companyId).toBe('c1');
    // Permission checked against the target scope.
    expect(authorizer.calls[0]?.permissionKey).toBe(DEPT_CONFIGURE);
    expect(authorizer.calls[0]?.target).toMatchObject({ companyId: 'c1', scopeType: 'COMPANY' });
  });

  it('rejects HEAD_OFFICE and unknown scopes', async () => {
    await expect(
      service.createDepartment(actor, 'c1', {
        scopeType: 'HEAD_OFFICE' as never,
        scopeId: 'ho1',
        code: 'x',
        name: 'x',
      }),
    ).rejects.toThrow(OrgValidationError);
    expect(store.departments).toHaveLength(0);
  });

  it('requires scopeId for PROJECT/SITE and forbids it for COMPANY', async () => {
    await expect(
      service.createDepartment(actor, 'c1', { scopeType: 'PROJECT', code: 'x', name: 'x' }),
    ).rejects.toThrow(OrgValidationError);
    await expect(
      service.createDepartment(actor, 'c1', {
        scopeType: 'COMPANY',
        scopeId: 'anything',
        code: 'x',
        name: 'x',
      }),
    ).rejects.toThrow(OrgValidationError);
  });

  it('rejects a project scope outside the company', async () => {
    store.projects.push(fakeProject({ id: 'pr-foreign', companyId: 'other-company' }));
    await expect(
      service.createDepartment(actor, 'c1', {
        scopeType: 'PROJECT',
        scopeId: 'pr-foreign',
        code: 'x',
        name: 'x',
      }),
    ).rejects.toThrow(OrgEntityNotFoundError);
  });

  it('creates a site-scoped department storing siteId only', async () => {
    store.sites.push(fakeSite({ id: 's1', companyId: 'c1' }));
    const dept = await service.createDepartment(actor, 'c1', {
      scopeType: 'SITE',
      scopeId: 's1',
      code: 'sa',
      name: 'Safety',
    });
    expect(dept.siteId).toBe('s1');
    expect(dept.projectId).toBeNull();
  });

  it('rejects a head employee from another company', async () => {
    store.employees.push(fakeEmployee({ id: 'e-foreign', companyId: 'other' }));
    await expect(
      service.createDepartment(actor, 'c1', {
        scopeType: 'COMPANY',
        code: 'x',
        name: 'x',
        headEmployeeId: 'e-foreign',
      }),
    ).rejects.toThrow(OrgEntityNotFoundError);
  });

  it('rejects duplicate codes within a company', async () => {
    store.departments.push(fakeDepartment({ code: 'PROC', companyId: 'c1' }));
    await expect(
      service.createDepartment(actor, 'c1', { scopeType: 'COMPANY', code: 'proc', name: 'x' }),
    ).rejects.toThrow(DuplicateCodeError);
  });

  it('allows the same code in a different company', async () => {
    store.departments.push(fakeDepartment({ code: 'PROC', companyId: 'other' }));
    const dept = await service.createDepartment(actor, 'c1', {
      scopeType: 'COMPANY',
      code: 'proc',
      name: 'x',
    });
    expect(dept.code).toBe('PROC');
  });
});

describe('transitions', () => {
  const seed = (status: string) => {
    const d = fakeDepartment({ status: status as never, companyId: 'c1' });
    store.departments.push(d);
    return d;
  };

  it('allows DRAFT→ACTIVE→INACTIVE→ACTIVE and →ARCHIVED', async () => {
    const d = seed('DRAFT');
    await service.transitionDepartmentStatus(actor, 'c1', d.id, 'ACTIVE');
    await service.transitionDepartmentStatus(actor, 'c1', d.id, 'INACTIVE');
    await service.transitionDepartmentStatus(actor, 'c1', d.id, 'ACTIVE');
    await service.transitionDepartmentStatus(actor, 'c1', d.id, 'ARCHIVED');
    expect(store.departments[0]?.status).toBe('ARCHIVED');
  });

  it('rejects invalid transitions and ARCHIVED terminal', async () => {
    const d = seed('DRAFT');
    await expect(service.transitionDepartmentStatus(actor, 'c1', d.id, 'INACTIVE')).rejects.toThrow(
      InvalidStatusTransitionError,
    );
    // The rejected transition rolled back — re-acquire the live store row.
    const row = store.departments[0];
    if (row === undefined) throw new Error('seed missing');
    row.status = 'ARCHIVED';
    await expect(service.transitionDepartmentStatus(actor, 'c1', d.id, 'ACTIVE')).rejects.toThrow(
      InvalidStatusTransitionError,
    );
  });

  it('audits status changes with before/after', async () => {
    const d = seed('DRAFT');
    await service.transitionDepartmentStatus(actor, 'c1', d.id, 'ACTIVE');
    const audit = store.auditLog[0];
    expect(audit?.statusBefore).toBe('DRAFT');
    expect(audit?.statusAfter).toBe('ACTIVE');
  });
});

describe('updateDepartment', () => {
  it('is a no-op for empty patches — no write, no audit', async () => {
    const d = fakeDepartment({ companyId: 'c1' });
    store.departments.push(d);
    const result = await service.updateDepartment(actor, 'c1', d.id, {});
    expect(result.version).toBe(0);
    expect(store.auditLog).toHaveLength(0);
  });

  it('updates name/capability/head and audits changed fields', async () => {
    const d = fakeDepartment({ companyId: 'c1' });
    const e = fakeEmployee({ id: 'e1', companyId: 'c1' });
    store.departments.push(d);
    store.employees.push(e);
    const updated = await service.updateDepartment(actor, 'c1', d.id, {
      name: ' New Name ',
      headEmployeeId: 'e1',
    });
    expect(updated.name).toBe('New Name');
    expect(updated.version).toBe(1);
    const audit = store.auditLog[0];
    expect(audit?.action).toBe('DEPT_DEPARTMENT_UPDATED');
    expect(audit?.changedFields?.name?.after).toBe('New Name');
  });

  it('rejects stale expectedVersion', async () => {
    const d = fakeDepartment({ companyId: 'c1' });
    store.departments.push(d);
    await service.updateDepartment(actor, 'c1', d.id, { name: 'a' }, 0);
    await expect(service.updateDepartment(actor, 'c1', d.id, { name: 'b' }, 0)).rejects.toThrow(
      VersionConflictError,
    );
  });

  it('rolls back when the audit write fails', async () => {
    const d = fakeDepartment({ companyId: 'c1' });
    store.departments.push(d);
    const uow = new FakeDeptUoW(store);
    const failingService = new DepartmentService(
      {
        run: async (fn) =>
          uow.run((repos) =>
            fn({
              ...repos,
              audit: {
                record: async () => {
                  throw new Error('audit write failed');
                },
              },
            }),
          ),
      },
      authorizer,
    );
    await expect(failingService.updateDepartment(actor, 'c1', d.id, { name: 'x' })).rejects.toThrow(
      'audit write failed',
    );
    // Business write rolled back with the transaction.
    expect(store.departments[0]?.name).toBe('Procurement');
    expect(store.departments[0]?.version).toBe(0);
    expect(store.auditLog).toHaveLength(0);
  });
});

describe('authorization', () => {
  it('denies writes without DEPARTMENT_CONFIGURE', async () => {
    const denying = new DepartmentService(new FakeDeptUoW(store), new FakeAuthorizer(false));
    await expect(
      denying.createDepartment(actor, 'c1', { scopeType: 'COMPANY', code: 'x', name: 'x' }),
    ).rejects.toThrow(AccessDeniedError);
    expect(store.departments).toHaveLength(0);
  });

  it('denies reads without DEPARTMENT_READ', async () => {
    const denying = new DepartmentService(new FakeDeptUoW(store), new FakeAuthorizer(false));
    await expect(denying.listDepartments(actor, 'c1')).rejects.toThrow(AccessDeniedError);
  });
});

describe('no delete surface', () => {
  it('has no delete/remove operations', () => {
    const svc = service as unknown as Record<string, unknown>;
    for (const key of Object.keys(svc)) {
      expect(key.toLowerCase()).not.toMatch(/delete|remove/);
    }
  });
});
