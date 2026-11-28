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
import { FINANCE_ROLE_KEYS } from '../../../src/modules/setup/role-templates.js';

export { fakeEmployee };

export interface EmpStore extends DeptStore {
  documents: { id: string; companyId: string; status: string }[];
  employeeDocuments: { companyId: string; employeeId: string; documentId: string }[];
  siteWorkforceExits: {
    id: string;
    companyId: string;
    employeeId: string;
    siteId: string | null;
    projectId: string | null;
    note?: string | undefined;
  }[];
  outbox: {
    companyId: string;
    eventType: string;
    aggregateId: string;
    recipientPrincipalIds: string[];
    summary: Record<string, unknown>;
  }[];
  roleAssignments: {
    id: string;
    companyId: string;
    principalId: string;
    revokedAt: Date | null;
    effectiveFrom: Date | null;
    effectiveTo: Date | null;
    roleKey?: string;
    principalStatus?: string;
    permissionKeys?: string[];
  }[];
  memberships: (import('@prisma/client').DepartmentMembership & {
    department?: import('@prisma/client').Department | null;
    employee?: import('@prisma/client').Employee | null;
  })[];
}

export function emptyEmpStore(): EmpStore {
  return {
    ...emptyDeptStore(),
    documents: [],
    employeeDocuments: [],
    siteWorkforceExits: [],
    outbox: [],
    roleAssignments: [],
    memberships: [],
  };
}

let nextId = 0;
const genId = () => `00000000-0000-4000-8000-${String(++nextId).padStart(12, '0')}`;

/** Mirror of the repo's LIFECYCLE_DEPT_SELECT embed for in-scope loads. */
function lifecycleDept(store: EmpStore, departmentId: string) {
  const d = store.departments.find((x) => x.id === departmentId) ?? null;
  if (d === null) return null;
  const site = d.siteId === null ? null : (store.sites.find((s) => s.id === d.siteId) ?? null);
  return {
    id: d.id,
    code: d.code,
    name: d.name,
    scopeType: d.scopeType,
    projectId: d.projectId,
    siteId: d.siteId,
    status: d.status,
    headEmployeeId: d.headEmployeeId,
    site: site === null ? null : { projectId: site.projectId },
  };
}

