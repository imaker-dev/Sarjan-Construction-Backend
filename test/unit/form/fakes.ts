import type { Department, Form, FormVersion, Operation } from '@prisma/client';
import type { FormRepos, FormUnitOfWork } from '../../../src/modules/form/repository.js';
import type { AuditRecord } from '../../../src/modules/organization/types.js';
import {
  DuplicateCodeError,
  VersionConflictError,
} from '../../../src/modules/organization/errors.js';
import { FakeAuthorizer, fakeDepartment } from '../department/fakes.js';
import { fakeOperation } from '../operation/fakes.js';

export { FakeAuthorizer, fakeDepartment, fakeOperation };

export interface FormStore {
  departments: Department[];
  operations: Operation[];
  forms: Form[];
  formVersions: FormVersion[];
  auditLog: AuditRecord[];
}

export function emptyFormStore(): FormStore {
  return { departments: [], operations: [], forms: [], formVersions: [], auditLog: [] };
}

let nextId = 0;
const genId = () => `form-id-${++nextId}`;

export function fakeForm(over: Partial<Form> = {}): Form {
  return {
    id: genId(),
    companyId: 'c1',
    operationId: 'op1',
    key: 'REQ',
    name: 'Request Form',
    description: null,
    schema: null,
    status: 'DRAFT',
    latestRevision: 0,
    currentVersionId: null,
    version: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

export function makeFormRepos(store: FormStore): FormRepos {
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
    forms: {
      findById: async (companyId, id) => {
        const row = store.forms.find((f) => f.id === id && f.companyId === companyId);
        return row ? { ...row } : null;
      },
      list: async (companyId, filter) =>
        store.forms
          .filter(
            (f) =>
              f.companyId === companyId &&
              (filter?.status === undefined || f.status === filter.status) &&
              (filter?.operationId === undefined || f.operationId === filter.operationId),
          )
          .map((f) => ({ ...f })),
      create: async (companyId, operationId, data) => {
        if (
          store.forms.some(
            (f) => f.companyId === companyId && f.operationId === operationId && f.key === data.key,
          )
        ) {
          throw new DuplicateCodeError('FORM');
        }
        const form: Form = {
          id: genId(),
          companyId,
          operationId,
          key: data.key,
          name: data.name,
          description: data.description ?? null,
          schema: (data.schema ?? null) as Form['schema'],
          status: 'DRAFT',
          latestRevision: 0,
          currentVersionId: null,
          version: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        store.forms.push(form);
        return { ...form };
      },
      update: async (companyId, id, data, expectedVersion) => {
        const form = store.forms.find((f) => f.id === id && f.companyId === companyId);
        if (!form) throw new VersionConflictError('FORM');
        if (expectedVersion !== undefined && form.version !== expectedVersion) {
          throw new VersionConflictError('FORM');
        }
        Object.assign(form, data);
        form.version += 1;
        return { ...form };
      },
      updateForPublish: async (
        companyId,
        id,
        latestRevision,
        currentVersionId,
        expectedVersion,
      ) => {
        const form = store.forms.find((f) => f.id === id && f.companyId === companyId);
        if (!form) throw new VersionConflictError('FORM');
        if (expectedVersion !== undefined && form.version !== expectedVersion) {
          throw new VersionConflictError('FORM');
        }
        form.latestRevision = latestRevision;
        form.currentVersionId = currentVersionId;
        form.version += 1;
        return { ...form };
      },
    },
    formVersions: {
      create: async (data) => {
        const v: FormVersion = {
          id: genId(),
          companyId: data.companyId,
          formId: data.formId,
          revision: data.revision,
          schema: data.schema as FormVersion['schema'],
          publishedAt: new Date(),
          publishedByPrincipalId: data.publishedByPrincipalId ?? null,
          createdAt: new Date(),
        };
        store.formVersions.push(v);
        return v;
      },
      list: async (companyId, formId) =>
        store.formVersions.filter((v) => v.companyId === companyId && v.formId === formId),
    },
    audit: {
      record: async (entry) => {
        store.auditLog.push(entry);
      },
    },
  };
}

export class FakeFormUoW implements FormUnitOfWork {
  constructor(public readonly store: FormStore) {}

  async run<T>(fn: (repos: FormRepos) => Promise<T>): Promise<T> {
    const snapshot = structuredClone(this.store);
    try {
      return await fn(makeFormRepos(this.store));
    } catch (error) {
      Object.assign(this.store, structuredClone(snapshot));
      throw error;
    }
  }
}
