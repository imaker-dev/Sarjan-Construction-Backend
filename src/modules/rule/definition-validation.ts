import { OrgValidationError } from '../organization/errors.js';
import {
  EVAL_OPS,
  FIELD_TYPES,
  MAX_EVAL_DEPTH,
  MAX_EVAL_LEAVES,
  MAX_IN_ELEMENTS,
} from './evaluator.js';
import type { LeafPredicate } from './evaluator.js';

// Bounded declarative rule descriptor:
//   { "when": {all|any of leaf predicates}, "then": [{type, params}] }
// Actions are inert descriptors — never executed by this engine.

export const RULE_ACTION_TYPES = [
  'SET_FIELD_VALUE',
  'REQUIRE_FIELD',
  'SET_FLAG',
  'REJECT_SUBMISSION',
] as const;

const FIELD_KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_DEFINITION_BYTES = 16 * 1024;
const MAX_ACTIONS = 20;
const MAX_VALUE_CHARS = 512;
const MAX_FIELD_NAME = 100;

function fail(field: string, message: string): never {
  throw new OrgValidationError(field, message);
}

// A leaf may carry an explicit immutable field binding — publish-time checks
// resolve the declared type from that FormVersion's schema.
export interface FieldRef {
  formVersionId: string;
  fieldKey: string;
}

export interface LeafWithRef extends LeafPredicate {
  ref?: FieldRef;
}

function validateLeaf(raw: unknown, path: string): void {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    fail(path, 'leaf predicate must be an object');
  }
  const p = raw as LeafWithRef;
  for (const k of Object.keys(p)) {
    if (!['field', 'op', 'value', 'fieldType', 'ref'].includes(k)) {
      fail(path, `unknown property ${k}`);
    }
  }
  if (typeof p.field !== 'string' || p.field.length === 0 || p.field.length > MAX_FIELD_NAME) {
    fail(`${path}.field`, `must be a field name of 1-${MAX_FIELD_NAME} chars`);
  }
  if (!EVAL_OPS.includes(p.op as never)) {
    fail(`${path}.op`, `unsupported operator ${JSON.stringify(p.op)}`);
  }
  if (p.fieldType !== undefined && !FIELD_TYPES.includes(p.fieldType as never)) {
    fail(`${path}.fieldType`, `unsupported type ${JSON.stringify(p.fieldType)}`);
  }
  const valueRequired = !['EMPTY', 'NOT_EMPTY'].includes(p.op);
  if (valueRequired && p.value === undefined) fail(`${path}.value`, `required for ${p.op}`);
  if (!valueRequired && p.value !== undefined) {
    fail(`${path}.value`, `must be omitted for ${p.op}`);
  }
  if (p.value !== undefined && JSON.stringify(p.value).length > MAX_VALUE_CHARS) {
    fail(`${path}.value`, `exceeds ${MAX_VALUE_CHARS} serialized chars`);
  }
  if (['IN', 'NOT_IN'].includes(p.op)) {
    if (!Array.isArray(p.value) || p.value.length === 0 || p.value.length > MAX_IN_ELEMENTS) {
      fail(`${path}.value`, `${p.op} requires an array of 1-${MAX_IN_ELEMENTS} elements`);
    }
  }
  if (p.op === 'BETWEEN' && (!Array.isArray(p.value) || p.value.length !== 2)) {
    fail(`${path}.value`, 'BETWEEN requires a two-element array [low, high]');
  }
  if (p.ref !== undefined) {
    const r: unknown = p.ref;
    if (typeof r !== 'object' || r === null) fail(`${path}.ref`, 'must be an object');
    const rr = r as FieldRef;
    for (const k of Object.keys(rr)) {
      if (!['formVersionId', 'fieldKey'].includes(k)) fail(`${path}.ref`, `unknown key ${k}`);
    }
    if (typeof rr.formVersionId !== 'string' || !UUID_RE.test(rr.formVersionId)) {
      fail(`${path}.ref.formVersionId`, 'must be a UUID');
    }
    if (typeof rr.fieldKey !== 'string' || !FIELD_KEY_RE.test(rr.fieldKey)) {
      fail(`${path}.ref.fieldKey`, 'must be a normalized field key');
    }
  }
}

