import { describe, it, expect, beforeEach } from 'vitest';
import type { DepartmentMembership } from '@prisma/client';
import { EmployeeService } from '../../../src/modules/employee/service.js';
import { emptyEmpStore, fakeEmployee, FakeEmployeeUoW, type EmpStore } from './fakes.js';
import { fakeDepartment, fakeProject, fakeSite } from '../department/fakes.js';
import {
  DuplicateCodeError,
  OrgEntityNotFoundError,
  OrgValidationError,
} from '../../../src/modules/organization/errors.js';
import { AccessDeniedError } from '../../../src/modules/access-control/errors.js';
import { ForbiddenError } from '../../../src/common/errors/app-error.js';
import type { ActorContext } from '../../../src/modules/organization/types.js';
import type { ScopeTarget } from '../../../src/modules/access-control/service.js';
import type { EmployeeRepos } from '../../../src/modules/employee/repository.js';

const actor: ActorContext = { actorId: 'pi1', actorType: 'USER' };

const P1 = '00000000-0000-4000-8000-0000000000a1';
const P2 = '00000000-0000-4000-8000-0000000000a2';
const S1 = '00000000-0000-4000-8000-0000000000b1';
const DA = '00000000-0000-4000-8000-0000000000d1';
const DB = '00000000-0000-4000-8000-0000000000d2';
const DC = '00000000-0000-4000-8000-0000000000d3';
const M1 = '00000000-0000-4000-8000-0000000000e1';
const E1 = '00000000-0000-4000-8000-0000000000f1';
const DOC1 = '00000000-0000-4000-8000-00000000d001';
const DOC2 = '00000000-0000-4000-8000-00000000d002';
const DOC_FOREIGN = '00000000-0000-4000-8000-00000000d003';
const DOC_QUARANTINED = '00000000-0000-4000-8000-00000000d004';

/** Scope-aware authorizer — mirrors PlacementAuth; flag covers every
 *  delegation switch (the fake ignores the flag name). */