export function makeEmployeeTestRepos(store: EmpStore): EmployeeRepos {
  const dept = makeDepartmentRepos(store);
  return {
    ...dept,
    employees: {
      findById: async (companyId, id) =>
        store.employees.find((e) => e.id === id && e.companyId === companyId) ?? null,
      lockForUpdate: async () => undefined,
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
      count: async (companyId, filter) =>
        store.employees.filter(
          (e) =>
            e.companyId === companyId &&
            (filter.status === undefined || e.status === filter.status),
        ).length,
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
      revokeFinanceRoleAssignments: async (companyId, principalId, at) => {
        const rows = store.roleAssignments.filter(
          (a) =>
            a.companyId === companyId &&
            a.principalId === principalId &&
            a.revokedAt === null &&
            FINANCE_ROLE_KEYS.has(a.roleKey ?? ''),
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
      listScopedTeam: async (companyId, scope, filter, now) => {
        const inScope = (m: (typeof store.memberships)[number]) => {
          const dept = store.departments.find((d) => d.id === m.departmentId);
          if (dept === undefined) return false;
          const deptInScope =
            'projectId' in scope
              ? dept.projectId === scope.projectId ||
                (dept.siteId !== null &&
                  store.sites.find((s) => s.id === dept.siteId)?.projectId === scope.projectId)
              : dept.siteId === scope.siteId;
          return (
            m.companyId === companyId &&
            deptInScope &&
            m.startedAt <= now &&
            (m.endedAt === null || m.endedAt > now)
          );
        };
        const q = filter.q?.trim().toLowerCase();
        let rows = store.employees.filter(
          (e) =>
            e.companyId === companyId &&
            (filter.status === undefined || e.status === filter.status) &&
            (q === undefined ||
              q === '' ||
              e.employeeCode.toLowerCase().includes(q) ||
              e.displayName.toLowerCase().includes(q)) &&
            store.memberships.some((m) => m.employeeId === e.id && inScope(m)),
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
      endActiveMemberships: async (companyId, employeeId) => {
        const rows = store.memberships.filter(
          (m) => m.companyId === companyId && m.employeeId === employeeId && m.endedAt === null,
        );
        for (const m of rows) {
          m.endedAt = new Date();
          m.endReason = 'DEACTIVATED';
          m.version++;
        }
        return rows.map((m) => ({ id: m.id }));
      },
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
    documents: {
      availableIds: async (companyId, ids) =>
        store.documents
          .filter(
            (d) => d.companyId === companyId && d.status === 'AVAILABLE' && ids.includes(d.id),
          )
          .map((d) => d.id),
    },
    employeeDocuments: {
      createMany: async (rows) => {
        for (const r of rows) store.employeeDocuments.push(r);
        return { count: rows.length };
      },
    },
    memberships: {
      list: async (companyId, employeeId) =>
        store.memberships
          .filter((m) => m.companyId === companyId && m.employeeId === employeeId)
          .map((m) => ({
            ...m,
            department: store.departments.find((d) => d.id === m.departmentId) ?? null,
            employee: store.employees.find((e) => e.id === m.employeeId) ?? null,
          })),
      findById: async (companyId, employeeId, id) => {
        const m = store.memberships.find(
          (x) => x.id === id && x.companyId === companyId && x.employeeId === employeeId,
        );
        if (!m) return null;
        return {
          ...m,
          department: store.departments.find((d) => d.id === m.departmentId) ?? null,
          employee: store.employees.find((e) => e.id === m.employeeId) ?? null,
        };
      },
      activeForEmployee: async (companyId, employeeId) =>
        store.memberships.filter(
          (m) => m.companyId === companyId && m.employeeId === employeeId && m.endedAt === null,
        ),
      activeFinanceCount: async (companyId, employeeId, at) =>
        store.memberships.filter((m) => {
          if (
            m.companyId !== companyId ||
            m.employeeId !== employeeId ||
            m.startedAt > at ||
            (m.endedAt !== null && m.endedAt <= at)
          ) {
            return false;
          }
          const dept = store.departments.find((d) => d.id === m.departmentId);
          return dept?.category === 'FINANCE' && dept.status === 'ACTIVE';
        }).length,
      create: async (d) => {
        const m = {
          id: genId(),
          version: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
          endedAt: null,
          endReason: null,
          endNote: null,
          suspendUntil: null,
          supersededBy: null,
          ...d,
          startedAt: d.startedAt ?? new Date(),
          department: store.departments.find((dept) => dept.id === d.departmentId) ?? null,
          employee: store.employees.find((emp) => emp.id === d.employeeId) ?? null,
        };
        store.memberships.push(m);
        return m;
      },
      setPrimary: async (companyId, employeeId, id, version) => {
        const row = store.memberships.find(
          (m) =>
            m.id === id &&
            m.companyId === companyId &&
            m.employeeId === employeeId &&
            m.endedAt === null &&
            m.version === version,
        );
        if (!row) return { count: 0 };
        row.isPrimary = true;
        row.version++;
        return { count: 1 };
      },
      demoteOthers: async (companyId, employeeId, exceptId) => {
        let count = 0;
        for (const m of store.memberships) {
          if (
            m.companyId === companyId &&
            m.employeeId === employeeId &&
            m.endedAt === null &&
            m.isPrimary &&
            m.id !== exceptId
          ) {
            m.isPrimary = false;
            m.version++;
            count++;
          }
        }
        return { count };
      },
      end: async (companyId, employeeId, id, version, endReason) => {
        const row = store.memberships.find(
          (m) =>
            m.id === id &&
            m.companyId === companyId &&
            m.employeeId === employeeId &&
            m.endedAt === null &&
            m.version === version,
        );
        if (!row) return { count: 0 };
        row.endedAt = new Date();
        if (endReason !== undefined) row.endReason = endReason;
        row.version++;
        return { count: 1 };
      },
      findInDepartment: async (companyId, departmentId, id) => {
        const m = store.memberships.find(
          (x) => x.id === id && x.companyId === companyId && x.departmentId === departmentId,
        );
        if (!m) return null;
        return {
          ...m,
          department: store.departments.find((d) => d.id === m.departmentId) ?? null,
          employee: store.employees.find((e) => e.id === m.employeeId) ?? null,
        };
      },
      activePrimary: async (companyId, employeeId) => {
        const m = store.memberships.find(
          (x) =>
            x.companyId === companyId &&
            x.employeeId === employeeId &&
            x.endedAt === null &&
            x.isPrimary,
        );
        if (!m) return null;
        return {
          ...m,
          department: store.departments.find((d) => d.id === m.departmentId) ?? null,
          employee: store.employees.find((e) => e.id === m.employeeId) ?? null,
        };
      },
      effectiveAt: async (companyId, employeeId, at) =>
        store.memberships.filter(
          (m) =>
            m.companyId === companyId &&
            m.employeeId === employeeId &&
            m.startedAt <= at &&
            (m.endedAt === null || m.endedAt > at),
        ),
      setPrimaryFlag: async (companyId, departmentId, id, isPrimary, version) => {
        const row = store.memberships.find(
          (m) =>
            m.id === id &&
            m.companyId === companyId &&
            m.departmentId === departmentId &&
            m.endedAt === null &&
            m.version === version,
        );
        if (!row) return { count: 0 };
        row.isPrimary = isPrimary;
        row.version++;
        return { count: 1 };
      },
      hasActive: async (companyId, departmentId, employeeId, at) =>
        store.memberships.some(
          (m) =>
            m.companyId === companyId &&
            m.departmentId === departmentId &&
            m.employeeId === employeeId &&
            m.startedAt <= at &&
            (m.endedAt === null || m.endedAt > at),
        ),
      currentInScope: async (companyId, scope, employeeIds, now) =>
        store.memberships
          .filter((m) => {
            const dept = store.departments.find((d) => d.id === m.departmentId);
            if (dept === undefined) return false;
            const deptInScope =
              'projectId' in scope
                ? dept.projectId === scope.projectId ||
                  (dept.siteId !== null &&
                    store.sites.find((s) => s.id === dept.siteId)?.projectId === scope.projectId)
                : dept.siteId === scope.siteId;
            return (
              m.companyId === companyId &&
              employeeIds.includes(m.employeeId) &&
              deptInScope &&
              m.startedAt <= now &&
              (m.endedAt === null || m.endedAt > now)
            );
          })
          .map((m) => ({
            ...m,
            department: store.departments.find((d) => d.id === m.departmentId) ?? null,
          })),
      listForDepartment: async (companyId, departmentId, filter, now) => {
        let rows = store.memberships.filter(
          (m) =>
            m.companyId === companyId &&
            m.departmentId === departmentId &&
            m.startedAt <= now &&
            (filter.includeEnded || m.endedAt === null || m.endedAt > now),
        );
        const c = filter.cursor;
        if (c !== undefined) {
          rows = rows.filter(
            (m) =>
              m.createdAt < c.createdAt ||
              (m.createdAt.getTime() === c.createdAt.getTime() && m.id < c.id),
          );
        }
        return rows
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id))
          .slice(0, filter.limit)
          .map((m) => {
            // Mirror the real repo's SCOPED_EMPLOYEE_SELECT — roster rows
            // never carry contact/principal fields.
            const e = store.employees.find((x) => x.id === m.employeeId) ?? null;
            return {
              ...m,
              department: store.departments.find((d) => d.id === m.departmentId) ?? null,
              employee:
                e === null
                  ? null
                  : {
                      id: e.id,
                      employeeCode: e.employeeCode,
                      displayName: e.displayName,
                      engagementType: e.engagementType,
                      designation: e.designation,
                      tradeCategory: e.tradeCategory,
                      status: e.status,
                    },
            };
          });
      },
      activeInScope: async (companyId, employeeId, scope) =>
        store.memberships
          .filter((m) => {
            const dept = store.departments.find((d) => d.id === m.departmentId);
            if (dept === undefined) return false;
            const deptInScope =
              'projectId' in scope
                ? dept.projectId === scope.projectId ||
                  (dept.siteId !== null &&
                    store.sites.find((s) => s.id === dept.siteId)?.projectId === scope.projectId)
                : dept.siteId === scope.siteId;
            return (
              m.companyId === companyId &&
              m.employeeId === employeeId &&
              m.endedAt === null &&
              deptInScope
            );
          })
          .map((m) => ({ ...m, department: lifecycleDept(store, m.departmentId) })),
      suspendedInScope: async (companyId, employeeId, scope) =>
        store.memberships
          .filter((m) => {
            const dept = store.departments.find((d) => d.id === m.departmentId);
            if (dept === undefined) return false;
            const deptInScope =
              'projectId' in scope
                ? dept.projectId === scope.projectId ||
                  (dept.siteId !== null &&
                    store.sites.find((s) => s.id === dept.siteId)?.projectId === scope.projectId)
                : dept.siteId === scope.siteId;
            return (
              m.companyId === companyId &&
              m.employeeId === employeeId &&
              m.endedAt !== null &&
              m.endReason === 'SUSPENDED' &&
              m.supersededBy === null &&
              deptInScope
            );
          })
          .map((m) => ({ ...m, department: lifecycleDept(store, m.departmentId) })),
      endAll: async (companyId, ids, endReason, fields) => {
        let count = 0;
        for (const m of store.memberships) {
          if (m.companyId === companyId && ids.includes(m.id) && m.endedAt === null) {
            m.endedAt = new Date();
            m.endReason = endReason;
            if (fields.endNote !== undefined) m.endNote = fields.endNote;
            if (fields.suspendUntil !== undefined) m.suspendUntil = fields.suspendUntil;
            m.version++;
            count++;
          }
        }
        return { count };
      },
      markSuperseded: async (companyId, employeeId, oldId, newId) => {
        const row = store.memberships.find(
          (m) =>
            m.id === oldId &&
            m.companyId === companyId &&
            m.employeeId === employeeId &&
            m.endReason === 'SUSPENDED' &&
            m.supersededBy === null,
        );
        if (!row) return { count: 0 };
        row.supersededBy = newId;
        row.version++;
        return { count: 1 };
      },
    },
    siteWorkforceExits: {
      listForEmployee: async (companyId, employeeId) =>
        store.siteWorkforceExits
          .filter((x) => x.companyId === companyId && x.employeeId === employeeId)
          .map((x) => ({ id: x.id, siteId: x.siteId, projectId: x.projectId })),
      create: async (entry) => {
        const marker = {
          id: genId(),
          companyId: entry.companyId,
          employeeId: entry.employeeId,
          siteId: entry.siteId ?? null,
          projectId: entry.projectId ?? null,
          note: entry.note,
        };
        if (
          store.siteWorkforceExits.some(
            (x) =>
              x.companyId === entry.companyId &&
              x.employeeId === entry.employeeId &&
              ((marker.siteId !== null && x.siteId === marker.siteId) ||
                (marker.projectId !== null && x.projectId === marker.projectId)),
          )
        ) {
          const e = new Error('Unique constraint failed') as Error & {
            code?: string;
            meta?: unknown;
          };
          e.code = 'P2002';
          e.meta = { constraint: { index: 'SiteWorkforceExit_site_uq' } };
          // PrismaClientKnownRequestError shape — the service checks `code`.
          throw Object.assign(
            new (await import('@prisma/client')).Prisma.PrismaClientKnownRequestError(
              'Unique constraint failed',
              { code: 'P2002', clientVersion: 'test' },
            ),
            { meta: { constraint: { index: 'SiteWorkforceExit_site_uq' } } },
          );
        }
        store.siteWorkforceExits.push(marker);
        return { id: marker.id };
      },
    },
    outbox: {
      record: async (entry) => {
        store.outbox.push({
          companyId: entry.companyId,
          eventType: entry.eventType,
          aggregateId: entry.aggregateId,
          recipientPrincipalIds: entry.recipientPrincipalIds,
          summary: entry.summary,
        });
        return {};
      },
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
