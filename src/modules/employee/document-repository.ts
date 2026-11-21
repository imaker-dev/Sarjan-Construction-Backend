import type {
  Document,
  Employee,
  EmployeeDocument,
  EmployeeDocumentType,
  DocumentVerificationStatus,
  Prisma,
  PrismaClient,
} from '@prisma/client';

export type EmployeeDocumentWithDetails = EmployeeDocument & {
  document: Pick<
    Document,
    'id' | 'storageKey' | 'originalFileName' | 'contentType' | 'sizeBytes' | 'sha256' | 'status'
  >;
  employee?: Pick<Employee, 'id' | 'employeeCode' | 'displayName'>;
  verifiedBy?: { id: string; loginId: string | null } | null;
};

export interface ListEmployeeDocumentsFilter {
  employeeId?: string | undefined;
  documentType?: EmployeeDocumentType | undefined;
  verificationStatus?: DocumentVerificationStatus | undefined;
}

export interface EmployeeDocumentRepository {
  create(
    companyId: string,
    data: {
      employeeId: string;
      documentId: string;
      documentType: EmployeeDocumentType;
      title: string;
      documentNumber?: string | null | undefined;
      issuingAuthority?: string | null | undefined;
      issueDate?: Date | null | undefined;
      expiryDate?: Date | null | undefined;
      metadata?: Prisma.InputJsonValue | undefined;
    },
  ): Promise<EmployeeDocumentWithDetails>;

  findById(companyId: string, id: string): Promise<EmployeeDocumentWithDetails | null>;

  findByEmployeeAndId(
    companyId: string,
    employeeId: string,
    id: string,
  ): Promise<EmployeeDocumentWithDetails | null>;

  list(
    companyId: string,
    filter: ListEmployeeDocumentsFilter,
  ): Promise<EmployeeDocumentWithDetails[]>;

  update(
    companyId: string,
    id: string,
    data: {
      title?: string | undefined;
      documentNumber?: string | null | undefined;
      issuingAuthority?: string | null | undefined;
      issueDate?: Date | null | undefined;
      expiryDate?: Date | null | undefined;
      metadata?: Prisma.InputJsonValue | undefined;
      expectedVersion?: number | undefined;
    },
  ): Promise<EmployeeDocumentWithDetails>;

  verify(
    companyId: string,
    id: string,
    data: {
      status: DocumentVerificationStatus;
      verifiedByPrincipalId: string;
      rejectionReason?: string | null | undefined;
      expectedVersion?: number | undefined;
    },
  ): Promise<EmployeeDocumentWithDetails>;

  delete(companyId: string, id: string): Promise<void>;

  findExpiring(companyId: string, thresholdDate: Date): Promise<EmployeeDocumentWithDetails[]>;
}

export class PrismaEmployeeDocumentRepository implements EmployeeDocumentRepository {
  constructor(private readonly prisma: PrismaClient) {}

  private readonly includeClause = {
    document: {
      select: {
        id: true,
        storageKey: true,
        originalFileName: true,
        contentType: true,
        sizeBytes: true,
        sha256: true,
        status: true,
      },
    },
    employee: {
      select: {
        id: true,
        employeeCode: true,
        displayName: true,
      },
    },
    verifiedBy: {
      select: {
        id: true,
        loginId: true,
      },
    },
  };

  async create(
    companyId: string,
    data: {
      employeeId: string;
      documentId: string;
      documentType: EmployeeDocumentType;
      title: string;
      documentNumber?: string | null;
      issuingAuthority?: string | null;
      issueDate?: Date | null;
      expiryDate?: Date | null;
      metadata?: Prisma.InputJsonValue;
    },
  ): Promise<EmployeeDocumentWithDetails> {
    return this.prisma.employeeDocument.create({
      data: {
        companyId,
        ...data,
      },
      include: this.includeClause,
    });
  }

  async findById(companyId: string, id: string): Promise<EmployeeDocumentWithDetails | null> {
    return this.prisma.employeeDocument.findFirst({
      where: { id, companyId },
      include: this.includeClause,
    });
  }

  async findByEmployeeAndId(
    companyId: string,
    employeeId: string,
    id: string,
  ): Promise<EmployeeDocumentWithDetails | null> {
    return this.prisma.employeeDocument.findFirst({
      where: { id, employeeId, companyId },
      include: this.includeClause,
    });
  }

  async list(
    companyId: string,
    filter: ListEmployeeDocumentsFilter,
  ): Promise<EmployeeDocumentWithDetails[]> {
    return this.prisma.employeeDocument.findMany({
      where: {
        companyId,
        ...(filter.employeeId !== undefined ? { employeeId: filter.employeeId } : {}),
        ...(filter.documentType !== undefined ? { documentType: filter.documentType } : {}),
        ...(filter.verificationStatus !== undefined
          ? { verificationStatus: filter.verificationStatus }
          : {}),
      },
      include: this.includeClause,
      orderBy: [{ createdAt: 'desc' }],
    });
  }

  async update(
    companyId: string,
    id: string,
    data: {
      title?: string;
      documentNumber?: string | null;
      issuingAuthority?: string | null;
      issueDate?: Date | null;
      expiryDate?: Date | null;
      metadata?: Prisma.InputJsonValue;
      expectedVersion?: number;
    },
  ): Promise<EmployeeDocumentWithDetails> {
    return this.prisma.employeeDocument.update({
      where: {
        id,
        companyId,
        ...(data.expectedVersion !== undefined ? { version: data.expectedVersion } : {}),
      },
      data: {
        ...(data.title !== undefined ? { title: data.title } : {}),
        ...(data.documentNumber !== undefined ? { documentNumber: data.documentNumber } : {}),
        ...(data.issuingAuthority !== undefined ? { issuingAuthority: data.issuingAuthority } : {}),
        ...(data.issueDate !== undefined ? { issueDate: data.issueDate } : {}),
        ...(data.expiryDate !== undefined ? { expiryDate: data.expiryDate } : {}),
        ...(data.metadata !== undefined ? { metadata: data.metadata } : {}),
        version: { increment: 1 },
      },
      include: this.includeClause,
    });
  }

  async verify(
    companyId: string,
    id: string,
    data: {
      status: DocumentVerificationStatus;
      verifiedByPrincipalId: string;
      rejectionReason?: string | null;
      expectedVersion?: number;
    },
  ): Promise<EmployeeDocumentWithDetails> {
    return this.prisma.employeeDocument.update({
      where: {
        id,
        companyId,
        ...(data.expectedVersion !== undefined ? { version: data.expectedVersion } : {}),
      },
      data: {
        verificationStatus: data.status,
        verifiedByPrincipalId: data.verifiedByPrincipalId,
        verifiedAt: new Date(),
        rejectionReason: data.rejectionReason ?? null,
        version: { increment: 1 },
      },
      include: this.includeClause,
    });
  }

  async delete(companyId: string, id: string): Promise<void> {
    await this.prisma.employeeDocument.delete({
      where: { id, companyId },
    });
  }

  async findExpiring(
    companyId: string,
    thresholdDate: Date,
  ): Promise<EmployeeDocumentWithDetails[]> {
    return this.prisma.employeeDocument.findMany({
      where: {
        companyId,
        expiryDate: {
          not: null,
          lte: thresholdDate,
        },
      },
      include: this.includeClause,
      orderBy: [{ expiryDate: 'asc' }],
    });
  }
}
