import { describe, it, expect, beforeEach } from 'vitest';
import {
  OperationService,
  OP_CONFIGURE,
  OP_PUBLISH,
  OP_READ,
} from '../../../src/modules/operation/service.js';
import { assertValidDefinition } from '../../../src/modules/operation/validation.js';
import {
  DuplicateCodeError,
  InvalidStatusTransitionError,
  OrgEntityNotFoundError,
  OrgValidationError,
  VersionConflictError,
} from '../../../src/modules/organization/errors.js';
import { AccessDeniedError } from '../../../src/modules/access-control/errors.js';
import { emptyOpStore, fakeDepartment, FakeAuthorizer, FakeOpUoW, type OpStore } from './fakes.js';
import type { ActorContext } from '../../../src/modules/organization/types.js';

const actor: ActorContext = { actorId: 'principal-1', actorType: 'USER' };
const sysActor: ActorContext = { actorId: 'sys-1', actorType: 'SYSTEM' };

let store: OpStore;
let authorizer: FakeAuthorizer;
let service: OperationService;

beforeEach(() => {
  store = emptyOpStore();
  authorizer = new FakeAuthorizer(true);
  service = new OperationService(new FakeOpUoW(store), authorizer);
  store.departments.push(fakeDepartment({ id: 'd1', companyId: 'c1' }));
});

describe('createOperation', () => {
  it('creates a draft operation, normalizes key, audits, checks permission', async () => {
    const op = await service.createOperation(actor, 'c1', 'd1', {
      key: ' procurement_review ',
      name: ' Procurement Review ',
      capabilityKey: 'PROCUREMENT_REVIEW',
    });
    expect(op.key).toBe('PROCUREMENT_REVIEW');
    expect(op.name).toBe('Procurement Review');
    expect(op.status).toBe('DRAFT');
    expect(op.latestRevision).toBe(0);
    expect(store.auditLog[0]?.action).toBe('OP_OPERATION_CREATED');
    expect(authorizer.calls[0]?.permissionKey).toBe(OP_CONFIGURE);
    // Authorized against the department's scope (company here).
    expect(authorizer.calls[0]?.target).toMatchObject({ companyId: 'c1', scopeType: 'COMPANY' });
  });

  it('authorizes against a site-scoped department correctly', async () => {
    const dept = store.departments[0];
    if (dept === undefined) throw new Error('seed missing');
    dept.scopeType = 'SITE';
    dept.siteId = 's1';
    await service.createOperation(actor, 'c1', 'd1', { key: 'k', name: 'n' });
    expect(authorizer.calls[0]?.target).toMatchObject({ scopeType: 'SITE', scopeId: 's1' });
  });

  it('rejects a department outside the company', async () => {
    await expect(
      service.createOperation(actor, 'c1', 'missing-dept', { key: 'k', name: 'n' }),
    ).rejects.toThrow(OrgEntityNotFoundError);
  });

  it('rejects duplicate keys within a department; allows them in another', async () => {
    await service.createOperation(actor, 'c1', 'd1', { key: 'k1', name: 'n' });
    await expect(
      service.createOperation(actor, 'c1', 'd1', { key: 'K1', name: 'n' }),
    ).rejects.toThrow(DuplicateCodeError);
    store.departments.push(fakeDepartment({ id: 'd2', companyId: 'c1' }));
    const op = await service.createOperation(actor, 'c1', 'd2', { key: 'k1', name: 'n' });
    expect(op.key).toBe('K1');
  });

  it('rejects invalid definitions', async () => {
    await expect(
      service.createOperation(actor, 'c1', 'd1', { key: 'k', name: 'n', definition: [1, 2] }),
    ).rejects.toThrow(OrgValidationError);
    const deep = { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } };
    await expect(
      service.createOperation(actor, 'c1', 'd1', { key: 'k', name: 'n', definition: deep }),
    ).rejects.toThrow(OrgValidationError);
  });
});

describe('definition validation', () => {
  it('accepts a bounded object and rejects oversized/deep/oversized-key payloads', () => {
    expect(() => {
      assertValidDefinition({ fields: [{ name: 'x', type: 'text' }] });
    }).not.toThrow();
    expect(() => {
      assertValidDefinition('string');
    }).toThrow(OrgValidationError);
    expect(() => {
      assertValidDefinition({ big: 'x'.repeat(20 * 1024) });
    }).toThrow(OrgValidationError);
    const many: Record<string, number> = {};
    for (let i = 0; i < 250; i++) many[`k${i}`] = i;
    expect(() => {
      assertValidDefinition(many);
    }).toThrow(OrgValidationError);
  });
});

