import type {
  Department,
  Operation,
  OperationVersion,
  Workflow,
  WorkflowVersion,
} from '@prisma/client';
import type {
  WorkflowRepos,
  WorkflowUnitOfWork,
} from '../../../src/modules/workflow/repository.js';
import type { AuditRecord } from '../../../src/modules/organization/types.js';
import {
  DuplicateCodeError,
  VersionConflictError,
} from '../../../src/modules/organization/errors.js';
import { FakeAuthorizer, fakeDepartment } from '../department/fakes.js';
import { fakeOperation } from '../operation/fakes.js';

export { FakeAuthorizer, fakeDepartment, fakeOperation };

export interface WfStore {
  departments: Department[];
  operations: Operation[];
  operationVersions: { id: string; companyId: string; operationId: string }[];
  formVersionOps: { id: string; companyId: string; operationId: string }[];
  ruleVersionOps: { id: string; companyId: string; operationId: string }[];
  workflows: Workflow[];
  workflowVersions: WorkflowVersion[];
  auditLog: AuditRecord[];
}

export function emptyWfStore(): WfStore {
  return {
    departments: [],
    operations: [],
    operationVersions: [],
    formVersionOps: [],
    ruleVersionOps: [],
    workflows: [],
    workflowVersions: [],
    auditLog: [],
  };
}

let nextId = 0;
const genId = () => `wf-id-${++nextId}`;

export function fakeOperationVersion(over: Partial<OperationVersion> = {}): OperationVersion {
  return {
    id: genId(),
    companyId: 'c1',
    operationId: 'op1',
    revision: 1,
    ...over,
  } as OperationVersion;
}

export function fakeWorkflow(over: Partial<Workflow> = {}): Workflow {
  return {
    id: genId(),
    companyId: 'c1',
    operationId: 'op1',
    operationVersionId: 'ov1',
    key: 'STORE_REQ',
    name: 'Store Request',
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

export function makeWorkflowRepos(store: WfStore): WorkflowRepos {
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
      list: async () => [],
      create: async () => store.operations[0] as never,
      update: async () => store.operations[0] as never,
      updateForPublish: async () => store.operations[0] as never,
    },
    workflows: {
      findById: async (companyId, id) => {
        const row = store.workflows.find((w) => w.id === id && w.companyId === companyId);
        return row ? { ...row } : null;
      },
      list: async (companyId, filter) =>
        store.workflows
          .filter(
            (w) =>
              w.companyId === companyId &&
              (filter?.status === undefined || w.status === filter.status) &&
              (filter?.operationId === undefined || w.operationId === filter.operationId),
          )
          .map((w) => ({ ...w })),
      create: async (companyId, operationId, operationVersionId, data) => {
        if (
          store.workflows.some(
            (w) => w.companyId === companyId && w.operationId === operationId && w.key === data.key,
          )
        ) {
          throw new DuplicateCodeError('WORKFLOW');
        }
        const wf: Workflow = {
          id: genId(),
          companyId,
          operationId,
          operationVersionId,
          key: data.key,
          name: data.name,
          description: data.description ?? null,
          definition: (data.definition ?? null) as Workflow['definition'],
          status: 'DRAFT',
          latestRevision: 0,
          currentVersionId: null,
          version: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        store.workflows.push(wf);
        return { ...wf };
      },
      update: async (companyId, id, data, expectedVersion) => {
        const wf = store.workflows.find((w) => w.id === id && w.companyId === companyId);
        if (!wf) throw new VersionConflictError('WORKFLOW');
        if (expectedVersion !== undefined && wf.version !== expectedVersion) {
          throw new VersionConflictError('WORKFLOW');
        }
        Object.assign(wf, data);
        wf.version += 1;
        return { ...wf };
      },
      updateForPublish: async (
        companyId,
        id,
        latestRevision,
        currentVersionId,
        expectedVersion,
      ) => {
        const wf = store.workflows.find((w) => w.id === id && w.companyId === companyId);
        if (!wf) throw new VersionConflictError('WORKFLOW');
        if (expectedVersion !== undefined && wf.version !== expectedVersion) {
          throw new VersionConflictError('WORKFLOW');
        }
        wf.latestRevision = latestRevision;
        wf.currentVersionId = currentVersionId;
        wf.version += 1;
        return { ...wf };
      },
    },
    workflowVersions: {
      create: async (data) => {
        const v: WorkflowVersion = {
          id: genId(),
          companyId: data.companyId,
          workflowId: data.workflowId,
          revision: data.revision,
          definition: data.definition as WorkflowVersion['definition'],
          publishedAt: new Date(),
          publishedByPrincipalId: data.publishedByPrincipalId ?? null,
          createdAt: new Date(),
        };
        store.workflowVersions.push(v);
        return v;
      },
      list: async (companyId, workflowId) =>
        store.workflowVersions.filter(
          (v) => v.companyId === companyId && v.workflowId === workflowId,
        ),
    },
    operationVersions: {
      findOperationId: async (companyId, operationVersionId) =>
        store.operationVersions.find(
          (v) => v.id === operationVersionId && v.companyId === companyId,
        )?.operationId ?? null,
    },
    formVersions: {
      findOperationId: async (companyId, formVersionId) =>
        store.formVersionOps.find((v) => v.id === formVersionId && v.companyId === companyId)
          ?.operationId ?? null,
    },
    ruleVersions: {
      findOperationId: async (companyId, ruleVersionId) =>
        store.ruleVersionOps.find((v) => v.id === ruleVersionId && v.companyId === companyId)
          ?.operationId ?? null,
    },
    audit: {
      record: async (entry) => {
        store.auditLog.push(entry);
      },
    },
  };
}

export class FakeWfUoW implements WorkflowUnitOfWork {
  constructor(public readonly store: WfStore) {}

  async run<T>(fn: (repos: WorkflowRepos) => Promise<T>): Promise<T> {
    const snapshot = structuredClone(this.store);
    try {
      return await fn(makeWorkflowRepos(this.store));
    } catch (error) {
      Object.assign(this.store, structuredClone(snapshot));
      throw error;
    }
  }
}
