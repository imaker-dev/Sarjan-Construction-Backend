import type { PrismaClient } from '@prisma/client';
import type { ActorContext } from '../organization/types.js';
import { auditEntry } from '../organization/service.js';
import { OrgEntityNotFoundError, OrgValidationError } from '../organization/errors.js';
import { AppError } from '../../common/errors/app-error.js';

const MASK_REDACTED = '***REDACTED***';
const mask = (v: unknown): unknown =>
  typeof v === 'string' && v.length > 4 ? `…${v.slice(-4)}` : MASK_REDACTED;

export interface ComplianceInput {
  category: string;
  customLabel?: string;
  identifier: string;
  jurisdiction?: string;
  issuingAuthority?: string;
  issueDate?: string;
  expiryDate?: string;
  documentId?: string;
}

export class ComplianceService {
  constructor(private readonly prisma: PrismaClient) {}

  private static validate(input: ComplianceInput, partial = false) {
    if (input.category === 'OTHER' && !input.customLabel?.trim()) {
      throw new OrgValidationError('customLabel', 'required when category = OTHER');
    }
    if (!partial && input.identifier.trim() === '') {
      throw new OrgValidationError('identifier', 'required');
    }
    if (input.issueDate !== undefined && input.expiryDate !== undefined) {
      if (new Date(input.expiryDate) < new Date(input.issueDate)) {
        throw new OrgValidationError('expiryDate', 'must be ≥ issueDate');
      }
    }
  }

  async list(companyId: string) {
    return this.prisma.complianceRecord.findMany({
      where: { companyId, status: { not: 'ARCHIVED' } },
      orderBy: [{ category: 'asc' }, { createdAt: 'asc' }],
    });
  }

  async create(actor: ActorContext, companyId: string, input: ComplianceInput) {
    ComplianceService.validate(input);
    return this.prisma.$transaction(async (tx) => {
      // Attachment must be an AVAILABLE document in THIS company.
      if (input.documentId !== undefined) {
        const doc = await tx.document.findFirst({
          where: { id: input.documentId, companyId, status: 'AVAILABLE' },
        });
        if (!doc) throw new OrgValidationError('documentId', 'not an available company document');
      }
      let record;
      try {
        record = await tx.complianceRecord.create({
          data: {
            companyId,
            category: input.category as never,
            customLabel: input.customLabel?.trim() ?? null,
            identifier: input.identifier.trim(),
            jurisdiction: input.jurisdiction?.trim() ?? null,
            issuingAuthority: input.issuingAuthority?.trim() ?? null,
            issueDate: input.issueDate !== undefined ? new Date(input.issueDate) : null,
            expiryDate: input.expiryDate !== undefined ? new Date(input.expiryDate) : null,
            documentId: input.documentId ?? null,
          },
        });
      } catch (error) {
        if ((error as { code?: string }).code === 'P2002') {
          throw new AppError(409, 'COMPLIANCE_DUPLICATE', 'identifier already registered');
        }
        throw error;
      }
      await tx.auditLog.create({
        data: auditEntry(actor, {
          action: 'COMPLIANCE_RECORD_CREATED',
          entityType: 'COMPLIANCE_RECORD',
          entityId: record.id,
          companyId,
          changedFields: { identifier: mask(record.identifier) } as never,
        }) as never,
      });
      return record;
    });
  }

