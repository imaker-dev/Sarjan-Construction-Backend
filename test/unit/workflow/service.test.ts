import { describe, it, expect, beforeEach } from 'vitest';
import {
  WorkflowService,
  WF_CONFIGURE,
  WF_PUBLISH,
  WF_READ,
} from '../../../src/modules/workflow/service.js';
import { assertValidWorkflowDefinition } from '../../../src/modules/workflow/definition-validation.js';
import {
  DuplicateCodeError,
  InvalidStatusTransitionError,
  OrgEntityNotFoundError,
  OrgValidationError,
  VersionConflictError,
} from '../../../src/modules/organization/errors.js';
import { AccessDeniedError } from '../../../src/modules/access-control/errors.js';
import {
  emptyWfStore,
  fakeDepartment,
  fakeOperation,
  fakeOperationVersion,
  FakeAuthorizer,
  FakeWfUoW,
  type WfStore,
} from './fakes.js';
import type { ActorContext } from '../../../src/modules/organization/types.js';

const actor: ActorContext = { actorId: 'principal-1', actorType: 'USER' };

const validDefinition = {
  initialState: 'SUBMITTED',
  steps: [
    {
      key: 'pi_review',
      kind: 'APPROVAL',
      name: 'PI review',
      from: 'SUBMITTED',
      action: 'APPROVE',
      to: 'APPROVED',
      stageKey: 'pi_stage',
      assignee: { type: 'ROLE_KEY', value: 'site_pi' },
    },
    {
      key: 'pi_reject',
      kind: 'APPROVAL',
      from: 'SUBMITTED',
      action: 'REJECT',
      to: 'REJECTED',
      stageKey: 'pi_stage',
      assignee: { type: 'ROLE_KEY', value: 'site_pi' },
    },
  ],
};

const cyclicDefinition = {
  initialState: 'SUBMITTED',
  steps: [
    {
      key: 'approve',
      kind: 'APPROVAL',
      from: 'SUBMITTED',
      action: 'APPROVE',
      to: 'APPROVED',
      stageKey: 'sr_stage',
      assignee: { type: 'INITIATOR' },
    },
    {
      key: 'return',
      kind: 'APPROVAL',
      from: 'SUBMITTED',
      action: 'RETURN',
      to: 'RETURNED',
      stageKey: 'sr_stage',
      assignee: { type: 'INITIATOR' },
    },
    { key: 'resubmit', kind: 'EXECUTION', from: 'RETURNED', action: 'SUBMIT', to: 'SUBMITTED' },
  ],
};

let store: WfStore;
let authorizer: FakeAuthorizer;
let service: WorkflowService;

beforeEach(() => {
  store = emptyWfStore();
  authorizer = new FakeAuthorizer(true);
  service = new WorkflowService(new FakeWfUoW(store), authorizer);
  store.departments.push(fakeDepartment({ id: 'd1', companyId: 'c1' }));
  store.operations.push(fakeOperation({ id: 'op1', companyId: 'c1', departmentId: 'd1' }));
  store.operationVersions.push(fakeOperationVersion({ id: 'ov1', operationId: 'op1' }));
});

