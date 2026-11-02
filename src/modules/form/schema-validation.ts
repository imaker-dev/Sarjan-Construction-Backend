import { OrgValidationError } from '../organization/errors.js';

// Field types from rule.md §8 — allowlisted. Entity-valued types are
// descriptors only; entity lookup is enforced at submission time (deferred).
export const FIELD_TYPES = [
  'TEXT',
  'NUMBER',
  'DECIMAL',
  'DATE',
  'TIME',
  'SELECT',
  'MULTI_SELECT',
  'BOOLEAN',
  'EMPLOYEE',
  'DEPARTMENT',
  'PROJECT',
  'SITE',
  'LABOUR',
  'MATERIAL',
  'MACHINE',
  'VENDOR',
  'FILE',
  'IMAGE',
  'SIGNATURE',
  'QR',
  'GPS',
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

// Declarative visibility predicate ops — evaluated by trusted code only.
export const WHEN_OPS = [
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
] as const;
export type WhenOp = (typeof WHEN_OPS)[number];

const FIELD_KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;

const MAX_SCHEMA_BYTES = 32 * 1024;
const MAX_FIELDS = 150;
const MAX_SECTIONS = 50;
const MAX_LABEL = 300;
const MAX_OPTIONS = 100;
const MAX_OPTION_LEN = 200;
const MAX_FILE_TYPES = 30;
const MAX_FILE_SIZE_KB = 50 * 1024;
const ALLOWED_FILE_TYPES = new Set([
  'pdf',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'csv',
  'xlsx',
  'docx',
]);

interface WhenClause {
  field: string;
  op: string;
  value?: unknown;
}

interface FieldSpec {
  key: string;
  type: string;
  label: string;
  required?: boolean;
  constraints?: Record<string, unknown>;
  when?: WhenClause;
}

function fail(field: string, message: string): never {
  throw new OrgValidationError(field, message);
}

function validateConstraints(spec: FieldSpec): void {
  const c: unknown = spec.constraints;
  if (c === undefined) return;
  if (typeof c !== 'object' || c === null || Array.isArray(c)) {
    fail(`fields.${spec.key}.constraints`, 'must be an object');
  }

  const cc = c as Record<string, unknown>;
  const ctx = `fields.${spec.key}.constraints`;
  if ('maxLength' in cc && (typeof cc.maxLength !== 'number' || cc.maxLength < 1)) {
    fail(ctx, 'maxLength must be a positive number');
  }
  for (const bound of ['min', 'max'] as const) {
    if (bound in cc && typeof cc[bound] !== 'number') {
      fail(ctx, `${bound} must be a number`);
    }
  }
  if (
    'min' in cc &&
    'max' in cc &&
    typeof cc.min === 'number' &&
    typeof cc.max === 'number' &&
    cc.min > cc.max
  ) {
    fail(ctx, 'min must not exceed max');
  }

  if ('options' in cc) {
    if (!['SELECT', 'MULTI_SELECT'].includes(spec.type)) {
      fail(ctx, 'options are only valid for SELECT/MULTI_SELECT fields');
    }
    const opts = cc.options;
    if (!Array.isArray(opts) || opts.length === 0) {
      fail(ctx, 'options must be a non-empty array');
    }
    if (opts.length > MAX_OPTIONS) {
      fail(ctx, `options exceed ${MAX_OPTIONS} entries`);
    }
    const seen = new Set<string>();
    for (const opt of opts) {
      if (typeof opt !== 'string' || opt.length === 0 || opt.length > MAX_OPTION_LEN) {
        fail(ctx, `options must be strings of 1-${MAX_OPTION_LEN} chars`);
      }
      if (seen.has(opt)) fail(ctx, `duplicate option ${JSON.stringify(opt)}`);
      seen.add(opt);
    }
  }

  if ('fileTypes' in cc) {
    if (!['FILE', 'IMAGE', 'SIGNATURE'].includes(spec.type)) {
      fail(ctx, 'fileTypes only apply to FILE/IMAGE/SIGNATURE fields');
    }
    const types = cc.fileTypes;
    if (!Array.isArray(types) || types.length === 0 || types.length > MAX_FILE_TYPES) {
      fail(ctx, `fileTypes must be an array of 1-${MAX_FILE_TYPES} extensions`);
    }
    for (const t of types) {
      if (typeof t !== 'string' || !ALLOWED_FILE_TYPES.has(t.toLowerCase())) {
        fail(ctx, `unsupported file type ${JSON.stringify(t)}`);
      }
    }
  }

  if ('maxFileSizeKb' in cc) {
    if (
      !['FILE', 'IMAGE', 'SIGNATURE'].includes(spec.type) ||
      typeof cc.maxFileSizeKb !== 'number' ||
      cc.maxFileSizeKb < 1 ||
      cc.maxFileSizeKb > MAX_FILE_SIZE_KB
    ) {
      fail(ctx, `maxFileSizeKb must be 1-${MAX_FILE_SIZE_KB}`);
    }
  }

  // Custom regex is intentionally unsupported — deferred decision. Allowlisted
  // built-in validators (format hints) only.
  const allowed = new Set([
    'maxLength',
    'min',
    'max',
    'options',
    'fileTypes',
    'maxFileSizeKb',
    'format',
    'integerOnly',
  ]);
  for (const key of Object.keys(c)) {
    if (!allowed.has(key)) fail(ctx, `unknown constraint ${JSON.stringify(key)}`);
  }
}

function validateWhen(spec: FieldSpec): void {
  const w: unknown = spec.when;
  if (w === undefined) return;
  if (typeof w !== 'object' || w === null) fail(`fields.${spec.key}.when`, 'must be an object');
  const clause = w as WhenClause;
  if (typeof clause.field !== 'string' || !FIELD_KEY_RE.test(clause.field)) {
    fail(`fields.${spec.key}.when.field`, 'must be a valid field key');
  }
  if (clause.field === spec.key) {
    fail(`fields.${spec.key}.when`, 'self-referencing condition');
  }
  if (!WHEN_OPS.includes(clause.op as WhenOp)) {
    fail(`fields.${spec.key}.when.op`, `unknown operator ${JSON.stringify(clause.op)}`);
  }
  const valueRequired = !['EMPTY', 'NOT_EMPTY'].includes(clause.op);
  if (valueRequired && clause.value === undefined) {
    fail(`fields.${spec.key}.when.value`, `required for ${clause.op}`);
  }
  if (!valueRequired && clause.value !== undefined) {
    fail(`fields.${spec.key}.when.value`, `must be omitted for ${clause.op}`);
  }
}

// A's `when` must not form a dependency cycle (A→B→…→A). Simple DFS.
function detectCycles(fields: FieldSpec[]): void {
  const refs = new Map<string, string | undefined>();
  for (const f of fields) refs.set(f.key, f.when?.field);

  const seen = new Set<string>();
  for (const f of fields) {
    const trail = new Set<string>();
    let cursor: string | undefined = f.key;
    while (cursor !== undefined && !seen.has(cursor)) {
      if (trail.has(cursor)) fail(`fields.${f.key}.when`, 'cyclic field dependency');
      trail.add(cursor);
      cursor = refs.get(cursor);
    }
    for (const k of trail) seen.add(k);
  }
}

/**
 * Validate a draft form descriptor. Fails closed on any unknown or malformed
 * structure. Returns nothing — throws OrgValidationError on failure.
 */
export function assertValidFormSchema(schema: unknown): void {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    fail('schema', 'must be a JSON object');
  }
  const serialized = JSON.stringify(schema);
  if (serialized.length > MAX_SCHEMA_BYTES) {
    fail('schema', `exceeds ${MAX_SCHEMA_BYTES} bytes`);
  }
  const root = schema as Record<string, unknown>;
  const allowed = new Set(['fields', 'sections']);
  for (const key of Object.keys(root)) {
    if (!allowed.has(key)) fail('schema', `unknown top-level key ${JSON.stringify(key)}`);
  }

  const rawFields = root.fields;
  if (!Array.isArray(rawFields)) fail('schema.fields', 'must be an array');
  if (rawFields.length > MAX_FIELDS) fail('schema.fields', `exceeds ${MAX_FIELDS} fields`);

  const seenKeys = new Set<string>();
  const specs: FieldSpec[] = [];
  for (const raw of rawFields) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      fail('schema.fields', 'each field must be an object');
    }
    const spec = raw as FieldSpec;
    if (typeof spec.key !== 'string' || !FIELD_KEY_RE.test(spec.key)) {
      fail('schema.fields', `invalid field key ${JSON.stringify(spec.key)}`);
    }
    if (seenKeys.has(spec.key)) fail('schema.fields', `duplicate field key ${spec.key}`);
    seenKeys.add(spec.key);
    if (!FIELD_TYPES.includes(spec.type as FieldType)) {
      fail(`fields.${spec.key}.type`, `unsupported type ${JSON.stringify(spec.type)}`);
    }
    if (
      typeof spec.label !== 'string' ||
      spec.label.trim().length === 0 ||
      spec.label.length > MAX_LABEL
    ) {
      fail(`fields.${spec.key}.label`, `must be a string of 1-${MAX_LABEL} chars`);
    }
    if (spec.required !== undefined && typeof spec.required !== 'boolean') {
      fail(`fields.${spec.key}.required`, 'must be a boolean');
    }
    const allowedFieldKeys = new Set(['key', 'type', 'label', 'required', 'constraints', 'when']);
    for (const k of Object.keys(spec)) {
      if (!allowedFieldKeys.has(k)) fail(`fields.${spec.key}`, `unknown property ${k}`);
    }
    validateConstraints(spec);
    validateWhen(spec);
    specs.push(spec);
  }
  // `when` must reference a declared field (existence checked after all keys).
  for (const spec of specs) {
    if (spec.when !== undefined && !seenKeys.has(spec.when.field)) {
      fail(`fields.${spec.key}.when`, `references unknown field ${spec.when.field}`);
    }
  }
  detectCycles(specs);

  if (root.sections !== undefined) {
    if (!Array.isArray(root.sections) || root.sections.length > MAX_SECTIONS) {
      fail('schema.sections', `must be an array of up to ${MAX_SECTIONS} entries`);
    }
    for (const raw of root.sections) {
      const sec = raw as Record<string, unknown>;
      if (typeof sec.title !== 'string' || sec.title.trim().length === 0) {
        fail('schema.sections', 'each section needs a title');
      }
      if (sec.fields !== undefined) {
        if (!Array.isArray(sec.fields)) fail('schema.sections', 'fields must be an array');
        for (const fk of sec.fields) {
          if (typeof fk !== 'string' || !seenKeys.has(fk)) {
            fail('schema.sections', `unknown field key ${JSON.stringify(fk)}`);
          }
        }
      }
    }
  }
}
