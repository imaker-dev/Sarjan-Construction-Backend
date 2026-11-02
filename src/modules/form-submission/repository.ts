import type {
  Form,
  FormSubmission,
  Prisma,
  PrismaClient,
  SubmissionRevision,
} from '@prisma/client';
import { mapOrgWriteError } from '../organization/errors.js';
import { scopedUpdate } from '../organization/repository.js';
import { makeWorkflowInstanceRepos } from '../workflow-instance/repository.js';
import type { WorkflowInstanceRepos } from '../workflow-instance/repository.js';
import type { SubmissionListFilter } from './types.js';

type Tx = Prisma.TransactionClient;

export interface SubmissionWriteRepository {
  create(data: {
    companyId: string;
    operationId: string;
    workflowInstanceId: string;
    formId: string;
    formVersionId: string;
    draftValues?: unknown;
  }): Promise<FormSubmission>;
  findById(companyId: string, id: string): Promise<FormSubmission | null>;
  list(companyId: string, filter?: SubmissionListFilter): Promise<FormSubmission[]>;
  saveDraft(
    companyId: string,
    id: string,
    draftValues: unknown,
    expectedVersion?: number,
  ): Promise<FormSubmission>;
  markSubmitted(
    companyId: string,
    id: string,
    data: {
      currentRevisionId: string;
      latestRevision: number;
      submittedByPrincipalId?: string;
      submittedAt: Date;
    },
    expectedVersion?: number,
  ): Promise<FormSubmission>;
}

// Append-only revision history: create/find/list only — no update or delete.
export interface SubmissionRevisionRepository {
  create(data: {
    companyId: string;
    submissionId: string;
    revision: number;
    values: unknown;
    submittedByPrincipalId?: string;
    idempotencyKey?: string;
    requestFingerprint?: string;
    eventKey: string;
  }): Promise<SubmissionRevision>;
  findByIdempotencyKey(
    companyId: string,
    submissionId: string,
    key: string,
  ): Promise<SubmissionRevision | null>;
  listBySubmission(companyId: string, submissionId: string): Promise<SubmissionRevision[]>;
}

export interface SubmissionRepos extends WorkflowInstanceRepos {
  submissionWrites: SubmissionWriteRepository;
  submissionRevisions: SubmissionRevisionRepository;
  forms: {
    findById(companyId: string, id: string): Promise<Form | null>;
  };
  formVersionRows: {
    findById(
      companyId: string,
      id: string,
    ): Promise<{ id: string; formId: string; schema: unknown } | null>;
  };
  // Read-only document lookups for FILE/IMAGE $documentId verification.
  documentRows: {
    findById(companyId: string, id: string): Promise<{ id: string; status: string } | null>;
  };
  documentLinkRows: {
    findActiveForSubmissionField(
      companyId: string,
      documentId: string,
      formSubmissionId: string,
      fieldKey: string,
    ): Promise<{ id: string } | null>;
  };
}

