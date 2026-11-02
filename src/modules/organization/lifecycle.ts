import { InvalidStatusTransitionError } from './errors.js';

type StatusMap = Record<string, readonly string[]>;

// Explicit transition tables. Arbitrary status strings are never accepted.
export const COMPANY_TRANSITIONS: StatusMap = {
  ACTIVE: ['SUSPENDED', 'ARCHIVED'],
  SUSPENDED: ['ACTIVE', 'ARCHIVED'],
  ARCHIVED: [],
};

// Shared by HeadOffice and Site.
export const ORG_NODE_TRANSITIONS: StatusMap = {
  ACTIVE: ['INACTIVE', 'ARCHIVED'],
  INACTIVE: ['ACTIVE', 'ARCHIVED'],
  ARCHIVED: [],
};

export const PROJECT_TRANSITIONS: StatusMap = {
  PLANNED: ['ACTIVE', 'ARCHIVED'],
  ACTIVE: ['ON_HOLD', 'COMPLETED', 'ARCHIVED'],
  ON_HOLD: ['ACTIVE', 'ARCHIVED'],
  COMPLETED: ['ARCHIVED'],
  ARCHIVED: [],
};

export function assertTransition(
  entityType: string,
  transitions: StatusMap,
  from: string,
  to: string,
): void {
  if (!(transitions[from] ?? []).includes(to)) {
    throw new InvalidStatusTransitionError(entityType, from, to);
  }
}
