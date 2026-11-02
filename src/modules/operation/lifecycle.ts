// DRAFT → ACTIVE ⇄ INACTIVE; any non-archived state → ARCHIVED (terminal).
export const OPERATION_TRANSITIONS: Record<string, readonly string[]> = {
  DRAFT: ['ACTIVE', 'ARCHIVED'],
  ACTIVE: ['INACTIVE', 'ARCHIVED'],
  INACTIVE: ['ACTIVE', 'ARCHIVED'],
  ARCHIVED: [],
} as const;
