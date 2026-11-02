import type {
  ApprovalTask,
  ApprovalTaskStatus,
  FormSubmission,
  PrismaClient,
  Workflow,
  WorkflowInstance,
  WorkflowState,
  WorkflowTransition,
} from '@prisma/client';
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
import type { BoundFieldSpec } from '../form/value-validation.js';

type Tx = Prisma.TransactionClient;

export interface WorkflowInstanceRepository {
  findById(companyId: string, id: string): Promise<WorkflowInstance | null>;
  list(
    companyId: string,
    filter?: {
      workflowId?: string;
      operationId?: string;
      state?: WorkflowState;
      businessEntityType?: string;
      businessEntityId?: string;
    },
  ): Promise<WorkflowInstance[]>;
  create(
    companyId: string,
    data: {
      operationId: string;
      workflowId: string;
      workflowVersionId: string;
      operationVersionId: string;
      state: WorkflowState;
      businessEntityType?: string;
      businessEntityId?: string;
      context?: Prisma.InputJsonValue;
      startedByPrincipalId?: string;
    },
  ): Promise<WorkflowInstance>;
  update(
    companyId: string,
    id: string,
    data: Record<string, unknown>,
    expectedVersion?: number,
  ): Promise<WorkflowInstance>;
}

// Append-only: no update or delete methods by design.
export interface WorkflowTransitionRepository {
  create(data: {
    companyId: string;
    workflowInstanceId: string;
    fromState: WorkflowState;
    toState: WorkflowState;
    action: string;
    stepKey: string;
    actorPrincipalId?: string;
    actorType: string;
    reason?: string;
    ruleVersionId?: string;
    ruleOutcome?: string;
    idempotencyKey?: string;
    requestFingerprint?: string;
    eventKey: string;
  }): Promise<WorkflowTransition>;
  findByIdempotencyKey(
    companyId: string,
    workflowInstanceId: string,
    key: string,
  ): Promise<WorkflowTransition | null>;
  list(companyId: string, workflowInstanceId: string): Promise<WorkflowTransition[]>;
}

export interface WorkflowQuery {
  /** Loads the workflow for start-instance: status, currentVersionId, pins. */
  findForStart(companyId: string, id: string): Promise<Workflow | null>;
}

export interface WorkflowVersionQuery {
  findById(
    companyId: string,
    workflowId: string,
    id: string,
  ): Promise<{ id: string; definition: Prisma.JsonValue } | null>;
}

export interface RuleVersionQuery {
  /** Loads a guard rule version's definition for evaluation. */
  findDefinition(
    companyId: string,
    id: string,
  ): Promise<{ id: string; definition: Prisma.JsonValue } | null>;
}

// Approval tasks are written through the shared workflow-instance transaction
// boundary (task opens/cancels are part of transition semantics).
export interface ApprovalTaskRepository {
  /**
   * Conflict-safe pending-task insert (`ON CONFLICT DO NOTHING` via
   * createMany): returns true when THIS call inserted, false when the
   * partial unique index `ApprovalTask_one_pending` skipped it because a
   * concurrent transaction already owns a pending row. A plain insert would
   * abort the whole transaction in PostgreSQL — the caller then re-reads the
   * scoped winner instead of rolling back.
   */
  createPending(data: {
    companyId: string;
    workflowInstanceId: string;
    stageKey: string;
    fromState: WorkflowState;
    assigneeType: string;
    assigneeValue: string | null;
    selfApprove: boolean;
  }): Promise<boolean>;
  findById(companyId: string, id: string): Promise<ApprovalTask | null>;
  findPending(companyId: string, workflowInstanceId: string): Promise<ApprovalTask | null>;
  /** Optimistic-concurrency close: sets a terminal status iff version matches. */
  close(
    companyId: string,
    id: string,
    data: {
      status: ApprovalTaskStatus;
      decidedByPrincipalId?: string;
      decidedAt: Date;
      decisionAction: string;
      decisionReason?: string;
    },
    expectedVersion?: number,
  ): Promise<ApprovalTask>;
  cancelPending(companyId: string, workflowInstanceId: string): Promise<number>;
  list(
    companyId: string,
    filter?: { status?: string; workflowInstanceId?: string; assigneeValue?: string },
  ): Promise<ApprovalTask[]>;
}

