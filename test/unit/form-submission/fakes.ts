import type { Document, DocumentLink, FormSubmission, SubmissionRevision } from '@prisma/client';
import type {
  SubmissionRepos,
  SubmissionUnitOfWork,
} from '../../../src/modules/form-submission/repository.js';
import {
  DuplicateCodeError,
  VersionConflictError,
} from '../../../src/modules/organization/errors.js';
import { emptyInstStore, makeInstRepos } from '../workflow-instance/fakes.js';
import type { InstStore } from '../workflow-instance/fakes.js';
import { fakeDepartment, fakeOperation } from '../workflow-instance/fakes.js';

export { fakeDepartment, fakeOperation };

export interface SubmissionStore extends InstStore {
  formRows: { id: string; companyId: string; operationId: string; status: string }[];
  formVersionRows: { id: string; companyId: string; formId: string; schema: unknown }[];
  documents: Document[];
  documentLinks: DocumentLink[];
}

export function emptySubmissionStore(): SubmissionStore {
  return {
    ...emptyInstStore(),
    formRows: [],
    formVersionRows: [],
    documents: [],
    documentLinks: [],
  };
}

let nextId = 0;
const genId = () => `fs-id-${++nextId}`;

export function fakeSubmission(over: Partial<FormSubmission> = {}): FormSubmission {
  return {
    id: genId(),
    companyId: 'c1',
    operationId: 'op1',
    workflowInstanceId: 'i1',
    formId: 'f1',
    formVersionId: 'fv1',
    status: 'DRAFT',
    draftValues: null,
    latestRevision: 0,
    currentRevisionId: null,
    submittedByPrincipalId: null,
    submittedAt: null,
    returnedReason: null,
    version: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

export function makeSubmissionTestRepos(store: SubmissionStore): SubmissionRepos {
  return {
    ...makeInstRepos(store),
    submissionWrites: {
      create: async (data) => {
        if (
          store.formSubmissions.some(
            (s) =>
              s.companyId === data.companyId &&
              s.workflowInstanceId === data.workflowInstanceId &&
              s.formVersionId === data.formVersionId,
          )
        ) {
          throw new DuplicateCodeError('FORM_SUBMISSION');
        }
        const s: FormSubmission = {
          id: genId(),
          companyId: data.companyId,
          operationId: data.operationId,
          workflowInstanceId: data.workflowInstanceId,
          formId: data.formId,
          formVersionId: data.formVersionId,
          status: 'DRAFT',
          draftValues: data.draftValues ?? null,
          latestRevision: 0,
          currentRevisionId: null,
          submittedByPrincipalId: null,
          submittedAt: null,
          returnedReason: null,
          version: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        store.formSubmissions.push(s);
        return { ...s };
      },
      findById: async (companyId, id) => {
        const row = store.formSubmissions.find((s) => s.id === id && s.companyId === companyId);
        return row ? { ...row } : null;
      },
      list: async (companyId, filter) =>
        store.formSubmissions
          .filter(
            (s) =>
              s.companyId === companyId &&
              (filter?.operationId === undefined || s.operationId === filter.operationId) &&
              (filter?.workflowInstanceId === undefined ||
                s.workflowInstanceId === filter.workflowInstanceId) &&
              (filter?.status === undefined || s.status === filter.status),
          )
          .map((s) => ({ ...s })),
      saveDraft: async (companyId, id, draftValues, expectedVersion) => {
        const row = store.formSubmissions.find((s) => s.id === id && s.companyId === companyId);
        if (!row) throw new VersionConflictError('FORM_SUBMISSION');
        if (expectedVersion !== undefined && row.version !== expectedVersion) {
          throw new VersionConflictError('FORM_SUBMISSION');
        }
        row.draftValues = draftValues as FormSubmission['draftValues'];
        row.version += 1;
        return { ...row };
      },
      markSubmitted: async (companyId, id, data, expectedVersion) => {
        const row = store.formSubmissions.find((s) => s.id === id && s.companyId === companyId);
        if (!row) throw new VersionConflictError('FORM_SUBMISSION');
        if (expectedVersion !== undefined && row.version !== expectedVersion) {
          throw new VersionConflictError('FORM_SUBMISSION');
        }
        row.status = 'SUBMITTED';
        row.currentRevisionId = data.currentRevisionId;
        row.latestRevision = data.latestRevision;
        row.draftValues = null;
        row.returnedReason = null;
        row.submittedByPrincipalId = data.submittedByPrincipalId ?? null;
        row.submittedAt = data.submittedAt;
        row.version += 1;
        return { ...row };
      },
    },
    submissionRevisions: {
      create: async (data) => {
        if (
          data.idempotencyKey !== undefined &&
          store.submissionRevisions.some(
            (r) => r.submissionId === data.submissionId && r.idempotencyKey === data.idempotencyKey,
          )
        ) {
          throw new DuplicateCodeError('SUBMISSION_REVISION');
        }
        const r: SubmissionRevision = {
          id: genId(),
          companyId: data.companyId,
          submissionId: data.submissionId,
          revision: data.revision,
          values: data.values as SubmissionRevision['values'],
          submittedAt: new Date(),
          submittedByPrincipalId: data.submittedByPrincipalId ?? null,
          idempotencyKey: data.idempotencyKey ?? null,
          requestFingerprint: data.requestFingerprint ?? null,
          eventKey: data.eventKey,
        };
        store.submissionRevisions.push(r);
        return r;
      },
      findByIdempotencyKey: async (companyId, submissionId, key) =>
        store.submissionRevisions.find(
          (r) =>
            r.companyId === companyId &&
            r.submissionId === submissionId &&
            r.idempotencyKey === key,
        ) ?? null,
      listBySubmission: async (companyId, submissionId) =>
        store.submissionRevisions.filter(
          (r) => r.companyId === companyId && r.submissionId === submissionId,
        ),
    },
    forms: {
      findById: async (companyId, id) => {
        const row = store.formRows.find((f) => f.id === id && f.companyId === companyId);
        return row ? ({ ...row } as never) : null;
      },
    },
    formVersionRows: {
      findById: async (companyId, id) => {
        const row = store.formVersionRows.find((v) => v.id === id && v.companyId === companyId);
        return row ? { id: row.id, formId: row.formId, schema: row.schema } : null;
      },
    },
    documentRows: {
      findById: async (companyId, id) => {
        const row = store.documents.find((d) => d.id === id && d.companyId === companyId);
        return row ? { id: row.id, status: row.status } : null;
      },
    },
    documentLinkRows: {
      findActiveForSubmissionField: async (companyId, documentId, formSubmissionId, fieldKey) => {
        const row = store.documentLinks.find(
          (l) =>
            l.companyId === companyId &&
            l.documentId === documentId &&
            l.formSubmissionId === formSubmissionId &&
            l.fieldKey === fieldKey &&
            l.unlinkedAt === null,
        );
        return row ? { id: row.id } : null;
      },
    },
  };
}

export class FakeSubmissionUoW implements SubmissionUnitOfWork {
  constructor(public readonly store: SubmissionStore) {}

  async run<T>(fn: (repos: SubmissionRepos) => Promise<T>): Promise<T> {
    const snapshot = structuredClone(this.store);
    try {
      return await fn(makeSubmissionTestRepos(this.store));
    } catch (error) {
      Object.assign(this.store, structuredClone(snapshot));
      throw error;
    }
  }
}
