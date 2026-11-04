import type {
  EmployeeRepos,
  EmployeeUnitOfWork,
} from '../../../src/modules/employee/repository.js';
import {
  emptyDeptStore,
  makeDepartmentRepos,
  fakeEmployee,
  type DeptStore,
} from '../department/fakes.js';
import {
  DuplicateCodeError,
  VersionConflictError,
} from '../../../src/modules/organization/errors.js';

export { fakeEmployee };

export interface EmpStore extends DeptStore {
  roleAssignments: {
    id: string;
    companyId: string;
    principalId: string;
    revokedAt: Date | null;
    effectiveFrom: Date | null;
    effectiveTo: Date | null;
    principalStatus?: string;
    permissionKeys?: string[];
  }[];
}

export function emptyEmpStore(): EmpStore {
  return { ...emptyDeptStore(), roleAssignments: [] };
}

let nextId = 0;
const genId = () => `00000000-0000-4000-8000-${String(++nextId).padStart(12, '0')}`;

export function makeEmployeeTestRepos(store: EmpStore): EmployeeRepos {
  const dept = makeDepartmentRepos(store);
  return {
    ...dept,
    employees: {
      findById: async (companyId, id) =>
        store.employees.find((e) => e.id === id && e.companyId === companyId) ?? null,
      findByCode: async (companyId, code) =>
        store.employees.find((e) => e.companyId === companyId && e.employeeCode === code) ?? null,
      list: async (companyId, filter) => {
        let rows = store.employees.filter(
          (e) =>
            e.companyId === companyId &&
            (filter.status === undefined || e.status === filter.status),
        );
        const c = filter.cursor;
        if (c !== undefined) {
          rows = rows.filter(
            (e) =>
              e.createdAt < c.createdAt ||
              (e.createdAt.getTime() === c.createdAt.getTime() && e.id < c.id),
          );
        }
        return rows
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id))
          .slice(0, filter.limit);
      },
      create: async (companyId, data) => {
        if (
          store.employees.some(
            (e) => e.companyId === companyId && e.employeeCode === data.employeeCode,
          )
        ) {
          throw new DuplicateCodeError('EMPLOYEE');
        }
        const emp = fakeEmployee({ id: genId(), companyId, ...data });
        store.employees.push(emp);
        return { ...emp };
      },
      update: async (companyId, id, data, expectedVersion) => {
        const e = store.employees.find((x) => x.id === id && x.companyId === companyId);
        if (!e) throw new Error('not found');
        if (expectedVersion !== undefined && e.version !== expectedVersion) {
          throw new VersionConflictError('EMPLOYEE');
        }
        Object.assign(e, data);
        e.version += 1;
        return { ...e };
      },
      revokeAssignmentsForPrincipal: async (companyId, principalId, at) => {
        const rows = store.roleAssignments.filter(
          (a) => a.companyId === companyId && a.principalId === principalId && a.revokedAt === null,
        );
        for (const r of rows) r.revokedAt = at;
        return rows.map((r) => r.id);
      },
      clearHeadReferences: async (companyId, employeeId) => {
        const rows = store.departments.filter(
          (d) => d.companyId === companyId && d.headEmployeeId === employeeId,
        );
        for (const d of rows) {
          d.headEmployeeId = null;
          d.version += 1;
        }
        return rows.map((d) => ({ id: d.id }));
      },
      endActiveMemberships: async () => [],
      activeHoldersOfKeys: async (companyId, keys, at) => {
        const holders = store.roleAssignments.filter(
          (a) =>
            a.companyId === companyId &&
            a.revokedAt === null &&
            (a.principalStatus ?? 'ACTIVE') === 'ACTIVE' &&
            (a.effectiveFrom === null || a.effectiveFrom <= at) &&
            (a.effectiveTo === null || a.effectiveTo >= at) &&
            (a.permissionKeys ?? []).some((k) => keys.includes(k)),
        );
        return [...new Set(holders.map((a) => a.principalId))];
      },
    },
    memberships: {
      list: async () => [],
      findById: async () => null,
      activeForEmployee: async () => [],
      create: async (d) => d as never,
      setPrimary: async () => ({ count: 1 }),
      demoteOthers: async () => ({ count: 0 }),
      end: async () => ({ count: 1 }),
    },
  };
}

export class FakeEmployeeUoW implements EmployeeUnitOfWork {
  constructor(public readonly store: EmpStore) {}
  async run<T>(fn: (repos: EmployeeRepos) => Promise<T>): Promise<T> {
    const snapshot = structuredClone(this.store);
    try {
      return await fn(makeEmployeeTestRepos(this.store));
    } catch (error) {
      Object.assign(this.store, structuredClone(snapshot));
      throw error;
    }
  }
}