// Persisted submission reads used by guard context + approval RETURN coupling.
export interface SubmissionRepository {
  findByInstanceForm(
    companyId: string,
    workflowInstanceId: string,
    formVersionId: string,
  ): Promise<FormSubmission | null>;
  /** Latest submitted revision's value for a field — null when absent. */
  findSubmittedFieldValue(
    companyId: string,
    workflowInstanceId: string,
    formVersionId: string,
    fieldKey: string,
  ): Promise<{ value: unknown } | null>;
  markReturned(
    companyId: string,
    id: string,
    returnedReason: string,
    expectedVersion?: number,
  ): Promise<FormSubmission>;
}

export interface WorkflowInstanceRepos {
  instances: WorkflowInstanceRepository;
  transitions: WorkflowTransitionRepository;
  approvalTasks: ApprovalTaskRepository;
  submissions: SubmissionRepository;
  workflows: WorkflowQuery;
  workflowVersions: WorkflowVersionQuery;
  ruleVersions: RuleVersionQuery;
  formVersions: {
    findFieldSpec(
      companyId: string,
      formVersionId: string,
      fieldKey: string,
    ): Promise<BoundFieldSpec | null>;
  };
  operations: OperationRepository;
  departments: DepartmentRepository;
  audit: AuditRepository;
  // Transactional outbox — emit-side only; the relay owns processing.
  outbox: {
    record(input: {
      companyId: string;
      eventType: string;
      aggregateType: string;
      aggregateId: string;
      eventKey: string;
      recipientPrincipalIds: string[];
      summary: Record<string, string>;
    }): Promise<void>;
  };
}

export interface WorkflowInstanceUnitOfWork {
  run<T>(fn: (repos: WorkflowInstanceRepos) => Promise<T>): Promise<T>;
}

