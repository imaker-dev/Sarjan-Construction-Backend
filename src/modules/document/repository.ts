import type { Document, DocumentLink, Prisma, PrismaClient } from '@prisma/client';
import { mapOrgWriteError } from '../organization/errors.js';
import { scopedUpdate } from '../organization/repository.js';
import { makeSubmissionRepos } from '../form-submission/repository.js';
import type { SubmissionRepos } from '../form-submission/repository.js';
import type { DocumentListFilter } from './types.js';

type Tx = Prisma.TransactionClient;

export interface DocumentRepository {
  create(data: {
    companyId: string;
    storageKey: string;
    originalFileName: string;
    declaredContentType?: string;
    uploadedByPrincipalId?: string;
    scopeType?: string;
    headOfficeId?: string;
    projectId?: string;
    siteId?: string;
  }): Promise<Document>;
  findById(companyId: string, id: string): Promise<Document | null>;
  list(companyId: string, filter?: DocumentListFilter): Promise<Document[]>;
  setStatus(
    companyId: string,
    id: string,
    data: {
      status: string;
      contentType?: string;
      sizeBytes?: number;
      sha256?: string;
      rejectReason?: string | null;
      reviewedByPrincipalId?: string | undefined;
      reviewedAt?: Date | undefined;
    },
    expectedVersion?: number,
  ): Promise<Document>;
  listStaleUploading(companyId: string, olderThan: Date): Promise<Document[]>;
  listRejected(companyId: string): Promise<Document[]>;
}

export interface DocumentLinkRepository {
  create(data: {
    companyId: string;
    documentId: string;
    entityType: string;
    formSubmissionId?: string | undefined;
    workflowInstanceId?: string | undefined;
    fieldKey?: string | undefined;
    linkedByPrincipalId?: string | undefined;
  }): Promise<DocumentLink>;
  findActiveForDocument(companyId: string, documentId: string): Promise<DocumentLink[]>;
  findActiveForSubmissionField(
    companyId: string,
    documentId: string,
    formSubmissionId: string,
    fieldKey: string,
  ): Promise<DocumentLink | null>;
  findActive(
    companyId: string,
    documentId: string,
    target: {
      formSubmissionId?: string | undefined;
      workflowInstanceId?: string | undefined;
      fieldKey?: string | undefined;
    },
  ): Promise<DocumentLink | null>;
  listActiveForDocument(companyId: string, documentId: string): Promise<DocumentLink[]>;
  findById(companyId: string, id: string): Promise<DocumentLink | null>;
  unlink(
    companyId: string,
    id: string,
    unlinkedByPrincipalId: string | undefined,
    at: Date,
    expectedVersion?: number,
  ): Promise<DocumentLink>;
}

export interface DocumentRepos extends SubmissionRepos {
  documents: DocumentRepository;
  documentLinks: DocumentLinkRepository;
  // Scoped-target lookups for upload-scope validation and link containment.
  scopeRows: {
    headOfficeById(
      companyId: string,
      id: string,
    ): Promise<{ id: string; companyId: string } | null>;
    projectById(
      companyId: string,
      id: string,
    ): Promise<{ id: string; companyId: string; headOfficeId: string } | null>;
    siteById(
      companyId: string,
      id: string,
    ): Promise<{ id: string; companyId: string; projectId: string } | null>;
  };
}