function validateTree(node: unknown, path: string, depth: number): void {
  if (depth > MAX_EVAL_DEPTH) fail(path, `exceeds nesting depth ${MAX_EVAL_DEPTH}`);
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    fail(path, 'condition node must be an object');
  }
  if ('all' in node && 'any' in node) {
    fail(path, 'cannot mix all and any at one node');
  }
  const list = 'all' in node ? node.all : 'any' in node ? node.any : undefined;
  if (list === undefined) {
    // Leaf predicate.
    validateLeaf(node, path);
    return;
  }
  if (!Array.isArray(list) || list.length === 0) {
    fail(path, 'node requires a non-empty all or any');
  }
  for (const [i, child] of list.entries()) {
    validateTree(child, `${path}.${i}`, depth + 1);
  }
}

function validateActions(then: unknown): void {
  if (!Array.isArray(then) || then.length === 0)
    fail('definition.then', 'must be a non-empty array');
  if (then.length > MAX_ACTIONS) fail('definition.then', `exceeds ${MAX_ACTIONS} actions`);
  for (const [i, raw] of then.entries()) {
    const path = `definition.then.${i}`;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      fail(path, 'each action must be an object');
    }
    const a = raw as Record<string, unknown>;
    for (const k of Object.keys(a)) {
      if (!['type', 'field', 'value', 'flag'].includes(k)) fail(path, `unknown property ${k}`);
    }
    if (!RULE_ACTION_TYPES.includes(a.type as never)) {
      fail(`${path}.type`, `unsupported action ${JSON.stringify(a.type)}`);
    }
    switch (a.type) {
      case 'SET_FIELD_VALUE':
      case 'REQUIRE_FIELD': {
        if (typeof a.field !== 'string' || !FIELD_KEY_RE.test(a.field)) {
          fail(`${path}.field`, 'must be a normalized field key');
        }
        if (a.type === 'SET_FIELD_VALUE' && a.value === undefined) {
          fail(`${path}.value`, 'required');
        }
        break;
      }
      case 'SET_FLAG': {
        if (typeof a.flag !== 'string' || !FIELD_KEY_RE.test(a.flag)) {
          fail(`${path}.flag`, 'must be a normalized key');
        }
        break;
      }
      case 'REJECT_SUBMISSION':
        break;
    }
    if (a.value !== undefined && JSON.stringify(a.value).length > MAX_VALUE_CHARS) {
      fail(`${path}.value`, `exceeds ${MAX_VALUE_CHARS} chars`);
    }
  }
}

export function assertValidRuleDefinition(definition: unknown): void {
  if (definition === null || typeof definition !== 'object' || Array.isArray(definition)) {
    fail('definition', 'must be a JSON object');
  }
  const serialized = JSON.stringify(definition);
  if (serialized.length > MAX_DEFINITION_BYTES) {
    fail('definition', `exceeds ${MAX_DEFINITION_BYTES} bytes`);
  }
  const root = definition as Record<string, unknown>;
  for (const k of Object.keys(root)) {
    if (!['when', 'then'].includes(k)) fail('definition', `unknown top-level key ${k}`);
  }
  const when = root.when;
  if (when === null || typeof when !== 'object' || Array.isArray(when)) {
    fail('definition.when', 'must be an object with all/any');
  }
  // The root must be a grouping node (all/any), not a bare leaf.
  const w = when as { all?: unknown[]; any?: unknown[] };
  if (w.all === undefined && w.any === undefined) {
    fail('definition.when', 'must start with all or any');
  }
  validateTree(when, 'definition.when', 1);
  // Count leaves recursively for the limit.
  const countLeaves = (node: unknown): number => {
    const n = node as { all?: unknown[]; any?: unknown[] };
    const list = n.all ?? n.any;
    if (list === undefined) return 1;
    return list.reduce((sum: number, c) => sum + countLeaves(c), 0);
  };
  const total = countLeaves(when);
  if (total > MAX_EVAL_LEAVES) fail('definition.when', `exceeds ${MAX_EVAL_LEAVES} conditions`);
  validateActions(root.then);
}

// Extract every immutable field binding for publish-time verification —
// includes the leaf's declared fieldType (if any) so publish can reject a
// descriptor that disagrees with the FormVersion's type.
export interface BoundFieldRef extends FieldRef {
  declaredType?: string;
}

export function fieldRefs(definition: unknown): BoundFieldRef[] {
  const refs: BoundFieldRef[] = [];
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return;
    const n = node as { all?: unknown[]; any?: unknown[]; ref?: FieldRef; fieldType?: string };
    for (const list of [n.all, n.any]) {
      if (Array.isArray(list)) for (const c of list) walk(c);
    }
    if (n.ref !== undefined) {
      refs.push({ ...n.ref, ...(n.fieldType !== undefined ? { declaredType: n.fieldType } : {}) });
    }
  };
  walk((definition as { when?: unknown }).when);
  return refs;
}
