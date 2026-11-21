import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import type {
  EmployeeDocumentType,
  DocumentVerificationStatus,
  Prisma,
  PrismaClient,
} from '@prisma/client';
import type { ActorContext } from '../organization/types.js';
import { OrgEntityNotFoundError, OrgValidationError } from '../organization/errors.js';
import type { ScopeTarget } from '../access-control/service.js';
import type { DocumentService } from '../document/service.js';
import type {
  EmployeeDocumentRepository,
  EmployeeDocumentWithDetails,
  ListEmployeeDocumentsFilter,
} from './document-repository.js';

export const EMPLOYEE_READ = 'EMPLOYEE_READ';
export const EMPLOYEE_MANAGE = 'EMPLOYEE_MANAGE';

export interface Authorizer {
  assertPermission(principalId: string, permissionKey: string, target: ScopeTarget): Promise<void>;
}

export interface EmployeeDocumentServiceDeps {
  repo: EmployeeDocumentRepository;
  documentService: DocumentService;
  prisma: PrismaClient;
  authorizer: Authorizer;
}

export interface CreateEmployeeDocumentInput {
  documentType: EmployeeDocumentType;
  title: string;
  documentNumber?: string | undefined;
  issuingAuthority?: string | undefined;
  issueDate?: string | undefined;
  expiryDate?: string | undefined;
  metadata?: Prisma.InputJsonValue | undefined;
}

export interface AttachEmployeeDocumentInput extends CreateEmployeeDocumentInput {
  documentId: string;
}

export interface UpdateEmployeeDocumentInput {
  title?: string | undefined;
  documentNumber?: string | null | undefined;
  issuingAuthority?: string | null | undefined;
  issueDate?: string | null | undefined;
  expiryDate?: string | null | undefined;
  metadata?: Prisma.InputJsonValue | undefined;
  expectedVersion?: number | undefined;
}

export interface VerifyEmployeeDocumentInput {
  status: DocumentVerificationStatus;
  rejectionReason?: string | null | undefined;
  expectedVersion?: number | undefined;
}

const auditEntry = (
  actor: ActorContext,
  base: {
    action: string;
    entityType: string;
    entityId: string;
    companyId: string;
    statusBefore?: string | null | undefined;
    statusAfter?: string | null | undefined;
    metadata?: Prisma.InputJsonValue | undefined;
  },
): Prisma.AuditLogUncheckedCreateInput => ({
  eventKey: randomUUID(),
  actorId: actor.actorId,
  actorType: actor.actorType,
  companyId: base.companyId,
  action: base.action,
  entityType: base.entityType,
  entityId: base.entityId,
  statusBefore: base.statusBefore ?? null,
  statusAfter: base.statusAfter ?? null,
  ...(actor.correlationId ? { correlationId: actor.correlationId } : {}),
  ...(base.metadata !== undefined ? { metadata: base.metadata } : {}),
});

const companyTarget = (companyId: string): ScopeTarget => ({
  companyId,
  scopeType: 'COMPANY',
  scopeId: companyId,
});

export class EmployeeDocumentService {
  constructor(private readonly deps: EmployeeDocumentServiceDeps) {}

  private async assertEmployeeExists(companyId: string, employeeId: string) {
    const employee = await this.deps.prisma.employee.findFirst({
      where: { id: employeeId, companyId },
    });
    if (!employee) throw new OrgEntityNotFoundError('EMPLOYEE');
    return employee;
  }

  private async isSelf(actor: ActorContext, companyId: string, employeeId: string): Promise<boolean> {
    if (actor.actorType !== 'USER') return false;
    const callerEmp = await this.deps.prisma.employee.findFirst({
      where: { companyId, principalId: actor.actorId },
    });
    return callerEmp?.id === employeeId;
  }

  private async checkReadAccess(actor: ActorContext, companyId: string, employeeId: string): Promise<void> {
    const self = await this.isSelf(actor, companyId, employeeId);
    if (!self) {
      await this.deps.authorizer.assertPermission(actor.actorId, EMPLOYEE_READ, companyTarget(companyId));
    }
  }

  private async checkManageOrSelfAccess(actor: ActorContext, companyId: string, employeeId: string): Promise<void> {
    const self = await this.isSelf(actor, companyId, employeeId);
    if (!self) {
      await this.deps.authorizer.assertPermission(actor.actorId, EMPLOYEE_MANAGE, companyTarget(companyId));
    }
  }

  async getCallerEmployee(companyId: string, principalId: string) {
    return this.deps.prisma.employee.findFirst({
      where: { companyId, principalId },
    });
  }

