// Pure, deterministic predicate evaluator. No eval, no user code, no side
// effects. Evaluation returns a tri-state result so callers can fail closed on
// malformed input rather than treating errors as "not matched".
//
// Null semantics (documented contract):
//  - EMPTY is true only for null/undefined/missing; NOT_EMPTY is its inverse.
//  - EQ with a null literal value means "is null" and equals EMPTY.
//  - Every other operator with a missing/null operand → VALID NO_MATCH.
//  - Type mismatches, malformed canonical inputs (dates, decimals), or
//    unsupported ops → INVALID (callers must fail closed).

export type EvalOutcome = 'MATCH' | 'NO_MATCH' | 'INVALID';

export interface EvalResult {
  outcome: EvalOutcome;
  reason?: string;
}

export const EVAL_OPS = [
  'EQ',
  'NE',
  'IN',
  'NOT_IN',
  'EMPTY',
  'NOT_EMPTY',
  'GT',
  'GTE',
  'LT',
  'LTE',
  'BETWEEN',
  'CONTAINS',
] as const;
export type EvalOp = (typeof EVAL_OPS)[number];

export const FIELD_TYPES = [
  'STRING',
  'NUMBER',
  'DECIMAL',
  'DATE',
  'TIME',
  'DATETIME',
  'BOOLEAN',
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export interface LeafPredicate {
  field: string;
  op: string;
  value?: unknown;
  fieldType?: string;
}

export interface ConditionNode {
  all?: Condition[];
  any?: Condition[];
}
export type Condition = ConditionNode | LeafPredicate;

export const MAX_EVAL_DEPTH = 4;
export const MAX_EVAL_LEAVES = 50;
export const MAX_CONTEXT_BYTES = 64 * 1024;
export const MAX_IN_ELEMENTS = 100;

// ---------------------------------------------------------------------------
// Canonical typed comparison — no raw-string date/decimal comparisons.
// ---------------------------------------------------------------------------

export const DATE_RE = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;
// Datetime must carry timezone info: Z or ±HH:MM offset.
export const DATETIME_RE =
  /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d+)?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)$/;
export const DECIMAL_RE = /^[+-]?\d+(\.\d+)?$/;

// Compare two decimal strings exactly, without floating-point rounding.
// Returns -1|0|1 or null when either side is not canonical decimal.
export function compareDecimal(a: string, b: string): number | null {
  if (!DECIMAL_RE.test(a) || !DECIMAL_RE.test(b)) return null;
  const norm = (s: string) => {
    const neg = s.startsWith('-');
    const clean = s.replace(/^[+-]/, '');
    const [intPart = '0', fracPart = ''] = clean.split('.');
    const intNorm = intPart.replace(/^0+/, '') || '0';
    const fracNorm = fracPart.replace(/0+$/, '');
    return { neg, intNorm, fracNorm };
  };
  const x = norm(a);
  const y = norm(b);
  const xZero = x.intNorm === '0' && x.fracNorm === '';
  const yZero = y.intNorm === '0' && y.fracNorm === '';
  if (xZero && yZero) return 0;
  if (x.neg !== y.neg) return x.neg ? -1 : 1;
  const sign = x.neg ? -1 : 1;
  if (x.intNorm.length !== y.intNorm.length) {
    return (x.intNorm.length - y.intNorm.length) * sign;
  }
  if (x.intNorm !== y.intNorm) return (x.intNorm < y.intNorm ? -1 : 1) * sign;
  const len = Math.max(x.fracNorm.length, y.fracNorm.length);
  const xf = x.fracNorm.padEnd(len, '0');
  const yf = y.fracNorm.padEnd(len, '0');
  if (xf === yf) return 0;
  return (xf < yf ? -1 : 1) * sign;
}

function toDateOrdinal(iso: string): number | null {
  const m = DATE_RE.exec(iso);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  // Valid calendar date.
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) {
    return null;
  }
  return Math.floor(date.getTime() / 86_400_000);
}

function toTimeSeconds(value: string): number | null {
  if (!TIME_RE.test(value)) return null;
  const [h = 0, m = 0, s = 0] = value.split(':').map(Number);
  return h * 3600 + m * 60 + s;
}

