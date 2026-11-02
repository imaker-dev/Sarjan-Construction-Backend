// DRAFT → ACTIVE ⇄ INACTIVE; any non-archived state → ARCHIVED; ARCHIVED terminal.
export const DEPARTMENT_TRANSITIONS: Record<string, readonly string[]> = {
  DRAFT: ['ACTIVE', 'ARCHIVED'],
  ACTIVE: ['INACTIVE', 'ARCHIVED'],
  INACTIVE: ['ACTIVE', 'ARCHIVED'],
  ARCHIVED: [],
} as const;