describe('descriptor validation', () => {
  const bad = (def: unknown): void => {
    expect(() => {
      assertValidWorkflowDefinition(def);
    }).toThrow(OrgValidationError);
  };

  it('accepts valid and cyclic (return/resubmit) graphs', () => {
    expect(() => {
      assertValidWorkflowDefinition(validDefinition);
    }).not.toThrow();
    expect(() => {
      assertValidWorkflowDefinition(cyclicDefinition);
    }).not.toThrow();
  });

  it('rejects bad states, actions, kinds, and action-kind mismatches', () => {
    bad({
      initialState: 'SUBMITTED',
      steps: [
        {
          key: 'a',
          kind: 'APPROVAL',
          from: 'SUBMITTED',
          action: 'APPROVE',
          to: 'SOMEWHERE',
          stageKey: 's_a',
          assignee: { type: 'INITIATOR' },
        },
      ],
    });
    bad({
      initialState: 'SUBMITTED',
      steps: [{ key: 'a', kind: 'MAGIC', from: 'SUBMITTED', action: 'APPROVE', to: 'APPROVED' }],
    });
    bad({
      initialState: 'SUBMITTED',
      steps: [
        {
          key: 'a',
          kind: 'APPROVAL',
          from: 'SUBMITTED',
          action: 'DELETE',
          to: 'APPROVED',
          stageKey: 's_a',
          assignee: { type: 'INITIATOR' },
        },
      ],
    });
    bad({
      initialState: 'SUBMITTED',
      steps: [
        { key: 'a', kind: 'EXECUTION', from: 'SUBMITTED', action: 'APPROVE', to: 'APPROVED' },
      ],
    });
    bad({
      initialState: 'SUBMITTED',
      steps: [
        { key: 'a', kind: 'ASSIGNMENT', from: 'SUBMITTED', action: 'APPROVE', to: 'IN_REVIEW' },
      ],
    });
  });

  it('rejects terminal-initial, unreachable, and dead-end states', () => {
    bad({
      initialState: 'APPROVED',
      steps: [
        {
          key: 'a',
          kind: 'APPROVAL',
          from: 'SUBMITTED',
          action: 'APPROVE',
          to: 'APPROVED',
          stageKey: 's_a',
          assignee: { type: 'INITIATOR' },
        },
      ],
    });
    bad({
      initialState: 'SUBMITTED',
      steps: [
        {
          key: 'a',
          kind: 'APPROVAL',
          from: 'SUBMITTED',
          action: 'APPROVE',
          to: 'APPROVED',
          stageKey: 's_a',
          assignee: { type: 'INITIATOR' },
        },
        {
          key: 'b',
          kind: 'APPROVAL',
          from: 'IN_REVIEW',
          action: 'APPROVE',
          to: 'APPROVED',
          stageKey: 's_b',
          assignee: { type: 'INITIATOR' },
        },
      ],
    });
    // Dead end: IN_PROGRESS has no path to a terminal.
    bad({
      initialState: 'SUBMITTED',
      steps: [
        { key: 'a', kind: 'EXECUTION', from: 'SUBMITTED', action: 'EXECUTE', to: 'IN_PROGRESS' },
      ],
    });
    bad({
      initialState: 'SUBMITTED',
      steps: [
        {
          key: 'a',
          kind: 'APPROVAL',
          from: 'SUBMITTED',
          action: 'APPROVE',
          to: 'APPROVED',
          stageKey: 's_a',
          assignee: { type: 'INITIATOR' },
        },
        {
          key: 'b',
          kind: 'APPROVAL',
          from: 'APPROVED',
          action: 'RETURN',
          to: 'RETURNED',
          stageKey: 's_b',
          assignee: { type: 'INITIATOR' },
        },
      ],
    });
  });

  it('enforces action→destination consistency', () => {
    // Every action must land in a semantically consistent state.
    bad({
      initialState: 'SUBMITTED',
      steps: [
        {
          key: 'a',
          kind: 'APPROVAL',
          from: 'SUBMITTED',
          action: 'APPROVE',
          to: 'REJECTED',
          stageKey: 's_a',
          assignee: { type: 'INITIATOR' },
        },
      ],
    });
    bad({
      initialState: 'SUBMITTED',
      steps: [
        {
          key: 'a',
          kind: 'APPROVAL',
          from: 'SUBMITTED',
          action: 'REJECT',
          to: 'APPROVED',
          stageKey: 's_a',
          assignee: { type: 'INITIATOR' },
        },
      ],
    });
    bad({
      initialState: 'SUBMITTED',
      steps: [
        {
          key: 'a',
          kind: 'APPROVAL',
          from: 'SUBMITTED',
          action: 'RETURN',
          to: 'IN_REVIEW',
          stageKey: 's_a',
          assignee: { type: 'INITIATOR' },
        },
      ],
    });
    bad({
      initialState: 'SUBMITTED',
      steps: [{ key: 'a', kind: 'CLOSURE', from: 'SUBMITTED', action: 'CLOSE', to: 'COMPLETED' }],
    });
    bad({
      initialState: 'SUBMITTED',
      steps: [
        {
          key: 'a',
          kind: 'APPROVAL',
          from: 'SUBMITTED',
          action: 'CANCEL',
          to: 'APPROVED',
          stageKey: 's_a',
          assignee: { type: 'INITIATOR' },
        },
      ],
    });
    // Valid mappings still pass: VERIFY→COMPLETED, EXECUTE→IN_PROGRESS.
    expect(() => {
      assertValidWorkflowDefinition({
        initialState: 'SUBMITTED',
        steps: [
          { key: 'v', kind: 'VERIFICATION', from: 'SUBMITTED', action: 'VERIFY', to: 'COMPLETED' },
          { key: 'c', kind: 'CLOSURE', from: 'COMPLETED', action: 'CLOSE', to: 'CLOSED' },
        ],
      });
    }).not.toThrow();
  });

  it('rejects bad step keys, assignee shapes, sla, and unknown props', () => {
    bad({
      initialState: 'SUBMITTED',
      steps: [
        {
          key: 'Bad Key',
          kind: 'APPROVAL',
          from: 'SUBMITTED',
          action: 'APPROVE',
          to: 'APPROVED',
          stageKey: 's_badkey',
          assignee: { type: 'INITIATOR' },
        },
      ],
    });
    bad({
      initialState: 'SUBMITTED',
      steps: [
        {
          key: 'a',
          kind: 'APPROVAL',
          from: 'SUBMITTED',
          action: 'APPROVE',
          to: 'APPROVED',
          assignee: { type: 'USER', value: 'u1' },
        },
      ],
    });
    bad({
      initialState: 'SUBMITTED',
      steps: [
        {
          key: 'a',
          kind: 'APPROVAL',
          from: 'SUBMITTED',
          action: 'APPROVE',
          to: 'APPROVED',
          assignee: { type: 'INITIATOR', value: 'x' },
        },
      ],
    });
    bad({
      initialState: 'SUBMITTED',
      steps: [
        {
          key: 'a',
          kind: 'APPROVAL',
          from: 'SUBMITTED',
          action: 'APPROVE',
          to: 'APPROVED',
          slaHours: 0,
          stageKey: 's_a',
          assignee: { type: 'INITIATOR' },
        },
      ],
    });
    bad({
      initialState: 'SUBMITTED',
      steps: [
        {
          key: 'a',
          kind: 'APPROVAL',
          from: 'SUBMITTED',
          action: 'APPROVE',
          to: 'APPROVED',
          script: 'x()',
          stageKey: 's_a',
          assignee: { type: 'INITIATOR' },
        },
      ],
    });
  });

  it('enforces approval-stage shape and consistency', () => {
    // stageKey required on APPROVAL steps.
    bad({
      initialState: 'SUBMITTED',
      steps: [
        {
          key: 'a',
          kind: 'APPROVAL',
          from: 'SUBMITTED',
          action: 'APPROVE',
          to: 'APPROVED',
          assignee: { type: 'INITIATOR' },
        },
      ],
    });
    // assignee required on APPROVAL steps.
    bad({
      initialState: 'SUBMITTED',
      steps: [
        {
          key: 'a',
          kind: 'APPROVAL',
          from: 'SUBMITTED',
          action: 'APPROVE',
          to: 'APPROVED',
          stageKey: 's1',
        },
      ],
    });
    // Steps in one stage must share assignee/from/guard/selfApprove.
    bad({
      initialState: 'SUBMITTED',
      steps: [
        {
          key: 'a',
          kind: 'APPROVAL',
          from: 'SUBMITTED',
          action: 'APPROVE',
          to: 'APPROVED',
          stageKey: 's1',
          assignee: { type: 'INITIATOR' },
        },
        {
          key: 'b',
          kind: 'APPROVAL',
          from: 'SUBMITTED',
          action: 'REJECT',
          to: 'REJECTED',
          stageKey: 's1',
          assignee: { type: 'ROLE_KEY', value: 'pi' },
        },
      ],
    });
    // At most one approval stage per from-state.
    bad({
      initialState: 'SUBMITTED',
      steps: [
        {
          key: 'a',
          kind: 'APPROVAL',
          from: 'SUBMITTED',
          action: 'APPROVE',
          to: 'APPROVED',
          stageKey: 's1',
          assignee: { type: 'INITIATOR' },
        },
        {
          key: 'b',
          kind: 'APPROVAL',
          from: 'SUBMITTED',
          action: 'REJECT',
          to: 'REJECTED',
          stageKey: 's2',
          assignee: { type: 'INITIATOR' },
        },
      ],
    });
    // selfApprove and stageKey are APPROVAL-only props.
    bad({
      initialState: 'SUBMITTED',
      steps: [
        {
          key: 'a',
          kind: 'EXECUTION',
          from: 'SUBMITTED',
          action: 'EXECUTE',
          to: 'IN_PROGRESS',
          stageKey: 's1',
        },
      ],
    });
  });
});

