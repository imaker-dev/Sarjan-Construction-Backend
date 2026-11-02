import type { FormSubmission, SubmissionRevision } from '@prisma/client';
import type { SubmissionRepos } from './repository.js';

/**
 * Verifies a $documentId field value inside the submission transaction:
 * the document must be AVAILABLE and actively linked to THIS submission+field.
 * Provided by the document module; absent → file-typed values stay rejected.
 */
export type SubmissionDocVerifier = (
  repos: SubmissionRepos,
  companyId: string,
  submissionId: string,
  fieldKey: string,
  documentId: string,
) => Promise<boolean>;

export interface CreateSubmissionInput {
  /** Required — standalone (unlinked) submissions are not supported in v1. */
  workflowInstanceId: string;
  /** Must be referenced by a step of the instance's pinned WorkflowVersion. */
  formVersionId: string;
  values?: Record<string, unknown>;
}

export interface SaveDraftInput {
  values: Record<string, unknown>;
  expectedVersion?: number;
}

export interface SubmitInput {
  /** Optional — defaults to the stored draft values. */
  values?: Record<string, unknown>;
  expectedVersion?: number;
  idempotencyKey?: string;
}

export interface SubmitResult {
  submission: FormSubmission;
  revision: SubmissionRevision;
  replayed: boolean;
}

export interface SubmissionListFilter {
  operationId?: string;
  workflowInstanceId?: string;
  status?: string;
}
