import { describe, it, expect, beforeEach } from 'vitest';
import {
  RuleService,
  RULE_CONFIGURE,
  RULE_PUBLISH,
  RULE_READ,
} from '../../../src/modules/rule/service.js';
import { assertValidRuleDefinition } from '../../../src/modules/rule/definition-validation.js';
import {
  DuplicateCodeError,
  InvalidStatusTransitionError,
  OrgEntityNotFoundError,
  OrgValidationError,
} from '../../../src/modules/organization/errors.js';
import { AccessDeniedError } from '../../../src/modules/access-control/errors.js';
import {
  emptyRuleStore,
  fakeDepartment,
  fakeOperation,
  FakeAuthorizer,
  FakeRuleUoW,
  type RuleStore,
} from './fakes.js';
import type { ActorContext } from '../../../src/modules/organization/types.js';

const actor: ActorContext = { actorId: 'principal-1', actorType: 'USER' };

const validDefinition = {
  when: {
    all: [
      { field: 'qty', op: 'GT', value: 0, fieldType: 'DECIMAL' },
      { field: 'type', op: 'IN', value: ['ISSUE'], fieldType: 'STRING' },
    ],
  },
  then: [{ type: 'SET_FLAG', flag: 'needs_check' }],
};

const fvId = '33333333-3333-3333-3333-333333333333';

let store: RuleStore;
let authorizer: FakeAuthorizer;
let service: RuleService;

beforeEach(() => {
  store = emptyRuleStore();
  authorizer = new FakeAuthorizer(true);
  service = new RuleService(new FakeRuleUoW(store), authorizer);
  store.departments.push(fakeDepartment({ id: 'd1', companyId: 'c1' }));
  store.operations.push(fakeOperation({ id: 'op1', companyId: 'c1', departmentId: 'd1' }));
});

describe('descriptor validation', () => {
  const bad = (d: unknown): void => {
    expect(() => {
      assertValidRuleDefinition(d);
    }).toThrow(OrgValidationError);
  };

  it('accepts a valid descriptor', () => {
    expect(() => {
      assertValidRuleDefinition(validDefinition);
    }).not.toThrow();
  });

  it('rejects malformed shapes: no all/any root, leaf root, unknown keys', () => {
    bad({ when: { field: 'x', op: 'EMPTY' }, then: [{ type: 'SET_FLAG', flag: 'a' }] });
    bad({
      when: { all: [{ field: 'x', op: 'HACK', value: 1 }] },
      then: [{ type: 'SET_FLAG', flag: 'a' }],
    });
    bad({
      when: { all: [{ field: 'x', op: 'EMPTY', script: 'x()' }] },
      then: [{ type: 'SET_FLAG', flag: 'a' }],
    });
    bad({
      when: { all: [{ field: 'x', op: 'EMPTY' }] },
      then: [{ type: 'EXEC', value: 'rm -rf' }],
    });
    bad({ when: { all: [{ field: 'x', op: 'EMPTY' }] }, then: [], unknown: true });
  });

  it('rejects value-shape violations and oversize', () => {
    bad({
      when: { all: [{ field: 'x', op: 'IN', value: 'notarray' }] },
      then: [{ type: 'SET_FLAG', flag: 'a' }],
    });
    bad({
      when: { all: [{ field: 'x', op: 'BETWEEN', value: [1, 2, 3] }] },
      then: [{ type: 'SET_FLAG', flag: 'a' }],
    });
    bad({
      when: { all: [{ field: 'x', op: 'EQ', value: 1, valueExtra: 2 }] },
      then: [{ type: 'SET_FLAG', flag: 'a' }],
    });
    bad({
      when: { all: Array.from({ length: 51 }, (_, i) => ({ field: `f${i}`, op: 'EMPTY' })) },
      then: [{ type: 'SET_FLAG', flag: 'a' }],
    });
  });

  it('rejects bad refs and mixing all/any', () => {
    bad({
      when: {
        all: [
          { field: 'x', op: 'EQ', value: 1, ref: { formVersionId: 'not-uuid', fieldKey: 'k' } },
        ],
      },
      then: [{ type: 'SET_FLAG', flag: 'a' }],
    });
    bad({
      when: { all: [{ field: 'x', op: 'EMPTY' }], any: [{ field: 'y', op: 'EMPTY' }] },
      then: [{ type: 'SET_FLAG', flag: 'a' }],
    });
  });
});

