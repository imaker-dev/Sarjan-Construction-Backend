import type { Document, DocumentLink } from '@prisma/client';
import type { Readable } from 'node:stream';

/** Upload scope — exactly the matching id per type; captured immutably at upload. */
export type DocumentScope =
  | { scopeType: 'COMPANY' }
  | { scopeType: 'HEAD_OFFICE'; headOfficeId: string }
  | { scopeType: 'PROJECT'; projectId: string }
  | { scopeType: 'SITE'; siteId: string };

export interface UploadInput {
  fileName: string;
  /** Client claim — recorded for audit only, never trusted. */
  declaredContentType?: string;
  body: Buffer;
  scope?: DocumentScope;
}

export type LinkTarget =
  | { kind: 'FORM_SUBMISSION'; formSubmissionId: string; fieldKey?: string }
  | { kind: 'WORKFLOW_INSTANCE'; workflowInstanceId: string };

export interface DownloadResult {
  document: Document;
  contentType: string;
  /** Sanitized — safe for Content-Disposition. */
  fileName: string;
  stream: Readable;
}

export interface ReconcileResult {
  staleUploadingMarked: number;
  rejectedObjectsDeleted: number;
}

export interface DocumentListFilter {
  status?: string;
  uploadedByPrincipalId?: string;
}

export type { Document, DocumentLink };
