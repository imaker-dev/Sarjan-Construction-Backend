import { OrgValidationError } from '../organization/errors.js';

// Bounded draft JSON: a plain object, bounded size and depth. It is versioned
// configuration data — never executable code.
const MAX_DEFINITION_BYTES = 16 * 1024; // 16 KiB
const MAX_DEPTH = 6;
const MAX_KEYS = 200;

function depthOf(value: unknown, depth: number): number {
  if (depth > MAX_DEPTH) return depth;
  if (Array.isArray(value)) {
    let max = depth;
    for (const item of value) max = Math.max(max, depthOf(item, depth + 1));
    return max;
  }
  if (value !== null && typeof value === 'object') {
    let max = depth;
    for (const v of Object.values(value as Record<string, unknown>)) {
      max = Math.max(max, depthOf(v, depth + 1));
    }
    return max;
  }
  return depth;
}

function keyCount(value: unknown): number {
  if (Array.isArray(value)) {
    return value.reduce<number>((sum, item) => sum + keyCount(item), 0);
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    return entries.length + entries.reduce<number>((sum, [, v]) => sum + keyCount(v), 0);
  }
  return 0;
}

export function assertValidDefinition(definition: unknown): void {
  if (definition === null || typeof definition !== 'object' || Array.isArray(definition)) {
    throw new OrgValidationError('definition', 'must be a JSON object');
  }
  const serialized = JSON.stringify(definition);
  if (serialized.length > MAX_DEFINITION_BYTES) {
    throw new OrgValidationError('definition', `exceeds ${MAX_DEFINITION_BYTES} bytes`);
  }
  if (depthOf(definition, 1) > MAX_DEPTH) {
    throw new OrgValidationError('definition', `exceeds max depth ${MAX_DEPTH}`);
  }
  if (keyCount(definition) > MAX_KEYS) {
    throw new OrgValidationError('definition', `exceeds ${MAX_KEYS} keys`);
  }
}