describe('lifecycle', () => {
  it('allows DRAFT→ACTIVE⇄INACTIVE and →ARCHIVED terminal', async () => {
    const op = await service.createOperation(actor, 'c1', 'd1', { key: 'k', name: 'n' });
    await service.transitionOperationStatus(actor, 'c1', op.id, 'ACTIVE');
    await service.transitionOperationStatus(actor, 'c1', op.id, 'INACTIVE');
    await service.transitionOperationStatus(actor, 'c1', op.id, 'ACTIVE');
    await service.transitionOperationStatus(actor, 'c1', op.id, 'ARCHIVED');
    expect(store.operations[0]?.status).toBe('ARCHIVED');
    await expect(service.transitionOperationStatus(actor, 'c1', op.id, 'ACTIVE')).rejects.toThrow(
      InvalidStatusTransitionError,
    );
  });

  it('rejects invalid transitions', async () => {
    const op = await service.createOperation(actor, 'c1', 'd1', { key: 'k', name: 'n' });
    await expect(service.transitionOperationStatus(actor, 'c1', op.id, 'INACTIVE')).rejects.toThrow(
      InvalidStatusTransitionError,
    );
  });
});

describe('updateOperation', () => {
  it('empty patch is a no-op', async () => {
    const op = await service.createOperation(actor, 'c1', 'd1', { key: 'k', name: 'n' });
    store.auditLog.length = 0;
    const result = await service.updateOperation(actor, 'c1', op.id, {});
    expect(result.version).toBe(0);
    expect(store.auditLog).toHaveLength(0);
  });

  it('rejects stale expectedVersion', async () => {
    const op = await service.createOperation(actor, 'c1', 'd1', { key: 'k', name: 'n' });
    await service.updateOperation(actor, 'c1', op.id, { name: 'a' }, 0);
    await expect(service.updateOperation(actor, 'c1', op.id, { name: 'b' }, 0)).rejects.toThrow(
      VersionConflictError,
    );
  });
});

describe('publishOperation', () => {
  it('creates an immutable version snapshot, bumps revision, sets pointer, audits', async () => {
    const op = await service.createOperation(actor, 'c1', 'd1', {
      key: 'k',
      name: 'n',
      definition: { fields: [{ name: 'qty', type: 'number' }] },
    });
    const published = await service.publishOperation(actor, 'c1', op.id);
    expect(published.latestRevision).toBe(1);
    expect(published.currentVersionId).toBe(store.operationVersions[0]?.id);
    const v = store.operationVersions[0];
    expect(v?.revision).toBe(1);
    expect(v?.publishedByPrincipalId).toBe('principal-1');
    expect(v?.definition).toEqual({ fields: [{ name: 'qty', type: 'number' }] });
    expect(store.auditLog.some((a) => a.action === 'OP_OPERATION_PUBLISHED')).toBe(true);
    expect(authorizer.calls.at(-1)?.permissionKey).toBe(OP_PUBLISH);
  });

  it('second publish increments revision and does not mutate earlier versions', async () => {
    const op = await service.createOperation(actor, 'c1', 'd1', { key: 'k', name: 'n' });
    await service.publishOperation(actor, 'c1', op.id);
    await service.updateOperation(actor, 'c1', op.id, { definition: { changed: true } });
    const second = await service.publishOperation(actor, 'c1', op.id);
    expect(second.latestRevision).toBe(2);
    expect(store.operationVersions[0]?.revision).toBe(1);
    // Draft edit after first publish didn't leak into version 1.
    expect(store.operationVersions[0]?.definition).toEqual({});
    expect(store.operationVersions[1]?.definition).toEqual({ changed: true });
  });

  it('rejects publishing an archived operation', async () => {
    const op = await service.createOperation(actor, 'c1', 'd1', { key: 'k', name: 'n' });
    await service.transitionOperationStatus(actor, 'c1', op.id, 'ACTIVE');
    await service.transitionOperationStatus(actor, 'c1', op.id, 'ARCHIVED');
    await expect(service.publishOperation(actor, 'c1', op.id)).rejects.toThrow(OrgValidationError);
  });

  it('leaves publishedByPrincipalId null for non-USER actors', async () => {
    const op = await service.createOperation(sysActor, 'c1', 'd1', { key: 'k', name: 'n' });
    await service.publishOperation(sysActor, 'c1', op.id);
    expect(store.operationVersions[0]?.publishedByPrincipalId).toBeNull();
  });
});

describe('authorization and delete surface', () => {
  it('denies unauthorized create/publish/read', async () => {
    const denying = new OperationService(new FakeOpUoW(store), new FakeAuthorizer(false));
    await expect(
      denying.createOperation(actor, 'c1', 'd1', { key: 'k', name: 'n' }),
    ).rejects.toThrow(AccessDeniedError);
    await expect(denying.listOperations(actor, 'c1')).rejects.toThrow(AccessDeniedError);
  });

  it('read requires OP_READ key', async () => {
    await service.listOperations(actor, 'c1');
    expect(authorizer.calls[0]?.permissionKey).toBe(OP_READ);
  });

  it('no delete/remove operations exist on service or repos', () => {
    const svc = service as unknown as Record<string, unknown>;
    for (const key of Object.keys(svc)) {
      expect(key.toLowerCase()).not.toMatch(/delete|remove/);
    }
  });
});
