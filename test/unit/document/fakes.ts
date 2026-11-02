import { Readable } from 'node:stream';
import type { Document, DocumentLink } from '@prisma/client';
import type { DocumentStorage } from '../../../src/modules/document/storage.js';
import type {
  DocumentRepos,
  DocumentUnitOfWork,
} from '../../../src/modules/document/repository.js';
import type { DocumentListFilter } from '../../../src/modules/document/types.js';
import {
  DuplicateCodeError,
  VersionConflictError,
} from '../../../src/modules/organization/errors.js';
import { emptySubmissionStore, makeSubmissionTestRepos } from '../form-submission/fakes.js';
import type { SubmissionStore } from '../form-submission/fakes.js';

export interface DocumentStore extends SubmissionStore {
  headOfficeRows: { id: string; companyId: string }[];
  projectRows: { id: string; companyId: string; headOfficeId: string }[];
  siteRows: { id: string; companyId: string; projectId: string }[];
}

export function emptyDocumentStore(): DocumentStore {
  return {
    ...emptySubmissionStore(),
    headOfficeRows: [],
    projectRows: [],
    siteRows: [],
  };
}

let nextId = 0;
const genId = () => `00000000-0000-4000-8000-${String(++nextId).padStart(12, '0')}`;

export function fakeDocument(over: Partial<Document> = {}): Document {
  return {
    id: genId(),
    companyId: 'c1',
    storageKey: `c/c1/${genId()}`,
    originalFileName: 'photo.png',
    declaredContentType: null,
    contentType: 'image/png',
    sizeBytes: 10,
    sha256: 'a'.repeat(64),
    status: 'QUARANTINED',
    rejectReason: null,
    uploadedByPrincipalId: 'principal-1',
    uploadedAt: new Date(),
    reviewedByPrincipalId: null,
    reviewedAt: null,
    scopeType: 'COMPANY',
    headOfficeId: null,
    projectId: null,
    siteId: null,
    version: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

export function fakeLink(over: Partial<DocumentLink> = {}): DocumentLink {
  return {
    id: genId(),
    companyId: 'c1',
    documentId: 'doc-1',
    entityType: 'FORM_SUBMISSION',
    formSubmissionId: null,
    workflowInstanceId: null,
    fieldKey: null,
    linkedByPrincipalId: 'principal-1',
    linkedAt: new Date(),
    unlinkedAt: null,
    unlinkedByPrincipalId: null,
    version: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

/** In-memory storage adapter — optionally failing for failure-path tests. */
export class FakeStorage implements DocumentStorage {
  objects = new Map<string, Buffer>();
  failPut: string | null = null;

  async put(key: string, body: Buffer): Promise<void> {
    if (this.failPut !== null) throw new Error(this.failPut);
    this.objects.set(key, body);
  }

  async getStream(key: string): Promise<Readable> {
    const buf = this.objects.get(key);
    if (buf === undefined) throw new Error('object missing');
    return Readable.from([buf]);
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

export function makeDocumentTestRepos(store: DocumentStore): DocumentRepos {
  return {
    ...makeSubmissionTestRepos(store),
    documents: {
      create: async (data) => {
        const d: Document = {
          id: genId(),
          companyId: data.companyId,
          storageKey: data.storageKey,
          originalFileName: data.originalFileName,
          declaredContentType: data.declaredContentType ?? null,
          contentType: null,
          sizeBytes: null,
          sha256: null,
          status: 'UPLOADING',
          rejectReason: null,
          uploadedByPrincipalId: data.uploadedByPrincipalId ?? null,
          uploadedAt: new Date(),
          reviewedByPrincipalId: null,
          reviewedAt: null,
          scopeType: (data.scopeType ?? 'COMPANY') as Document['scopeType'],
          headOfficeId: data.headOfficeId ?? null,
          projectId: data.projectId ?? null,
          siteId: data.siteId ?? null,
          version: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        store.documents.push(d);
        return { ...d };
      },
      findById: async (companyId, id) => {
        const row = store.documents.find((d) => d.id === id && d.companyId === companyId);
        return row ? { ...row } : null;
      },
      list: async (companyId, filter?: DocumentListFilter) =>
        store.documents.filter(
          (d) =>
            d.companyId === companyId &&
            (filter?.status === undefined || d.status === filter.status) &&
            (filter?.uploadedByPrincipalId === undefined ||
              d.uploadedByPrincipalId === filter.uploadedByPrincipalId),
        ),
      setStatus: async (companyId, id, data, expectedVersion) => {
        const row = store.documents.find((d) => d.id === id && d.companyId === companyId);
        if (!row) throw new VersionConflictError('DOCUMENT');
        if (expectedVersion !== undefined && row.version !== expectedVersion) {
          throw new VersionConflictError('DOCUMENT');
        }
        Object.assign(row, {
          status: data.status,
          ...(data.contentType !== undefined ? { contentType: data.contentType } : {}),
          ...(data.sizeBytes !== undefined ? { sizeBytes: data.sizeBytes } : {}),
          ...(data.sha256 !== undefined ? { sha256: data.sha256 } : {}),
          ...(data.rejectReason !== undefined ? { rejectReason: data.rejectReason } : {}),
          ...(data.reviewedByPrincipalId !== undefined
            ? { reviewedByPrincipalId: data.reviewedByPrincipalId }
            : {}),
          ...(data.reviewedAt !== undefined ? { reviewedAt: data.reviewedAt } : {}),
          version: row.version + 1,
        });
        return { ...row };
      },
      listStaleUploading: async (companyId, olderThan) =>
        store.documents.filter(
          (d) => d.companyId === companyId && d.status === 'UPLOADING' && d.uploadedAt < olderThan,
        ),
      listRejected: async (companyId) =>
        store.documents.filter((d) => d.companyId === companyId && d.status === 'REJECTED'),
    },
    documentLinks: {
      create: async (data) => {
        // Partial-unique simulation: one active link per doc+target+field.
        const active = store.documentLinks.find(
          (l) =>
            l.companyId === data.companyId &&
            l.documentId === data.documentId &&
            l.unlinkedAt === null &&
            (data.formSubmissionId !== undefined
              ? l.formSubmissionId === data.formSubmissionId &&
                (l.fieldKey ?? '') === (data.fieldKey ?? '')
              : l.workflowInstanceId === data.workflowInstanceId),
        );
        if (active !== undefined) throw new DuplicateCodeError('DOCUMENT_LINK');
        const l: DocumentLink = {
          id: genId(),
          companyId: data.companyId,
          documentId: data.documentId,
          entityType: data.entityType,
          formSubmissionId: data.formSubmissionId ?? null,
          workflowInstanceId: data.workflowInstanceId ?? null,
          fieldKey: data.fieldKey ?? null,
          linkedByPrincipalId: data.linkedByPrincipalId ?? null,
          linkedAt: new Date(),
          unlinkedAt: null,
          unlinkedByPrincipalId: null,
          version: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        store.documentLinks.push(l);
        return { ...l };
      },
      findActiveForDocument: async (companyId, documentId) =>
        store.documentLinks.filter(
          (l) => l.companyId === companyId && l.documentId === documentId && l.unlinkedAt === null,
        ),
      findActiveForSubmissionField: async (companyId, documentId, formSubmissionId, fieldKey) =>
        store.documentLinks.find(
          (l) =>
            l.companyId === companyId &&
            l.documentId === documentId &&
            l.formSubmissionId === formSubmissionId &&
            l.fieldKey === fieldKey &&
            l.unlinkedAt === null,
        ) ?? null,
      findActive: async (companyId, documentId, target) =>
        store.documentLinks.find(
          (l) =>
            l.companyId === companyId &&
            l.documentId === documentId &&
            l.unlinkedAt === null &&
            (target.formSubmissionId !== undefined
              ? l.formSubmissionId === target.formSubmissionId &&
                (l.fieldKey ?? null) === (target.fieldKey ?? null)
              : l.workflowInstanceId === target.workflowInstanceId),
        ) ?? null,
      listActiveForDocument: async (companyId, documentId) =>
        store.documentLinks.filter(
          (l) => l.companyId === companyId && l.documentId === documentId && l.unlinkedAt === null,
        ),
      findById: async (companyId, id) =>
        store.documentLinks.find((l) => l.id === id && l.companyId === companyId) ?? null,
      unlink: async (companyId, id, unlinkedByPrincipalId, at, expectedVersion) => {
        const row = store.documentLinks.find((l) => l.id === id && l.companyId === companyId);
        if (!row) throw new VersionConflictError('DOCUMENT_LINK');
        if (expectedVersion !== undefined && row.version !== expectedVersion) {
          throw new VersionConflictError('DOCUMENT_LINK');
        }
        row.unlinkedAt = at;
        row.unlinkedByPrincipalId = unlinkedByPrincipalId ?? null;
        row.version += 1;
        return { ...row };
      },
    },
    scopeRows: {
      headOfficeById: async (companyId, id) =>
        store.headOfficeRows.find((r) => r.id === id && r.companyId === companyId) ?? null,
      projectById: async (companyId, id) =>
        store.projectRows.find((r) => r.id === id && r.companyId === companyId) ?? null,
      siteById: async (companyId, id) =>
        store.siteRows.find((r) => r.id === id && r.companyId === companyId) ?? null,
    },
  };
}

export class FakeDocumentUoW implements DocumentUnitOfWork {
  constructor(public readonly store: DocumentStore) {}

  async run<T>(fn: (repos: DocumentRepos) => Promise<T>): Promise<T> {
    const snapshot = structuredClone(this.store);
    try {
      return await fn(makeDocumentTestRepos(this.store));
    } catch (error) {
      Object.assign(this.store, structuredClone(snapshot));
      throw error;
    }
  }
}