  async uploadAndAttach(
    actor: ActorContext,
    companyId: string,
    employeeId: string,
    file: { body: Buffer; fileName: string; declaredContentType?: string },
    input: CreateEmployeeDocumentInput,
  ): Promise<EmployeeDocumentWithDetails> {
    await this.assertEmployeeExists(companyId, employeeId);
    await this.checkManageOrSelfAccess(actor, companyId, employeeId);

    if (!input.title || input.title.trim().length === 0) {
      throw new OrgValidationError('title', 'title is required');
    }

    // 1. Upload to Document engine (enforces size, sniffing, SHA256, storage write)
    const uploaded = await this.deps.documentService.upload(actor, companyId, {
      body: file.body,
      fileName: file.fileName,
      declaredContentType: file.declaredContentType,
      scope: { scopeType: 'COMPANY' },
      autoApprove: true,
    });

    // 2. Attach metadata to EmployeeDocument
    const doc = await this.deps.repo.create(companyId, {
      employeeId,
      documentId: uploaded.id,
      documentType: input.documentType,
      title: input.title.trim(),
      documentNumber: input.documentNumber?.trim() ?? null,
      issuingAuthority: input.issuingAuthority?.trim() ?? null,
      issueDate: input.issueDate ? new Date(input.issueDate) : null,
      expiryDate: input.expiryDate ? new Date(input.expiryDate) : null,
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    });

    // 3. Audit trail
    await this.deps.prisma.auditLog.create({
      data: auditEntry(actor, {
        action: 'EMPLOYEE_DOCUMENT_UPLOADED',
        entityType: 'EMPLOYEE_DOCUMENT',
        entityId: doc.id,
        companyId,
        statusAfter: doc.verificationStatus,
      }),
    });

    return doc;
  }

  async attachExisting(
    actor: ActorContext,
    companyId: string,
    employeeId: string,
    input: AttachEmployeeDocumentInput,
  ): Promise<EmployeeDocumentWithDetails> {
    await this.assertEmployeeExists(companyId, employeeId);
    await this.checkManageOrSelfAccess(actor, companyId, employeeId);

    if (!input.title || input.title.trim().length === 0) {
      throw new OrgValidationError('title', 'title is required');
    }

    const availableDoc = await this.deps.prisma.document.findFirst({
      where: { id: input.documentId, companyId, status: 'AVAILABLE' },
    });
    if (!availableDoc) {
      throw new OrgValidationError('documentId', 'not an available company document');
    }

    const doc = await this.deps.repo.create(companyId, {
      employeeId,
      documentId: input.documentId,
      documentType: input.documentType,
      title: input.title.trim(),
      documentNumber: input.documentNumber?.trim() ?? null,
      issuingAuthority: input.issuingAuthority?.trim() ?? null,
      issueDate: input.issueDate ? new Date(input.issueDate) : null,
      expiryDate: input.expiryDate ? new Date(input.expiryDate) : null,
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    });

    await this.deps.prisma.auditLog.create({
      data: auditEntry(actor, {
        action: 'EMPLOYEE_DOCUMENT_ATTACHED',
        entityType: 'EMPLOYEE_DOCUMENT',
        entityId: doc.id,
        companyId,
        statusAfter: doc.verificationStatus,
      }),
    });

    return doc;
  }

  async listDocuments(
    actor: ActorContext,
    companyId: string,
    employeeId: string,
    filter?: Omit<ListEmployeeDocumentsFilter, 'employeeId'>,
  ): Promise<EmployeeDocumentWithDetails[]> {
    await this.assertEmployeeExists(companyId, employeeId);
    await this.checkReadAccess(actor, companyId, employeeId);

    return this.deps.repo.list(companyId, {
      employeeId,
      ...(filter?.documentType !== undefined ? { documentType: filter.documentType } : {}),
      ...(filter?.verificationStatus !== undefined
        ? { verificationStatus: filter.verificationStatus }
        : {}),
    });
  }

  async getDocument(
    actor: ActorContext,
    companyId: string,
    employeeId: string,
    documentId: string,
  ): Promise<EmployeeDocumentWithDetails> {
    await this.assertEmployeeExists(companyId, employeeId);
    await this.checkReadAccess(actor, companyId, employeeId);

    const doc = await this.deps.repo.findByEmployeeAndId(companyId, employeeId, documentId);
    if (!doc) throw new OrgEntityNotFoundError('EMPLOYEE_DOCUMENT');
    return doc;
  }

  async downloadDocument(
    actor: ActorContext,
    companyId: string,
    employeeId: string,
    documentId: string,
  ): Promise<{ stream: Readable; contentType: string; fileName: string }> {
    await this.assertEmployeeExists(companyId, employeeId);
    await this.checkReadAccess(actor, companyId, employeeId);

    const empDoc = await this.deps.repo.findByEmployeeAndId(companyId, employeeId, documentId);
    if (!empDoc) throw new OrgEntityNotFoundError('EMPLOYEE_DOCUMENT');

    const download = await this.deps.documentService.getRawStream(companyId, empDoc.documentId);
    return {
      stream: download.stream,
      contentType: download.contentType,
      fileName: download.fileName,
    };
  }

