import { describe, it, expect, beforeEach } from 'vitest';
import { FormSubmissionService } from '../../../src/modules/form-submission/service.js';
import { SubmissionUnsupportedFieldError } from '../../../src/modules/form-submission/errors.js';
import { IdempotencyConflictError } from '../../../src/modules/workflow-instance/errors.js';
import {
  InvalidStatusTransitionError,
  OrgEntityNotFoundError,
  OrgValidationError,
  VersionConflictError,
} from '../../../src/modules/organization/errors.js';
import { AccessDeniedError } from '../../../src/modules/access-control/errors.js';
import { assertValidWorkflowDefinition } from '../../../src/modules/workflow/definition-validation.js';
import {
  FakeSubmissionUoW,
  emptySubmissionStore,
  fakeDepartment,
  fakeOperation,
  type SubmissionStore,
} from './fakes.js';
import { FakeAuthorizer, fakeInstance } from '../workflow-instance/fakes.js';
import type { ActorContext } from '../../../src/modules/organization/types.js';

const actor: ActorContext = { actorId: 'principal-1', actorType: 'USER' };

const formSchema = {
  fields: [
    { key: 'amount', type: 'DECIMAL', label: 'Amount', required: true, constraints: { min: 0 } },
    { key: 'reason', type: 'TEXT', label: 'Reason', constraints: { maxLength: 50 } },
    {
      key: 'urgent',
      type: 'BOOLEAN',
      label: 'Urgent',
      required: false,
    },
    {
      key: 'urgent_reason',
      type: 'TEXT',
      label: 'Why',
      required: true,
      when: { field: 'urgent', op: 'EQ', value: true },
    },
    { key: 'photo', type: 'IMAGE', label: 'Photo', required: false },
  ],
};

// Pinned def where step 'collect' binds fv1 and step 'collect2' binds fv2 —
// two forms on one instance.
const defTwoForms = {
  initialState: 'SUBMITTED',
  steps: [
    {
      key: 'collect',
      kind: 'EXECUTION',
      from: 'SUBMITTED',
      action: 'EXECUTE',
      to: 'IN_PROGRESS',
      formVersionId: '11111111-1111-1111-1111-111111111111',
    },
    {
      key: 'collect2',
      kind: 'EXECUTION',
      from: 'IN_PROGRESS',
      action: 'EXECUTE',
      to: 'COMPLETED',
      formVersionId: '22222222-2222-2222-2222-222222222222',
    },
    { key: 'close', kind: 'CLOSURE', from: 'COMPLETED', action: 'CLOSE', to: 'CLOSED' },
  ],
};

let store: SubmissionStore;
let authorizer: FakeAuthorizer;
let service: FormSubmissionService;

// Narrowed accessors — non-null without `!`.
function sub() {
  const s = store.formSubmissions[0];
  if (s === undefined) throw new Error('no seeded submission');
  return s;
}
function inst() {
  const i = store.instances[0];
  if (i === undefined) throw new Error('no seeded instance');
  return i;
}
function formRow(i: number) {
  const r = store.formRows[i];
  if (r === undefined) throw new Error('no seeded form');
  return r;
}

function seed(def: unknown = defTwoForms) {
  store.departments.push(fakeDepartment({ id: 'd1', companyId: 'c1' }));
  store.operations.push(fakeOperation({ id: 'op1', companyId: 'c1', departmentId: 'd1' }));
  store.workflowVersions.push({ id: 'wfv1', companyId: 'c1', workflowId: 'wf1', definition: def });
  store.instances.push(fakeInstance({ id: '33333333-3333-3333-3333-333333333333' }));
  store.formRows.push({ id: 'f1', companyId: 'c1', operationId: 'op1', status: 'ACTIVE' });
  store.formRows.push({ id: 'f2', companyId: 'c1', operationId: 'op1', status: 'ACTIVE' });
  store.formVersionRows.push({
    id: '11111111-1111-1111-1111-111111111111',
    companyId: 'c1',
    formId: 'f1',
    schema: formSchema,
  });
  store.formVersionRows.push({
    id: '22222222-2222-2222-2222-222222222222',
    companyId: 'c1',
    formId: 'f2',
    schema: formSchema,
  });
}

beforeEach(() => {
  store = emptySubmissionStore();
  authorizer = new FakeAuthorizer(true);
  service = new FormSubmissionService(new FakeSubmissionUoW(store), authorizer);
});

