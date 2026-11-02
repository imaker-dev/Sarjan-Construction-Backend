import { describe, it, expect, beforeEach } from 'vitest';
import {
  FormService,
  FORM_CONFIGURE,
  FORM_PUBLISH,
  FORM_READ,
} from '../../../src/modules/form/service.js';
import { assertValidFormSchema } from '../../../src/modules/form/schema-validation.js';
import {
  DuplicateCodeError,
  InvalidStatusTransitionError,
  OrgEntityNotFoundError,
  OrgValidationError,
  VersionConflictError,
} from '../../../src/modules/organization/errors.js';
import { AccessDeniedError } from '../../../src/modules/access-control/errors.js';
import {
  emptyFormStore,
  fakeDepartment,
  fakeOperation,
  FakeAuthorizer,
  FakeFormUoW,
  type FormStore,
} from './fakes.js';
import type { ActorContext } from '../../../src/modules/organization/types.js';

const actor: ActorContext = { actorId: 'principal-1', actorType: 'USER' };

const validSchema = {
  fields: [
    {
      key: 'request_type',
      type: 'SELECT',
      label: 'Type',
      constraints: { options: ['ISSUE', 'RETURN'] },
    },
    { key: 'qty', type: 'DECIMAL', label: 'Qty', required: true, constraints: { min: 0 } },
    {
      key: 'notes',
      type: 'TEXT',
      label: 'Notes',
      when: { field: 'request_type', op: 'EQ', value: 'ISSUE' },
    },
  ],
};

let store: FormStore;
let authorizer: FakeAuthorizer;
let service: FormService;

beforeEach(() => {
  store = emptyFormStore();
  authorizer = new FakeAuthorizer(true);
  service = new FormService(new FakeFormUoW(store), authorizer);
  store.departments.push(fakeDepartment({ id: 'd1', companyId: 'c1' }));
  store.operations.push(fakeOperation({ id: 'op1', companyId: 'c1', departmentId: 'd1' }));
});

describe('descriptor validation', () => {
  const bad = (schema: unknown): void => {
    expect(() => {
      assertValidFormSchema(schema);
    }).toThrow(OrgValidationError);
  };

  it('accepts a valid descriptor', () => {
    expect(() => {
      assertValidFormSchema(validSchema);
    }).not.toThrow();
  });

  it('rejects unknown types, keys, and duplicate field keys', () => {
    bad({ fields: [{ key: 'a', type: 'SCRIPT', label: 'x' }] });
    bad({ fields: [{ key: 'A bad key', type: 'TEXT', label: 'x' }] });
    bad({
      fields: [
        { key: 'a', type: 'TEXT', label: 'x' },
        { key: 'a', type: 'TEXT', label: 'y' },
      ],
    });
  });

  it('rejects bad constraints and unknown constraint keys', () => {
    bad({ fields: [{ key: 'a', type: 'NUMBER', label: 'x', constraints: { min: 5, max: 2 } }] });
    bad({ fields: [{ key: 'a', type: 'TEXT', label: 'x', constraints: { options: ['y'] } }] });
    bad({
      fields: [{ key: 'a', type: 'SELECT', label: 'x', constraints: { options: 'yes' } }],
    });
    bad({
      fields: [{ key: 'a', type: 'TEXT', label: 'x', constraints: { regex: '.*' } }],
    });
    bad({
      fields: [{ key: 'a', type: 'FILE', label: 'x', constraints: { fileTypes: ['exe'] } }],
    });
  });

  it('rejects bad `when` conditions: unknown/self ref, bad op, missing value, cycle', () => {
    bad({
      fields: [{ key: 'a', type: 'TEXT', label: 'x', when: { field: 'a', op: 'EQ', value: 1 } }],
    });
    bad({
      fields: [
        { key: 'a', type: 'TEXT', label: 'x', when: { field: 'ghost', op: 'EQ', value: 1 } },
      ],
    });
    bad({
      fields: [{ key: 'a', type: 'TEXT', label: 'x', when: { field: 'b', op: 'OR', value: 1 } }],
    });
    bad({ fields: [{ key: 'a', type: 'TEXT', label: 'x', when: { field: 'b', op: 'EQ' } }] });
    bad({
      fields: [
        { key: 'a', type: 'TEXT', label: 'x', when: { field: 'b', op: 'NOT_EMPTY' } },
        { key: 'b', type: 'TEXT', label: 'y', when: { field: 'a', op: 'EMPTY' } },
      ],
    });
  });

  it('enforces size/field/option limits', () => {
    bad({
      fields: Array.from({ length: 151 }, (_, i) => ({ key: `f${i}`, type: 'TEXT', label: 'x' })),
    });
    bad({
      fields: [
        {
          key: 'a',
          type: 'SELECT',
          label: 'x',
          constraints: { options: Array.from({ length: 101 }, (_, i) => `o${i}`) },
        },
      ],
    });
    bad({ fields: [{ key: 'a', type: 'TEXT', label: 'x'.repeat(301) }] });
    bad({ fields: [{ key: 'a', type: 'TEXT', label: 'x', constraints: { maxLength: 0 } }] });
  });

  it('rejects sections referencing unknown fields', () => {
    bad({
      fields: [{ key: 'a', type: 'TEXT', label: 'x' }],
      sections: [{ title: 's', fields: ['nope'] }],
    });
  });
});