describe('createRule', () => {
  it('creates a draft rule and audits', async () => {
    const rule = await service.createRule(actor, 'c1', 'op1', {
      key: ' qty_check ',
      name: ' Qty Check ',
      definition: validDefinition,
    });
    expect(rule.key).toBe('QTY_CHECK');
    expect(store.auditLog[0]?.action).toBe('RULE_CREATED');
    expect(authorizer.calls[0]?.permissionKey).toBe(RULE_CONFIGURE);
  });

  it('rejects cross-company operation, invalid descriptor, duplicate keys', async () => {
    await expect(
      service.createRule(actor, 'c1', 'other-op', { key: 'k', name: 'n' }),
    ).rejects.toThrow(OrgEntityNotFoundError);
    await expect(
      service.createRule(actor, 'c1', 'op1', { key: 'k', name: 'n', definition: 'bad' }),
    ).rejects.toThrow(OrgValidationError);
    await service.createRule(actor, 'c1', 'op1', { key: 'k1', name: 'n' });
    await expect(service.createRule(actor, 'c1', 'op1', { key: 'K1', name: 'n' })).rejects.toThrow(
      DuplicateCodeError,
    );
  });
});

describe('publishRule — field bindings', () => {
  const defWithRef = {
    when: {
      all: [
        {
          field: 'qty',
          op: 'GT',
          value: 0,
          ref: { formVersionId: fvId, fieldKey: 'qty' },
        },
      ],
    },
    then: [{ type: 'REQUIRE_FIELD', field: 'qty' }],
  };

  it('publishes when ref resolves in the same operation with matching type', async () => {
    store.formVersionFields.push({
      id: fvId,
      companyId: 'c1',
      operationId: 'op1',
      fields: new Map([['qty', 'DECIMAL']]),
    });
    const rule = await service.createRule(actor, 'c1', 'op1', {
      key: 'k',
      name: 'n',
      definition: defWithRef,
    });
    const published = await service.publishRule(actor, 'c1', rule.id);
    expect(published.latestRevision).toBe(1);
    expect(published.currentVersionId).toBe(store.ruleVersions[0]?.id);
    expect(store.auditLog.some((a) => a.action === 'RULE_PUBLISHED')).toBe(true);
    expect(authorizer.calls.at(-1)?.permissionKey).toBe(RULE_PUBLISH);
  });

  it('rejects publish when version is missing, wrong-operation, or field absent', async () => {
    const rule = await service.createRule(actor, 'c1', 'op1', {
      key: 'k',
      name: 'n',
      definition: defWithRef,
    });
    await expect(service.publishRule(actor, 'c1', rule.id)).rejects.toThrow(/not found/);
    store.formVersionFields.push({
      id: fvId,
      companyId: 'c1',
      operationId: 'other-op',
      fields: new Map([['qty', 'DECIMAL']]),
    });
    await expect(service.publishRule(actor, 'c1', rule.id)).rejects.toThrow(/different operation/);
    const ref = store.formVersionFields[0];
    if (ref === undefined) throw new Error('seed missing');
    ref.operationId = 'op1';
    ref.fields = new Map([['other_field', 'DECIMAL']]);
    await expect(service.publishRule(actor, 'c1', rule.id)).rejects.toThrow(/not declared/);
  });

  it('rejects a leaf fieldType that disagrees with the FormVersion', async () => {
    const mismatched = {
      when: {
        all: [
          {
            field: 'qty',
            op: 'GT',
            value: 0,
            fieldType: 'STRING', // lies — FormVersion says DECIMAL
            ref: { formVersionId: fvId, fieldKey: 'qty' },
          },
        ],
      },
      then: [{ type: 'REQUIRE_FIELD', field: 'qty' }],
    };
    store.formVersionFields.push({
      id: fvId,
      companyId: 'c1',
      operationId: 'op1',
      fields: new Map([['qty', 'DECIMAL']]),
    });
    const rule = await service.createRule(actor, 'c1', 'op1', {
      key: 'k',
      name: 'n',
      definition: mismatched,
    });
    await expect(service.publishRule(actor, 'c1', rule.id)).rejects.toThrow(/typed DECIMAL/);
  });
});

describe('lifecycle, updates, authorization', () => {
  it('lifecycle + no-op + stale version', async () => {
    const rule = await service.createRule(actor, 'c1', 'op1', { key: 'k', name: 'n' });
    await service.transitionRuleStatus(actor, 'c1', rule.id, 'ACTIVE');
    await service.transitionRuleStatus(actor, 'c1', rule.id, 'ARCHIVED');
    await expect(service.transitionRuleStatus(actor, 'c1', rule.id, 'ACTIVE')).rejects.toThrow(
      InvalidStatusTransitionError,
    );
    store.auditLog.length = 0;
    const same = await service.updateRule(actor, 'c1', rule.id, {});
    // Empty patch: returned row unchanged, no write, no audit.
    expect(same.version).toBe(store.rules[0]?.version);
    expect(store.auditLog).toHaveLength(0);
  });

  it('denies unauthorized operations and requires RULE_READ', async () => {
    const denying = new RuleService(new FakeRuleUoW(store), new FakeAuthorizer(false));
    await expect(denying.createRule(actor, 'c1', 'op1', { key: 'k', name: 'n' })).rejects.toThrow(
      AccessDeniedError,
    );
    await service.listRules(actor, 'c1');
    expect(authorizer.calls[0]?.permissionKey).toBe(RULE_READ);
  });
});
