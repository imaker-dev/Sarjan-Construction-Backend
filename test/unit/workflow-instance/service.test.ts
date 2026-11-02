import { describe, it, expect, beforeEach } from 'vitest';
import {
  WorkflowInstanceService,
  WF_INSTANCE_READ,
  WF_INSTANCE_START,
  WF_INSTANCE_TRANSITION,
} from '../../../src/modules/workflow-instance/service.js';
import {
  IdempotencyConflictError,
  WorkflowEvaluationError,
  WorkflowGuardDeniedError,
} from '../../../src/modules/workflow-instance/errors.js';
import { WorkflowContextUnavailableError } from '../../../src/modules/workflow-instance/context.js';
import {
  InvalidStatusTransitionError,
  OrgEntityNotFoundError,
  OrgValidationError,
  VersionConflictError,
} from '../../../src/modules/organization/errors.js';
import { AccessDeniedError } from '../../../src/modules/access-control/errors.js';
import {
  emptyInstStore,
  fakeDepartment,
  fakeInstance,
  fakeOperation,
  fakeTask,
  fakeVersionRow,
  fakeWorkflow,
  FakeAuthorizer,
  FakeInstUoW,
  type InstStore,
} from './fakes.js';
import type { ActorContext } from '../../../src/modules/organization/types.js';

const actor: ActorContext = { actorId: 'principal-1', actorType: 'USER' };

// SUBMITTED → APPROVED / REJECTED via approval steps; EXECUTION SUBMIT→IN_REVIEW
// for non-approval coverage; CLOSURE CLOSE→CLOSED.
const definition = {
  initialState: 'SUBMITTED',
  steps: [
    { key: 'do_exec', kind: 'EXECUTION', from: 'SUBMITTED', action: 'EXECUTE', to: 'IN_PROGRESS' },
    { key: 'verify', kind: 'VERIFICATION', from: 'IN_PROGRESS', action: 'VERIFY', to: 'COMPLETED' },
    { key: 'close', kind: 'CLOSURE', from: 'COMPLETED', action: 'CLOSE', to: 'CLOSED' },
    { key: 'cancel', kind: 'CLOSURE', from: 'SUBMITTED', action: 'CANCEL', to: 'CANCELLED' },
    {
      key: 'approve',
      kind: 'APPROVAL',
      from: 'SUBMITTED',
      action: 'APPROVE',
      to: 'APPROVED',
      stageKey: 'pi_review',
      assignee: { type: 'PERMISSION_KEY', value: 'STORE_REQUEST_APPROVE' },
    },
    {
      key: 'guarded',
      kind: 'VERIFICATION',
      from: 'SUBMITTED',
      action: 'VERIFY',
      to: 'COMPLETED',
      ruleVersionId: 'rv1',
    },
  ],
};

const guardedDef = {
  initialState: 'SUBMITTED',
  steps: [
    {
      key: 'guarded',
      kind: 'VERIFICATION',
      from: 'SUBMITTED',
      action: 'VERIFY',
      to: 'COMPLETED',
      ruleVersionId: 'rv1',
    },
    { key: 'close', kind: 'CLOSURE', from: 'COMPLETED', action: 'CLOSE', to: 'CLOSED' },
  ],
};

// amount is bound to pinned FormVersion fv1 — the only way caller input may
// legitimately feed a guard.
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

// A rule that fails evaluation even with valid context (literal of the wrong
// type for DECIMAL comparison).
const invalidRule = {
  when: {
    all: [
      {
        field: 'amount',
        op: 'GT',
        value: 'notanumber',
        fieldType: 'DECIMAL',
        ref: { formVersionId: 'fv1', fieldKey: 'amount' },
      },
    ],
  },
  then: [{ type: 'SET_FLAG', flag: 'ok' }],
};

const amountSpec = {
  formVersionId: 'fv1',
  fieldKey: 'amount',
  companyId: 'c1',
  type: 'DECIMAL',
};

