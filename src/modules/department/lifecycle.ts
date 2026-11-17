// DRAFT → ACTIVE ⇄ INACTIVE; any state → ARCHIVED; ARCHIVED → ACTIVE.
export const DEPARTMENT_TRANSITIONS: Record<string, readonly string[]> = {
  DRAFT: ['ACTIVE', 'ARCHIVED'],
  ACTIVE: ['INACTIVE', 'ARCHIVED'],
  INACTIVE: ['ACTIVE', 'ARCHIVED'],
  ARCHIVED: ['ACTIVE'],
} as const;
