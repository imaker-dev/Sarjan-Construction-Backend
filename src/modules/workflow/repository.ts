import type { PrismaClient, Workflow, WorkflowStatus, WorkflowVersion } from '@prisma/client';
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

export interface WorkflowRepository {
  findById(companyId: string, id: string): Promise<Workflow | null>;
  list(
    companyId: string,
    filter?: { status?: WorkflowStatus; operationId?: string },
  ): Promise<Workflow[]>;
  create(
    companyId: string,
    operationId: string,
    operationVersionId: string,
    data: {
      key: string;
      name: string;
      description?: string;
      definition?: Prisma.InputJsonValue;
    },
  ): Promise<Workflow>;
  update(
    companyId: string,
    id: string,
    data: Record<string, unknown>,
    expectedVersion?: number,
  ): Promise<Workflow>;
  updateForPublish(
    companyId: string,
    id: string,
    latestRevision: number,
    currentVersionId: string,
    expectedVersion?: number,
  ): Promise<Workflow>;
}

// Append-only: no update or delete methods by design.
export interface WorkflowVersionRepository {
  create(data: {
    companyId: string;
    workflowId: string;
    revision: number;
    definition: Prisma.InputJsonValue;
    publishedByPrincipalId?: string;
  }): Promise<WorkflowVersion>;
  list(companyId: string, workflowId: string): Promise<WorkflowVersion[]>;
}

export interface OperationVersionQuery {
  /** The operationId the given OperationVersion belongs to (null if absent). */
  findOperationId(companyId: string, operationVersionId: string): Promise<string | null>;
}

// Publish-time check: a referenced FormVersion must live in the same company
// and belong to the same operation as the workflow.
export interface FormVersionQuery {
  findOperationId(companyId: string, formVersionId: string): Promise<string | null>;
}

// Publish-time check: a referenced RuleVersion (transition guard) must exist
// in the company and belong to the same operation as the workflow.
export interface RuleVersionQuery {
  findOperationId(companyId: string, ruleVersionId: string): Promise<string | null>;
}

export interface WorkflowRepos {
  workflows: WorkflowRepository;
  workflowVersions: WorkflowVersionRepository;
  operationVersions: OperationVersionQuery;
  formVersions: FormVersionQuery;
  ruleVersions: RuleVersionQuery;
  operations: OperationRepository;
  departments: DepartmentRepository;
  audit: AuditRepository;
}

export interface WorkflowUnitOfWork {
  run<T>(fn: (repos: WorkflowRepos) => Promise<T>): Promise<T>;
}

export function makeWorkflowRepos(tx: Tx): WorkflowRepos {
  const org: OrgRepos = makeOrgRepos(tx);
  const ops = makeOperationRepos(tx);
  return {
    departments: ops.departments,
    operations: ops.operations,
    audit: org.audit,
    workflows: {
      findById: (companyId, id) => tx.workflow.findFirst({ where: { id, companyId } }),
      list: (companyId, filter) =>
        tx.workflow.findMany({
          where: {
            companyId,
            ...(filter?.status ? { status: filter.status } : {}),
            ...(filter?.operationId ? { operationId: filter.operationId } : {}),
          },
          orderBy: { id: 'asc' },
        }),
      create: async (companyId, operationId, operationVersionId, data) => {
        try {
          return await tx.workflow.create({
            data: { ...data, companyId, operationId, operationVersionId },
          });
        } catch (error) {
          mapOrgWriteError(error, 'WORKFLOW');
        }
      },
      update: (companyId, id, data, expectedVersion) =>
        scopedUpdate(
          'WORKFLOW',
          { id, companyId },
          data,
          expectedVersion,
          (args) => tx.workflow.updateMany(args),
          () => tx.workflow.findFirst({ where: { id, companyId } }),
        ),
      updateForPublish: (companyId, id, latestRevision, currentVersionId, expectedVersion) =>
        scopedUpdate(
          'WORKFLOW',
          { id, companyId },
          { latestRevision, currentVersionId },
          expectedVersion,
          (args) => tx.workflow.updateMany(args),
          () => tx.workflow.findFirst({ where: { id, companyId } }),
        ),
    },
    workflowVersions: {
      create: async (data) => {
        try {
          return await tx.workflowVersion.create({ data });
        } catch (error) {
          mapOrgWriteError(error, 'WORKFLOW_VERSION');
        }
      },
      list: (companyId, workflowId) =>
        tx.workflowVersion.findMany({
          where: { companyId, workflowId },
          orderBy: { revision: 'asc' },
        }),
    },
    operationVersions: {
      findOperationId: async (companyId, operationVersionId) => {
        const row = await tx.operationVersion.findFirst({
          where: { id: operationVersionId, companyId },
          select: { operationId: true },
        });
        return row?.operationId ?? null;
      },
    },
    formVersions: {
      findOperationId: async (companyId, formVersionId) => {
        const row = await tx.formVersion.findFirst({
          where: { id: formVersionId, companyId },
          select: { form: { select: { operationId: true } } },
        });
        return row?.form.operationId ?? null;
      },
    },
    ruleVersions: {
      findOperationId: async (companyId, ruleVersionId) => {
        const row = await tx.ruleVersion.findFirst({
          where: { id: ruleVersionId, companyId },
          select: { rule: { select: { operationId: true } } },
        });
        return row?.rule.operationId ?? null;
      },
    },
  };
}

export class PrismaWorkflowUnitOfWork implements WorkflowUnitOfWork {
  constructor(private readonly prisma: PrismaClient) {}

  run<T>(fn: (repos: WorkflowRepos) => Promise<T>): Promise<T> {
    return this.prisma.$transaction((tx) => fn(makeWorkflowRepos(tx)));
  }
}
