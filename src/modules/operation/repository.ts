import type { Operation, OperationStatus, OperationVersion, PrismaClient } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import { mapOrgWriteError } from '../organization/errors.js';
import {
  makeOrgRepos,
  scopedUpdate,
  type AuditRepository,
  type OrgRepos,
} from '../organization/repository.js';
import type { DepartmentRepository } from '../department/repository.js';
import { makeDepartmentRepos } from '../department/repository.js';

type Tx = Prisma.TransactionClient;

export interface OperationRepository {
  findById(companyId: string, id: string): Promise<Operation | null>;
  list(
    companyId: string,
    filter?: { status?: OperationStatus; departmentId?: string },
  ): Promise<Operation[]>;
  create(
    companyId: string,
    departmentId: string,
    data: {
      key: string;
      name: string;
      capabilityKey?: string;
      description?: string;
      definition?: Prisma.InputJsonValue;
    },
  ): Promise<Operation>;
  update(
    companyId: string,
    id: string,
    data: Record<string, unknown>,
    expectedVersion?: number,
  ): Promise<Operation>;
  /** Publish-path guarded update: bumps version + sets revision pointer. */
  updateForPublish(
    companyId: string,
    id: string,
    latestRevision: number,
    currentVersionId: string,
    expectedVersion?: number,
  ): Promise<Operation>;
}

// Append-only: no update or delete methods by design.
export interface OperationVersionRepository {
  create(data: {
    companyId: string;
    operationId: string;
    revision: number;
    definition: Prisma.InputJsonValue;
    publishedByPrincipalId?: string;
  }): Promise<OperationVersion>;
  list(companyId: string, operationId: string): Promise<OperationVersion[]>;
}

export interface OperationRepos {
  operations: OperationRepository;
  operationVersions: OperationVersionRepository;
  departments: DepartmentRepository;
  audit: AuditRepository;
}

export interface OperationUnitOfWork {
  run<T>(fn: (repos: OperationRepos) => Promise<T>): Promise<T>;
}

export function makeOperationRepos(tx: Tx): OperationRepos {
  const org: OrgRepos = makeOrgRepos(tx);
  const depts = makeDepartmentRepos(tx);
  return {
    departments: depts.departments,
    audit: org.audit,
    operations: {
      findById: (companyId, id) => tx.operation.findFirst({ where: { id, companyId } }),
      list: (companyId, filter) =>
        tx.operation.findMany({
          where: {
            companyId,
            ...(filter?.status ? { status: filter.status } : {}),
            ...(filter?.departmentId ? { departmentId: filter.departmentId } : {}),
          },
          orderBy: { id: 'asc' },
        }),
      create: async (companyId, departmentId, data) => {
        try {
          return await tx.operation.create({ data: { ...data, companyId, departmentId } });
        } catch (error) {
          mapOrgWriteError(error, 'OPERATION');
        }
      },
      update: (companyId, id, data, expectedVersion) =>
        scopedUpdate(
          'OPERATION',
          { id, companyId },
          data,
          expectedVersion,
          (args) => tx.operation.updateMany(args),
          () => tx.operation.findFirst({ where: { id, companyId } }),
        ),
      updateForPublish: (companyId, id, latestRevision, currentVersionId, expectedVersion) =>
        scopedUpdate(
          'OPERATION',
          { id, companyId },
          { latestRevision, currentVersionId },
          expectedVersion,
          (args) => tx.operation.updateMany(args),
          () => tx.operation.findFirst({ where: { id, companyId } }),
        ),
    },
    operationVersions: {
      create: async (data) => {
        try {
          return await tx.operationVersion.create({ data });
        } catch (error) {
          mapOrgWriteError(error, 'OPERATION_VERSION');
        }
      },
      list: (companyId, operationId) =>
        tx.operationVersion.findMany({
          where: { companyId, operationId },
          orderBy: { revision: 'asc' },
        }),
    },
  };
}

export class PrismaOperationUnitOfWork implements OperationUnitOfWork {
  constructor(private readonly prisma: PrismaClient) {}

  run<T>(fn: (repos: OperationRepos) => Promise<T>): Promise<T> {
    return this.prisma.$transaction((tx) => fn(makeOperationRepos(tx)));
  }
}
