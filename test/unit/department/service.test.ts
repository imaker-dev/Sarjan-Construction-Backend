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
    // Field-scope departments get the default operation set at creation.
    expect(store.seededOperations).toEqual([{ departmentId: dept.id, scopeType: 'SITE' }]);
  });

  it('seeds default operations on PROJECT departments, not COMPANY/HEAD_OFFICE', async () => {
    store.projects.push(fakeProject({ id: 'p1', companyId: 'c1' }));
    const projDept = await service.createDepartment(actor, 'c1', {
      scopeType: 'PROJECT',
      scopeId: 'p1',
      code: 'pe',
      name: 'Project Engineering',
    });
    const coDept = await service.createDepartment(actor, 'c1', {
      scopeType: 'COMPANY',
      code: 'hr',
      name: 'HR',
    });
    expect(store.seededOperations).toEqual([{ departmentId: projDept.id, scopeType: 'PROJECT' }]);
    expect(store.seededOperations.find((s) => s.departmentId === coDept.id)).toBeUndefined();
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

  it('rejects invalid transitions and allows ARCHIVED to ACTIVE', async () => {
    const d = seed('DRAFT');
    await expect(service.transitionDepartmentStatus(actor, 'c1', d.id, 'INACTIVE')).rejects.toThrow(
      InvalidStatusTransitionError,
    );
    // The rejected transition rolled back — re-acquire the live store row.
    const row = store.departments[0];
    if (row === undefined) throw new Error('seed missing');
    row.status = 'ARCHIVED';
    await expect(service.transitionDepartmentStatus(actor, 'c1', d.id, 'INACTIVE')).rejects.toThrow(
      InvalidStatusTransitionError,
    );
    const updated = await service.transitionDepartmentStatus(actor, 'c1', d.id, 'ACTIVE');
    expect(updated.status).toBe('ACTIVE');
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

describe('getDepartment', () => {
  it('returns the department with the embedded base head office', async () => {
    store.headOffices.push({
      id: 'ho1',
      companyId: 'c1',
      code: 'HQ',
      name: 'Head Office — Patna',
      isPrimary: true,
    } as never);
    const dept = fakeDepartment({ id: 'd1', scopeType: 'COMPANY', baseHeadOfficeId: 'ho1' });
    store.departments.push(dept);
    const detail = await service.getDepartment(actor, 'c1', 'd1');
    expect(detail.id).toBe('d1');
    expect(detail.baseHeadOffice).toEqual({
      id: 'ho1',
      code: 'HQ',
      name: 'Head Office — Patna',
      isPrimary: true,
    });
    // READ is asserted at the department's own scope, not just company-wide.
    expect(authorizer.calls.at(-1)?.target).toEqual({
      companyId: 'c1',
      scopeType: 'COMPANY',
      scopeId: 'c1',
    });
  });

  it('listDepartments embeds the base head office on each row', async () => {
    store.headOffices.push({
      id: 'ho1',
      companyId: 'c1',
      code: 'HQ',
      name: 'Head Office — Patna',
      isPrimary: true,
    } as never);
    store.departments.push(
      fakeDepartment({ id: 'd1', baseHeadOfficeId: 'ho1' }),
      fakeDepartment({ id: 'd2', baseHeadOfficeId: null }),
    );
    const rows = await service.listDepartments(actor, 'c1');
    expect(rows.find((d) => d.id === 'd1')?.baseHeadOffice?.code).toBe('HQ');
    expect(rows.find((d) => d.id === 'd2')?.baseHeadOffice).toBeNull();
  });

  it('returns null embed when the department has no base head office', async () => {
    store.departments.push(fakeDepartment({ id: 'd2', baseHeadOfficeId: null }));
    const detail = await service.getDepartment(actor, 'c1', 'd2');
    expect(detail.baseHeadOffice).toBeNull();
  });

  it('404s on missing or cross-company departments and denies without READ', async () => {
    await expect(service.getDepartment(actor, 'c1', 'nope')).rejects.toThrow(
      OrgEntityNotFoundError,
    );
    store.departments.push(fakeDepartment({ id: 'other', companyId: 'c2' }));
    await expect(service.getDepartment(actor, 'c1', 'other')).rejects.toThrow(
      OrgEntityNotFoundError,
    );
    const denying = new DepartmentService(new FakeDeptUoW(store), new FakeAuthorizer(false));
    store.departments.push(fakeDepartment({ id: 'd3' }));
    await expect(denying.getDepartment(actor, 'c1', 'd3')).rejects.toThrow(AccessDeniedError);
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

describe('delegated department administration (deptManage)', () => {
  const scopedAuthorizer = (delegated: boolean) => ({
    calls: [] as { permissionKey: string; target: { scopeType: string; scopeId: string } }[],
    async assertPermission(
      principalId: string,
      permissionKey: string,
      target: { companyId: string; scopeType: never; scopeId: string },
    ) {
      this.calls.push({ permissionKey, target });
    },
    async hasPermission() {
      return false; // scoped caller — never a company-scope grant
    },
    async delegationEnabled(_companyId: string, flag: string) {
      return flag === 'deptManage' && delegated;
    },
  });

  const projDept = { scopeType: 'PROJECT' as const, scopeId: 'pr-1', code: 'pe', name: 'PE' };

  it('flag off → scoped create denied (fail closed), even with a scoped grant', async () => {
    store.projects.push(fakeProject({ id: 'pr-1', companyId: 'c1' }));
    const scoped = new DepartmentService(new FakeDeptUoW(store), scopedAuthorizer(false));
    await expect(scoped.createDepartment(actor, 'c1', projDept)).rejects.toThrow(
      'delegated department administration',
    );
    expect(store.departments).toHaveLength(0);
  });

  it('flag on → scoped create allowed and permission asserted at project scope', async () => {
    store.projects.push(fakeProject({ id: 'pr-1', companyId: 'c1' }));
    const authz = scopedAuthorizer(true);
    const scoped = new DepartmentService(new FakeDeptUoW(store), authz);
    const dept = await scoped.createDepartment(actor, 'c1', projDept);
    expect(dept.scopeType).toBe('PROJECT');
    expect(authz.calls[0]?.target).toMatchObject({ scopeType: 'PROJECT', scopeId: 'pr-1' });
  });

  it('flag on → scoped update + status allowed; company caller unaffected by flag', async () => {
    store.departments.push(fakeDepartment({ id: 'd-p', scopeType: 'PROJECT', projectId: 'pr-1' }));
    const scoped = new DepartmentService(new FakeDeptUoW(store), scopedAuthorizer(true));
    const updated = await scoped.updateDepartment(actor, 'c1', 'd-p', { name: 'Renamed' });
    expect(updated.name).toBe('Renamed');
    const transitioned = await scoped.transitionDepartmentStatus(actor, 'c1', 'd-p', 'ACTIVE');
    expect(transitioned.status).toBe('ACTIVE');

    // Company-grant holder (hasPermission → true at company): flag off still allowed.
    const coAuth = {
      async assertPermission() {
        return undefined;
      },
      async hasPermission() {
        return true;
      },
      async delegationEnabled() {
        return false;
      },
    };
    store.departments.push(fakeDepartment({ id: 'd-p2', scopeType: 'PROJECT', projectId: 'pr-1' }));
    const co = new DepartmentService(new FakeDeptUoW(store), coAuth);
    await expect(co.updateDepartment(actor, 'c1', 'd-p2', { name: 'OK' })).resolves.toBeDefined();
  });

  it('flag off → scoped update/status denied on project depts', async () => {
    store.departments.push(fakeDepartment({ id: 'd-p', scopeType: 'PROJECT', projectId: 'pr-1' }));
    const scoped = new DepartmentService(new FakeDeptUoW(store), scopedAuthorizer(false));
    await expect(scoped.updateDepartment(actor, 'c1', 'd-p', { name: 'x' })).rejects.toThrow(
      'delegated department administration',
    );
    await expect(scoped.transitionDepartmentStatus(actor, 'c1', 'd-p', 'ACTIVE')).rejects.toThrow(
      'delegated department administration',
    );
  });

  it('COMPANY-scope departments never consult the flag', async () => {
    store.departments.push(fakeDepartment({ id: 'd-c', scopeType: 'COMPANY' }));
    let flagCalls = 0;
    const coAuth = {
      async assertPermission() {
        return undefined;
      },
      async hasPermission() {
        return false;
      },
      async delegationEnabled() {
        flagCalls += 1;
        return false;
      },
    };
    const svc = new DepartmentService(new FakeDeptUoW(store), coAuth);
    // assertPermission passes → company-scope dept mutates without flag probe.
    await expect(
      svc.updateDepartment(actor, 'c1', 'd-c', { name: 'Renamed Co' }),
    ).resolves.toBeDefined();
    expect(flagCalls).toBe(0);
  });
});
