import { DATE_RE, DATETIME_RE, DECIMAL_RE, TIME_RE } from '../rule/evaluator.js';

// Field descriptor fragment needed for runtime value validation — sourced
// from the pinned FormVersion, never trusted from caller input.
export interface BoundFieldSpec {
  type: string;
  options: string[] | null;
}

const STRING_FIELD_TYPES = new Set([
  'TEXT',
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
]);

// Field types whose values require binary/document storage that does not
// exist yet — rejected at submission with a clear domain error.
export const UNSUPPORTED_VALUE_TYPES = new Set(['FILE', 'IMAGE', 'SIGNATURE', 'QR']);

// Validate a value against a pinned FormVersion field descriptor's type and
// options. Pure and total — returns true when the value is usable.
export function validateBoundValue(value: unknown, spec: BoundFieldSpec): boolean {
  switch (spec.type) {
    case 'SELECT':
      if (typeof value !== 'string') return false;
      return spec.options === null || spec.options.includes(value);
    case 'MULTI_SELECT':
      if (!Array.isArray(value) || !value.every((v): v is string => typeof v === 'string')) {
        return false;
      }
      return spec.options === null || value.every((v) => spec.options?.includes(v) ?? false);
    case 'NUMBER':
      return typeof value === 'number' && Number.isFinite(value);
    case 'DECIMAL':
      return (
        (typeof value === 'number' && Number.isFinite(value)) ||
        (typeof value === 'string' && DECIMAL_RE.test(value))
      );
    case 'BOOLEAN':
      return typeof value === 'boolean';
    case 'DATE':
      return typeof value === 'string' && DATE_RE.test(value);
    case 'TIME':
      return typeof value === 'string' && TIME_RE.test(value);
    case 'DATETIME':
      return typeof value === 'string' && DATETIME_RE.test(value);
    case 'GPS':
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
      {
        const g = value as { lat?: unknown; lng?: unknown };
        return (
          typeof g.lat === 'number' &&
          Number.isFinite(g.lat) &&
          Math.abs(g.lat) <= 90 &&
          typeof g.lng === 'number' &&
          Number.isFinite(g.lng) &&
          Math.abs(g.lng) <= 180
        );
      }
    default:
      // TEXT and every entity/reference type carry string identifiers.
      return STRING_FIELD_TYPES.has(spec.type) ? typeof value === 'string' : false;
  }
}

export interface ConstraintSpec {
  maxLength?: number;
  min?: number;
  max?: number;
  integerOnly?: boolean;
}

// Non-option descriptor constraints enforced on concrete values.
export function checkConstraints(value: unknown, c: ConstraintSpec): boolean {
  if (typeof value === 'string' && c.maxLength !== undefined && value.length > c.maxLength) {
    return false;
  }
  if (typeof value === 'number') {
    if (c.min !== undefined && value < c.min) return false;
    if (c.max !== undefined && value > c.max) return false;
    if (c.integerOnly === true && !Number.isInteger(value)) return false;
  }
  return true;
}
