import type { ApprovalDecision, Employee, WorkflowInstance } from '@prisma/client';
import type {
  ApprovalRepos,
  ApprovalUnitOfWork,
  AssignmentRow,
} from '../../../src/modules/approval/repository.js';
import type { ScopeTarget } from '../../../src/modules/access-control/service.js';
import { AccessDeniedError } from '../../../src/modules/access-control/errors.js';
import { DuplicateCodeError } from '../../../src/modules/organization/errors.js';
import { emptyInstStore, makeInstRepos } from '../workflow-instance/fakes.js';
import type { InstStore } from '../workflow-instance/fakes.js';
import { fakeDepartment, fakeOperation } from '../workflow-instance/fakes.js';

export { fakeDepartment, fakeOperation };

export interface ApprovalStore extends InstStore {
  approvalDecisions: ApprovalDecision[];
  roleAssignments: AssignmentRow[];
  employees: Employee[];
  sites: { id: string; companyId: string; projectId: string }[];
  projects: { id: string; companyId: string; headOfficeId: string | null }[];
}

export function emptyApprovalStore(): ApprovalStore {
  return {
    ...emptyInstStore(),
    approvalDecisions: [],
    roleAssignments: [],
    employees: [],
    sites: [],
    projects: [],
  };
}

let nextId = 0;
const genId = () => `ap-id-${++nextId}`;

export function fakeTask(over: Partial<ApprovalStore['approvalTasks'][number]> = {}) {
  return {
    id: genId(),
    companyId: 'c1',
    workflowInstanceId: 'i1',
    stageKey: 'pi_stage',
    fromState: 'SUBMITTED' as const,
    assigneeType: 'PERMISSION_KEY',
    assigneeValue: 'STORE_REQUEST_APPROVE',
    selfApprove: false,
    status: 'PENDING' as const,
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

export function fakeAssignment(over: Partial<AssignmentRow> = {}): AssignmentRow {
  const row: AssignmentRow = {
    id: genId(),
    principalId: 'principal-1',
    roleId: 'role-1',
    companyId: 'c1',
    scopeType: 'COMPANY',
    headOfficeId: null,
    projectId: null,
    siteId: null,
    grantedByPrincipalId: null,
    effectiveFrom: null,
    effectiveTo: null,
    revokedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    role: { key: 'site_pi' },
    ...over,
  };
  return row;
}

export function makeApprovalTestRepos(store: ApprovalStore): ApprovalRepos {
  return {
    ...makeInstRepos(store),
    approvalDecisions: {
      create: async (data) => {
        if (
          data.idempotencyKey !== undefined &&
          store.approvalDecisions.some(
            (d) =>
              d.approvalTaskId === data.approvalTaskId && d.idempotencyKey === data.idempotencyKey,
          )
        ) {
          throw new DuplicateCodeError('APPROVAL_DECISION');
        }
        const d: ApprovalDecision = {
          id: genId(),
          companyId: data.companyId,
          approvalTaskId: data.approvalTaskId,
          outcome: data.outcome,
          action: data.action,
          actorPrincipalId: data.actorPrincipalId ?? null,
          actorType: data.actorType,
          reason: data.reason ?? null,
          idempotencyKey: data.idempotencyKey ?? null,
          requestFingerprint: data.requestFingerprint ?? null,
          eventKey: data.eventKey,
          decidedAt: new Date(),
        };
        store.approvalDecisions.push(d);
        return d;
      },
      findByIdempotencyKey: async (companyId, approvalTaskId, key) =>
        store.approvalDecisions.find(
          (d) =>
            d.companyId === companyId &&
            d.approvalTaskId === approvalTaskId &&
            d.idempotencyKey === key,
        ) ?? null,
      listByTask: async (companyId, approvalTaskId) =>
        store.approvalDecisions.filter(
          (d) => d.companyId === companyId && d.approvalTaskId === approvalTaskId,
        ),
    },
    roleAssignments: {
      listActiveForPrincipal: async (principalId, companyId) =>
        store.roleAssignments.filter(
          (a) => a.principalId === principalId && a.companyId === companyId && a.revokedAt === null,
        ),
    },
    employees: {
      findById: async (companyId, id) =>
        store.employees.find((e) => e.id === id && e.companyId === companyId) ?? null,
    },
    sites: {
      findChain: async (companyId, siteId) =>
        store.sites.find((s) => s.id === siteId && s.companyId === companyId) ?? null,
    },
    projects: {
      findChain: async (companyId, projectId) =>
        store.projects.find((p) => p.id === projectId && p.companyId === companyId) ?? null,
    },
  };
}

export class FakeApprovalUoW implements ApprovalUnitOfWork {
  constructor(public readonly store: ApprovalStore) {}

  async run<T>(fn: (repos: ApprovalRepos) => Promise<T>): Promise<T> {
    const snapshot = structuredClone(this.store);
    try {
      return await fn(makeApprovalTestRepos(this.store));
    } catch (error) {
      Object.assign(this.store, structuredClone(snapshot));
      throw error;
    }
  }
}

// Grant/deny control over both assertPermission and hasPermission.
export class FakeApprovalAuthorizer {
  calls: { permissionKey: string; target: ScopeTarget }[] = [];
  constructor(
    private allow = true,
    public grantedKeys: Set<string> = new Set(),
  ) {}
  async assertPermission(
    _principalId: string,
    permissionKey: string,
    target: ScopeTarget,
  ): Promise<void> {
    this.calls.push({ permissionKey, target });
    if (!this.allow) throw new AccessDeniedError();
  }
  async hasPermission(_principalId: string, permissionKey: string): Promise<boolean> {
    return this.grantedKeys.has(permissionKey);
  }
}

export function seededApprovalInstance(over: Partial<WorkflowInstance> = {}): WorkflowInstance {
  return {
    id: 'i1',
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
    startedByPrincipalId: 'principal-9', // someone else — avoids SoD by default
    startedAt: new Date(),
    closedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}