describe('createWorkflow', () => {
  it('creates a draft workflow pinned to the operation version and audits', async () => {
    const wf = await service.createWorkflow(actor, 'c1', {
      operationVersionId: 'ov1',
      key: ' store_req ',
      name: ' Store Request ',
      definition: validDefinition,
    });
    expect(wf.key).toBe('STORE_REQ');
    expect(wf.operationVersionId).toBe('ov1');
    expect(wf.operationId).toBe('op1');
    expect(store.auditLog[0]?.action).toBe('WF_CREATED');
    expect(authorizer.calls[0]?.permissionKey).toBe(WF_CONFIGURE);
  });

  it('rejects an OperationVersion outside the company', async () => {
    await expect(
      service.createWorkflow(actor, 'c1', {
        operationVersionId: 'foreign-ov',
        key: 'k',
        name: 'n',
      }),
    ).rejects.toThrow(OrgEntityNotFoundError);
  });

  it('rejects duplicate keys within an operation', async () => {
    await service.createWorkflow(actor, 'c1', { operationVersionId: 'ov1', key: 'k1', name: 'n' });
    await expect(
      service.createWorkflow(actor, 'c1', { operationVersionId: 'ov1', key: 'K1', name: 'n' }),
    ).rejects.toThrow(DuplicateCodeError);
  });
});

