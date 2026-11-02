import { describe, it, expect } from 'vitest';
import {
  compareDecimal,
  evaluateCondition,
  evaluateWhen,
} from '../../../src/modules/rule/evaluator.js';
import type { Condition } from '../../../src/modules/rule/evaluator.js';

const ctx = {
  qty: 5,
  type: 'ISSUE',
  active: true,
  when_date: '2026-10-20',
  due: '2026-10-25T10:30:00Z',
  tags: ['a', 'b'],
  decimal_val: '12.50',
  empty_field: null,
};

const cond = (c: Condition) => evaluateCondition(c, ctx);

describe('operator coverage', () => {
  it('EQ/NE/IN/NOT_IN on strings', () => {
    expect(cond({ field: 'type', op: 'EQ', value: 'ISSUE', fieldType: 'STRING' }).outcome).toBe(
      'MATCH',
    );
    expect(cond({ field: 'type', op: 'NE', value: 'ISSUE', fieldType: 'STRING' }).outcome).toBe(
      'NO_MATCH',
    );
    expect(
      cond({ field: 'type', op: 'IN', value: ['ISSUE', 'RETURN'], fieldType: 'STRING' }).outcome,
    ).toBe('MATCH');
    expect(
      cond({ field: 'type', op: 'NOT_IN', value: ['ISSUE'], fieldType: 'STRING' }).outcome,
    ).toBe('NO_MATCH');
  });

  it('EMPTY/NOT_EMPTY and EQ-null semantics', () => {
    expect(cond({ field: 'empty_field', op: 'EMPTY' }).outcome).toBe('MATCH');
    expect(cond({ field: 'missing', op: 'EMPTY' }).outcome).toBe('MATCH');
    expect(cond({ field: 'qty', op: 'EMPTY' }).outcome).toBe('NO_MATCH');
    expect(cond({ field: 'qty', op: 'NOT_EMPTY' }).outcome).toBe('MATCH');
    expect(cond({ field: 'empty_field', op: 'EQ', value: null }).outcome).toBe('MATCH');
  });

  it('missing operand → valid NO_MATCH (not error)', () => {
    expect(cond({ field: 'missing', op: 'GT', value: 1, fieldType: 'DECIMAL' }).outcome).toBe(
      'NO_MATCH',
    );
  });

  it('numeric comparisons', () => {
    expect(cond({ field: 'qty', op: 'GT', value: 4, fieldType: 'DECIMAL' }).outcome).toBe('MATCH');
    expect(cond({ field: 'qty', op: 'GTE', value: 5, fieldType: 'DECIMAL' }).outcome).toBe('MATCH');
    expect(cond({ field: 'qty', op: 'LT', value: 5, fieldType: 'DECIMAL' }).outcome).toBe(
      'NO_MATCH',
    );
    expect(cond({ field: 'qty', op: 'LTE', value: 5, fieldType: 'DECIMAL' }).outcome).toBe('MATCH');
  });

  it('BETWEEN and CONTAINS', () => {
    expect(
      cond({ field: 'qty', op: 'BETWEEN', value: [1, 10], fieldType: 'DECIMAL' }).outcome,
    ).toBe('MATCH');
    expect(
      cond({ field: 'qty', op: 'BETWEEN', value: [10, 20], fieldType: 'DECIMAL' }).outcome,
    ).toBe('NO_MATCH');
    expect(cond({ field: 'tags', op: 'CONTAINS', value: 'a', fieldType: 'STRING' }).outcome).toBe(
      'MATCH',
    );
    expect(cond({ field: 'tags', op: 'CONTAINS', value: 'z', fieldType: 'STRING' }).outcome).toBe(
      'NO_MATCH',
    );
  });
});