export function makeSubmissionRepos(tx: Tx): SubmissionRepos {
  return {
    ...makeWorkflowInstanceRepos(tx),
    submissionWrites: {
      create: async (data) => {
        try {
          return await tx.formSubmission.create({
            data: {
              companyId: data.companyId,
              operationId: data.operationId,
              workflowInstanceId: data.workflowInstanceId,
              formId: data.formId,
              formVersionId: data.formVersionId,
              ...(data.draftValues !== undefined
                ? { draftValues: data.draftValues as Prisma.InputJsonValue }
                : {}),
            },
          });
        } catch (error) {
          mapOrgWriteError(error, 'FORM_SUBMISSION');
        }
      },
      findById: (companyId, id) => tx.formSubmission.findFirst({ where: { id, companyId } }),
      list: (companyId, filter) =>
        tx.formSubmission.findMany({
          where: {
            companyId,
            ...(filter?.operationId ? { operationId: filter.operationId } : {}),
            ...(filter?.workflowInstanceId
              ? { workflowInstanceId: filter.workflowInstanceId }
              : {}),
            ...(filter?.status ? { status: filter.status as never } : {}),
          },
          orderBy: { id: 'asc' },
        }),
      saveDraft: (companyId, id, draftValues, expectedVersion) =>
        scopedUpdate<FormSubmission>(
          'FORM_SUBMISSION',
          { id, companyId },
          { draftValues: draftValues },
          expectedVersion,
          (args) => tx.formSubmission.updateMany(args),
          () => tx.formSubmission.findFirst({ where: { id, companyId } }),
        ),
      markSubmitted: (companyId, id, data, expectedVersion) =>
        scopedUpdate<FormSubmission>(
          'FORM_SUBMISSION',
          { id, companyId },
          {
            status: 'SUBMITTED',
            currentRevisionId: data.currentRevisionId,
            latestRevision: data.latestRevision,
            draftValues: null,
            returnedReason: null,
            submittedByPrincipalId: data.submittedByPrincipalId ?? null,
            submittedAt: data.submittedAt,
          },
          expectedVersion,
          (args) => tx.formSubmission.updateMany(args),
          () => tx.formSubmission.findFirst({ where: { id, companyId } }),
        ),
    },
    submissionRevisions: {
      create: async (data) => {
        try {
          return await tx.submissionRevision.create({
            data: {
              companyId: data.companyId,
              submissionId: data.submissionId,
              revision: data.revision,
              values: data.values as Prisma.InputJsonValue,
              ...(data.submittedByPrincipalId !== undefined
                ? { submittedByPrincipalId: data.submittedByPrincipalId }
                : {}),
              ...(data.idempotencyKey !== undefined ? { idempotencyKey: data.idempotencyKey } : {}),
              ...(data.requestFingerprint !== undefined
                ? { requestFingerprint: data.requestFingerprint }
                : {}),
              eventKey: data.eventKey,
            },
          });
        } catch (error) {
          mapOrgWriteError(error, 'SUBMISSION_REVISION');
        }
      },
      findByIdempotencyKey: (companyId, submissionId, key) =>
        tx.submissionRevision.findFirst({
          where: { companyId, submissionId, idempotencyKey: key },
        }),
      listBySubmission: (companyId, submissionId) =>
        tx.submissionRevision.findMany({
          where: { companyId, submissionId },
          orderBy: [{ revision: 'asc' }],
        }),
    },
    forms: {
      findById: (companyId, id) => tx.form.findFirst({ where: { id, companyId } }),
    },
    formVersionRows: {
      findById: async (companyId, id) => {
        const row = await tx.formVersion.findFirst({
          where: { id, companyId },
          select: { id: true, formId: true, schema: true },
        });
        return row === null ? null : { id: row.id, formId: row.formId, schema: row.schema };
      },
    },
    documentRows: {
      findById: async (companyId, id) => {
        const row = await tx.document.findFirst({
          where: { id, companyId },
          select: { id: true, status: true },
        });
        return row === null ? null : { id: row.id, status: row.status };
      },
    },
    documentLinkRows: {
      findActiveForSubmissionField: async (companyId, documentId, formSubmissionId, fieldKey) => {
        const row = await tx.documentLink.findFirst({
          where: { companyId, documentId, formSubmissionId, fieldKey, unlinkedAt: null },
          select: { id: true },
        });
        return row === null ? null : { id: row.id };
      },
    },
  };
}

export interface SubmissionUnitOfWork {
  run<T>(fn: (repos: SubmissionRepos) => Promise<T>): Promise<T>;
}

export class PrismaSubmissionUnitOfWork implements SubmissionUnitOfWork {
  constructor(private readonly prisma: PrismaClient) {}
  run<T>(fn: (repos: SubmissionRepos) => Promise<T>): Promise<T> {
    return this.prisma.$transaction((tx) => fn(makeSubmissionRepos(tx)));
  }
}