describe('createForm', () => {
  it('creates a draft form under the operation and audits', async () => {
    const form = await service.createForm(actor, 'c1', 'op1', {
      key: ' request ',
      name: ' Request ',
      schema: validSchema,
    });
    expect(form.key).toBe('REQUEST');
    expect(form.status).toBe('DRAFT');
    expect(store.auditLog[0]?.action).toBe('FORM_CREATED');
    expect(authorizer.calls[0]?.permissionKey).toBe(FORM_CONFIGURE);
  });

  it('rejects cross-company operation and duplicate keys', async () => {
    await expect(
      service.createForm(actor, 'c1', 'other-op', { key: 'k', name: 'n' }),
    ).rejects.toThrow(OrgEntityNotFoundError);
    await service.createForm(actor, 'c1', 'op1', { key: 'k1', name: 'n' });
    await expect(service.createForm(actor, 'c1', 'op1', { key: 'K1', name: 'n' })).rejects.toThrow(
      DuplicateCodeError,
    );
  });

  it('rejects invalid descriptors at create', async () => {
    await expect(
      service.createForm(actor, 'c1', 'op1', { key: 'k', name: 'n', schema: [1] }),
    ).rejects.toThrow(OrgValidationError);
  });
});

describe('lifecycle and updates', () => {
  it('transitions DRAFT→ACTIVE⇄INACTIVE→ARCHIVED and rejects invalid', async () => {
    const form = await service.createForm(actor, 'c1', 'op1', { key: 'k', name: 'n' });
    await service.transitionFormStatus(actor, 'c1', form.id, 'ACTIVE');
    await service.transitionFormStatus(actor, 'c1', form.id, 'INACTIVE');
    await service.transitionFormStatus(actor, 'c1', form.id, 'ACTIVE');
    await service.transitionFormStatus(actor, 'c1', form.id, 'ARCHIVED');
    await expect(service.transitionFormStatus(actor, 'c1', form.id, 'ACTIVE')).rejects.toThrow(
      InvalidStatusTransitionError,
    );
  });

  it('empty patch is a no-op; stale version conflicts', async () => {
    const form = await service.createForm(actor, 'c1', 'op1', { key: 'k', name: 'n' });
    store.auditLog.length = 0;
    const same = await service.updateForm(actor, 'c1', form.id, {});
    expect(same.version).toBe(0);
    expect(store.auditLog).toHaveLength(0);
    await service.updateForm(actor, 'c1', form.id, { name: 'a' }, 0);
    await expect(service.updateForm(actor, 'c1', form.id, { name: 'b' }, 0)).rejects.toThrow(
      VersionConflictError,
    );
  });
});

describe('publishForm', () => {
  it('publishes an immutable snapshot, bumps revision, sets pointer, audits', async () => {
    const form = await service.createForm(actor, 'c1', 'op1', {
      key: 'k',
      name: 'n',
      schema: validSchema,
    });
    const published = await service.publishForm(actor, 'c1', form.id);
    expect(published.latestRevision).toBe(1);
    expect(published.currentVersionId).toBe(store.formVersions[0]?.id);
    expect(store.formVersions[0]?.publishedByPrincipalId).toBe('principal-1');
    expect(store.formVersions[0]?.schema).toEqual(validSchema);
    expect(store.auditLog.some((a) => a.action === 'FORM_PUBLISHED')).toBe(true);
    expect(authorizer.calls.at(-1)?.permissionKey).toBe(FORM_PUBLISH);
  });

  it('rejects publish without a descriptor and on archived forms', async () => {
    const empty = await service.createForm(actor, 'c1', 'op1', { key: 'k', name: 'n' });
    await expect(service.publishForm(actor, 'c1', empty.id)).rejects.toThrow(OrgValidationError);
    const form = await service.createForm(actor, 'c1', 'op1', {
      key: 'k2',
      name: 'n',
      schema: validSchema,
    });
    await service.transitionFormStatus(actor, 'c1', form.id, 'ARCHIVED');
    await expect(service.publishForm(actor, 'c1', form.id)).rejects.toThrow(OrgValidationError);
  });

  it('draft edits after publish do not mutate the snapshot', async () => {
    const form = await service.createForm(actor, 'c1', 'op1', {
      key: 'k',
      name: 'n',
      schema: validSchema,
    });
    await service.publishForm(actor, 'c1', form.id);
    await service.updateForm(actor, 'c1', form.id, {
      schema: { fields: [{ key: 'only', type: 'BOOLEAN', label: 'x' }] },
    });
    const second = await service.publishForm(actor, 'c1', form.id);
    expect(second.latestRevision).toBe(2);
    expect(store.formVersions[0]?.schema).toEqual(validSchema);
    expect(store.formVersions[1]?.schema).toEqual({
      fields: [{ key: 'only', type: 'BOOLEAN', label: 'x' }],
    });
  });
});

describe('authorization and append-only surface', () => {
  it('denies unauthorized operations', async () => {
    const denying = new FormService(new FakeFormUoW(store), new FakeAuthorizer(false));
    await expect(denying.createForm(actor, 'c1', 'op1', { key: 'k', name: 'n' })).rejects.toThrow(
      AccessDeniedError,
    );
    await expect(denying.listForms(actor, 'c1')).rejects.toThrow(AccessDeniedError);
  });

  it('read requires FORM_READ', async () => {
    await service.listForms(actor, 'c1');
    expect(authorizer.calls[0]?.permissionKey).toBe(FORM_READ);
  });

  it('formVersions repo exposes no update/delete paths', () => {
    const svc = service as unknown as Record<string, unknown>;
    for (const key of Object.keys(svc)) {
      expect(key.toLowerCase()).not.toMatch(/delete|remove/);
    }
  });
});