describe('lifecycle and updates', () => {
  it('transitions and rejects invalid moves', async () => {
    const wf = await service.createWorkflow(actor, 'c1', {
      operationVersionId: 'ov1',
      key: 'k',
      name: 'n',
    });
    await service.transitionWorkflowStatus(actor, 'c1', wf.id, 'ACTIVE');
    await service.transitionWorkflowStatus(actor, 'c1', wf.id, 'ARCHIVED');
    await expect(service.transitionWorkflowStatus(actor, 'c1', wf.id, 'ACTIVE')).rejects.toThrow(
      InvalidStatusTransitionError,
    );
  });

  it('empty patch no-op; stale version conflict', async () => {
    const wf = await service.createWorkflow(actor, 'c1', {
      operationVersionId: 'ov1',
      key: 'k',
      name: 'n',
    });
    store.auditLog.length = 0;
    const same = await service.updateWorkflow(actor, 'c1', wf.id, {});
    expect(same.version).toBe(0);
    expect(store.auditLog).toHaveLength(0);
    await service.updateWorkflow(actor, 'c1', wf.id, { name: 'a' }, 0);
    await expect(service.updateWorkflow(actor, 'c1', wf.id, { name: 'b' }, 0)).rejects.toThrow(
      VersionConflictError,
    );
  });
});

