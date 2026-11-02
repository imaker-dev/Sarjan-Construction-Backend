import type {
  ApprovalTask,
  Department,
  FormSubmission,
  Operation,
  OutboxEvent,
  SubmissionRevision,
  Workflow,
  WorkflowInstance,
  WorkflowTransition,
  WorkflowVersion,
} from '@prisma/client';
import type {
  WorkflowInstanceRepos,
  WorkflowInstanceUnitOfWork,
} from '../../../src/modules/workflow-instance/repository.js';
import type { AuditRecord } from '../../../src/modules/organization/types.js';
import {
  DuplicateCodeError,
  VersionConflictError,
} from '../../../src/modules/organization/errors.js';
import { FakeAuthorizer, fakeDepartment } from '../department/fakes.js';
import { fakeOperation } from '../operation/fakes.js';
import { fakeWorkflow } from '../workflow/fakes.js';

export { FakeAuthorizer, fakeDepartment, fakeOperation, fakeWorkflow };

export interface InstStore {
  departments: Department[];
  operations: Operation[];
  workflows: Workflow[];
  workflowVersions: { id: string; companyId: string; workflowId: string; definition: unknown }[];
  ruleVersions: { id: string; companyId: string; definition: unknown }[];
  formVersionSpecs: {
    formVersionId: string;
    fieldKey: string;
    companyId: string;
    type: string;
    options?: string[];
  }[];
  instances: WorkflowInstance[];
  transitions: WorkflowTransition[];
  approvalTasks: ApprovalTask[];
  formSubmissions: FormSubmission[];
  submissionRevisions: SubmissionRevision[];
  outboxEvents: OutboxEvent[];
  auditLog: AuditRecord[];
  /** Simulates a concurrent tx committing between findPending and insert. */
  injectApprovalWinner?: ApprovalTask;
  /** Simulates a skipped insert with no winner — defensive path coverage. */
  alwaysSkipTaskInsert?: boolean;
}

export function emptyInstStore(): InstStore {
  return {
    departments: [],
    operations: [],
    workflows: [],
    workflowVersions: [],
    ruleVersions: [],
    formVersionSpecs: [],
    instances: [],
    transitions: [],
    approvalTasks: [],
    formSubmissions: [],
    submissionRevisions: [],
    outboxEvents: [],
    auditLog: [],
  };
}

let nextId = 0;
const genId = () => `00000000-0000-4000-8000-${String(++nextId).padStart(12, '0')}`;

export function fakeVersionRow(
  over: Partial<{ id: string; companyId: string; workflowId: string; definition: unknown }> = {},
) {
  return { id: genId(), companyId: 'c1', workflowId: 'wf1', definition: {}, ...over };
}

