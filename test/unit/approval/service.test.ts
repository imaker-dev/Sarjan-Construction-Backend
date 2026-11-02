import { describe, it, expect, beforeEach } from 'vitest';
import { ApprovalService } from '../../../src/modules/approval/service.js';
import { WORKFLOW_APPROVAL_DECIDE } from '../../../src/modules/approval/service.js';
import {
  ApprovalTaskClosedError,
  NotTaskAssigneeError,
  SeparationOfDutiesError,
} from '../../../src/modules/approval/errors.js';
import { IdempotencyConflictError } from '../../../src/modules/workflow-instance/errors.js';
import { WorkflowContextUnavailableError } from '../../../src/modules/workflow-instance/context.js';
import {
  InvalidStatusTransitionError,
  OrgEntityNotFoundError,
  OrgValidationError,
} from '../../../src/modules/organization/errors.js';
import { AccessDeniedError } from '../../../src/modules/access-control/errors.js';
import {
  FakeApprovalAuthorizer,
  FakeApprovalUoW,
  emptyApprovalStore,
  fakeAssignment,
  fakeDepartment,
  fakeOperation,
  fakeTask,
  makeApprovalTestRepos,
  seededApprovalInstance,
  type ApprovalStore,
} from './fakes.js';
import type { ActorContext } from '../../../src/modules/organization/types.js';
import type { Employee } from '@prisma/client';

const actor: ActorContext = { actorId: 'principal-1', actorType: 'USER' };
const ASSIGNEE = { type: 'PERMISSION_KEY', value: 'STORE_REQUEST_APPROVE' };

const approvalDef = {
  initialState: 'SUBMITTED',
  steps: [
    {
      key: 'approve',
      kind: 'APPROVAL',
      from: 'SUBMITTED',
      action: 'APPROVE',
      to: 'APPROVED',
      stageKey: 'pi_stage',
      assignee: ASSIGNEE,
    },
    {
      key: 'reject',
      kind: 'APPROVAL',
      from: 'SUBMITTED',
      action: 'REJECT',
      to: 'REJECTED',
      stageKey: 'pi_stage',
      assignee: ASSIGNEE,
    },
    {
      key: 'return',
      kind: 'APPROVAL',
      from: 'SUBMITTED',
      action: 'RETURN',
      to: 'RETURNED',
      stageKey: 'pi_stage',
      assignee: ASSIGNEE,
    },
    { key: 'exec', kind: 'EXECUTION', from: 'SUBMITTED', action: 'EXECUTE', to: 'IN_PROGRESS' },
    { key: 'resubmit', kind: 'EXECUTION', from: 'RETURNED', action: 'SUBMIT', to: 'SUBMITTED' },
  ],
};

const guardedApprovalDef = {
  initialState: 'SUBMITTED',
  steps: [
    {
      key: 'approve',
      kind: 'APPROVAL',
      from: 'SUBMITTED',
      action: 'APPROVE',
      to: 'APPROVED',
      stageKey: 'pi_stage',
      assignee: ASSIGNEE,
      ruleVersionId: 'rv1',
    },
    {
      key: 'reject',
      kind: 'APPROVAL',
      from: 'SUBMITTED',
      action: 'REJECT',
      to: 'REJECTED',
      stageKey: 'pi_stage',
      assignee: ASSIGNEE,
      ruleVersionId: 'rv1',
    },
  ],
};

const returnDef = {
  initialState: 'SUBMITTED',
  steps: [
    {
      key: 'approve',
      kind: 'APPROVAL',
      from: 'SUBMITTED',
      action: 'APPROVE',
      to: 'APPROVED',
      stageKey: 'pi_stage',
      assignee: ASSIGNEE,
    },
    {
      key: 'return',
      kind: 'APPROVAL',
      from: 'SUBMITTED',
      action: 'RETURN',
      to: 'RETURNED',
      stageKey: 'pi_stage',
      assignee: ASSIGNEE,
      formVersionId: 'fv1',
    },
    { key: 'resubmit', kind: 'EXECUTION', from: 'RETURNED', action: 'SUBMIT', to: 'SUBMITTED' },
  ],
};

const guardRule = {
  when: {
    all: [
      {
        field: 'amount',
        op: 'GT',
        value: 100,
        fieldType: 'DECIMAL',
        ref: { formVersionId: 'fv1', fieldKey: 'amount' },
      },
    ],
  },
  then: [{ type: 'SET_FLAG', flag: 'ok' }],
};