class OnboardAuth {
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
let svc: EmployeeService;

beforeEach(() => {
  store = emptyEmpStore();
  store.projects.push(fakeProject({ id: P1 }), fakeProject({ id: P2 }));
  store.sites.push(fakeSite({ id: S1, projectId: P1 }));
  store.departments.push(
    fakeDepartment({ id: DA, scopeType: 'PROJECT', projectId: P1, status: 'ACTIVE' }),
    fakeDepartment({ id: DB, scopeType: 'PROJECT', projectId: P2, status: 'ACTIVE' }),
    fakeDepartment({ id: DC, scopeType: 'COMPANY', status: 'ACTIVE' }),
    fakeDepartment({
      id: '00000000-0000-4000-8000-0000000000d8',
      scopeType: 'SITE',
      siteId: S1,
      status: 'ACTIVE',
    }),
  );
  svc = new EmployeeService(
    new FakeEmployeeUoW(store),
    new OnboardAuth({ scopes: new Set([P1, S1]), flag: true }),
  );
});

const BODY = {
  employeeCode: 'wk-0142',
  displayName: 'Ramesh Kumar',
  engagementType: 'DAILY_WAGE',
};

describe('onboardScopedMember', () => {
  it('creates profile + initial primary membership atomically, principalId null', async () => {
    const out = await svc.onboardScopedMember(actor, 'c1', DA, { ...BODY });
    expect(out.employee.employeeCode).toBe('WK-0142'); // normalized
    expect(out.employee.principalId).toBeNull();
    expect(out.employee.status).toBe('ACTIVE');
    expect(out.membership.isPrimary).toBe(true);
    expect(out.membership.departmentId).toBe(DA);
    expect(out.membership.endedAt).toBeNull();
    expect(out.documentsLinked).toBe(0);
    expect(store.employees).toHaveLength(1);
    expect(store.memberships).toHaveLength(1);
    const onboarded = store.auditLog.filter((a) => a.action === 'EMPLOYEE_ONBOARDED');
    expect(onboarded).toHaveLength(1);
    expect(onboarded[0]?.entityType).toBe('DEPARTMENT_MEMBERSHIP');
  });

  it('delegation flag off or probe absent denies scoped holders — no writes', async () => {
    const off = new EmployeeService(
      new FakeEmployeeUoW(store),
      new OnboardAuth({ scopes: new Set([P1]), flag: false }),
    );
    await expect(off.onboardScopedMember(actor, 'c1', DA, { ...BODY })).rejects.toThrow(
      ForbiddenError,
    );
    const scoped = new OnboardAuth({ scopes: new Set([P1]), flag: true });
    const noProbe = new EmployeeService(new FakeEmployeeUoW(store), {
      assertPermission: scoped.assertPermission.bind(scoped),
      hasPermission: scoped.hasPermission.bind(scoped),
    });
    await expect(noProbe.onboardScopedMember(actor, 'c1', DA, { ...BODY })).rejects.toThrow(
      ForbiddenError,
    );
    expect(store.employees).toHaveLength(0);
    expect(store.memberships).toHaveLength(0);
  });

  it('company/HO departments are never delegated; company admin bypasses flag', async () => {
    await expect(svc.onboardScopedMember(actor, 'c1', DC, { ...BODY })).rejects.toThrow(
      ForbiddenError,
    );
    const admin = new EmployeeService(
      new FakeEmployeeUoW(store),
      new OnboardAuth({ companyWide: true }),
    );
    const out = await admin.onboardScopedMember(actor, 'c1', DC, { ...BODY });
    expect(out.membership.departmentId).toBe(DC);
  });

  it('sibling-project and cross-company departments deny without writes', async () => {
    await expect(svc.onboardScopedMember(actor, 'c1', DB, { ...BODY })).rejects.toThrow(
      AccessDeniedError,
    );
    store.departments.push(
      fakeDepartment({
        id: '00000000-0000-4000-8000-0000000000d9',
        companyId: 'c2',
        scopeType: 'PROJECT',
      }),
    );
    await expect(
      svc.onboardScopedMember(actor, 'c1', '00000000-0000-4000-8000-0000000000d9', { ...BODY }),
    ).rejects.toThrow(OrgEntityNotFoundError);
    await expect(svc.onboardScopedMember(actor, 'c1', 'not-a-uuid', { ...BODY })).rejects.toThrow(
      OrgEntityNotFoundError,
    );
    expect(store.employees).toHaveLength(0);
  });

  it('inactive department is 422; child-site department works', async () => {
    store.departments.push(
      fakeDepartment({
        id: '00000000-0000-4000-8000-0000000000d7',
        scopeType: 'SITE',
        siteId: S1,
        status: 'ARCHIVED',
      }),
    );
    await expect(
      svc.onboardScopedMember(actor, 'c1', '00000000-0000-4000-8000-0000000000d7', { ...BODY }),
    ).rejects.toThrow(OrgValidationError);
    const siteDept = '00000000-0000-4000-8000-0000000000d8';
    const out = await svc.onboardScopedMember(actor, 'c1', siteDept, { ...BODY });
    expect(out.membership.departmentId).toBe(siteDept);
  });

  it('duplicate employee code is a deliberate 409', async () => {
    await svc.onboardScopedMember(actor, 'c1', DA, { ...BODY });
    await expect(svc.onboardScopedMember(actor, 'c1', DA, { ...BODY })).rejects.toThrow(
      DuplicateCodeError,
    );
    expect(store.employees).toHaveLength(1);
    expect(store.memberships).toHaveLength(1);
  });

  it('validates code/name/engagement/emergency pair before any write', async () => {
    await expect(
      svc.onboardScopedMember(actor, 'c1', DA, { ...BODY, employeeCode: 'bad code!' }),
    ).rejects.toThrow(OrgValidationError);
    await expect(
      svc.onboardScopedMember(actor, 'c1', DA, { ...BODY, displayName: '   ' }),
    ).rejects.toThrow(OrgValidationError);
    await expect(
      svc.onboardScopedMember(actor, 'c1', DA, { ...BODY, engagementType: 'SUPERADMIN' }),
    ).rejects.toThrow(OrgValidationError);
    await expect(
      svc.onboardScopedMember(actor, 'c1', DA, {
        ...BODY,
        emergencyContactName: 'Sita',
      }),
    ).rejects.toThrow(OrgValidationError);
    expect(store.employees).toHaveLength(0);
  });

  it('joiningDate is a profile fact — membership still starts now, primary', async () => {
    const past = new Date('2020-01-15');
    const out = await svc.onboardScopedMember(actor, 'c1', DA, {
      ...BODY,
      joiningDate: past,
    });
    expect(out.employee.joiningDate?.getTime()).toBe(past.getTime());
    expect(out.membership.startedAt.getTime()).toBeGreaterThan(past.getTime());
    expect(out.membership.isPrimary).toBe(true);
  });

  it('links available company documents in the same transaction', async () => {
    store.documents.push(
      { id: DOC1, companyId: 'c1', status: 'AVAILABLE' },
      { id: DOC2, companyId: 'c1', status: 'AVAILABLE' },
    );
    const out = await svc.onboardScopedMember(actor, 'c1', DA, {
      ...BODY,
      documents: [
        { documentId: DOC1, documentType: 'PHOTO', title: 'Site photo' },
        {
          documentId: DOC2,
          documentType: 'TRADE_CERTIFICATE',
          title: 'Mason cert',
          documentNumber: 'CERT-9',
          expiryDate: new Date('2030-01-01'),
        },
      ],
    });
    expect(out.documentsLinked).toBe(2);
    expect(store.employeeDocuments).toHaveLength(2);
    expect(store.employeeDocuments.every((d) => d.companyId === 'c1')).toBe(true);
  });

  it('foreign/unavailable documents abort the whole onboard — rollback', async () => {
    store.documents.push(
      { id: DOC_FOREIGN, companyId: 'c2', status: 'AVAILABLE' },
      { id: DOC_QUARANTINED, companyId: 'c1', status: 'QUARANTINED' },
    );
    for (const documentId of [DOC_FOREIGN, DOC_QUARANTINED]) {
      await expect(
        svc.onboardScopedMember(actor, 'c1', DA, {
          ...BODY,
          documents: [{ documentId, documentType: 'PHOTO', title: 'x' }],
        }),
      ).rejects.toThrow(OrgValidationError);
    }
    await expect(
      svc.onboardScopedMember(actor, 'c1', DA, {
        ...BODY,
        documents: [
          { documentId: DOC1, documentType: 'PHOTO', title: 'a' },
          { documentId: DOC1, documentType: 'PAN', title: 'b' },
        ],
      }),
    ).rejects.toThrow(OrgValidationError);
    expect(store.employees).toHaveLength(0);
    expect(store.memberships).toHaveLength(0);
    expect(store.employeeDocuments).toHaveLength(0);
  });

  it('membership failure rolls back the employee row', async () => {
    const base = new FakeEmployeeUoW(store);
    const uow = {
      run: <T>(fn: (repos: EmployeeRepos) => Promise<T>) =>
        base.run(async (repos) => {
          repos.memberships.create = async () => {
            throw new Error('simulated membership failure');
          };
          return fn(repos);
        }),
    };
    const failing = new EmployeeService(
      uow,
      new OnboardAuth({ scopes: new Set([P1]), flag: true }),
    );
    await expect(failing.onboardScopedMember(actor, 'c1', DA, { ...BODY })).rejects.toThrow(
      'simulated membership failure',
    );
    expect(store.employees).toHaveLength(0);
    expect(store.memberships).toHaveLength(0);
    expect(store.auditLog).toHaveLength(0);
  });
});

describe('getScopedMember — contact read-back', () => {
  const seedMember = () => {
    store.employees.push(
      fakeEmployee({
        id: E1,
        companyId: 'c1',
        contactPhone: '9000000001',
        emergencyContactName: 'Sita',
        emergencyContactPhone: '9000000002',
      }),
    );
    const m: DepartmentMembership = {
      id: M1,
      companyId: 'c1',
      employeeId: E1,
      departmentId: DA,
      isPrimary: true,
      startedAt: new Date(Date.now() - 1000),
      endedAt: null,
      endReason: null,
      endNote: null,
      suspendUntil: null,
      supersededBy: null,
      version: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    store.memberships.push(m);
  };

  it('returns contact fields for an in-scope department member', async () => {
    seedMember();
    const auth = new OnboardAuth({ scopes: new Set([P1]) });
    const svc2 = new EmployeeService(new FakeEmployeeUoW(store), auth);
    const out = await svc2.getScopedMember(actor, 'c1', DA, M1);
    expect(out.employee?.contactPhone).toBe('9000000001');
    expect(out.employee?.emergencyContactName).toBe('Sita');
    expect(out.employee).not.toHaveProperty('principalId');
  });

  it('denies out-of-scope departments; wrong-department membership is 404', async () => {
    seedMember();
    const auth = new OnboardAuth({ scopes: new Set([P1, S1]) });
    const svc2 = new EmployeeService(new FakeEmployeeUoW(store), auth);
    await expect(svc2.getScopedMember(actor, 'c1', DB, M1)).rejects.toThrow(AccessDeniedError);
    const siteDept = '00000000-0000-4000-8000-0000000000d8';
    await expect(svc2.getScopedMember(actor, 'c1', siteDept, M1)).rejects.toThrow(
      OrgEntityNotFoundError,
    );
    await expect(svc2.getScopedMember(actor, 'c1', DA, 'not-a-uuid')).rejects.toThrow(
      OrgEntityNotFoundError,
    );
  });
});
