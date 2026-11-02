import { createHash, randomUUID } from 'node:crypto';
import type { Document } from '@prisma/client';
import type { ActorContext, AuditRecord } from '../organization/types.js';
import {
  OrgEntityNotFoundError,
  OrgValidationError,
  InvalidStatusTransitionError,
} from '../organization/errors.js';
import type { Authorizer } from '../department/service.js';
import type { ScopeTarget } from '../access-control/service.js';
import { scopeCovers } from '../access-control/service.js';
import type { ScopeChain } from '../access-control/repository.js';
import { departmentScopeTarget } from '../operation/service.js';
import { AccessDeniedError } from '../access-control/errors.js';
import {
  DocumentNotAvailableError,
  DocumentStorageError,
  DocumentTooLargeError,
  DocumentUnsupportedTypeError,
} from './errors.js';
import { sanitizeFileName } from './filename.js';
import { sniffContentType } from './sniff.js';
import type { DocumentStorage } from './storage.js';
import type { DocumentRepos, DocumentUnitOfWork } from './repository.js';
import type {
  DocumentScope,
  DownloadResult,
  DocumentListFilter,
  LinkTarget,
  ReconcileResult,
  UploadInput,
} from './types.js';

export const DOCUMENT_UPLOAD = 'DOCUMENT_UPLOAD';
export const DOCUMENT_READ = 'DOCUMENT_READ';
export const DOCUMENT_LINK = 'DOCUMENT_LINK';
export const DOCUMENT_UNLINK = 'DOCUMENT_UNLINK';
export const DOCUMENT_ARCHIVE = 'DOCUMENT_ARCHIVE';
export const DOCUMENT_REVIEW = 'DOCUMENT_REVIEW';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Boolean access check used by link-derived read authorization.
export interface DocumentAuthorizer extends Authorizer {
  hasPermission(actorId: string, permissionKey: string, target: ScopeTarget): Promise<boolean>;
}

function auditEntry(
  actor: ActorContext,
  base: Omit<AuditRecord, 'eventKey' | 'actorId' | 'actorType' | 'correlationId'>,
): AuditRecord {
  return {
    eventKey: randomUUID(),
    actorId: actor.actorId,
    actorType: actor.actorType,
    ...(actor.correlationId !== undefined ? { correlationId: actor.correlationId } : {}),
    ...base,
  };
}

function companyTarget(companyId: string): ScopeTarget {
  return { companyId, scopeType: 'COMPANY', scopeId: companyId };
}

/** The document's own captured scope — review/download authority attaches here. */
function docScopeTarget(d: {
  companyId: string;
  scopeType: string;
  headOfficeId: string | null;
  projectId: string | null;
  siteId: string | null;
}): ScopeTarget {
  const scopeId =
    d.scopeType === 'HEAD_OFFICE'
      ? d.headOfficeId
      : d.scopeType === 'PROJECT'
        ? d.projectId
        : d.scopeType === 'SITE'
          ? d.siteId
          : d.companyId;
  if (scopeId === null) throw new Error('DOCUMENT invariant violated: missing scope id');
  return { companyId: d.companyId, scopeType: d.scopeType as ScopeTarget['scopeType'], scopeId };
}

/**
 * Verifier for FormSubmissionService: a $documentId value is valid iff the
 * document is AVAILABLE and actively linked to this exact submission+field.
 */
export function makeSubmissionDocVerifier() {
  return async (
    repos: {
      documentRows: {
        findById(c: string, id: string): Promise<{ id: string; status: string } | null>;
      };
      documentLinkRows: {
        findActiveForSubmissionField(
          c: string,
          d: string,
          s: string,
          f: string,
        ): Promise<{ id: string } | null>;
      };
    },
    companyId: string,
    submissionId: string,
    fieldKey: string,
    documentId: string,
  ): Promise<boolean> => {
    const doc = await repos.documentRows.findById(companyId, documentId);
    if (doc?.status !== 'AVAILABLE') return false;
    const link = await repos.documentLinkRows.findActiveForSubmissionField(
      companyId,
      documentId,
      submissionId,
      fieldKey,
    );
    return link !== null;
  };
}

