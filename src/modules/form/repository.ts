import type { Form, FormStatus, FormVersion, PrismaClient } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import { mapOrgWriteError } from '../organization/errors.js';
import {
  makeOrgRepos,
  scopedUpdate,
  type AuditRepository,
  type OrgRepos,
} from '../organization/repository.js';
import type { OperationRepository } from '../operation/repository.js';
import { makeOperationRepos } from '../operation/repository.js';
import type { DepartmentRepository } from '../department/repository.js';

type Tx = Prisma.TransactionClient;

export interface FormRepository {
  findById(companyId: string, id: string): Promise<Form | null>;
  list(companyId: string, filter?: { status?: FormStatus; operationId?: string }): Promise<Form[]>;
  create(
    companyId: string,
    operationId: string,
    data: {
      key: string;
      name: string;
      description?: string;
      schema?: Prisma.InputJsonValue;
    },
  ): Promise<Form>;
  update(
    companyId: string,
    id: string,
    data: Record<string, unknown>,
    expectedVersion?: number,
  ): Promise<Form>;
  updateForPublish(
    companyId: string,
    id: string,
    latestRevision: number,
    currentVersionId: string,
    expectedVersion?: number,
  ): Promise<Form>;
}

// Append-only: no update or delete methods by design.
export interface FormVersionRepository {
  create(data: {
    companyId: string;
    formId: string;
    revision: number;
    schema: Prisma.InputJsonValue;
    publishedByPrincipalId?: string;
  }): Promise<FormVersion>;
  list(companyId: string, formId: string): Promise<FormVersion[]>;
}

export interface FormRepos {
  forms: FormRepository;
  formVersions: FormVersionRepository;
  operations: OperationRepository;
  departments: DepartmentRepository;
  audit: AuditRepository;
}

export interface FormUnitOfWork {
  run<T>(fn: (repos: FormRepos) => Promise<T>): Promise<T>;
}

export function makeFormRepos(tx: Tx): FormRepos {
  const org: OrgRepos = makeOrgRepos(tx);
  const ops = makeOperationRepos(tx);
  return {
    departments: ops.departments,
    audit: org.audit,
    operations: ops.operations,
    forms: {
      findById: (companyId, id) => tx.form.findFirst({ where: { id, companyId } }),
      list: (companyId, filter) =>
        tx.form.findMany({
          where: {
            companyId,
            ...(filter?.status ? { status: filter.status } : {}),
            ...(filter?.operationId ? { operationId: filter.operationId } : {}),
          },
          orderBy: { id: 'asc' },
        }),
      create: async (companyId, operationId, data) => {
        try {
          return await tx.form.create({ data: { ...data, companyId, operationId } });
        } catch (error) {
          mapOrgWriteError(error, 'FORM');
        }
      },
      update: (companyId, id, data, expectedVersion) =>
        scopedUpdate(
          'FORM',
          { id, companyId },
          data,
          expectedVersion,
          (args) => tx.form.updateMany(args),
          () => tx.form.findFirst({ where: { id, companyId } }),
        ),
      updateForPublish: (companyId, id, latestRevision, currentVersionId, expectedVersion) =>
        scopedUpdate(
          'FORM',
          { id, companyId },
          { latestRevision, currentVersionId },
          expectedVersion,
          (args) => tx.form.updateMany(args),
          () => tx.form.findFirst({ where: { id, companyId } }),
        ),
    },
    formVersions: {
      create: async (data) => {
        try {
          return await tx.formVersion.create({ data });
        } catch (error) {
          mapOrgWriteError(error, 'FORM_VERSION');
        }
      },
      list: (companyId, formId) =>
        tx.formVersion.findMany({
          where: { companyId, formId },
          orderBy: { revision: 'asc' },
        }),
    },
  };
}

export class PrismaFormUnitOfWork implements FormUnitOfWork {
  constructor(private readonly prisma: PrismaClient) {}

  run<T>(fn: (repos: FormRepos) => Promise<T>): Promise<T> {
    return this.prisma.$transaction((tx) => fn(makeFormRepos(tx)));
  }
}
