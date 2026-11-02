import { createHash } from 'node:crypto';

// Canonical JSON: deterministic serialization with recursively sorted object
// keys so semantically identical commands hash identically.
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const body = entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(',');
  return `{${body}}`;
}

/**
 * Stable fingerprint of the complete semantic command: the caller supplies
 * exactly the semantic fields (action, persisted reason, values, ...) —
 * retry-specific fields (expectedVersion, correlation ids) must be omitted
 * by the caller. Stored in place of raw inputs — never logs context.
 */
export function commandFingerprint(semantic: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalize(semantic)).digest('hex');
}