  async updateDocument(
    actor: ActorContext,
    companyId: string,
    employeeId: string,
    documentId: string,
    input: UpdateEmployeeDocumentInput,
  ): Promise<EmployeeDocumentWithDetails> {
    await this.assertEmployeeExists(companyId, employeeId);
    await this.deps.authorizer.assertPermission(actor.actorId, EMPLOYEE_MANAGE, companyTarget(companyId));

    const existing = await this.deps.repo.findByEmployeeAndId(companyId, employeeId, documentId);
    if (!existing) throw new OrgEntityNotFoundError('EMPLOYEE_DOCUMENT');

    const updated = await this.deps.repo.update(companyId, documentId, {
      ...(input.title !== undefined ? { title: input.title.trim() } : {}),
      ...(input.documentNumber !== undefined
        ? { documentNumber: input.documentNumber?.trim() ?? null }
        : {}),
      ...(input.issuingAuthority !== undefined
        ? { issuingAuthority: input.issuingAuthority?.trim() ?? null }
        : {}),
      ...(input.issueDate !== undefined
        ? { issueDate: input.issueDate ? new Date(input.issueDate) : null }
        : {}),
      ...(input.expiryDate !== undefined
        ? { expiryDate: input.expiryDate ? new Date(input.expiryDate) : null }
        : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      ...(input.expectedVersion !== undefined ? { expectedVersion: input.expectedVersion } : {}),
    });

    await this.deps.prisma.auditLog.create({
      data: auditEntry(actor, {
        action: 'EMPLOYEE_DOCUMENT_UPDATED',
        entityType: 'EMPLOYEE_DOCUMENT',
        entityId: documentId,
        companyId,
        statusBefore: existing.verificationStatus,
        statusAfter: updated.verificationStatus,
      }),
    });

    return updated;
  }

  async verifyDocument(
    actor: ActorContext,
    companyId: string,
    employeeId: string,
    documentId: string,
    input: VerifyEmployeeDocumentInput,
  ): Promise<EmployeeDocumentWithDetails> {
    await this.assertEmployeeExists(companyId, employeeId);
    await this.deps.authorizer.assertPermission(actor.actorId, EMPLOYEE_MANAGE, companyTarget(companyId));

    const existing = await this.deps.repo.findByEmployeeAndId(companyId, employeeId, documentId);
    if (!existing) throw new OrgEntityNotFoundError('EMPLOYEE_DOCUMENT');

    if (input.status === 'REJECTED' && (!input.rejectionReason || input.rejectionReason.trim().length === 0)) {
      throw new OrgValidationError('rejectionReason', 'reason is required when rejecting a document');
    }

    const verified = await this.deps.repo.verify(companyId, documentId, {
      status: input.status,
      verifiedByPrincipalId: actor.actorId,
      rejectionReason: input.rejectionReason?.trim() ?? null,
      ...(input.expectedVersion !== undefined ? { expectedVersion: input.expectedVersion } : {}),
    });

    await this.deps.prisma.auditLog.create({
      data: auditEntry(actor, {
        action: input.status === 'VERIFIED' ? 'EMPLOYEE_DOCUMENT_VERIFIED' : 'EMPLOYEE_DOCUMENT_REJECTED',
        entityType: 'EMPLOYEE_DOCUMENT',
        entityId: documentId,
        companyId,
        statusBefore: existing.verificationStatus,
        statusAfter: input.status,
      }),
    });

    return verified;
  }

  async deleteDocument(
    actor: ActorContext,
    companyId: string,
    employeeId: string,
    documentId: string,
  ): Promise<void> {
    await this.assertEmployeeExists(companyId, employeeId);
    await this.deps.authorizer.assertPermission(actor.actorId, EMPLOYEE_MANAGE, companyTarget(companyId));

    const existing = await this.deps.repo.findByEmployeeAndId(companyId, employeeId, documentId);
    if (!existing) throw new OrgEntityNotFoundError('EMPLOYEE_DOCUMENT');

    await this.deps.repo.delete(companyId, documentId);

    await this.deps.prisma.auditLog.create({
      data: auditEntry(actor, {
        action: 'EMPLOYEE_DOCUMENT_DELETED',
        entityType: 'EMPLOYEE_DOCUMENT',
        entityId: documentId,
        companyId,
        statusBefore: existing.verificationStatus,
      }),
    });
  }

  async listExpiringDocuments(
    actor: ActorContext,
    companyId: string,
    withinDays = 30,
  ): Promise<EmployeeDocumentWithDetails[]> {
    await this.deps.authorizer.assertPermission(actor.actorId, EMPLOYEE_READ, companyTarget(companyId));
    const thresholdDate = new Date();
    thresholdDate.setDate(thresholdDate.getDate() + withinDays);
    return this.deps.repo.findExpiring(companyId, thresholdDate);
  }
}