export function fakeTask(over: Partial<ApprovalTask> = {}): ApprovalTask {
  return {
    id: genId(),
    companyId: 'c1',
    workflowInstanceId: 'i1',
    stageKey: 'stage-1',
    fromState: 'IN_REVIEW',
    assigneeType: 'INITIATOR',
    assigneeValue: null,
    selfApprove: false,
    status: 'PENDING',
    decidedByPrincipalId: null,
    decidedAt: null,
    decisionAction: null,
    decisionReason: null,
    version: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

export function fakeInstance(over: Partial<WorkflowInstance> = {}): WorkflowInstance {
  return {
    id: genId(),
    companyId: 'c1',
    operationId: 'op1',
    workflowId: 'wf1',
    workflowVersionId: 'wfv1',
    operationVersionId: 'ov1',
    state: 'SUBMITTED',
    businessEntityType: null,
    businessEntityId: null,
    context: null,
    version: 0,
    startedByPrincipalId: null,
    startedAt: new Date(),
    closedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

export function makeInstRepos(store: InstStore): WorkflowInstanceRepos {
  return {
    outbox: {
      record: async (input) => {
        store.outboxEvents.push({
          id: genId(),
          companyId: input.companyId,
          eventType: input.eventType,
          aggregateType: input.aggregateType,
          aggregateId: input.aggregateId,
          eventKey: input.eventKey,
          payload: {
            recipientPrincipalIds: input.recipientPrincipalIds,
            summary: input.summary,
          },
          status: 'PENDING',
          attempts: 0,
          leaseUntil: null,
          nextAttemptAt: new Date(),
          lastError: null,
          processedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      },
    },
    departments: {
      findById: async (companyId, id) => {
        const row = store.departments.find((d) => d.id === id && d.companyId === companyId);
        return row ? { ...row } : null;
      },
      list: async () => [],
      create: async () => store.departments[0] as never,
      update: async () => store.departments[0] as never,
    },
    operations: {
      findById: async (companyId, id) => {
        const row = store.operations.find((o) => o.id === id && o.companyId === companyId);
        return row ? { ...row } : null;
      },
      list: async () => [],
      create: async () => store.operations[0] as never,
      update: async () => store.operations[0] as never,
      updateForPublish: async () => store.operations[0] as never,
    },
    workflows: {
      findForStart: async (companyId, id) => {
        const row = store.workflows.find((w) => w.id === id && w.companyId === companyId);
        return row ? { ...row } : null;
      },
    },
    workflowVersions: {
      findById: async (companyId, workflowId, id) => {
        const row = store.workflowVersions.find(
          (v) => v.id === id && v.workflowId === workflowId && v.companyId === companyId,
        );
        return row ? { id: row.id, definition: row.definition as never } : null;
      },
    },
    ruleVersions: {
      findDefinition: async (companyId, id) => {
        const row = store.ruleVersions.find((v) => v.id === id && v.companyId === companyId);
        return row ? { id: row.id, definition: row.definition as never } : null;
      },
    },
    formVersions: {
      findFieldSpec: async (companyId, formVersionId, fieldKey) => {
        const row = store.formVersionSpecs.find(
          (f) =>
            f.formVersionId === formVersionId &&
            f.fieldKey === fieldKey &&
            f.companyId === companyId,
        );
        return row ? { type: row.type, options: row.options ?? null } : null;
      },
    },
    instances: {
      findById: async (companyId, id) => {
        const row = store.instances.find((i) => i.id === id && i.companyId === companyId);
        return row ? { ...row } : null;
      },
      list: async (companyId, filter) =>
        store.instances
          .filter(
            (i) =>
              i.companyId === companyId &&
              (filter?.workflowId === undefined || i.workflowId === filter.workflowId) &&
              (filter?.operationId === undefined || i.operationId === filter.operationId) &&
              (filter?.state === undefined || i.state === filter.state) &&
              (filter?.businessEntityType === undefined ||
                i.businessEntityType === filter.businessEntityType) &&
              (filter?.businessEntityId === undefined ||
                i.businessEntityId === filter.businessEntityId),
          )
          .map((i) => ({ ...i })),
      create: async (companyId, data) => {
        const inst: WorkflowInstance = {
          id: genId(),
          companyId,
          operationId: data.operationId,
          workflowId: data.workflowId,
          workflowVersionId: data.workflowVersionId,
          operationVersionId: data.operationVersionId,
          state: data.state,
          businessEntityType: data.businessEntityType ?? null,
          businessEntityId: data.businessEntityId ?? null,
          context: (data.context ?? null) as WorkflowInstance['context'],
          version: 0,
          startedByPrincipalId: data.startedByPrincipalId ?? null,
          startedAt: new Date(),
          closedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        store.instances.push(inst);
        return { ...inst };
      },
      update: async (companyId, id, data, expectedVersion) => {
        const inst = store.instances.find((i) => i.id === id && i.companyId === companyId);
        if (!inst) throw new VersionConflictError('WORKFLOW_INSTANCE');
        if (expectedVersion !== undefined && inst.version !== expectedVersion) {
          throw new VersionConflictError('WORKFLOW_INSTANCE');
        }
        Object.assign(inst, data);
        inst.version += 1;
        return { ...inst };
      },
    },
    approvalTasks: {
      createPending: async (data) => {
        // ON CONFLICT DO NOTHING semantics: return false on a concurrent
        // pending row — never throws for the partial-unique conflict. A
        // configured winner materializes at insert time (committed between
        // our findPending and this insert).
        if (store.alwaysSkipTaskInsert === true) return false;
        if (store.injectApprovalWinner !== undefined) {
          store.approvalTasks.push(store.injectApprovalWinner);
          delete store.injectApprovalWinner;
          return false;
        }
        if (
          store.approvalTasks.some(
            (t) => t.workflowInstanceId === data.workflowInstanceId && t.status === 'PENDING',
          )
        ) {
          return false;
        }
        const t: ApprovalTask = {
          id: genId(),
          companyId: data.companyId,
          workflowInstanceId: data.workflowInstanceId,
          stageKey: data.stageKey,
          fromState: data.fromState,
          assigneeType: data.assigneeType,
          assigneeValue: data.assigneeValue,
          selfApprove: data.selfApprove,
          status: 'PENDING',
          decidedByPrincipalId: null,
          decidedAt: null,
          decisionAction: null,
          decisionReason: null,
          version: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        store.approvalTasks.push(t);
        return true;
      },
      findById: async (companyId, id) => {
        const row = store.approvalTasks.find((t) => t.id === id && t.companyId === companyId);
        return row ? { ...row } : null;
      },
      findPending: async (companyId, workflowInstanceId) => {
        const row = store.approvalTasks.find(
          (t) =>
            t.companyId === companyId &&
            t.workflowInstanceId === workflowInstanceId &&
            t.status === 'PENDING',
        );
        return row ? { ...row } : null;
      },
      close: async (companyId, id, data, expectedVersion) => {
        const row = store.approvalTasks.find((t) => t.id === id && t.companyId === companyId);
        if (!row) throw new VersionConflictError('APPROVAL_TASK');
        if (expectedVersion !== undefined && row.version !== expectedVersion) {
          throw new VersionConflictError('APPROVAL_TASK');
        }
        row.status = data.status;
        row.decidedByPrincipalId = data.decidedByPrincipalId ?? null;
        row.decidedAt = data.decidedAt;
        row.decisionAction = data.decisionAction;
        row.decisionReason = data.decisionReason ?? null;
        row.version += 1;
        return { ...row };
      },
      cancelPending: async (companyId, workflowInstanceId) => {
        let n = 0;
        for (const t of store.approvalTasks) {
          if (
            t.companyId === companyId &&
            t.workflowInstanceId === workflowInstanceId &&
            t.status === 'PENDING'
          ) {
            t.status = 'CANCELLED';
            n += 1;
          }
        }
        return n;
      },
      list: async (companyId, filter) =>
        store.approvalTasks
          .filter(
            (t) =>
              t.companyId === companyId &&
              (filter?.status === undefined || t.status === filter.status) &&
              (filter?.workflowInstanceId === undefined ||
                t.workflowInstanceId === filter.workflowInstanceId) &&
              (filter?.assigneeValue === undefined || t.assigneeValue === filter.assigneeValue),
          )
          .map((t) => ({ ...t })),
    },
    submissions: {
      findByInstanceForm: async (companyId, workflowInstanceId, formVersionId) => {
        const row = store.formSubmissions.find(
          (s) =>
            s.companyId === companyId &&
            s.workflowInstanceId === workflowInstanceId &&
            s.formVersionId === formVersionId,
        );
        return row ? { ...row } : null;
      },
      findSubmittedFieldValue: async (companyId, workflowInstanceId, formVersionId, fieldKey) => {
        const sub = store.formSubmissions.find(
          (s) =>
            s.companyId === companyId &&
            s.workflowInstanceId === workflowInstanceId &&
            s.formVersionId === formVersionId,
        );
        if (sub?.currentRevisionId === null || sub?.currentRevisionId === undefined) return null;
        const rev = store.submissionRevisions.find(
          (r) => r.id === sub.currentRevisionId && r.companyId === companyId,
        );
        if (rev === undefined || rev.values === null || typeof rev.values !== 'object') return null;
        const values = rev.values as Record<string, unknown>;
        return fieldKey in values ? { value: values[fieldKey] } : null;
      },
      markReturned: async (companyId, id, returnedReason, expectedVersion) => {
        const row = store.formSubmissions.find((s) => s.id === id && s.companyId === companyId);
        if (!row) throw new VersionConflictError('FORM_SUBMISSION');
        if (expectedVersion !== undefined && row.version !== expectedVersion) {
          throw new VersionConflictError('FORM_SUBMISSION');
        }
        row.status = 'RETURNED';
        row.returnedReason = returnedReason;
        row.version += 1;
        return { ...row };
      },
    },
    transitions: {
      create: async (data) => {
        if (
          data.idempotencyKey !== undefined &&
          store.transitions.some(
            (t) =>
              t.workflowInstanceId === data.workflowInstanceId &&
              t.idempotencyKey === data.idempotencyKey,
          )
        ) {
          throw new DuplicateCodeError('WORKFLOW_TRANSITION');
        }
        const t: WorkflowTransition = {
          id: genId(),
          companyId: data.companyId,
          workflowInstanceId: data.workflowInstanceId,
          fromState: data.fromState,
          toState: data.toState,
          action: data.action,
          stepKey: data.stepKey,
          actorPrincipalId: data.actorPrincipalId ?? null,
          actorType: data.actorType,
          reason: data.reason ?? null,
          ruleVersionId: data.ruleVersionId ?? null,
          ruleOutcome: data.ruleOutcome ?? null,
          idempotencyKey: data.idempotencyKey ?? null,
          requestFingerprint: data.requestFingerprint ?? null,
          eventKey: data.eventKey,
          occurredAt: new Date(),
        };
        store.transitions.push(t);
        return t;
      },
      findByIdempotencyKey: async (companyId, workflowInstanceId, key) =>
        store.transitions.find(
          (t) =>
            t.companyId === companyId &&
            t.workflowInstanceId === workflowInstanceId &&
            t.idempotencyKey === key,
        ) ?? null,
      list: async (companyId, workflowInstanceId) =>
        store.transitions.filter(
          (t) => t.companyId === companyId && t.workflowInstanceId === workflowInstanceId,
        ),
    },
    audit: {
      record: async (entry) => {
        store.auditLog.push(entry);
      },
    },
  };
}

export class FakeInstUoW implements WorkflowInstanceUnitOfWork {
  constructor(public readonly store: InstStore) {}

  async run<T>(fn: (repos: WorkflowInstanceRepos) => Promise<T>): Promise<T> {
    const snapshot = structuredClone(this.store);
    try {
      return await fn(makeInstRepos(this.store));
    } catch (error) {
      Object.assign(this.store, structuredClone(snapshot));
      throw error;
    }
  }
}

export type { WorkflowVersion as WfVersion };
