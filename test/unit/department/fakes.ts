import type { Department, Employee, HeadOffice, Project, Site } from '@prisma/client';
import type {
  DepartmentRepos,
  DepartmentUnitOfWork,
} from '../../../src/modules/department/repository.js';
import type { AuditRecord } from '../../../src/modules/organization/types.js';
import {
  DuplicateCodeError,
  VersionConflictError,
} from '../../../src/modules/organization/errors.js';
import type { Authorizer } from '../../../src/modules/department/service.js';
import type { ScopeTarget } from '../../../src/modules/access-control/service.js';
import { AccessDeniedError } from '../../../src/modules/access-control/errors.js';

export interface DeptStore {
  departments: Department[];
  employees: Employee[];
  projects: Project[];
  sites: Site[];
  headOffices: HeadOffice[];
  auditLog: AuditRecord[];
}

export function emptyDeptStore(): DeptStore {
  return {
    departments: [],
    employees: [],
    projects: [],
    sites: [],
    headOffices: [],
    auditLog: [],
  };
}

let nextId = 0;
const genId = () => `dept-id-${++nextId}`;

export function fakeDepartment(over: Partial<Department> = {}): Department {
  return {
    id: genId(),
    companyId: 'c1',
    scopeType: 'COMPANY',
    projectId: null,
    siteId: null,
    code: 'PROC',
    name: 'Procurement',
    capabilityKey: null,
    headEmployeeId: null,
    baseHeadOfficeId: null,
    status: 'DRAFT',
    version: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

export function fakeEmployee(over: Partial<Employee> = {}): Employee {
  return {
    id: genId(),
    companyId: 'c1',
    principalId: null,
    employeeCode: 'E1',
    displayName: 'Test Employee',
    status: 'ACTIVE',
    version: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

export function fakeProject(over: Partial<Project> = {}): Project {
  return { id: genId(), companyId: 'c1', ...over } as Project;
}

export function fakeSite(over: Partial<Site> = {}): Site {
  return { id: genId(), companyId: 'c1', ...over } as Site;
}

export function makeDepartmentRepos(store: DeptStore): DepartmentRepos {
  return {
    companies: {
      findById: async (companyId, id) => (companyId === id ? ({ id } as never) : null),
      findByCode: async () => null,
      create: async () => ({ id: 'unused' }) as never,
      update: async () => ({ id: 'unused' }) as never,
    },
    projects: {
      findById: async (companyId, id) =>
        store.projects.find((p) => p.id === id && p.companyId === companyId) ?? null,
      list: async () => store.projects,
      create: async () => store.projects[0] as never,
      update: async () => store.projects[0] as never,
    },
    sites: {
      findById: async (companyId, id) =>
        store.sites.find((s) => s.id === id && s.companyId === companyId) ?? null,
      list: async () => store.sites,
      create: async () => store.sites[0] as never,
      update: async () => store.sites[0] as never,
    },
    employees: {
      findById: async (companyId, id) =>
        store.employees.find((e) => e.id === id && e.companyId === companyId) ?? null,
    },
    headOffices: {
      findById: async (companyId, id) =>
        store.headOffices.find((h) => h.id === id && h.companyId === companyId) ?? null,
    },
    departments: {
      // Copies, not live references — callers see a snapshot like a real row.
      findById: async (companyId, id) => {
        const row = store.departments.find((d) => d.id === id && d.companyId === companyId);
        return row ? { ...row } : null;
      },
      list: async (companyId, filter) =>
        store.departments.filter(
          (d) =>
            d.companyId === companyId &&
            (filter?.status === undefined || d.status === filter.status) &&
            (filter?.projectId === undefined || d.projectId === filter.projectId) &&
            (filter?.siteId === undefined || d.siteId === filter.siteId),
        ),
      create: async (companyId, data) => {
        if (store.departments.some((d) => d.companyId === companyId && d.code === data.code)) {
          throw new DuplicateCodeError('DEPARTMENT');
        }
        const dept: Department = {
          id: genId(),
          companyId,
          scopeType: data.scopeType,
          projectId: data.projectId ?? null,
          siteId: data.siteId ?? null,
          code: data.code,
          name: data.name,
          capabilityKey: data.capabilityKey ?? null,
          headEmployeeId: data.headEmployeeId ?? null,
          baseHeadOfficeId: data.baseHeadOfficeId ?? null,
          status: 'DRAFT',
          version: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        store.departments.push(dept);
        return dept;
      },
      update: async (companyId, id, data, expectedVersion) => {
        const dept = store.departments.find((d) => d.id === id && d.companyId === companyId);
        if (!dept) throw new VersionConflictError('DEPARTMENT');
        if (expectedVersion !== undefined && dept.version !== expectedVersion) {
          throw new VersionConflictError('DEPARTMENT');
        }
        Object.assign(dept, data);
        dept.version += 1;
        return { ...dept };
      },
    },
    audit: {
      record: async (entry) => {
        store.auditLog.push(entry);
      },
    },
  };
}

export class FakeDeptUoW implements DepartmentUnitOfWork {
  constructor(public readonly store: DeptStore) {}

  async run<T>(fn: (repos: DepartmentRepos) => Promise<T>): Promise<T> {
    const snapshot = structuredClone(this.store);
    try {
      return await fn(makeDepartmentRepos(this.store));
    } catch (error) {
      Object.assign(this.store, structuredClone(snapshot));
      throw error;
    }
  }
}

// Authorizer double: records permission checks; configurable allowlist.
export class FakeAuthorizer implements Authorizer {
  calls: { principalId: string; permissionKey: string; target: ScopeTarget }[] = [];

  constructor(private readonly allowed = true) {}

  async assertPermission(
    principalId: string,
    permissionKey: string,
    target: ScopeTarget,
  ): Promise<void> {
    this.calls.push({ principalId, permissionKey, target });
    if (!this.allowed) throw new AccessDeniedError();
  }

  async hasPermission(
    principalId: string,
    permissionKey: string,
    target: ScopeTarget,
  ): Promise<boolean> {
    this.calls.push({ principalId, permissionKey, target });
    return this.allowed;
  }
}