describe('createDraft', () => {
  it('pins only step-referenced FormVersions — caller cannot pick an arbitrary version', async () => {
    seed();
    const s = await service.createDraft(actor, 'c1', {
      workflowInstanceId: '33333333-3333-3333-3333-333333333333',
      formVersionId: '11111111-1111-1111-1111-111111111111',
    });
    expect(s.status).toBe('DRAFT');
    expect(s.formVersionId).toBe('11111111-1111-1111-1111-111111111111');
    expect(s.operationId).toBe('op1');
    expect(store.auditLog[0]?.action).toBe('FORM_SUBMISSION_CREATED');
    await expect(
      service.createDraft(actor, 'c1', {
        workflowInstanceId: '33333333-3333-3333-3333-333333333333',
        formVersionId: '55555555-5555-5555-5555-555555555555',
      }),
    ).rejects.toThrow(/not referenced/);
  });

  it('requires a valid workflowInstanceId — standalone submissions rejected', async () => {
    seed();
    await expect(
      service.createDraft(actor, 'c1', {
        workflowInstanceId: '',
        formVersionId: '11111111-1111-1111-1111-111111111111',
      }),
    ).rejects.toThrow(OrgValidationError);
    await expect(
      service.createDraft(actor, 'c1', {
        workflowInstanceId: '55555555-5555-5555-5555-555555555555',
        formVersionId: '11111111-1111-1111-1111-111111111111',
      }),
    ).rejects.toThrow(OrgEntityNotFoundError);
  });

  it('multiple forms per instance — one submission per (instance, formVersion)', async () => {
    seed();
    const a = await service.createDraft(actor, 'c1', {
      workflowInstanceId: '33333333-3333-3333-3333-333333333333',
      formVersionId: '11111111-1111-1111-1111-111111111111',
    });
    const b = await service.createDraft(actor, 'c1', {
      workflowInstanceId: '33333333-3333-3333-3333-333333333333',
      formVersionId: '22222222-2222-2222-2222-222222222222',
    });
    expect(a.formVersionId).not.toBe(b.formVersionId);
    await expect(
      service.createDraft(actor, 'c1', {
        workflowInstanceId: '33333333-3333-3333-3333-333333333333',
        formVersionId: '11111111-1111-1111-1111-111111111111',
      }),
    ).rejects.toThrow(); // duplicate association
  });

  it('rejects cross-operation forms and terminal instances', async () => {
    seed();
    formRow(1).operationId = 'op-other';
    await expect(
      service.createDraft(actor, 'c1', {
        workflowInstanceId: '33333333-3333-3333-3333-333333333333',
        formVersionId: '22222222-2222-2222-2222-222222222222',
      }),
    ).rejects.toThrow(/different operation/);
    inst().state = 'CLOSED';
    await expect(
      service.createDraft(actor, 'c1', {
        workflowInstanceId: '33333333-3333-3333-3333-333333333333',
        formVersionId: '11111111-1111-1111-1111-111111111111',
      }),
    ).rejects.toThrow(InvalidStatusTransitionError);
  });
});