  async update(
    actor: ActorContext,
    companyId: string,
    id: string,
    patch: Partial<ComplianceInput>,
    expectedVersion: number,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.complianceRecord.findFirst({ where: { id, companyId } });
      if (!existing) throw new OrgEntityNotFoundError('COMPLIANCE_RECORD');
      const { count } = await tx.complianceRecord.updateMany({
        where: { id, companyId, version: expectedVersion },
        data: {
          ...(patch.customLabel !== undefined ? { customLabel: patch.customLabel.trim() } : {}),
          ...(patch.identifier !== undefined ? { identifier: patch.identifier.trim() } : {}),
          ...(patch.jurisdiction !== undefined ? { jurisdiction: patch.jurisdiction.trim() } : {}),
          ...(patch.issuingAuthority !== undefined
            ? { issuingAuthority: patch.issuingAuthority.trim() }
            : {}),
          ...(patch.issueDate !== undefined ? { issueDate: new Date(patch.issueDate) } : {}),
          ...(patch.expiryDate !== undefined ? { expiryDate: new Date(patch.expiryDate) } : {}),
          version: { increment: 1 },
        },
      });
      if (count === 0) {
        throw new AppError(409, 'STALE_VERSION', 'record changed; re-read and retry');
      }
      const updated = await tx.complianceRecord.findFirstOrThrow({ where: { id, companyId } });
      await tx.auditLog.create({
        data: auditEntry(actor, {
          action: 'COMPLIANCE_RECORD_UPDATED',
          entityType: 'COMPLIANCE_RECORD',
          entityId: id,
          companyId,
          statusBefore: existing.status,
          statusAfter: updated.status,
          changedFields: { identifier: mask(updated.identifier) } as never,
        }) as never,
      });
      return updated;
    });
  }

  async transition(
    actor: ActorContext,
    companyId: string,
    id: string,
    to: string,
    expectedVersion: number,
  ) {
    const TRANSITIONS: Record<string, string[]> = {
      DRAFT: ['ACTIVE', 'ARCHIVED'],
      ACTIVE: ['SUSPENDED', 'EXPIRED', 'ARCHIVED'],
      SUSPENDED: ['ACTIVE', 'ARCHIVED'],
      EXPIRED: ['ARCHIVED'],
      ARCHIVED: [],
    };
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.complianceRecord.findFirst({ where: { id, companyId } });
      if (!existing) throw new OrgEntityNotFoundError('COMPLIANCE_RECORD');
      if (!TRANSITIONS[existing.status]?.includes(to)) {
        throw new AppError(422, 'INVALID_TRANSITION', `${existing.status} → ${to} not allowed`);
      }
      const { count } = await tx.complianceRecord.updateMany({
        where: { id, companyId, version: expectedVersion },
        data: { status: to as never, version: { increment: 1 } },
      });
      if (count === 0) {
        throw new AppError(409, 'STALE_VERSION', 'record changed; re-read and retry');
      }
      await tx.auditLog.create({
        data: auditEntry(actor, {
          action: 'COMPLIANCE_RECORD_STATUS',
          entityType: 'COMPLIANCE_RECORD',
          entityId: id,
          companyId,
          statusBefore: existing.status,
          statusAfter: to,
        }) as never,
      });
      return tx.complianceRecord.findFirstOrThrow({ where: { id, companyId } });
    });
  }

  async verify(
    actor: ActorContext,
    companyId: string,
    id: string,
    documentId: string | undefined,
    expectedVersion: number,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.complianceRecord.findFirst({ where: { id, companyId } });
      if (!existing) throw new OrgEntityNotFoundError('COMPLIANCE_RECORD');
      if (documentId !== undefined) {
        const doc = await tx.document.findFirst({
          where: { id: documentId, companyId, status: 'AVAILABLE' },
        });
        if (!doc) throw new OrgValidationError('documentId', 'not an available company document');
      }
      const { count } = await tx.complianceRecord.updateMany({
        where: { id, companyId, version: expectedVersion },
        data: {
          verifiedAt: new Date(),
          verifiedBy: actor.actorId,
          ...(documentId !== undefined ? { documentId } : {}),
          version: { increment: 1 },
        },
      });
      if (count === 0) {
        throw new AppError(409, 'STALE_VERSION', 'record changed; re-read and retry');
      }
      await tx.auditLog.create({
        data: auditEntry(actor, {
          action: 'COMPLIANCE_RECORD_VERIFIED',
          entityType: 'COMPLIANCE_RECORD',
          entityId: id,
          companyId,
        }) as never,
      });
      return tx.complianceRecord.findFirstOrThrow({ where: { id, companyId } });
    });
  }
}
