import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  EmployeeDocumentService,
  EMPLOYEE_MANAGE,
  EMPLOYEE_READ,
  type Authorizer,
} from '../../../src/modules/employee/document-service.js';
import type {
  EmployeeDocumentRepository,
  EmployeeDocumentWithDetails,
} from '../../../src/modules/employee/document-repository.js';
import type { DocumentService } from '../../../src/modules/document/service.js';
import {
  OrgEntityNotFoundError,
  OrgValidationError,
} from '../../../src/modules/organization/errors.js';
import type { ActorContext } from '../../../src/modules/organization/types.js';

describe('EmployeeDocumentService', () => {
  const actor: ActorContext = { actorId: 'admin-principal', actorType: 'USER' };
  const companyId = 'comp-1';
  const employeeId = 'emp-1';

  const assertPermissionSpy = vi.fn().mockResolvedValue(undefined);
  const uploadDocSpy = vi.fn();
  const getRawStreamSpy = vi.fn();
  const repoCreateSpy = vi.fn();
  const repoFindByIdSpy = vi.fn();
  const repoFindByEmployeeAndIdSpy = vi.fn();
  const repoListSpy = vi.fn();
  const repoUpdateSpy = vi.fn();
  const repoVerifySpy = vi.fn();
  const repoDeleteSpy = vi.fn();
  const repoFindExpiringSpy = vi.fn();
  const employeeFindFirstSpy = vi.fn();
  const documentFindFirstSpy = vi.fn();
  const auditLogCreateSpy = vi.fn();

  let service: EmployeeDocumentService;

  const sampleEmployeeDoc: EmployeeDocumentWithDetails = {
    id: 'emp-doc-1',
    companyId,
    employeeId,
    documentId: 'doc-1',
    documentType: 'AADHAAR',
    title: 'Aadhaar Card Front & Back',
    documentNumber: '1234-5678-9012',
    issuingAuthority: 'UIDAI',
    issueDate: new Date('2020-01-01'),
    expiryDate: null,
    verificationStatus: 'PENDING',
    verifiedByPrincipalId: null,
    verifiedAt: null,
    rejectionReason: null,
    metadata: null,
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    document: {
      id: 'doc-1',
      storageKey: 'company/comp-1/doc-1.pdf',
      originalFileName: 'aadhaar.pdf',
      contentType: 'application/pdf',
      sizeBytes: 1024,
      sha256: 'abc123sha',
      status: 'AVAILABLE',
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();

    assertPermissionSpy.mockResolvedValue(undefined);

    repoCreateSpy.mockResolvedValue(sampleEmployeeDoc);
    repoFindByIdSpy.mockResolvedValue(sampleEmployeeDoc);
    repoFindByEmployeeAndIdSpy.mockResolvedValue(sampleEmployeeDoc);
    repoListSpy.mockResolvedValue([sampleEmployeeDoc]);
    repoUpdateSpy.mockResolvedValue({ ...sampleEmployeeDoc, version: 2 });
    repoVerifySpy.mockResolvedValue({
      ...sampleEmployeeDoc,
      verificationStatus: 'VERIFIED',
      version: 2,
    });
    repoDeleteSpy.mockResolvedValue(undefined);
    repoFindExpiringSpy.mockResolvedValue([]);

    uploadDocSpy.mockResolvedValue({
      id: 'doc-1',
      storageKey: 'company/comp-1/doc-1.pdf',
      originalFileName: 'aadhaar.pdf',
      contentType: 'application/pdf',
      sizeBytes: 1024,
      sha256: 'abc123sha',
      status: 'AVAILABLE',
    });
    getRawStreamSpy.mockResolvedValue({
      stream: {} as never,
      contentType: 'application/pdf',
      fileName: 'aadhaar.pdf',
    });

    employeeFindFirstSpy.mockImplementation((args: { where?: { id?: string; principalId?: string } }) => {
      if (args?.where?.id === employeeId) {
        return Promise.resolve({
          id: employeeId,
          companyId,
          principalId: 'emp-user-principal',
        });
      }
      if (args?.where?.principalId === 'emp-user-principal') {
        return Promise.resolve({
          id: employeeId,
          companyId,
          principalId: 'emp-user-principal',
        });
      }
      return Promise.resolve(null);
    });
    documentFindFirstSpy.mockResolvedValue({
      id: 'doc-1',
      companyId,
      status: 'AVAILABLE',
    });
    auditLogCreateSpy.mockResolvedValue({ id: 'audit-1' });

    const mockRepo: EmployeeDocumentRepository = {
      create: repoCreateSpy,
      findById: repoFindByIdSpy,
      findByEmployeeAndId: repoFindByEmployeeAndIdSpy,
      list: repoListSpy,
      update: repoUpdateSpy,
      verify: repoVerifySpy,
      delete: repoDeleteSpy,
      findExpiring: repoFindExpiringSpy,
    };

    const mockDocService = {
      upload: uploadDocSpy,
      getRawStream: getRawStreamSpy,
    } as unknown as DocumentService;

    const mockPrisma = {
      employee: { findFirst: employeeFindFirstSpy },
      document: { findFirst: documentFindFirstSpy },
      auditLog: { create: auditLogCreateSpy },
    } as unknown as PrismaClient;

    const mockAuthorizer: Authorizer = {
      assertPermission: assertPermissionSpy,
    };

    service = new EmployeeDocumentService({
      repo: mockRepo,
      documentService: mockDocService,
      prisma: mockPrisma,
      authorizer: mockAuthorizer,
    });
  });

  describe('uploadAndAttach', () => {
    it('uploads file via DocumentService and attaches metadata to employee document', async () => {
      const result = await service.uploadAndAttach(
        actor,
        companyId,
        employeeId,
        {
          body: Buffer.from('file-content'),
          fileName: 'aadhaar.pdf',
          declaredContentType: 'application/pdf',
        },
        {
          documentType: 'AADHAAR',
          title: 'Aadhaar Card Front & Back',
          documentNumber: '1234-5678-9012',
          issuingAuthority: 'UIDAI',
        },
      );

      expect(assertPermissionSpy).toHaveBeenCalledWith(
        actor.actorId,
        EMPLOYEE_MANAGE,
        expect.anything(),
      );
      expect(uploadDocSpy).toHaveBeenCalledWith(
        actor,
        companyId,
        expect.objectContaining({
          fileName: 'aadhaar.pdf',
          autoApprove: true,
        }),
      );
      expect(repoCreateSpy).toHaveBeenCalledWith(
        companyId,
        expect.objectContaining({
          employeeId,
          documentId: 'doc-1',
          documentType: 'AADHAAR',
          title: 'Aadhaar Card Front & Back',
        }),
      );
      expect(auditLogCreateSpy).toHaveBeenCalled();
      expect(result.id).toBe('emp-doc-1');
    });

    it('allows self-upload without EMPLOYEE_MANAGE permission', async () => {
      const selfActor: ActorContext = { actorId: 'emp-user-principal', actorType: 'USER' };

      await service.uploadAndAttach(
        selfActor,
        companyId,
        employeeId,
        {
          body: Buffer.from('file-content'),
          fileName: 'pass.jpg',
        },
        {
          documentType: 'PHOTO',
          title: 'Profile Photo',
        },
      );

      expect(assertPermissionSpy).not.toHaveBeenCalled();
    });

    it('rejects upload with empty title', async () => {
      await expect(
        service.uploadAndAttach(
          actor,
          companyId,
          employeeId,
          {
            body: Buffer.from('abc'),
            fileName: 'doc.pdf',
          },
          {
            documentType: 'OTHER',
            title: '   ',
          },
        ),
      ).rejects.toThrow(OrgValidationError);
    });

    it('throws OrgEntityNotFoundError if employee does not exist', async () => {
      employeeFindFirstSpy.mockResolvedValue(null);

      await expect(
        service.uploadAndAttach(
          actor,
          companyId,
          'non-existent',
          {
            body: Buffer.from('abc'),
            fileName: 'doc.pdf',
          },
          {
            documentType: 'OTHER',
            title: 'Doc',
          },
        ),
      ).rejects.toThrow(OrgEntityNotFoundError);
    });
  });

  describe('attachExisting', () => {
    it('attaches existing available company document to employee', async () => {
      const result = await service.attachExisting(actor, companyId, employeeId, {
        documentId: 'doc-1',
        documentType: 'AADHAAR',
        title: 'Attached Aadhaar',
      });

      expect(repoCreateSpy).toHaveBeenCalledWith(
        companyId,
        expect.objectContaining({
          documentId: 'doc-1',
          title: 'Attached Aadhaar',
        }),
      );
      expect(result.id).toBe('emp-doc-1');
    });

    it('rejects attachment if document is not available or belongs to another company', async () => {
      documentFindFirstSpy.mockResolvedValue(null);

      await expect(
        service.attachExisting(actor, companyId, employeeId, {
          documentId: 'bad-doc',
          documentType: 'AADHAAR',
          title: 'Aadhaar',
        }),
      ).rejects.toThrow(OrgValidationError);
    });
  });

  describe('verifyDocument', () => {
    it('approves document verification with 200 and logs audit', async () => {
      const verified = await service.verifyDocument(actor, companyId, employeeId, 'emp-doc-1', {
        status: 'VERIFIED',
      });

      expect(assertPermissionSpy).toHaveBeenCalledWith(
        actor.actorId,
        EMPLOYEE_MANAGE,
        expect.anything(),
      );
      expect(repoVerifySpy).toHaveBeenCalledWith(
        companyId,
        'emp-doc-1',
        expect.objectContaining({
          status: 'VERIFIED',
          verifiedByPrincipalId: actor.actorId,
        }),
      );
      expect(verified.verificationStatus).toBe('VERIFIED');
    });

    it('requires rejectionReason when status is REJECTED', async () => {
      await expect(
        service.verifyDocument(actor, companyId, employeeId, 'emp-doc-1', {
          status: 'REJECTED',
          rejectionReason: '',
        }),
      ).rejects.toThrow(OrgValidationError);
    });
  });

  describe('updateDocument & deleteDocument', () => {
    it('updates document metadata with optimistic locking', async () => {
      const updated = await service.updateDocument(actor, companyId, employeeId, 'emp-doc-1', {
        title: 'Updated Title',
        documentNumber: 'NEW-NUM-123',
        expectedVersion: 1,
      });

      expect(repoUpdateSpy).toHaveBeenCalledWith(
        companyId,
        'emp-doc-1',
        expect.objectContaining({
          title: 'Updated Title',
          documentNumber: 'NEW-NUM-123',
          expectedVersion: 1,
        }),
      );
      expect(updated.version).toBe(2);
    });

    it('deletes document record and audits', async () => {
      await service.deleteDocument(actor, companyId, employeeId, 'emp-doc-1');
      expect(repoDeleteSpy).toHaveBeenCalledWith(companyId, 'emp-doc-1');
      expect(auditLogCreateSpy).toHaveBeenCalled();
    });
  });

  describe('downloadDocument', () => {
    it('returns stream and headers for caller with access', async () => {
      const download = await service.downloadDocument(actor, companyId, employeeId, 'emp-doc-1');
      expect(assertPermissionSpy).toHaveBeenCalledWith(
        actor.actorId,
        EMPLOYEE_READ,
        expect.anything(),
      );
      expect(download.fileName).toBe('aadhaar.pdf');
    });
  });
});