describe('saveDraft / submit', () => {
  it('draft save rejects unknown fields and bad types but allows incomplete data', async () => {
    seed();
    const s = await service.createDraft(actor, 'c1', {
      workflowInstanceId: '33333333-3333-3333-3333-333333333333',
      formVersionId: '11111111-1111-1111-1111-111111111111',
    });
    await service.saveDraft(actor, 'c1', s.id, { values: { amount: 10 } }); // reason still missing — ok
    await expect(service.saveDraft(actor, 'c1', s.id, { values: { nope: 1 } })).rejects.toThrow(
      OrgValidationError,
    );
    await expect(service.saveDraft(actor, 'c1', s.id, { values: { amount: 'x' } })).rejects.toThrow(
      OrgValidationError,
    );
    await expect(
      service.saveDraft(actor, 'c1', s.id, { values: { reason: 'y'.repeat(60) } }),
    ).rejects.toThrow(OrgValidationError); // maxLength
  });

  it('submit validates required, visibility, and types → immutable revision', async () => {
    seed();
    const s = await service.createDraft(actor, 'c1', {
      workflowInstanceId: '33333333-3333-3333-3333-333333333333',
      formVersionId: '11111111-1111-1111-1111-111111111111',
    });
    // Missing required `amount`.
    await expect(service.submit(actor, 'c1', s.id, { values: { reason: 'x' } })).rejects.toThrow(
      OrgValidationError,
    );
    // urgent_reason is required only when urgent → visible failure.
    await expect(
      service.submit(actor, 'c1', s.id, {
        values: { amount: 5, urgent: true },
      }),
    ).rejects.toThrow(/required/);
    // Hidden field must be absent.
    await expect(
      service.submit(actor, 'c1', s.id, {
        values: { amount: 5, urgent_reason: 'sneaky' },
      }),
    ).rejects.toThrow(/hidden/);
    const r = await service.submit(actor, 'c1', s.id, {
      values: { amount: 5, urgent: true, urgent_reason: 'site blocked' },
    });
    expect(r.submission.status).toBe('SUBMITTED');
    expect(r.submission.latestRevision).toBe(1);
    expect(r.submission.currentRevisionId).toBe(r.revision.id);
    expect(r.submission.draftValues).toBeNull();
    expect(r.revision.values).toMatchObject({ amount: 5 });
  });

  it('rejects FILE/IMAGE-typed values at submit — no document service', async () => {
    seed();
    const s = await service.createDraft(actor, 'c1', {
      workflowInstanceId: '33333333-3333-3333-3333-333333333333',
      formVersionId: '11111111-1111-1111-1111-111111111111',
    });
    await expect(
      service.submit(actor, 'c1', s.id, {
        values: { amount: 5, photo: { fileName: 'x.png' } },
      }),
    ).rejects.toThrow(SubmissionUnsupportedFieldError);
  });

  it('submit on a submitted/returned submission creates the next immutable revision', async () => {
    seed();
    const s = await service.createDraft(actor, 'c1', {
      workflowInstanceId: '33333333-3333-3333-3333-333333333333',
      formVersionId: '11111111-1111-1111-1111-111111111111',
    });
    const first = await service.submit(actor, 'c1', s.id, { values: { amount: 1 } });
    expect(first.revision.revision).toBe(1);
    // SUBMITTED cannot resubmit — a RETURN must move it back first.
    await expect(service.submit(actor, 'c1', s.id, { values: { amount: 2 } })).rejects.toThrow(
      InvalidStatusTransitionError,
    );
    sub().status = 'RETURNED';
    const second = await service.submit(actor, 'c1', s.id, { values: { amount: 2 } });
    expect(second.revision.revision).toBe(2);
    expect(second.submission.currentRevisionId).toBe(second.revision.id);
    // First revision is immutable — still holds the old values.
    const revs = store.submissionRevisions;
    expect(revs[0]?.values).toMatchObject({ amount: 1 });
    expect(revs[1]?.values).toMatchObject({ amount: 2 });
  });

  it('idempotent submit replays the recorded revision; different values conflict', async () => {
    seed();
    const s = await service.createDraft(actor, 'c1', {
      workflowInstanceId: '33333333-3333-3333-3333-333333333333',
      formVersionId: '11111111-1111-1111-1111-111111111111',
    });
    const first = await service.submit(actor, 'c1', s.id, {
      values: { amount: 5 },
      idempotencyKey: 'k1',
    });
    sub().status = 'RETURNED'; // force a state where naive retry differs
    const second = await service.submit(actor, 'c1', s.id, {
      values: { amount: 5 },
      idempotencyKey: 'k1',
    });
    expect(second.replayed).toBe(true);
    expect(second.revision.id).toBe(first.revision.id);
    await expect(
      service.submit(actor, 'c1', s.id, { values: { amount: 6 }, idempotencyKey: 'k1' }),
    ).rejects.toThrow(IdempotencyConflictError);
    expect(store.submissionRevisions).toHaveLength(1);
  });

  it('stale expectedVersion conflicts', async () => {
    seed();
    const s = await service.createDraft(actor, 'c1', {
      workflowInstanceId: '33333333-3333-3333-3333-333333333333',
      formVersionId: '11111111-1111-1111-1111-111111111111',
    });
    await expect(
      service.submit(actor, 'c1', s.id, { values: { amount: 1 }, expectedVersion: 9 }),
    ).rejects.toThrow(VersionConflictError);
  });
});

describe('reads + authorization', () => {
  it('lists submissions and revisions under scope; denied actor reads nothing', async () => {
    seed();
    const s = await service.createDraft(actor, 'c1', {
      workflowInstanceId: '33333333-3333-3333-3333-333333333333',
      formVersionId: '11111111-1111-1111-1111-111111111111',
    });
    await service.submit(actor, 'c1', s.id, { values: { amount: 1 } });
    expect(
      (
        await service.listSubmissions(actor, 'c1', {
          workflowInstanceId: '33333333-3333-3333-3333-333333333333',
        })
      ).length,
    ).toBe(1);
    expect((await service.listRevisions(actor, 'c1', s.id)).length).toBe(1);
    const strict = new FakeAuthorizer(false);
    const denied = new FormSubmissionService(new FakeSubmissionUoW(store), strict);
    await expect(denied.getSubmission(actor, 'c1', s.id)).rejects.toThrow(AccessDeniedError);
    await expect(service.getSubmission(actor, 'c2', s.id)).rejects.toThrow(OrgEntityNotFoundError);
  });
});

describe('publish-time form version uniqueness', () => {
  it('rejects a definition reusing one FormVersion on multiple steps', () => {
    expect(() => {
      assertValidWorkflowDefinition(defTwoForms);
    }).not.toThrow();
    expect(() => {
      assertValidWorkflowDefinition({
        initialState: 'SUBMITTED',
        steps: [
          {
            key: 'a',
            kind: 'EXECUTION',
            from: 'SUBMITTED',
            action: 'EXECUTE',
            to: 'IN_PROGRESS',
            formVersionId: '11111111-1111-1111-1111-111111111111',
          },
          {
            key: 'b',
            kind: 'EXECUTION',
            from: 'IN_PROGRESS',
            action: 'EXECUTE',
            to: 'COMPLETED',
            formVersionId: '11111111-1111-1111-1111-111111111111',
          },
        ],
      });
    }).toThrow(/already bound/);
  });
});