describe('typed comparisons', () => {
  it('exact decimal comparison — no float rounding', () => {
    expect(compareDecimal('0.1', '0.10')).toBe(0);
    expect(compareDecimal('12.50', '12.5')).toBe(0);
    expect(compareDecimal('0.30000000000000004', '0.3')).toBe(1); // float artifact ≠ 0.3
    expect(compareDecimal('-1', '1')).toBe(-1);
    expect(compareDecimal('100.01', '100.009')).toBe(1);
    expect(
      cond({ field: 'decimal_val', op: 'EQ', value: '12.5', fieldType: 'DECIMAL' }).outcome,
    ).toBe('MATCH');
  });

  it('dates/datetimes compare as parsed values, requiring canonical input', () => {
    expect(
      cond({ field: 'when_date', op: 'EQ', value: '2026-10-20', fieldType: 'DATE' }).outcome,
    ).toBe('MATCH');
    expect(
      cond({ field: 'when_date', op: 'LT', value: '2026-10-21', fieldType: 'DATE' }).outcome,
    ).toBe('MATCH');
    expect(
      cond({
        field: 'when_date',
        op: 'BETWEEN',
        value: ['2026-10-01', '2026-10-31'],
        fieldType: 'DATE',
      }).outcome,
    ).toBe('MATCH');
    expect(
      cond({ field: 'due', op: 'LT', value: '2026-10-26T00:00:00Z', fieldType: 'DATETIME' })
        .outcome,
    ).toBe('MATCH');
    // Datetime without timezone → INVALID, never string-compared.
    expect(
      cond({ field: 'due', op: 'LT', value: '2026-10-26T00:00:00', fieldType: 'DATETIME' }).outcome,
    ).toBe('INVALID');
    // Malformed date → INVALID.
    expect(
      cond({ field: 'when_date', op: 'EQ', value: '2026-13-99', fieldType: 'DATE' }).outcome,
    ).toBe('INVALID');
  });

  it('type mismatches are INVALID in strict mode', () => {
    expect(cond({ field: 'qty', op: 'GT', value: 'abc', fieldType: 'DECIMAL' }).outcome).toBe(
      'INVALID',
    );
    expect(cond({ field: 'type', op: 'GT', value: 5, fieldType: 'NUMBER' }).outcome).toBe(
      'INVALID',
    );
  });
});

describe('trees, limits, and when-compat', () => {
  it('all/any logic', () => {
    expect(
      cond({
        all: [
          { field: 'qty', op: 'GT', value: 0, fieldType: 'DECIMAL' },
          { field: 'active', op: 'EQ', value: true, fieldType: 'BOOLEAN' },
        ],
      }).outcome,
    ).toBe('MATCH');
    expect(
      cond({
        any: [
          { field: 'type', op: 'EQ', value: 'NOPE', fieldType: 'STRING' },
          { field: 'type', op: 'EQ', value: 'ISSUE', fieldType: 'STRING' },
        ],
      }).outcome,
    ).toBe('MATCH');
    expect(
      cond({
        all: [
          { field: 'type', op: 'EQ', value: 'NOPE', fieldType: 'STRING' },
          { field: 'qty', op: 'GT', value: 0, fieldType: 'DECIMAL' },
        ],
      }).outcome,
    ).toBe('NO_MATCH');
  });

  it('INVALID propagates out of a tree (fail closed)', () => {
    expect(
      cond({
        all: [
          { field: 'type', op: 'EQ', value: 'ISSUE', fieldType: 'STRING' },
          { field: 'qty', op: 'GT', value: 'bad', fieldType: 'DECIMAL' },
        ],
      }).outcome,
    ).toBe('INVALID');
  });

  it('rejects malformed context and depth/leaf breaches', () => {
    expect(evaluateCondition({ field: 'x', op: 'EMPTY' }, [] as never).outcome).toBe('INVALID');
    const deep: Condition = {
      all: [{ all: [{ all: [{ all: [{ all: [{ field: 'a', op: 'EMPTY' }] }] }] }] }],
    };
    expect(cond(deep).outcome).toBe('INVALID');
    const many: Condition = {
      all: Array.from({ length: 51 }, (_, i) => ({ field: `f${i}`, op: 'EMPTY' })),
    };
    expect(cond(many).outcome).toBe('INVALID');
  });

  it('when-compat: inferred typing, mismatch → NO_MATCH not INVALID', () => {
    expect(evaluateWhen({ field: 'type', op: 'EQ', value: 'ISSUE' }, ctx).outcome).toBe('MATCH');
    expect(evaluateWhen({ field: 'qty', op: 'GT', value: 'not a number' }, ctx).outcome).toBe(
      'NO_MATCH',
    );
    expect(evaluateWhen({ field: 'missing', op: 'NOT_EMPTY' }, ctx).outcome).toBe('NO_MATCH');
  });
});