function toEpochMs(value: string): number | null {
  if (!DATETIME_RE.test(value)) return null; // timezone info required
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

// Canonicalize a context/literal value for a declared type. null → INVALID.
function canonicalize(value: unknown, type: FieldType): number | string | boolean | null {
  switch (type) {
    case 'STRING':
      return typeof value === 'string' ? value : null;
    case 'BOOLEAN':
      return typeof value === 'boolean' ? value : null;
    case 'NUMBER':
    case 'DECIMAL': {
      if (typeof value === 'number' && Number.isFinite(value)) return String(value);
      if (typeof value === 'string' && DECIMAL_RE.test(value)) return value;
      return null;
    }
    case 'DATE':
      return typeof value === 'string' ? toDateOrdinal(value) : null;
    case 'TIME':
      return typeof value === 'string' ? toTimeSeconds(value) : null;
    case 'DATETIME':
      return typeof value === 'string' ? toEpochMs(value) : null;
  }
}

function compareCanonical(a: unknown, b: unknown, type: FieldType): number | null {
  if (type === 'DECIMAL' || type === 'NUMBER') {
    if (typeof a !== 'string' || typeof b !== 'string') return null;
    return compareDecimal(a, b);
  }
  if (typeof a !== typeof b) return null;
  if (typeof a === 'number' && typeof b === 'number') return a === b ? 0 : a < b ? -1 : 1;
  if (typeof a === 'string' && typeof b === 'string') return a === b ? 0 : a < b ? -1 : 1;
  if (typeof a === 'boolean' && typeof b === 'boolean') return a === b ? 0 : 1;
  return null;
}

function isMissing(v: unknown): boolean {
  return v === undefined || v === null;
}

const leafResult = (outcome: EvalOutcome, reason?: string): EvalResult =>
  reason === undefined ? { outcome } : { outcome, reason };

// Evaluate one leaf predicate against a context. When `strictType` is false
// (Form `when` compatibility), types are inferred from the context value and
// mismatches are NO_MATCH rather than INVALID.
function evalLeaf(p: LeafPredicate, ctx: Record<string, unknown>, strictType: boolean): EvalResult {
  const type = p.fieldType as FieldType | undefined;
  if (type !== undefined && !FIELD_TYPES.includes(type)) {
    return leafResult('INVALID', `unsupported fieldType ${p.fieldType}`);
  }
  if (!EVAL_OPS.includes(p.op as EvalOp)) {
    return leafResult('INVALID', `unsupported op ${p.op}`);
  }
  const actual = ctx[p.field];

  if (p.op === 'EMPTY') return leafResult(isMissing(actual) ? 'MATCH' : 'NO_MATCH');
  if (p.op === 'NOT_EMPTY') return leafResult(isMissing(actual) ? 'NO_MATCH' : 'MATCH');

  // EQ null literal = "is null".
  if (p.op === 'EQ' && p.value === null) {
    return leafResult(isMissing(actual) ? 'MATCH' : 'NO_MATCH');
  }
  if (isMissing(actual)) return leafResult('NO_MATCH');

  // Infer the type when not declared: strict mode requires a declarable type.
  let effectiveType: FieldType;
  if (type !== undefined) {
    effectiveType = type;
  } else if (typeof actual === 'string') {
    effectiveType = 'STRING';
  } else if (typeof actual === 'number') {
    effectiveType = 'DECIMAL';
  } else if (typeof actual === 'boolean') {
    effectiveType = 'BOOLEAN';
  } else if (strictType) {
    return leafResult('INVALID', `cannot infer type for field ${p.field}`);
  } else {
    return leafResult('NO_MATCH'); // inferred mode: unrepresentable → no-match
  }

  switch (p.op) {
    case 'IN':
    case 'NOT_IN': {
      if (!Array.isArray(p.value)) return leafResult('INVALID', 'IN requires an array value');
      if (p.value.length > MAX_IN_ELEMENTS) {
        return leafResult('INVALID', `IN exceeds ${MAX_IN_ELEMENTS} elements`);
      }
      for (const candidate of p.value) {
        const ca = canonicalize(actual, effectiveType);
        const cb = canonicalize(candidate, effectiveType);
        if (ca === null || cb === null) {
          return strictType || type !== undefined
            ? leafResult('INVALID', `type mismatch on field ${p.field}`)
            : leafResult('NO_MATCH');
        }
        const cmp = compareCanonical(ca, cb, effectiveType);
        if (cmp === null) return leafResult('INVALID', `type mismatch on field ${p.field}`);
        if (cmp === 0) return leafResult(p.op === 'IN' ? 'MATCH' : 'NO_MATCH');
      }
      return leafResult(p.op === 'IN' ? 'NO_MATCH' : 'MATCH');
    }
    case 'CONTAINS': {
      if (!Array.isArray(actual)) {
        return strictType
          ? leafResult('INVALID', 'CONTAINS requires array operand')
          : leafResult('NO_MATCH');
      }
      const cb = canonicalize(p.value, effectiveType);
      if (cb === null) return leafResult('INVALID', `type mismatch on field ${p.field}`);
      for (const el of actual) {
        const ca = canonicalize(el, effectiveType);
        if (ca !== null && compareCanonical(ca, cb, effectiveType) === 0) {
          return leafResult('MATCH');
        }
      }
      return leafResult('NO_MATCH');
    }
    case 'BETWEEN': {
      const range = p.value;
      if (!Array.isArray(range) || range.length !== 2) {
        return leafResult('INVALID', 'BETWEEN requires a two-element array');
      }
      const ca = canonicalize(actual, effectiveType);
      const lo = canonicalize(range[0], effectiveType);
      const hi = canonicalize(range[1], effectiveType);
      if (ca === null || lo === null || hi === null) {
        return strictType || type !== undefined
          ? leafResult('INVALID', `type mismatch on field ${p.field}`)
          : leafResult('NO_MATCH');
      }
      const cLo = compareCanonical(ca, lo, effectiveType);
      const cHi = compareCanonical(ca, hi, effectiveType);
      if (cLo === null || cHi === null) {
        return leafResult('INVALID', `type mismatch on field ${p.field}`);
      }
      return leafResult(cLo >= 0 && cHi <= 0 ? 'MATCH' : 'NO_MATCH');
    }
    default: {
      const ca = canonicalize(actual, effectiveType);
      const cb = canonicalize(p.value, effectiveType);
      if (ca === null || cb === null) {
        return strictType || type !== undefined
          ? leafResult('INVALID', `type mismatch on field ${p.field}`)
          : leafResult('NO_MATCH');
      }
      const cmp = compareCanonical(ca, cb, effectiveType);
      if (cmp === null) return leafResult('INVALID', `type mismatch on field ${p.field}`);
      switch (p.op) {
        case 'EQ':
          return leafResult(cmp === 0 ? 'MATCH' : 'NO_MATCH');
        case 'NE':
          return leafResult(cmp !== 0 ? 'MATCH' : 'NO_MATCH');
        case 'GT':
          return leafResult(cmp > 0 ? 'MATCH' : 'NO_MATCH');
        case 'GTE':
          return leafResult(cmp >= 0 ? 'MATCH' : 'NO_MATCH');
        case 'LT':
          return leafResult(cmp < 0 ? 'MATCH' : 'NO_MATCH');
        case 'LTE':
          return leafResult(cmp <= 0 ? 'MATCH' : 'NO_MATCH');
        default:
          return leafResult('INVALID', `unsupported op ${p.op}`);
      }
    }
  }
}

function isLeaf(c: Condition): c is LeafPredicate {
  return typeof (c as LeafPredicate).field === 'string' && (c as LeafPredicate).field !== '';
}

interface EvalBudget {
  leaves: number;
}

function evalNode(
  node: Condition,
  ctx: Record<string, unknown>,
  depth: number,
  budget: EvalBudget,
  strictType: boolean,
): EvalResult {
  if (depth > MAX_EVAL_DEPTH) return leafResult('INVALID', `exceeds depth ${MAX_EVAL_DEPTH}`);
  if (isLeaf(node)) {
    budget.leaves += 1;
    if (budget.leaves > MAX_EVAL_LEAVES) {
      return leafResult('INVALID', `exceeds ${MAX_EVAL_LEAVES} conditions`);
    }
    return evalLeaf(node, ctx, strictType);
  }
  const list = 'all' in node ? node.all : 'any' in node ? node.any : undefined;
  if (!Array.isArray(list) || list.length === 0) {
    return leafResult('INVALID', 'condition node needs non-empty all/any');
  }
  const isAll = 'all' in node;
  for (const child of list) {
    const r = evalNode(child, ctx, depth + 1, budget, strictType);
    if (r.outcome === 'INVALID') return r;
    if (isAll && r.outcome === 'NO_MATCH') return leafResult('NO_MATCH');
    if (!isAll && r.outcome === 'MATCH') return leafResult('MATCH');
  }
  return leafResult(isAll ? 'MATCH' : 'NO_MATCH');
}

/** Evaluate a rule condition tree. Callers must fail closed on INVALID. */
export function evaluateCondition(
  condition: Condition,
  context: unknown,
  opts: { strictType?: boolean } = {},
): EvalResult {
  if (context === null || typeof context !== 'object' || Array.isArray(context)) {
    return { outcome: 'INVALID', reason: 'context must be an object' };
  }
  const serialized = JSON.stringify(context);
  if (serialized.length > MAX_CONTEXT_BYTES) {
    return { outcome: 'INVALID', reason: 'context exceeds size limit' };
  }
  return evalNode(
    condition,
    context as Record<string, unknown>,
    1,
    { leaves: 0 },
    opts.strictType ?? true,
  );
}

/**
 * Form `when` compatibility: evaluate a single leaf predicate in inferred
 * (non-strict) typing mode — mismatched types are NO_MATCH, mirroring the
 * Form descriptor's semantics.
 */
export function evaluateWhen(
  predicate: LeafPredicate,
  context: Record<string, unknown>,
): EvalResult {
  return evalLeaf(predicate, context, false);
}