let store: ApprovalStore;
let authorizer: FakeApprovalAuthorizer;
let service: ApprovalService;

// Seed a submitted revision on instance i1 — the only source guards read.
function seedSubmittedApproval(values: Record<string, unknown>, formVersionId = 'fv1'): void {
  const subId = `sub-${formVersionId}`;
  const revId = `rev-${formVersionId}`;
  store.formSubmissions.push({
    id: subId,
    companyId: 'c1',
    operationId: 'op1',
    workflowInstanceId: 'i1',
    formId: 'f1',
    formVersionId,
    status: 'SUBMITTED',
    draftValues: null,
    latestRevision: 1,
    currentRevisionId: revId,
    submittedByPrincipalId: null,
    submittedAt: new Date(),
    returnedReason: null,
    version: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  store.submissionRevisions.push({
    id: revId,
    companyId: 'c1',
    submissionId: subId,
    revision: 1,
    values: values as never,
    submittedAt: new Date(),
    submittedByPrincipalId: null,
    idempotencyKey: null,
    requestFingerprint: null,
    eventKey: `ev-${revId}`,
  });
}

// Narrowed accessors — non-null without `!`.
function task() {
  const t = store.approvalTasks[0];
  if (t === undefined) throw new Error('no seeded task');
  return t;
}
function inst() {
  const i = store.instances[0];
  if (i === undefined) throw new Error('no seeded instance');
  return i;
}
function dept() {
  const d = store.departments[0];
  if (d === undefined) throw new Error('no seeded department');
  return d;
}

function seed(def: unknown = approvalDef, taskOver: Record<string, unknown> = {}) {
  store.departments.push(fakeDepartment({ id: 'd1', companyId: 'c1' }));
  store.operations.push(fakeOperation({ id: 'op1', companyId: 'c1', departmentId: 'd1' }));
  store.workflowVersions.push({ id: 'wfv1', companyId: 'c1', workflowId: 'wf1', definition: def });
  store.instances.push(seededApprovalInstance());
  store.approvalTasks.push(fakeTask(taskOver));
}

beforeEach(() => {
  store = emptyApprovalStore();
  authorizer = new FakeApprovalAuthorizer(true, new Set(['STORE_REQUEST_APPROVE']));
  service = new ApprovalService(new FakeApprovalUoW(store), authorizer);
});

describe('decideTask — outcomes', () => {
  it('APPROVE closes the task and applies the pinned transition atomically', async () => {
    seed();
    const r = await service.decideTask(actor, 'c1', task().id, {
      action: 'APPROVE',
    });
    expect(r.replayed).toBe(false);
    expect(r.instance.state).toBe('APPROVED');
    expect(r.task.status).toBe('APPROVED');
    expect(r.task.decidedByPrincipalId).toBe('principal-1');
    expect(r.decision.outcome).toBe('APPROVED');
    expect(r.transition.toState).toBe('APPROVED');
    expect(r.transition.stepKey).toBe('approve'); // pinned step, not caller input
    const actions = store.auditLog.map((a) => a.action);
    expect(actions).toContain('APPROVAL_DECIDED');
    expect(actions).toContain('WF_TRANSITION');
  });

  it('REJECT and RETURN require a reason and land on pinned destinations', async () => {
    seed();
    const id = task().id;
    await expect(service.decideTask(actor, 'c1', id, { action: 'REJECT' })).rejects.toThrow(
      OrgValidationError,
    );
    await expect(
      service.decideTask(actor, 'c1', id, { action: 'RETURN', reason: '  ' }),
    ).rejects.toThrow(OrgValidationError);
    const r = await service.decideTask(actor, 'c1', id, {
      action: 'REJECT',
      reason: 'incomplete',
    });
    expect(r.instance.state).toBe('REJECTED');
    expect(r.decision.reason).toBe('incomplete');
  });

  it('rejects actions not declared on the stage', async () => {
    seed();
    await expect(
      service.decideTask(actor, 'c1', task().id, {
        // @ts-expect-error — invalid literal guarded at runtime too
        action: 'CLOSE',
      }),
    ).rejects.toThrow(OrgValidationError);
  });
});

describe('decideTask — assignee resolution', () => {
  it('denies a permitted actor who does not satisfy PERMISSION_KEY', async () => {
    seed();
    authorizer.grantedKeys.clear();
    await expect(service.decideTask(actor, 'c1', task().id, { action: 'APPROVE' })).rejects.toThrow(
      NotTaskAssigneeError,
    );
  });

  it('ROLE_KEY resolves via an active in-scope assignment, fails closed without one', async () => {
    seed(approvalDef, { assigneeType: 'ROLE_KEY', assigneeValue: 'site_pi' });
    const id = task().id;
    await expect(service.decideTask(actor, 'c1', id, { action: 'APPROVE' })).rejects.toThrow(
      NotTaskAssigneeError,
    );
    store.roleAssignments.push(fakeAssignment({ role: { key: 'site_pi' } }));
    const r = await service.decideTask(actor, 'c1', id, { action: 'APPROVE' });
    expect(r.instance.state).toBe('APPROVED');
  });

  it('INITIATOR passes only when the actor started the instance (with selfApprove)', async () => {
    seed(approvalDef, { assigneeType: 'INITIATOR', selfApprove: true });
    inst().startedByPrincipalId = 'principal-1';
    const r = await service.decideTask(actor, 'c1', task().id, {
      action: 'APPROVE',
    });
    expect(r.instance.state).toBe('APPROVED');
  });

  it('DEPARTMENT_HEAD resolves via the department head employee link', async () => {
    seed(approvalDef, { assigneeType: 'DEPARTMENT_HEAD', assigneeValue: null });
    dept().headEmployeeId = 'e1';
    const id = task().id;
    await expect(service.decideTask(actor, 'c1', id, { action: 'APPROVE' })).rejects.toThrow(
      NotTaskAssigneeError,
    );
    store.employees.push({ id: 'e1', companyId: 'c1', principalId: 'principal-1' } as Employee);
    const r = await service.decideTask(actor, 'c1', id, { action: 'APPROVE' });
    expect(r.instance.state).toBe('APPROVED');
  });
});

describe('decideTask — separation of duties', () => {
  it('denies the initiator when selfApprove is off, allows when on', async () => {
    seed();
    inst().startedByPrincipalId = 'principal-1';
    await expect(service.decideTask(actor, 'c1', task().id, { action: 'APPROVE' })).rejects.toThrow(
      SeparationOfDutiesError,
    );
    task().selfApprove = true;
    const r = await service.decideTask(actor, 'c1', task().id, {
      action: 'APPROVE',
    });
    expect(r.instance.state).toBe('APPROVED');
  });
});

describe('decideTask — state, guards, idempotency', () => {
  it('rejects a non-pending task and a stale instance state', async () => {
    seed();
    task().status = 'APPROVED';
    await expect(service.decideTask(actor, 'c1', task().id, { action: 'APPROVE' })).rejects.toThrow(
      ApprovalTaskClosedError,
    );
    task().status = 'PENDING';
    inst().state = 'IN_PROGRESS';
    await expect(service.decideTask(actor, 'c1', task().id, { action: 'APPROVE' })).rejects.toThrow(
      InvalidStatusTransitionError,
    );
  });

  it('enforces the stage guard — missing trusted context fails closed', async () => {
    seed(guardedApprovalDef, { stageKey: 'pi_stage' });
    store.ruleVersions.push({ id: 'rv1', companyId: 'c1', definition: guardRule });
    store.formVersionSpecs.push({
      formVersionId: 'fv1',
      fieldKey: 'amount',
      companyId: 'c1',
      type: 'DECIMAL',
    });
    const id = task().id;
    await expect(service.decideTask(actor, 'c1', id, { action: 'APPROVE' })).rejects.toThrow(
      WorkflowContextUnavailableError,
    );
    // Persisted revision is the only source — no caller channel exists.
    seedSubmittedApproval({ amount: 150 });
    const r = await service.decideTask(actor, 'c1', id, { action: 'APPROVE' });
    expect(r.instance.state).toBe('APPROVED');
    expect(r.transition.ruleOutcome).toBe('MATCH');
  });

  it('idempotent replay returns the recorded decision; changed input conflicts', async () => {
    seed();
    const id = task().id;
    const first = await service.decideTask(actor, 'c1', id, {
      action: 'REJECT',
      reason: 'bad docs',
      idempotencyKey: 'k1',
    });
    const second = await service.decideTask(actor, 'c1', id, {
      action: 'REJECT',
      reason: 'bad docs',
      idempotencyKey: 'k1',
    });
    expect(second.replayed).toBe(true);
    expect(second.decision.id).toBe(first.decision.id);
    await expect(
      service.decideTask(actor, 'c1', id, {
        action: 'REJECT',
        reason: 'different',
        idempotencyKey: 'k1',
      }),
    ).rejects.toThrow(IdempotencyConflictError);
    expect(store.approvalDecisions.length).toBe(1);
  });

  it('a second decide on a closed task conflicts (concurrent loser)', async () => {
    seed();
    const id = task().id;
    await service.decideTask(actor, 'c1', id, { action: 'APPROVE' });
    await expect(
      service.decideTask(actor, 'c1', id, { action: 'REJECT', reason: 'x' }),
    ).rejects.toThrow(ApprovalTaskClosedError);
  });

  it("RETURN marks the stage's exact submission RETURNED in the same transaction", async () => {
    seed(returnDef);
    seedSubmittedApproval({ amount: 1 });
    const r = await service.decideTask(actor, 'c1', task().id, {
      action: 'RETURN',
      reason: 'fix the quantity',
    });
    expect(r.instance.state).toBe('RETURNED');
    const sub = store.formSubmissions[0];
    expect(sub?.status).toBe('RETURNED');
    expect(sub?.returnedReason).toBe('fix the quantity');
  });

  it('RETURN fails closed when the named submission is missing', async () => {
    seed(returnDef);
    await expect(
      service.decideTask(actor, 'c1', task().id, { action: 'RETURN', reason: 'fix it' }),
    ).rejects.toThrow(OrgEntityNotFoundError);
    // Rolled back: task still pending, instance unmoved.
    expect(task().status).toBe('PENDING');
    expect(inst().state).toBe('SUBMITTED');
  });

  it('a stale expectedVersion on the instance conflicts', async () => {
    seed();
    await expect(
      service.decideTask(actor, 'c1', task().id, {
        action: 'APPROVE',
        expectedVersion: 9,
      }),
    ).rejects.toThrow();
  });

  it('authorization precedes task visibility and replay', async () => {
    seed();
    const strict = new FakeApprovalAuthorizer(false, new Set(['STORE_REQUEST_APPROVE']));
    const denied = new ApprovalService(new FakeApprovalUoW(store), strict);
    const id = task().id;
    await expect(denied.decideTask(actor, 'c1', id, { action: 'APPROVE' })).rejects.toThrow(
      AccessDeniedError,
    );
    // Cross-company task id → not found, no existence leak.
    await expect(service.decideTask(actor, 'c2', id, { action: 'APPROVE' })).rejects.toThrow(
      OrgEntityNotFoundError,
    );
    expect(authorizer.calls.some((c) => c.permissionKey === WORKFLOW_APPROVAL_DECIDE)).toBe(false);
  });

  it('audit failure rolls back the whole decision', async () => {
    seed();
    const id = task().id;
    const repos = makeApprovalTestRepos(store);
    const failing = {
      ...repos,
      audit: {
        record: async () => {
          throw new Error('audit unavailable');
        },
      },
    };
    const rollbackUow = {
      run: async <T>(fn: (r: typeof failing) => Promise<T>): Promise<T> => {
        const snapshot = structuredClone(store);
        try {
          return await fn(failing);
        } catch (error) {
          Object.assign(store, structuredClone(snapshot));
          throw error;
        }
      },
    };
    const svc = new ApprovalService(rollbackUow, authorizer);
    await expect(svc.decideTask(actor, 'c1', id, { action: 'APPROVE' })).rejects.toThrow();
    // Store untouched: no decision, task still pending, instance unmoved.
    expect(store.approvalDecisions.length).toBe(0);
    expect(task().status).toBe('PENDING');
    expect(inst().state).toBe('SUBMITTED');
  });
});

describe('task reads', () => {
  it('listDecisions requires READ permission and stays scoped', async () => {
    seed();
    const id = task().id;
    await service.decideTask(actor, 'c1', id, { action: 'APPROVE' });
    const decisions = await service.listDecisions(actor, 'c1', id);
    expect(decisions.length).toBe(1);
    const strict = new FakeApprovalAuthorizer(false);
    const denied = new ApprovalService(new FakeApprovalUoW(store), strict);
    await expect(denied.listDecisions(actor, 'c1', id)).rejects.toThrow(AccessDeniedError);
    await expect(service.listDecisions(actor, 'c2', id)).rejects.toThrow(OrgEntityNotFoundError);
  });
});