export interface DocumentServiceDeps {
  uow: DocumentUnitOfWork;
  authorizer: DocumentAuthorizer;
  storage: DocumentStorage;
  maxBytes: number;
  staleUploadingMinutes: number;
  now?: () => Date;
}

export class DocumentService {
  private readonly now: () => Date;

  constructor(private readonly deps: DocumentServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Three-step lifecycle — DB and storage are NOT atomic:
   *   tx1: persist UPLOADING reservation (server-generated key)
   *   outside: validate bytes + write object
   *   tx2: mark QUARANTINED with server-verified metadata
   * Failure after reservation → REJECTED + best-effort object cleanup;
   * reconcile() sweeps stale UPLOADING rows and rejected objects.
   */
  async upload(actor: ActorContext, companyId: string, input: UploadInput): Promise<Document> {
    if (input.body.length > this.deps.maxBytes) {
      throw new DocumentTooLargeError(input.body.length, this.deps.maxBytes);
    }
    const fileName = sanitizeFileName(input.fileName);
    const storageKey = `c/${companyId}/${randomUUID()}`;
    const scope = input.scope ?? { scopeType: 'COMPANY' as const };

    const doc = await this.deps.uow.run(async (repos) => {
      // Validate + authorize AT the captured scope — not just company.
      const target = await this.validateUploadScope(repos, companyId, scope);
      await this.deps.authorizer.assertPermission(actor.actorId, DOCUMENT_UPLOAD, target);
      const d = await repos.documents.create({
        companyId,
        storageKey,
        originalFileName: fileName,
        ...(input.declaredContentType !== undefined
          ? { declaredContentType: input.declaredContentType }
          : {}),
        ...(actor.actorType === 'USER' ? { uploadedByPrincipalId: actor.actorId } : {}),
        scopeType: scope.scopeType,
        ...('headOfficeId' in scope ? { headOfficeId: scope.headOfficeId } : {}),
        ...('projectId' in scope ? { projectId: scope.projectId } : {}),
        ...('siteId' in scope ? { siteId: scope.siteId } : {}),
      });
      await repos.audit.record(
        auditEntry(actor, {
          action: 'DOCUMENT_UPLOAD_INITIATED',
          entityType: 'DOCUMENT',
          entityId: d.id,
          companyId,
          statusAfter: 'UPLOADING',
        }),
      );
      return d;
    });

    // Storage I/O + verification OUTSIDE any transaction.
    const sniffed = sniffContentType(input.body);
    if (sniffed === null) {
      const reason = 'unrecognized or disallowed content (allowed: PNG, JPEG, PDF)';
      await this.markRejected(actor, companyId, doc.id, `upload failed — ${reason}`);
      await this.deps.storage.delete(storageKey).catch(() => undefined);
      throw new DocumentUnsupportedTypeError(input.declaredContentType ?? null);
    }
    try {
      await this.deps.storage.put(storageKey, input.body);
    } catch (error) {
      const failure = error instanceof Error ? error.message : 'storage write failed';
      await this.markRejected(actor, companyId, doc.id, `upload failed — ${failure}`);
      await this.deps.storage.delete(storageKey).catch(() => undefined);
      throw new DocumentStorageError(failure);
    }
    const sha256 = createHash('sha256').update(input.body).digest('hex');
    return this.deps.uow.run(async (repos) => {
      const finalized = await repos.documents.setStatus(
        companyId,
        doc.id,
        {
          status: 'QUARANTINED',
          contentType: sniffed,
          sizeBytes: input.body.length,
          sha256,
        },
        doc.version,
      );
      await repos.audit.record(
        auditEntry(actor, {
          action: 'DOCUMENT_UPLOADED',
          entityType: 'DOCUMENT',
          entityId: doc.id,
          companyId,
          statusBefore: 'UPLOADING',
          statusAfter: 'QUARANTINED',
          changedFields: { sizeBytes: { before: null, after: input.body.length } },
        }),
      );
      return finalized;
    });
  }

  /** QUARANTINED → AVAILABLE — only through authorized review. */
  async approve(actor: ActorContext, companyId: string, documentId: string): Promise<Document> {
    return this.transition(actor, companyId, documentId, {
      permission: DOCUMENT_REVIEW,
      from: ['QUARANTINED'],
      to: 'AVAILABLE',
      action: 'DOCUMENT_APPROVED',
      verb: 'approve',
    });
  }

  /** QUARANTINED/AVAILABLE → REJECTED + best-effort object cleanup. */
  async reject(
    actor: ActorContext,
    companyId: string,
    documentId: string,
    reason: string,
  ): Promise<Document> {
    const doc = await this.transition(actor, companyId, documentId, {
      permission: DOCUMENT_REVIEW,
      from: ['QUARANTINED', 'AVAILABLE'],
      to: 'REJECTED',
      action: 'DOCUMENT_REJECTED',
      verb: 'reject',
      reason,
    });
    await this.deps.storage.delete(doc.storageKey).catch(() => undefined);
    return doc;
  }

  async archive(actor: ActorContext, companyId: string, documentId: string): Promise<Document> {
    return this.transition(actor, companyId, documentId, {
      permission: DOCUMENT_ARCHIVE,
      from: ['AVAILABLE'],
      to: 'ARCHIVED',
      action: 'DOCUMENT_ARCHIVED',
      verb: 'archive',
    });
  }

  private async markRejected(
    actor: ActorContext,
    companyId: string,
    documentId: string,
    reason: string,
  ): Promise<void> {
    await this.deps.uow.run(async (repos) => {
      const d = await repos.documents.findById(companyId, documentId);
      if (d === null) return;
      await repos.documents.setStatus(companyId, documentId, {
        status: 'REJECTED',
        rejectReason: reason,
      });
      await repos.audit.record(
        auditEntry(actor, {
          action: 'DOCUMENT_REJECTED',
          entityType: 'DOCUMENT',
          entityId: documentId,
          companyId,
          statusBefore: d.status,
          statusAfter: 'REJECTED',
          changedFields: { rejectReason: { before: null, after: reason } },
        }),
      );
    });
  }

  /**
   * Download: only AVAILABLE documents ever stream. Authorization — the
   * uploader, a REVIEW holder, or DOCUMENT_READ at the scope of ANY active
   * link's target. Audit records authorized stream initiation — it does NOT
   * prove the client finished downloading.
   */
  async getDownload(
    actor: ActorContext,
    companyId: string,
    documentId: string,
  ): Promise<DownloadResult> {
    const doc = await this.deps.uow.run(async (repos) => {
      const d = await repos.documents.findById(companyId, documentId);
      if (d === null) throw new OrgEntityNotFoundError('DOCUMENT');
      const links = await repos.documentLinks.listActiveForDocument(companyId, documentId);
      const scope = docScopeTarget(d);
      const authorized =
        (await this.deps.authorizer.hasPermission(actor.actorId, DOCUMENT_REVIEW, scope)) ||
        (await this.deps.authorizer.hasPermission(actor.actorId, DOCUMENT_READ, scope)) ||
        (await this.anyLinkScopeGrantsRead(repos, actor, companyId, links));
      if (!authorized) {
        throw new AccessDeniedError(`${DOCUMENT_READ} required at linked document scope`);
      }
      await repos.audit.record(
        auditEntry(actor, {
          action: 'DOCUMENT_DOWNLOADED',
          entityType: 'DOCUMENT',
          entityId: documentId,
          companyId,
          statusBefore: d.status,
          statusAfter: d.status,
        }),
      );
      return d;
    });
    if (doc.status !== 'AVAILABLE') throw new DocumentNotAvailableError(doc.status);
    const stream = await this.deps.storage.getStream(doc.storageKey);
    return {
      document: doc,
      contentType: doc.contentType ?? 'application/octet-stream',
      fileName: doc.originalFileName,
      stream,
    };
  }

  /**
   * Quarantine review-access path — distinct from download. Only DOCUMENT_REVIEW
   * at the document's own scope may stream a QUARANTINED file, as an attachment
   * only (callers must set attachment disposition + nosniff; never public/inline).
   */
  async getReviewStream(
    actor: ActorContext,
    companyId: string,
    documentId: string,
  ): Promise<DownloadResult> {
    const doc = await this.deps.uow.run(async (repos) => {
      const d = await repos.documents.findById(companyId, documentId);
      if (d === null) throw new OrgEntityNotFoundError('DOCUMENT');
      await this.deps.authorizer.assertPermission(
        actor.actorId,
        DOCUMENT_REVIEW,
        docScopeTarget(d),
      );
      if (d.status !== 'QUARANTINED') {
        throw new DocumentNotAvailableError(d.status);
      }
      await repos.audit.record(
        auditEntry(actor, {
          action: 'DOCUMENT_REVIEW_ACCESSED',
          entityType: 'DOCUMENT',
          entityId: documentId,
          companyId,
          statusBefore: d.status,
          statusAfter: d.status,
        }),
      );
      return d;
    });
    const stream = await this.deps.storage.getStream(doc.storageKey);
    return {
      document: doc,
      contentType: doc.contentType ?? 'application/octet-stream',
      fileName: doc.originalFileName,
      stream,
    };
  }

  /** Link an AVAILABLE document to a submission/field or workflow instance. */
  async link(
    actor: ActorContext,
    companyId: string,
    documentId: string,
    target: LinkTarget,
  ): Promise<void> {
    if (!UUID_RE.test(documentId)) {
      throw new OrgValidationError('documentId', 'must be a UUID');
    }
    await this.deps.uow.run(async (repos) => {
      const doc = await repos.documents.findById(companyId, documentId);
      if (doc === null) throw new OrgEntityNotFoundError('DOCUMENT');
      if (doc.status !== 'AVAILABLE') throw new DocumentNotAvailableError(doc.status);

      const scope = await this.targetScope(repos, companyId, target);
      await this.deps.authorizer.assertPermission(actor.actorId, DOCUMENT_LINK, scope);
      // Containment: the target's ancestor chain must sit inside the
      // document's captured scope — a project/site file can't escape upward.
      const chain = await this.targetChain(repos, companyId, target);
      if (
        !scopeCovers(
          {
            scopeType: doc.scopeType,
            headOfficeId: doc.headOfficeId,
            projectId: doc.projectId,
            siteId: doc.siteId,
            companyId: doc.companyId,
          },
          chain,
        )
      ) {
        throw new OrgValidationError('target', 'link target is outside the document scope');
      }

      const dup = await repos.documentLinks.findActive(companyId, documentId, {
        ...(target.kind === 'FORM_SUBMISSION'
          ? { formSubmissionId: target.formSubmissionId, fieldKey: target.fieldKey }
          : { workflowInstanceId: target.workflowInstanceId }),
      });
      if (dup !== null) {
        throw new OrgValidationError('link', 'an active link already exists for this target');
      }
      const link = await repos.documentLinks.create({
        companyId,
        documentId,
        entityType: target.kind,
        ...(target.kind === 'FORM_SUBMISSION'
          ? { formSubmissionId: target.formSubmissionId, fieldKey: target.fieldKey }
          : { workflowInstanceId: target.workflowInstanceId }),
        ...(actor.actorType === 'USER' ? { linkedByPrincipalId: actor.actorId } : {}),
      });
      await repos.audit.record(
        auditEntry(actor, {
          action: 'DOCUMENT_LINKED',
          entityType: 'DOCUMENT_LINK',
          entityId: link.id,
          companyId,
          changedFields: {
            documentId: { before: null, after: documentId },
            target: { before: null, after: target.kind },
          },
        }),
      );
    });
  }

  async unlink(actor: ActorContext, companyId: string, linkId: string): Promise<void> {
    await this.deps.uow.run(async (repos) => {
      const link = await repos.documentLinks.findById(companyId, linkId);
      if (link === null) throw new OrgEntityNotFoundError('DOCUMENT_LINK');
      if (link.unlinkedAt !== null) {
        throw new InvalidStatusTransitionError('DOCUMENT_LINK', 'UNLINKED', 'unlink');
      }
      const scope = await this.linkScope(repos, companyId, link);
      await this.deps.authorizer.assertPermission(actor.actorId, DOCUMENT_UNLINK, scope);
      await repos.documentLinks.unlink(
        companyId,
        linkId,
        actor.actorType === 'USER' ? actor.actorId : undefined,
        this.now(),
      );
      await repos.audit.record(
        auditEntry(actor, {
          action: 'DOCUMENT_UNLINKED',
          entityType: 'DOCUMENT_LINK',
          entityId: linkId,
          companyId,
        }),
      );
    });
  }

  /**
   * Scoped reconciliation: stale UPLOADING rows are marked REJECTED and
   * objects deleted; REJECTED rows have objects removed. No storage-wide
   * listing — only known keys. No worker is wired; callers schedule this.
   */
  async reconcile(actor: ActorContext, companyId: string): Promise<ReconcileResult> {
    await this.deps.authorizer.assertPermission(
      actor.actorId,
      DOCUMENT_REVIEW,
      companyTarget(companyId),
    );
    const staleBefore = new Date(this.now().getTime() - this.deps.staleUploadingMinutes * 60_000);
    const result: ReconcileResult = { staleUploadingMarked: 0, rejectedObjectsDeleted: 0 };
    const stale = await this.deps.uow.run(async (repos) => {
      const rows = await repos.documents.listStaleUploading(companyId, staleBefore);
      for (const row of rows) {
        await repos.documents.setStatus(companyId, row.id, {
          status: 'REJECTED',
          rejectReason: 'stale upload — storage write never finalized',
        });
        await repos.audit.record(
          auditEntry(actor, {
            action: 'DOCUMENT_REJECTED',
            entityType: 'DOCUMENT',
            entityId: row.id,
            companyId,
            statusBefore: 'UPLOADING',
            statusAfter: 'REJECTED',
            changedFields: { rejectReason: { before: null, after: 'stale upload' } },
          }),
        );
      }
      return rows;
    });
    result.staleUploadingMarked = stale.length;
    const keysToDelete = stale.map((r) => r.storageKey);
    const rejected = await this.deps.uow.run((repos) => repos.documents.listRejected(companyId));
    keysToDelete.push(...rejected.map((r) => r.storageKey));
    for (const key of new Set(keysToDelete)) {
      const ok = await this.deps.storage
        .delete(key)
        .then(() => true)
        .catch(() => false);
      if (ok) result.rejectedObjectsDeleted += 1;
    }
    return result;
  }

  async listDocuments(actor: ActorContext, companyId: string, filter?: DocumentListFilter) {
    await this.deps.authorizer.assertPermission(
      actor.actorId,
      DOCUMENT_READ,
      companyTarget(companyId),
    );
    return this.deps.uow.run(({ documents }) => documents.list(companyId, filter));
  }

  // ----------------------------------------------------------------- internal

  private async transition(
    actor: ActorContext,
    companyId: string,
    documentId: string,
    cfg: {
      permission: string;
      from: string[];
      to: string;
      action: string;
      verb: string;
      reason?: string;
    },
  ): Promise<Document> {
    return this.deps.uow.run(async (repos) => {
      const d = await repos.documents.findById(companyId, documentId);
      if (d === null) throw new OrgEntityNotFoundError('DOCUMENT');
      await this.deps.authorizer.assertPermission(actor.actorId, cfg.permission, docScopeTarget(d));
      if (!cfg.from.includes(d.status)) {
        throw new InvalidStatusTransitionError('DOCUMENT', d.status, cfg.verb);
      }
      const updated = await repos.documents.setStatus(
        companyId,
        documentId,
        {
          status: cfg.to,
          ...(cfg.to === 'REJECTED' ? { rejectReason: cfg.reason ?? null } : {}),
          ...(cfg.to === 'AVAILABLE'
            ? { reviewedByPrincipalId: actor.actorType === 'USER' ? actor.actorId : undefined }
            : {}),
          ...(cfg.to === 'AVAILABLE' ? { reviewedAt: this.now() } : {}),
        },
        d.version,
      );
      await repos.audit.record(
        auditEntry(actor, {
          action: cfg.action,
          entityType: 'DOCUMENT',
          entityId: documentId,
          companyId,
          statusBefore: d.status,
          statusAfter: cfg.to,
          ...(cfg.reason !== undefined
            ? { changedFields: { rejectReason: { before: null, after: cfg.reason } } }
            : {}),
        }),
      );
      // Outbox — review outcomes notify the transaction-known uploader.
      if (cfg.action === 'DOCUMENT_APPROVED' || cfg.action === 'DOCUMENT_REJECTED') {
        await repos.outbox.record({
          companyId,
          eventType: cfg.action,
          aggregateType: 'DOCUMENT',
          aggregateId: documentId,
          eventKey: `evt:${documentId}:${cfg.action}`,
          recipientPrincipalIds: d.uploadedByPrincipalId !== null ? [d.uploadedByPrincipalId] : [],
          summary: { status: cfg.to, ...(cfg.reason !== undefined ? { reason: cfg.reason } : {}) },
        });
      }
      return updated;
    });
  }

  private async targetScope(
    repos: DocumentRepos,
    companyId: string,
    target: LinkTarget,
  ): Promise<ScopeTarget> {
    if (target.kind === 'FORM_SUBMISSION') {
      const sub = await repos.submissionWrites.findById(companyId, target.formSubmissionId);
      if (sub === null) throw new OrgEntityNotFoundError('FORM_SUBMISSION');
      if (target.fieldKey !== undefined) {
        await this.assertFileField(repos, companyId, sub.formVersionId, target.fieldKey);
      }
      return this.operationScope(repos, companyId, sub.operationId);
    }
    const inst = await repos.instances.findById(companyId, target.workflowInstanceId);
    if (inst === null) throw new OrgEntityNotFoundError('WORKFLOW_INSTANCE');
    return this.operationScope(repos, companyId, inst.operationId);
  }

  // FILE-family fields a document may back — SIGNATURE/QR stay unsupported.
  private async assertFileField(
    repos: DocumentRepos,
    companyId: string,
    formVersionId: string,
    fieldKey: string,
  ): Promise<void> {
    const fv = await repos.formVersionRows.findById(companyId, formVersionId);
    if (fv === null) throw new OrgEntityNotFoundError('FORM_VERSION');
    const fields = (fv.schema as { fields?: { key: string; type: string }[] }).fields ?? [];
    const field = fields.find((f) => f.key === fieldKey);
    if (field === undefined) {
      throw new OrgValidationError('fieldKey', 'not declared on the pinned form version');
    }
    if (field.type !== 'FILE' && field.type !== 'IMAGE') {
      throw new OrgValidationError(
        'fieldKey',
        `field type ${field.type} cannot reference documents`,
      );
    }
  }

  /** Validate the caller-supplied upload scope and resolve its ScopeTarget. */
  private async validateUploadScope(
    repos: DocumentRepos,
    companyId: string,
    scope: DocumentScope,
  ): Promise<ScopeTarget> {
    switch (scope.scopeType) {
      case 'COMPANY':
        return companyTarget(companyId);
      case 'HEAD_OFFICE': {
        if ((await repos.scopeRows.headOfficeById(companyId, scope.headOfficeId)) === null) {
          throw new OrgEntityNotFoundError('HEAD_OFFICE');
        }
        return { companyId, scopeType: 'HEAD_OFFICE', scopeId: scope.headOfficeId };
      }
      case 'PROJECT': {
        if ((await repos.scopeRows.projectById(companyId, scope.projectId)) === null) {
          throw new OrgEntityNotFoundError('PROJECT');
        }
        return { companyId, scopeType: 'PROJECT', scopeId: scope.projectId };
      }
      case 'SITE': {
        if ((await repos.scopeRows.siteById(companyId, scope.siteId)) === null) {
          throw new OrgEntityNotFoundError('SITE');
        }
        return { companyId, scopeType: 'SITE', scopeId: scope.siteId };
      }
    }
  }

  /** Full ancestor chain of a link target for scope-containment checks. */
  private async targetChain(
    repos: DocumentRepos,
    companyId: string,
    target: LinkTarget,
  ): Promise<ScopeChain> {
    const operationId =
      target.kind === 'FORM_SUBMISSION'
        ? await this.submissionOperationId(repos, companyId, target.formSubmissionId)
        : await this.instanceOperationId(repos, companyId, target.workflowInstanceId);
    const operation = await repos.operations.findById(companyId, operationId);
    if (!operation) throw new OrgEntityNotFoundError('OPERATION');
    const department = await repos.departments.findById(companyId, operation.departmentId);
    if (!department) throw new OrgEntityNotFoundError('DEPARTMENT');
    const chain: ScopeChain = { companyId };
    if (department.scopeType === 'SITE' && department.siteId !== null) {
      chain.siteId = department.siteId;
      const site = await repos.scopeRows.siteById(companyId, department.siteId);
      if (site !== null) {
        chain.projectId = site.projectId;
        const project = await repos.scopeRows.projectById(companyId, site.projectId);
        if (project !== null) chain.headOfficeId = project.headOfficeId;
      }
    } else if (department.scopeType === 'PROJECT' && department.projectId !== null) {
      chain.projectId = department.projectId;
      const project = await repos.scopeRows.projectById(companyId, department.projectId);
      if (project !== null) chain.headOfficeId = project.headOfficeId;
    }
    return chain;
  }

  private async submissionOperationId(
    repos: DocumentRepos,
    companyId: string,
    submissionId: string,
  ): Promise<string> {
    const sub = await repos.submissionWrites.findById(companyId, submissionId);
    if (sub === null) throw new OrgEntityNotFoundError('FORM_SUBMISSION');
    return sub.operationId;
  }

  private async instanceOperationId(
    repos: DocumentRepos,
    companyId: string,
    instanceId: string,
  ): Promise<string> {
    const inst = await repos.instances.findById(companyId, instanceId);
    if (inst === null) throw new OrgEntityNotFoundError('WORKFLOW_INSTANCE');
    return inst.operationId;
  }

  private async operationScope(
    repos: DocumentRepos,
    companyId: string,
    operationId: string,
  ): Promise<ScopeTarget> {
    const operation = await repos.operations.findById(companyId, operationId);
    if (!operation) throw new OrgEntityNotFoundError('OPERATION');
    const department = await repos.departments.findById(companyId, operation.departmentId);
    if (!department) throw new OrgEntityNotFoundError('DEPARTMENT');
    return departmentScopeTarget(department);
  }

  private async anyLinkScopeGrantsRead(
    repos: DocumentRepos,
    actor: ActorContext,
    companyId: string,
    links: { formSubmissionId: string | null; workflowInstanceId: string | null }[],
  ): Promise<boolean> {
    for (const link of links) {
      const operationId = await this.linkOperationId(repos, companyId, link);
      if (operationId === null) continue;
      const target = await this.operationScope(repos, companyId, operationId);
      if (await this.deps.authorizer.hasPermission(actor.actorId, DOCUMENT_READ, target)) {
        return true;
      }
    }
    return false;
  }

  private async linkOperationId(
    repos: DocumentRepos,
    companyId: string,
    link: { formSubmissionId: string | null; workflowInstanceId: string | null },
  ): Promise<string | null> {
    if (link.formSubmissionId !== null) {
      const sub = await repos.submissionWrites.findById(companyId, link.formSubmissionId);
      return sub?.operationId ?? null;
    }
    if (link.workflowInstanceId !== null) {
      const inst = await repos.instances.findById(companyId, link.workflowInstanceId);
      return inst?.operationId ?? null;
    }
    return null;
  }

  private async linkScope(
    repos: DocumentRepos,
    companyId: string,
    link: { formSubmissionId: string | null; workflowInstanceId: string | null },
  ): Promise<ScopeTarget> {
    const operationId = await this.linkOperationId(repos, companyId, link);
    if (operationId === null) return companyTarget(companyId);
    return this.operationScope(repos, companyId, operationId);
  }
}
