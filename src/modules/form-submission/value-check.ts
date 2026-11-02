import { OrgValidationError } from '../organization/errors.js';
import { evaluateWhen } from '../rule/evaluator.js';
import type { LeafPredicate } from '../rule/evaluator.js';
import {
  checkConstraints,
  validateBoundValue,
  UNSUPPORTED_VALUE_TYPES,
} from '../form/value-validation.js';
import { SubmissionUnsupportedFieldError } from './errors.js';

export const VALUES_MAX_BYTES = 64 * 1024;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DOCUMENT_VALUE_TYPES = new Set(['FILE', 'IMAGE']);

/** Extract a verified document reference — FILE/IMAGE values carry {"$documentId"}. */
export function documentRefOf(value: unknown): string | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as { $documentId?: unknown };
  if (typeof v.$documentId !== 'string' || !UUID_RE.test(v.$documentId)) return null;
  if (Object.keys(v).length !== 1) return null;
  return v.$documentId;
}

export interface ValueCheckOpts {
  /** FILE/IMAGE $documentId references allowed only when the doc verifier is wired. */
  allowDocumentRefs?: boolean;
}

interface SubmitField {
  key: string;
  type: string;
  required?: boolean;
  constraints?: Record<string, unknown>;
  when?: { field: string; op: string; value?: unknown };
}

export function fieldsOf(schema: unknown): SubmitField[] {
  const s = schema as { fields?: unknown };
  return (Array.isArray(s.fields) ? s.fields : []) as SubmitField[];
}

export function assertValuesObject(v: unknown): asserts v is Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    throw new OrgValidationError('values', 'must be an object of fieldKey → value');
  }
  if (JSON.stringify(v).length > VALUES_MAX_BYTES) {
    throw new OrgValidationError('values', `exceeds ${VALUES_MAX_BYTES} bytes`);
  }
}

function checkPresentValue(
  field: SubmitField,
  value: unknown,
  opts: { rejectUnsupported: boolean; allowDocumentRefs?: boolean },
): void {
  // FILE/IMAGE accept a verified document reference when the resolver is wired.
  if (DOCUMENT_VALUE_TYPES.has(field.type) && documentRefOf(value) !== null) {
    if (opts.allowDocumentRefs !== true) {
      throw new SubmissionUnsupportedFieldError(field.key, field.type);
    }
    return;
  }
  if (opts.rejectUnsupported && UNSUPPORTED_VALUE_TYPES.has(field.type)) {
    throw new SubmissionUnsupportedFieldError(field.key, field.type);
  }
  if (!validateBoundValue(value, { type: field.type, options: optionsOf(field) })) {
    throw new OrgValidationError(`values.${field.key}`, `invalid for field type ${field.type}`);
  }
  const c = (field.constraints ?? {}) as Parameters<typeof checkConstraints>[1];
  if (!checkConstraints(value, c)) {
    throw new OrgValidationError(`values.${field.key}`, 'violates field constraints');
  }
}

function optionsOf(field: SubmitField): string[] | null {
  const c = field.constraints as { options?: unknown } | undefined;
  const opts: unknown = c?.options;
  return Array.isArray(opts) ? (opts as string[]) : null;
}

/** Draft saves: unknown keys and malformed/oversize values rejected; required fields may be incomplete. */
export function validateDraftValues(
  fields: SubmitField[],
  values: Record<string, unknown>,
  opts?: ValueCheckOpts,
): void {
  for (const [key, value] of Object.entries(values)) {
    const field = fields.find((f) => f.key === key);
    if (field === undefined) {
      throw new OrgValidationError(`values.${key}`, 'unknown field for this form version');
    }
    checkPresentValue(field, value, { rejectUnsupported: true, ...opts });
  }
}

/**
 * Submit validation: every visible required field present and valid;
 * `when`-hidden fields must be absent; unsupported storage types rejected.
 */
export function validateSubmitValues(
  fields: SubmitField[],
  values: Record<string, unknown>,
  opts?: ValueCheckOpts,
): void {
  const known = new Set(fields.map((f) => f.key));
  for (const key of Object.keys(values)) {
    if (!known.has(key)) {
      throw new OrgValidationError(`values.${key}`, 'unknown field for this form version');
    }
  }
  for (const field of fields) {
    const present = field.key in values;
    const visible = field.when === undefined || isVisible(field, values);
    if (visible) {
      if (field.required === true && !present) {
        throw new OrgValidationError(`values.${field.key}`, 'required field missing');
      }
      if (present) {
        checkPresentValue(field, values[field.key], { rejectUnsupported: true, ...opts });
      }
    } else if (present) {
      throw new OrgValidationError(
        `values.${field.key}`,
        'hidden by conditional visibility — value must be absent',
      );
    }
  }
}

function isVisible(field: SubmitField, values: Record<string, unknown>): boolean {
  const w = field.when;
  if (w === undefined) return true;
  const leaf: LeafPredicate = {
    field: w.field,
    op: w.op,
    ...(w.value !== undefined ? { value: w.value } : {}),
  };
  const result = evaluateWhen(leaf, values);
  return result.outcome === 'MATCH';
}