export function makeWorkflowInstanceRepos(tx: Tx): WorkflowInstanceRepos {
  const org: OrgRepos = makeOrgRepos(tx);
  const ops = makeOperationRepos(tx);
  return {
    departments: ops.departments,
    operations: ops.operations,
    audit: org.audit,
    outbox: {
      record: async (input) => {
        await tx.outboxEvent.create({
          data: {
            companyId: input.companyId,
            eventType: input.eventType,
            aggregateType: input.aggregateType,
            aggregateId: input.aggregateId,
            eventKey: input.eventKey,
            payload: {
              recipientPrincipalIds: input.recipientPrincipalIds,
              summary: input.summary,
            },
          },
        });
      },
    },
    instances: {
      findById: (companyId, id) => tx.workflowInstance.findFirst({ where: { id, companyId } }),
      list: (companyId, filter) =>
        tx.workflowInstance.findMany({
          where: {
            companyId,
            ...(filter?.workflowId ? { workflowId: filter.workflowId } : {}),
            ...(filter?.operationId ? { operationId: filter.operationId } : {}),
            ...(filter?.state ? { state: filter.state } : {}),
            ...(filter?.businessEntityType
              ? { businessEntityType: filter.businessEntityType }
              : {}),
            ...(filter?.businessEntityId ? { businessEntityId: filter.businessEntityId } : {}),
          },
          orderBy: { id: 'asc' },
        }),
      create: async (companyId, data) => {
        try {
          return await tx.workflowInstance.create({ data: { ...data, companyId } });
        } catch (error) {
          mapOrgWriteError(error, 'WORKFLOW_INSTANCE');
        }
      },
      update: (companyId, id, data, expectedVersion) =>
        scopedUpdate(
          'WORKFLOW_INSTANCE',
          { id, companyId },
          data,
          expectedVersion,
          (args) => tx.workflowInstance.updateMany(args),
          () => tx.workflowInstance.findFirst({ where: { id, companyId } }),
        ),
    },
    transitions: {
      create: async (data) => {
        try {
          return await tx.workflowTransition.create({ data });
        } catch (error) {
          mapOrgWriteError(error, 'WORKFLOW_TRANSITION');
        }
      },
      findByIdempotencyKey: (companyId, workflowInstanceId, key) =>
        tx.workflowTransition.findFirst({
          where: { companyId, workflowInstanceId, idempotencyKey: key },
        }),
      list: (companyId, workflowInstanceId) =>
        tx.workflowTransition.findMany({
          where: { companyId, workflowInstanceId },
          orderBy: { occurredAt: 'asc' },
        }),
    },
    approvalTasks: {
      createPending: async (data) => {
        // ON CONFLICT DO NOTHING — no statement error, tx stays usable.
        const { count } = await tx.approvalTask.createMany({ data: [data], skipDuplicates: true });
        return count === 1;
      },
      findById: (companyId, id) => tx.approvalTask.findFirst({ where: { id, companyId } }),
      findPending: (companyId, workflowInstanceId) =>
        tx.approvalTask.findFirst({
          where: { companyId, workflowInstanceId, status: 'PENDING' },
        }),
      close: (companyId, id, data, expectedVersion) =>
        scopedUpdate<ApprovalTask>(
          'APPROVAL_TASK',
          { id, companyId },
          {
            status: data.status,
            decidedByPrincipalId: data.decidedByPrincipalId ?? null,
            decidedAt: data.decidedAt,
            decisionAction: data.decisionAction,
            decisionReason: data.decisionReason ?? null,
          },
          expectedVersion,
          (args) => tx.approvalTask.updateMany(args),
          () => tx.approvalTask.findFirst({ where: { id, companyId } }),
        ),
      cancelPending: async (companyId, workflowInstanceId) => {
        const res = await tx.approvalTask.updateMany({
          where: { companyId, workflowInstanceId, status: 'PENDING' },
          data: { status: 'CANCELLED' },
        });
        return res.count;
      },
      list: (companyId, filter) =>
        tx.approvalTask.findMany({
          where: {
            companyId,
            ...(filter?.status ? { status: filter.status as never } : {}),
            ...(filter?.workflowInstanceId
              ? { workflowInstanceId: filter.workflowInstanceId }
              : {}),
            ...(filter?.assigneeValue ? { assigneeValue: filter.assigneeValue } : {}),
          },
          orderBy: { id: 'asc' },
        }),
    },
    submissions: {
      findByInstanceForm: (companyId, workflowInstanceId, formVersionId) =>
        tx.formSubmission.findFirst({
          where: { companyId, workflowInstanceId, formVersionId },
        }),
      findSubmittedFieldValue: async (companyId, workflowInstanceId, formVersionId, fieldKey) => {
        const sub = await tx.formSubmission.findFirst({
          where: { companyId, workflowInstanceId, formVersionId },
          select: { currentRevisionId: true },
        });
        const revId = sub?.currentRevisionId;
        if (revId === undefined || revId === null) return null;
        const rev = await tx.submissionRevision.findFirst({
          where: { id: revId, companyId },
          select: { values: true },
        });
        const rv = rev?.values;
        if (rv === undefined || rv === null || typeof rv !== 'object') return null;
        const values = rv as Record<string, unknown>;
        return fieldKey in values ? { value: values[fieldKey] } : null;
      },
      markReturned: (companyId, id, returnedReason, expectedVersion) =>
        scopedUpdate<FormSubmission>(
          'FORM_SUBMISSION',
          { id, companyId },
          { status: 'RETURNED', returnedReason },
          expectedVersion,
          (args) => tx.formSubmission.updateMany(args),
          () => tx.formSubmission.findFirst({ where: { id, companyId } }),
        ),
    },
    workflows: {
      findForStart: (companyId, id) => tx.workflow.findFirst({ where: { id, companyId } }),
    },
    workflowVersions: {
      findById: async (companyId, workflowId, id) => {
        const row = await tx.workflowVersion.findFirst({
          where: { id, workflowId, companyId },
          select: { id: true, definition: true },
        });
        return row === null ? null : { id: row.id, definition: row.definition };
      },
    },
    ruleVersions: {
      findDefinition: async (companyId, id) => {
        const row = await tx.ruleVersion.findFirst({
          where: { id, companyId },
          select: { id: true, definition: true },
        });
        return row === null ? null : { id: row.id, definition: row.definition };
      },
    },
    formVersions: {
      findFieldSpec: async (companyId, formVersionId, fieldKey) => {
        const row = await tx.formVersion.findFirst({
          where: { id: formVersionId, companyId },
          select: { schema: true },
        });
        if (row === null) return null;
        const fields = (row.schema as { fields?: unknown[] }).fields;
        if (!Array.isArray(fields)) return null;
        for (const f of fields) {
          const rec = f as { key?: unknown; type?: unknown; constraints?: unknown };
          if (rec.key !== fieldKey || typeof rec.type !== 'string') continue;
          const opts = (rec.constraints as { options?: unknown } | undefined)?.options;
          return {
            type: rec.type,
            options: Array.isArray(opts)
              ? opts.filter((o): o is string => typeof o === 'string')
              : null,
          };
        }
        return null;
      },
    },
  };
}

export class PrismaWorkflowInstanceUnitOfWork implements WorkflowInstanceUnitOfWork {
  constructor(private readonly prisma: PrismaClient) {}

  run<T>(fn: (repos: WorkflowInstanceRepos) => Promise<T>): Promise<T> {
    return this.prisma.$transaction((tx) => fn(makeWorkflowInstanceRepos(tx)));
  }
}