export function makeDocumentRepos(tx: Tx): DocumentRepos {
  return {
    ...makeSubmissionRepos(tx),
    documents: {
      create: async (data) => {
        try {
          return await tx.document.create({
            data: {
              companyId: data.companyId,
              storageKey: data.storageKey,
              originalFileName: data.originalFileName,
              ...(data.declaredContentType !== undefined
                ? { declaredContentType: data.declaredContentType }
                : {}),
              ...(data.uploadedByPrincipalId !== undefined
                ? { uploadedByPrincipalId: data.uploadedByPrincipalId }
                : {}),
              ...(data.scopeType !== undefined ? { scopeType: data.scopeType as never } : {}),
              ...(data.headOfficeId !== undefined ? { headOfficeId: data.headOfficeId } : {}),
              ...(data.projectId !== undefined ? { projectId: data.projectId } : {}),
              ...(data.siteId !== undefined ? { siteId: data.siteId } : {}),
            },
          });
        } catch (error) {
          mapOrgWriteError(error, 'DOCUMENT');
        }
      },
      findById: (companyId, id) => tx.document.findFirst({ where: { id, companyId } }),
      list: (companyId, filter) =>
        tx.document.findMany({
          where: {
            companyId,
            ...(filter?.status ? { status: filter.status as never } : {}),
            ...(filter?.uploadedByPrincipalId
              ? { uploadedByPrincipalId: filter.uploadedByPrincipalId }
              : {}),
          },
          orderBy: { uploadedAt: 'desc' },
        }),
      setStatus: (companyId, id, data, expectedVersion) =>
        scopedUpdate<Document>(
          'DOCUMENT',
          { id, companyId },
          {
            status: data.status,
            ...(data.contentType !== undefined ? { contentType: data.contentType } : {}),
            ...(data.sizeBytes !== undefined ? { sizeBytes: data.sizeBytes } : {}),
            ...(data.sha256 !== undefined ? { sha256: data.sha256 } : {}),
            ...(data.rejectReason !== undefined ? { rejectReason: data.rejectReason } : {}),
            ...(data.reviewedByPrincipalId !== undefined
              ? { reviewedByPrincipalId: data.reviewedByPrincipalId }
              : {}),
            ...(data.reviewedAt !== undefined ? { reviewedAt: data.reviewedAt } : {}),
          },
          expectedVersion,
          (args) => tx.document.updateMany(args),
          () => tx.document.findFirst({ where: { id, companyId } }),
        ),
      listStaleUploading: (companyId, olderThan) =>
        tx.document.findMany({
          where: { companyId, status: 'UPLOADING', uploadedAt: { lt: olderThan } },
        }),
      listRejected: (companyId) =>
        tx.document.findMany({ where: { companyId, status: 'REJECTED' } }),
    },
    documentLinks: {
      create: async (data) => {
        try {
          return await tx.documentLink.create({
            data: {
              companyId: data.companyId,
              documentId: data.documentId,
              entityType: data.entityType,
              ...(data.formSubmissionId !== undefined
                ? { formSubmissionId: data.formSubmissionId }
                : {}),
              ...(data.workflowInstanceId !== undefined
                ? { workflowInstanceId: data.workflowInstanceId }
                : {}),
              ...(data.fieldKey !== undefined ? { fieldKey: data.fieldKey } : {}),
              ...(data.linkedByPrincipalId !== undefined
                ? { linkedByPrincipalId: data.linkedByPrincipalId }
                : {}),
            },
          });
        } catch (error) {
          mapOrgWriteError(error, 'DOCUMENT_LINK');
        }
      },
      findActiveForDocument: (companyId, documentId) =>
        tx.documentLink.findMany({ where: { companyId, documentId, unlinkedAt: null } }),
      findActiveForSubmissionField: (companyId, documentId, formSubmissionId, fieldKey) =>
        tx.documentLink.findFirst({
          where: { companyId, documentId, formSubmissionId, fieldKey, unlinkedAt: null },
        }),
      findActive: (companyId, documentId, target) =>
        tx.documentLink.findFirst({
          where: {
            companyId,
            documentId,
            unlinkedAt: null,
            ...(target.formSubmissionId !== undefined
              ? { formSubmissionId: target.formSubmissionId, fieldKey: target.fieldKey ?? null }
              : { workflowInstanceId: target.workflowInstanceId ?? '' }),
          },
        }),
      listActiveForDocument: (companyId, documentId) =>
        tx.documentLink.findMany({ where: { companyId, documentId, unlinkedAt: null } }),
      findById: (companyId, id) => tx.documentLink.findFirst({ where: { id, companyId } }),
      unlink: (companyId, id, unlinkedByPrincipalId, at, expectedVersion) =>
        scopedUpdate<DocumentLink>(
          'DOCUMENT_LINK',
          { id, companyId },
          {
            unlinkedAt: at,
            ...(unlinkedByPrincipalId !== undefined ? { unlinkedByPrincipalId } : {}),
          },
          expectedVersion,
          (args) => tx.documentLink.updateMany(args),
          () => tx.documentLink.findFirst({ where: { id, companyId } }),
        ),
    },
    scopeRows: {
      headOfficeById: async (companyId, id) => {
        const row = await tx.headOffice.findFirst({
          where: { id, companyId },
          select: { id: true, companyId: true },
        });
        return row === null ? null : { id: row.id, companyId: row.companyId };
      },
      projectById: async (companyId, id) => {
        const row = await tx.project.findFirst({
          where: { id, companyId },
          select: { id: true, companyId: true, headOfficeId: true },
        });
        return row === null
          ? null
          : { id: row.id, companyId: row.companyId, headOfficeId: row.headOfficeId };
      },
      siteById: async (companyId, id) => {
        const row = await tx.site.findFirst({
          where: { id, companyId },
          select: { id: true, companyId: true, projectId: true },
        });
        return row === null
          ? null
          : { id: row.id, companyId: row.companyId, projectId: row.projectId };
      },
    },
  };
}

export interface DocumentUnitOfWork {
  run<T>(fn: (repos: DocumentRepos) => Promise<T>): Promise<T>;
}

export class PrismaDocumentUnitOfWork implements DocumentUnitOfWork {
  constructor(private readonly prisma: PrismaClient) {}
  run<T>(fn: (repos: DocumentRepos) => Promise<T>): Promise<T> {
    return this.prisma.$transaction((tx) => fn(makeDocumentRepos(tx)));
  }
}