// Seed a submitted revision — the ONLY source bound guard fields may read.
function seedSubmitted(values: Record<string, unknown>, formVersionId = 'fv1'): void {
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

let store: InstStore;
let authorizer: FakeAuthorizer;
let service: WorkflowInstanceService;

function seedActiveWorkflow(
  def: unknown,
  status: 'DRAFT' | 'ACTIVE' | 'INACTIVE' | 'ARCHIVED' = 'ACTIVE',
): void {
  store.workflows.push(
    fakeWorkflow({
      id: 'wf1',
      companyId: 'c1',
      operationId: 'op1',
      operationVersionId: 'ov1',
      status,
      currentVersionId: 'wfv1',
    }),
  );
  store.workflowVersions.push(fakeVersionRow({ id: 'wfv1', workflowId: 'wf1', definition: def }));
}

beforeEach(() => {
  store = emptyInstStore();
  authorizer = new FakeAuthorizer(true);
  service = new WorkflowInstanceService(new FakeInstUoW(store), authorizer);
  store.departments.push(fakeDepartment({ id: 'd1', companyId: 'c1' }));
  store.operations.push(fakeOperation({ id: 'op1', companyId: 'c1', departmentId: 'd1' }));
});

describe('startInstance', () => {
  it('pins workflow + operation versions and audits', async () => {
    seedActiveWorkflow(definition);
    const inst = await service.startInstance(actor, 'c1', 'wf1');
    expect(inst.state).toBe('SUBMITTED');
    expect(inst.workflowVersionId).toBe('wfv1');
    expect(inst.operationVersionId).toBe('ov1');
    expect(inst.operationId).toBe('op1');
    expect(store.auditLog[0]?.action).toBe('WF_INSTANCE_STARTED');
    expect(authorizer.calls[0]?.permissionKey).toBe(WF_INSTANCE_START);
  });

  it('rejects non-ACTIVE workflows and cross-company workflow ids', async () => {
    seedActiveWorkflow(definition, 'DRAFT');
    await expect(service.startInstance(actor, 'c1', 'wf1')).rejects.toThrow(/only ACTIVE/);
    await expect(service.startInstance(actor, 'c1', 'foreign')).rejects.toThrow(
      OrgEntityNotFoundError,
    );
  });

  it('business back-reference: both-or-neither and valid shape', async () => {
    seedActiveWorkflow(definition);
    await expect(
      service.startInstance(actor, 'c1', 'wf1', { businessEntityType: 'STORE_REQUEST' }),
    ).rejects.toThrow(OrgValidationError);
    await expect(
      service.startInstance(actor, 'c1', 'wf1', { businessEntityId: 'x' }),
    ).rejects.toThrow(OrgValidationError);
    const inst = await service.startInstance(actor, 'c1', 'wf1', {
      businessEntityType: 'STORE_REQUEST',
      businessEntityId: '44444444-4444-4444-4444-444444444444',
    });
    expect(inst.businessEntityType).toBe('STORE_REQUEST');
  });
});

describe('transition', () => {
  const seeded = () => {
    seedActiveWorkflow(definition);
    store.instances.push(fakeInstance({ id: 'i1' }));
    store.ruleVersions.push({ id: 'rv1', companyId: 'c1', definition: guardRule });
  };

  it('moves state, records transition + audit', async () => {
    seeded();
    const r = await service.transition(actor, 'c1', 'i1', { action: 'EXECUTE' });
    expect(r.replayed).toBe(false);
    expect(r.instance.state).toBe('IN_PROGRESS');
    expect(r.transition?.stepKey).toBe('do_exec');
    expect(store.auditLog.some((a) => a.action === 'WF_TRANSITION')).toBe(true);
    expect(authorizer.calls[0]?.permissionKey).toBe(WF_INSTANCE_TRANSITION);
    // Transactional outbox — same tx as the transition.
    const ev = store.outboxEvents.find((e) => e.eventType === 'WORKFLOW_TRANSITIONED');
    expect(ev).toBeDefined();
    expect(ev?.eventKey).toContain(`evt:i1:WORKFLOW_TRANSITIONED:v`);
  });

  it('rejects terminal instances, wrong action, stale version', async () => {
    seeded();
    await expect(service.transition(actor, 'c1', 'i1', { action: 'CLOSE' })).rejects.toThrow(
      InvalidStatusTransitionError,
    );
    await service.transition(actor, 'c1', 'i1', { action: 'CANCEL' });
    await expect(service.transition(actor, 'c1', 'i1', { action: 'EXECUTE' })).rejects.toThrow(
      InvalidStatusTransitionError,
    );
    store.instances.push(fakeInstance({ id: 'i2' }));
    await expect(
      service.transition(actor, 'c1', 'i2', { action: 'EXECUTE', expectedVersion: 9 }),
    ).rejects.toThrow(VersionConflictError);
  });

  it('APPROVAL actions open a pending task instead of transitioning', async () => {
    seeded();
    const r = await service.transition(actor, 'c1', 'i1', { action: 'APPROVE' });
    expect(r.pendingApproval).toBe(true);
    expect(r.task?.status).toBe('PENDING');
    expect(r.task?.stageKey).toBe('pi_review');
    expect(r.transition).toBeUndefined();
    expect(store.instances.find((i) => i.id === 'i1')?.state).toBe('SUBMITTED');
  });

  it('opens a task when the definition begins in an approval stage', async () => {
    seedActiveWorkflow(definition);
    await service.startInstance(actor, 'c1', 'wf1');
    const task = store.approvalTasks.find((t) => t.status === 'PENDING');
    expect(task?.stageKey).toBe('pi_review');
    expect(store.auditLog.some((a) => a.action === 'APPROVAL_TASK_OPENED')).toBe(true);
  });

  it('opens a task when a transition lands on an approval stage', async () => {
    seedActiveWorkflow({
      initialState: 'SUBMITTED',
      steps: [
        {
          key: 'submit',
          kind: 'EXECUTION',
          from: 'SUBMITTED',
          action: 'EXECUTE',
          to: 'IN_REVIEW',
        },
        {
          key: 'approve',
          kind: 'APPROVAL',
          from: 'IN_REVIEW',
          action: 'APPROVE',
          to: 'APPROVED',
          stageKey: 'mgr',
          assignee: { type: 'INITIATOR' },
        },
        { key: 'close', kind: 'CLOSURE', from: 'APPROVED', action: 'CLOSE', to: 'CLOSED' },
      ],
    });
    store.instances.push(fakeInstance({ id: 'i1' }));
    const r = await service.transition(actor, 'c1', 'i1', { action: 'EXECUTE' });
    expect(r.instance.state).toBe('IN_REVIEW');
    expect(r.task?.stageKey).toBe('mgr');
    expect(store.approvalTasks[0]?.status).toBe('PENDING');
  });

  it('concurrent task open: the losing caller gets the winning pending task — no rollback', async () => {
    seedActiveWorkflow({
      initialState: 'SUBMITTED',
      steps: [
        {
          key: 'submit',
          kind: 'EXECUTION',
          from: 'SUBMITTED',
          action: 'EXECUTE',
          to: 'IN_REVIEW',
        },
        {
          key: 'approve',
          kind: 'APPROVAL',
          from: 'IN_REVIEW',
          action: 'APPROVE',
          to: 'APPROVED',
          stageKey: 'mgr',
          assignee: { type: 'INITIATOR' },
        },
        { key: 'close', kind: 'CLOSURE', from: 'APPROVED', action: 'CLOSE', to: 'CLOSED' },
      ],
    });
    store.instances.push(fakeInstance({ id: 'i1' }));
    // A "concurrent" transaction commits its pending row between our
    // findPending and insert — the fake's injectApprovalWinner models the
    // ON CONFLICT DO NOTHING skip (returns false, winner appears).
    store.injectApprovalWinner = fakeTask({
      id: 'task-winner',
      workflowInstanceId: 'i1',
      stageKey: 'mgr',
    });
    const r = await service.transition(actor, 'c1', 'i1', { action: 'EXECUTE' });
    expect(r.instance.state).toBe('IN_REVIEW'); // transition not rolled back
    expect(r.task?.id).toBe('task-winner'); // loser's result is the winner's task
    const pendings = store.approvalTasks.filter(
      (t) => t.workflowInstanceId === 'i1' && t.status === 'PENDING',
    );
    expect(pendings).toHaveLength(1); // exactly one pending task
    // Only the winner's audit record — no duplicate OPENED entry.
    expect(store.auditLog.filter((a) => a.action === 'APPROVAL_TASK_OPENED')).toHaveLength(0);
  });

  it('skipped insert with no visible winner is a hard failure — not silently continued', async () => {
    seeded();
    store.alwaysSkipTaskInsert = true;
    await expect(service.transition(actor, 'c1', 'i1', { action: 'APPROVE' })).rejects.toThrow(
      /insert skipped/,
    );
  });

  it('cancelling the instance cancels its pending approval task', async () => {
    seeded();
    await service.transition(actor, 'c1', 'i1', { action: 'APPROVE' });
    expect(store.approvalTasks[0]?.status).toBe('PENDING');
    await service.transition(actor, 'c1', 'i1', { action: 'CANCEL' });
    expect(store.approvalTasks[0]?.status).toBe('CANCELLED');
    expect(store.instances.find((i) => i.id === 'i1')?.state).toBe('CANCELLED');
  });

  it('guard MATCH proceeds, NO_MATCH denies — persisted values only', async () => {
    seedActiveWorkflow(guardedDef);
    store.instances.push(fakeInstance({ id: 'i1' }));
    store.ruleVersions.push({ id: 'rv1', companyId: 'c1', definition: guardRule });
    store.formVersionSpecs.push(amountSpec);
    seedSubmitted({ amount: 50 }); // persisted, too low
    await expect(service.transition(actor, 'c1', 'i1', { action: 'VERIFY' })).rejects.toThrow(
      WorkflowGuardDeniedError,
    );
    // Resubmission advances the revision — MATCH now.
    const rev = store.submissionRevisions[0];
    if (rev === undefined) throw new Error('missing seeded revision');
    rev.values = { amount: 150 };
    const r = await service.transition(actor, 'c1', 'i1', { action: 'VERIFY' });
    expect(r.transition?.ruleOutcome).toBe('MATCH');
    expect(r.transition?.ruleVersionId).toBe('rv1');
  });

  it('guard INVALID → WorkflowEvaluationError (never misclassified)', async () => {
    seedActiveWorkflow(guardedDef);
    store.instances.push(fakeInstance({ id: 'i1' }));
    store.ruleVersions.push({ id: 'rv1', companyId: 'c1', definition: invalidRule });
    store.formVersionSpecs.push(amountSpec);
    seedSubmitted({ amount: 150 });
    await expect(service.transition(actor, 'c1', 'i1', { action: 'VERIFY' })).rejects.toThrow(
      WorkflowEvaluationError,
    );
  });

  it('context provenance: unbound fields fail closed — caller cannot inject', async () => {
    seedActiveWorkflow(guardedDef);
    store.instances.push(fakeInstance({ id: 'i1' }));
    // Rule references `amount` WITHOUT a ref — no verified source exists.
    store.ruleVersions.push({
      id: 'rv1',
      companyId: 'c1',
      definition: {
        when: { all: [{ field: 'amount', op: 'GT', value: 100, fieldType: 'DECIMAL' }] },
        then: [{ type: 'SET_FLAG', flag: 'x' }],
      },
    });
    // No caller channel exists — fails closed, never evaluated.
    await expect(service.transition(actor, 'c1', 'i1', { action: 'VERIFY' })).rejects.toThrow(
      WorkflowContextUnavailableError,
    );
    expect(store.instances.find((i) => i.id === 'i1')?.state).toBe('SUBMITTED');
  });

  it('context provenance: missing or invalid persisted values fail closed', async () => {
    seedActiveWorkflow(guardedDef);
    store.instances.push(fakeInstance({ id: 'i1' }));
    store.ruleVersions.push({ id: 'rv1', companyId: 'c1', definition: guardRule });
    // Missing FormVersion spec → unavailable.
    await expect(service.transition(actor, 'c1', 'i1', { action: 'VERIFY' })).rejects.toThrow(
      WorkflowContextUnavailableError,
    );
    store.formVersionSpecs.push(amountSpec);
    // No submission at all → unavailable.
    await expect(service.transition(actor, 'c1', 'i1', { action: 'VERIFY' })).rejects.toThrow(
      WorkflowContextUnavailableError,
    );
    // Draft-only submission (no revision) → unavailable, never reads drafts.
    store.formSubmissions.push({
      id: 'sub-draft',
      companyId: 'c1',
      operationId: 'op1',
      workflowInstanceId: 'i1',
      formId: 'f1',
      formVersionId: 'fv1',
      status: 'DRAFT',
      draftValues: { amount: 9999 },
      latestRevision: 0,
      currentRevisionId: null,
      submittedByPrincipalId: null,
      submittedAt: null,
      returnedReason: null,
      version: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await expect(service.transition(actor, 'c1', 'i1', { action: 'VERIFY' })).rejects.toThrow(
      WorkflowContextUnavailableError,
    );
    // Persisted wrong type → validation fails, never NO_MATCH.
    store.formSubmissions.length = 0;
    seedSubmitted({ amount: 'abc' });
    await expect(service.transition(actor, 'c1', 'i1', { action: 'VERIFY' })).rejects.toThrow(
      WorkflowContextUnavailableError,
    );
    expect(store.instances.find((i) => i.id === 'i1')?.state).toBe('SUBMITTED');
  });

  it('context tampering: protected keys come only from the server', async () => {
    seedActiveWorkflow({
      initialState: 'SUBMITTED',
      steps: [
        {
          key: 'g',
          kind: 'VERIFICATION',
          from: 'SUBMITTED',
          action: 'VERIFY',
          to: 'COMPLETED',
          ruleVersionId: 'rv2',
        },
        { key: 'close', kind: 'CLOSURE', from: 'COMPLETED', action: 'CLOSE', to: 'CLOSED' },
      ],
    });
    store.instances.push(fakeInstance({ id: 'i1' }));
    // Guard requires state === 'SUBMITTED' — resolved server-side only.
    store.ruleVersions.push({
      id: 'rv2',
      companyId: 'c1',
      definition: {
        when: { all: [{ field: 'state', op: 'EQ', value: 'SUBMITTED', fieldType: 'STRING' }] },
        then: [{ type: 'SET_FLAG', flag: 'x' }],
      },
    });
    const r = await service.transition(actor, 'c1', 'i1', { action: 'VERIFY' });
    expect(r.instance.state).toBe('COMPLETED');
  });
});

describe('idempotency', () => {
  const seeded = () => {
    seedActiveWorkflow(definition);
    store.instances.push(fakeInstance({ id: 'i1' }));
  };

  it('same key + same action replays the recorded transition', async () => {
    seeded();
    const first = await service.transition(actor, 'c1', 'i1', {
      action: 'EXECUTE',
      idempotencyKey: 'k1',
    });
    // Simulate a replayed request — instance now IN_PROGRESS so a fresh
    // execution would fail; replay must return the recorded result instead.
    const second = await service.transition(actor, 'c1', 'i1', {
      action: 'EXECUTE',
      idempotencyKey: 'k1',
    });
    expect(second.replayed).toBe(true);
    expect(second.transition?.id).toBe(first.transition?.id);
    expect(store.transitions).toHaveLength(1);
  });

  it('same key + different action/reason → conflict', async () => {
    seeded();
    await service.transition(actor, 'c1', 'i1', {
      action: 'EXECUTE',
      reason: 'first',
      idempotencyKey: 'k1',
    });
    await expect(
      service.transition(actor, 'c1', 'i1', { action: 'CANCEL', idempotencyKey: 'k1' }),
    ).rejects.toThrow(IdempotencyConflictError);
    store.instances.push(fakeInstance({ id: 'i2' }));
    await service.transition(actor, 'c1', 'i2', {
      action: 'EXECUTE',
      reason: 'first',
      idempotencyKey: 'k1',
    });
    await expect(
      service.transition(actor, 'c1', 'i2', {
        action: 'EXECUTE',
        reason: 'different reason',
        idempotencyKey: 'k1',
      }),
    ).rejects.toThrow(IdempotencyConflictError);
  });

  it('expectedVersion is excluded from the fingerprint — a stale-version retry replays', async () => {
    seeded();
    await service.transition(actor, 'c1', 'i1', {
      action: 'EXECUTE',
      idempotencyKey: 'k1',
      expectedVersion: 0,
    });
    // Client retries the same semantic command with an outdated expectedVersion —
    // retry-specific data doesn't change the fingerprint.
    const replay = await service.transition(actor, 'c1', 'i1', {
      action: 'EXECUTE',
      idempotencyKey: 'k1',
      expectedVersion: 0,
    });
    expect(replay.replayed).toBe(true);
    expect(store.transitions).toHaveLength(1);
  });

  it('a concurrent winner with the same fingerprint replays instead of erroring', async () => {
    seeded();
    // Simulate a completed concurrent request: a transition row exists with
    // the same key. The unique-guard catch path returns it.
    const first = await service.transition(actor, 'c1', 'i1', {
      action: 'EXECUTE',
      idempotencyKey: 'k1',
      reason: 'r',
    });
    const second = await service.transition(actor, 'c1', 'i1', {
      action: 'EXECUTE',
      idempotencyKey: 'k1',
      reason: 'r',
    });
    expect(second.replayed).toBe(true);
    expect(second.transition?.id).toBe(first.transition?.id);
    expect(store.transitions).toHaveLength(1);
  });

  it('replay is authorized first — denied actor cannot read recorded result', async () => {
    seeded();
    await service.transition(actor, 'c1', 'i1', { action: 'EXECUTE', idempotencyKey: 'k1' });
    const denying = new WorkflowInstanceService(new FakeInstUoW(store), new FakeAuthorizer(false));
    await expect(
      denying.transition(actor, 'c1', 'i1', { action: 'EXECUTE', idempotencyKey: 'k1' }),
    ).rejects.toThrow(AccessDeniedError);
  });
});

describe('retired config and authorization', () => {
  it('archived definitions block new starts but in-flight instances continue', async () => {
    seedActiveWorkflow(definition);
    store.instances.push(fakeInstance({ id: 'i1' }));
    const wf = store.workflows.find((w) => w.id === 'wf1');
    if (wf === undefined) throw new Error('seed missing');
    wf.status = 'ARCHIVED';
    await expect(service.startInstance(actor, 'c1', 'wf1')).rejects.toThrow(/only ACTIVE/);
    const r = await service.transition(actor, 'c1', 'i1', { action: 'EXECUTE' });
    expect(r.instance.state).toBe('IN_PROGRESS');
  });

  it('denies unauthorized start/transition/read and enforces read permission', async () => {
    seedActiveWorkflow(definition);
    const denying = new WorkflowInstanceService(new FakeInstUoW(store), new FakeAuthorizer(false));
    await expect(denying.startInstance(actor, 'c1', 'wf1')).rejects.toThrow(AccessDeniedError);
    await expect(denying.listInstances(actor, 'c1')).rejects.toThrow(AccessDeniedError);
    await service.listInstances(actor, 'c1');
    expect(authorizer.calls[0]?.permissionKey).toBe(WF_INSTANCE_READ);
  });

  it('cross-company instance access is not found', async () => {
    seedActiveWorkflow(definition);
    store.instances.push(fakeInstance({ id: 'i1', companyId: 'other' }));
    await expect(service.transition(actor, 'c1', 'i1', { action: 'EXECUTE' })).rejects.toThrow(
      OrgEntityNotFoundError,
    );
  });
});

describe('ambiguous definitions rejected at publish time', () => {
  it('duplicate (from, action) pairs are invalid descriptors', async () => {
    const { assertValidWorkflowDefinition } =
      await import('../../../src/modules/workflow/definition-validation.js');
    expect(() => {
      assertValidWorkflowDefinition({
        initialState: 'SUBMITTED',
        steps: [
          { key: 'a', kind: 'EXECUTION', from: 'SUBMITTED', action: 'EXECUTE', to: 'IN_PROGRESS' },
          { key: 'b', kind: 'EXECUTION', from: 'SUBMITTED', action: 'EXECUTE', to: 'COMPLETED' },
        ],
      });
    }).toThrow(/ambiguous|duplicate/);
  });
});
