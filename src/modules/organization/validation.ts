import { OrgValidationError } from './errors.js';

// Conservative allowlist: uppercase alphanumeric, '-' and '_' inside, 1-30 chars.
const CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{0,29}$/;
const NAME_MAX = 200;
const GEO_FENCE_MIN_M = 10;
const GEO_FENCE_MAX_M = 5000;

export function normalizeCode(code: string, field = 'code'): string {
  const normalized = code.trim().toUpperCase();
  if (!CODE_PATTERN.test(normalized)) {
    throw new OrgValidationError(
      field,
      'must be 1-30 chars of A-Z, 0-9, starting with alphanumeric; - and _ allowed',
    );
  }
  return normalized;
}

export function normalizeName(name: string, field = 'name'): string {
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > NAME_MAX) {
    throw new OrgValidationError(field, `must be 1-${NAME_MAX} characters after trimming`);
  }
  return trimmed;
}

export function assertValidTimezone(timezone: string, field = 'timezone'): string {
  const tz = timezone.trim();
  let valid = false;
  try {
    // Accepts canonical IANA names and aliases (e.g. Asia/Kolkata, UTC).
    new Intl.DateTimeFormat('en', { timeZone: tz });
    valid = true;
  } catch {
    valid = false;
  }
  if (!valid) {
    throw new OrgValidationError(field, 'must be a valid IANA timezone name');
  }
  return tz;
}

export function assertValidLatitude(value: number, field = 'geoLatitude'): number {
  if (!Number.isFinite(value) || value < -90 || value > 90) {
    throw new OrgValidationError(field, 'must be a number between -90 and 90');
  }
  return value;
}

export function assertValidLongitude(value: number, field = 'geoLongitude'): number {
  if (!Number.isFinite(value) || value < -180 || value > 180) {
    throw new OrgValidationError(field, 'must be a number between -180 and 180');
  }
  return value;
}

export function assertValidGeoFenceRadius(value: number, field = 'geoFenceRadiusM'): number {
  if (!Number.isInteger(value) || value < GEO_FENCE_MIN_M || value > GEO_FENCE_MAX_M) {
    throw new OrgValidationError(
      field,
      `must be an integer between ${GEO_FENCE_MIN_M} and ${GEO_FENCE_MAX_M} metres`,
    );
  }
  return value;
}

// Non-negative decimal string at API boundaries (money, areas, lengths).
// Precision is column-enforced (DECIMAL(18,2) etc.); this gate rejects
// malformed input before Prisma.
const DECIMAL_PATTERN = /^\d+(\.\d{1,6})?$/;

export function assertDecimalString(value: string, field: string): string {
  const trimmed = value.trim();
  if (!DECIMAL_PATTERN.test(trimmed)) {
    throw new OrgValidationError(field, 'must be a non-negative decimal string, e.g. "12500.00"');
  }
  return trimmed;
}

const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export function assertCurrencyCode(value: string, field = 'currency'): string {
  const normalized = value.trim().toUpperCase();
  if (!CURRENCY_PATTERN.test(normalized)) {
    throw new OrgValidationError(field, 'must be a 3-letter ISO 4217 code');
  }
  return normalized;
}

export function assertNonNegativeInt(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new OrgValidationError(field, 'must be a non-negative integer');
  }
  return value;
}
