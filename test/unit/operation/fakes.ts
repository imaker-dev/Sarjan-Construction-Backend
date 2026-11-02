import type { Department, Operation, OperationVersion } from '@prisma/client';
import type {
  OperationRepos,
  OperationUnitOfWork,
} from '../../../src/modules/operation/repository.js';
import type { AuditRecord } from '../../../src/modules/organization/types.js';
import {
  DuplicateCodeError,
  VersionConflictError,
} from '../../../src/modules/organization/errors.js';
import { FakeAuthorizer, fakeDepartment } from '../department/fakes.js';

export { FakeAuthorizer, fakeDepartment };

export interface OpStore {
  departments: Department[];
  operations: Operation[];
  operationVersions: OperationVersion[];
  auditLog: AuditRecord[];
}

export function emptyOpStore(): OpStore {
  return { departments: [], operations: [], operationVersions: [], auditLog: [] };
}

let nextId = 0;
const genId = () => `op-id-${++nextId}`;

export function fakeOperation(over: Partial<Operation> = {}): Operation {
  return {
    id: genId(),
    companyId: 'c1',
    departmentId: 'd1',
    key: 'REV',
    name: 'Review',
    capabilityKey: null,
    description: null,
    definition: null,
    status: 'DRAFT',
    latestRevision: 0,
    currentVersionId: null,
    version: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

export function makeOperationRepos(store: OpStore): OperationRepos {
  return {
    departments: {
      findById: async (companyId, id) => {
        const row = store.departments.find((d) => d.id === id && d.companyId === companyId);
        return row ? { ...row } : null;
      },
      list: async () => [],
      create: async () => store.departments[0] as never,
      update: async () => store.departments[0] as never,
    },
    operations: {
      findById: async (companyId, id) => {
        const row = store.operations.find((o) => o.id === id && o.companyId === companyId);
        return row ? { ...row } : null;
      },
      list: async (companyId, filter) =>
        store.operations
          .filter(
            (o) =>
              o.companyId === companyId &&
              (filter?.status === undefined || o.status === filter.status) &&
              (filter?.departmentId === undefined || o.departmentId === filter.departmentId),
          )
          .map((o) => ({ ...o })),
      create: async (companyId, departmentId, data) => {
        if (
          store.operations.some(
            (o) =>
              o.companyId === companyId && o.departmentId === departmentId && o.key === data.key,
          )
        ) {
          throw new DuplicateCodeError('OPERATION');
        }
        const op: Operation = {
          id: genId(),
          companyId,
          departmentId,
          key: data.key,
          name: data.name,
          capabilityKey: data.capabilityKey ?? null,
          description: data.description ?? null,
          definition: (data.definition ?? null) as Operation['definition'],
          status: 'DRAFT',
          latestRevision: 0,
          currentVersionId: null,
          version: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        store.operations.push(op);
        return { ...op };
      },
      update: async (companyId, id, data, expectedVersion) => {
        const op = store.operations.find((o) => o.id === id && o.companyId === companyId);
        if (!op) throw new VersionConflictError('OPERATION');
        if (expectedVersion !== undefined && op.version !== expectedVersion) {
          throw new VersionConflictError('OPERATION');
        }
        Object.assign(op, data);
        op.version += 1;
        return { ...op };
      },
      updateForPublish: async (
        companyId,
        id,
        latestRevision,
        currentVersionId,
        expectedVersion,
      ) => {
        const op = store.operations.find((o) => o.id === id && o.companyId === companyId);
        if (!op) throw new VersionConflictError('OPERATION');
        if (expectedVersion !== undefined && op.version !== expectedVersion) {
          throw new VersionConflictError('OPERATION');
        }
        op.latestRevision = latestRevision;
        op.currentVersionId = currentVersionId;
        op.version += 1;
        return { ...op };
      },
    },
    operationVersions: {
      create: async (data) => {
        const v: OperationVersion = {
          id: genId(),
          companyId: data.companyId,
          operationId: data.operationId,
          revision: data.revision,
          definition: data.definition as OperationVersion['definition'],
          publishedAt: new Date(),
          publishedByPrincipalId: data.publishedByPrincipalId ?? null,
          createdAt: new Date(),
        };
        store.operationVersions.push(v);
        return v;
      },
      list: async (companyId, operationId) =>
        store.operationVersions.filter(
          (v) => v.companyId === companyId && v.operationId === operationId,
        ),
    },
    audit: {
      record: async (entry) => {
        store.auditLog.push(entry);
      },
    },
  };
}

export class FakeOpUoW implements OperationUnitOfWork {
  constructor(public readonly store: OpStore) {}

  async run<T>(fn: (repos: OperationRepos) => Promise<T>): Promise<T> {
    const snapshot = structuredClone(this.store);
    try {
      return await fn(makeOperationRepos(this.store));
    } catch (error) {
      Object.assign(this.store, structuredClone(snapshot));
      throw error;
    }
  }
}