describe('publishWorkflow', () => {
  it('publishes an immutable snapshot and audits', async () => {
    const wf = await service.createWorkflow(actor, 'c1', {
      operationVersionId: 'ov1',
      key: 'k',
      name: 'n',
      definition: validDefinition,
    });
    const published = await service.publishWorkflow(actor, 'c1', wf.id);
    expect(published.latestRevision).toBe(1);
    expect(published.currentVersionId).toBe(store.workflowVersions[0]?.id);
    expect(store.workflowVersions[0]?.definition).toEqual(validDefinition);
    expect(store.auditLog.some((a) => a.action === 'WF_PUBLISHED')).toBe(true);
    expect(authorizer.calls.at(-1)?.permissionKey).toBe(WF_PUBLISH);
  });

  it('rejects publish without definition or when archived', async () => {
    const wf = await service.createWorkflow(actor, 'c1', {
      operationVersionId: 'ov1',
      key: 'k',
      name: 'n',
    });
    await expect(service.publishWorkflow(actor, 'c1', wf.id)).rejects.toThrow(OrgValidationError);
    await service.transitionWorkflowStatus(actor, 'c1', wf.id, 'ARCHIVED');
    await expect(service.publishWorkflow(actor, 'c1', wf.id)).rejects.toThrow(OrgValidationError);
  });

  it('rejects FormVersion refs that are missing or belong to another operation', async () => {
    const fv1 = '11111111-1111-1111-1111-111111111111';
    const def = {
      initialState: 'SUBMITTED',
      steps: [
        {
          key: 's',
          kind: 'EXECUTION',
          from: 'SUBMITTED',
          action: 'EXECUTE',
          to: 'COMPLETED',
          formVersionId: fv1,
        },
        { key: 't', kind: 'CLOSURE', from: 'COMPLETED', action: 'CLOSE', to: 'CLOSED' },
      ],
    };
    const wf = await service.createWorkflow(actor, 'c1', {
      operationVersionId: 'ov1',
      key: 'k',
      name: 'n',
      definition: def,
    });
    // Missing version.
    await expect(service.publishWorkflow(actor, 'c1', wf.id)).rejects.toThrow(OrgValidationError);
    // Version exists but belongs to a different operation.
    store.formVersionOps.push({ id: fv1, companyId: 'c1', operationId: 'other-op' });
    await expect(service.publishWorkflow(actor, 'c1', wf.id)).rejects.toThrow(
      /different operation/,
    );
    // Cross-company version (same id, other tenant) behaves as missing.
    // NOTE: each rejected publish rolls back into a fresh cloned array —
    // re-fetch the live row after every failed call.
    const liveRef = () => {
      const r = store.formVersionOps[0];
      if (r === undefined) throw new Error('seed missing');
      return r;
    };
    liveRef().companyId = 'other';
    liveRef().operationId = 'op1';
    await expect(service.publishWorkflow(actor, 'c1', wf.id)).rejects.toThrow(OrgValidationError);
    // Correct ref publishes.
    liveRef().companyId = 'c1';
    const published = await service.publishWorkflow(actor, 'c1', wf.id);
    expect(published.latestRevision).toBe(1);
  });
});

describe('authorization and append-only surface', () => {
  it('denies unauthorized operations', async () => {
    const denying = new WorkflowService(new FakeWfUoW(store), new FakeAuthorizer(false));
    await expect(
      denying.createWorkflow(actor, 'c1', { operationVersionId: 'ov1', key: 'k', name: 'n' }),
    ).rejects.toThrow(AccessDeniedError);
    await expect(denying.listWorkflows(actor, 'c1')).rejects.toThrow(AccessDeniedError);
  });

  it('read requires WORKFLOW_READ', async () => {
    await service.listWorkflows(actor, 'c1');
    expect(authorizer.calls[0]?.permissionKey).toBe(WF_READ);
  });
});
