import { Prisma } from '@prisma/client';
import {
  AppError,
  ConflictError,
  DomainValidationError,
  NotFoundError,
} from '../../common/errors/app-error.js';
export class OrgEntityNotFoundError extends NotFoundError {
  constructor(entityType: string) {
    // Deliberately generic: do not leak whether the record exists under a
    // different tenant scope.
    super(`${entityType} not found`);
  }
}

export class DuplicateCodeError extends ConflictError {
  constructor(entityType: string) {
    super('DUPLICATE_CODE', `${entityType} code already exists in this scope`);
  }
}

/** Deliberately opaque — does not reveal where the employee's primary lives. */
export class PrimaryOutOfScopeError extends ConflictError {
  constructor() {
    super('PRIMARY_OUT_OF_SCOPE', 'primary membership is managed outside this scope');
  }
}

/** The change would leave the employee with multiple effective memberships
 *  and no primary — leave-policy resolution would fail closed (ambiguous). */
export class AmbiguousPrimaryError extends ConflictError {
  constructor() {
    super(
      'AMBIGUOUS_PRIMARY',
      'membership change would leave multiple effective memberships without a primary; designate an in-scope primary first',
    );
  }
}

/** W4: the workforce episode was already exited — the SiteWorkforceExit
 *  marker permanently blocks reinstatement and repeat exits. */
export class AlreadyExitedError extends ConflictError {
  constructor() {
    super('ALREADY_EXITED', 'this workforce episode was already exited');
  }
}

/** Unique-invariant race: an active membership already exists for the pair. */
export class ActiveMembershipExistsError extends ConflictError {
  constructor() {
    super('ACTIVE_MEMBERSHIP_EXISTS', 'an active membership already exists for this department');
  }
}

/** Unique-index race on the one-active-primary invariant — concurrent
 *  primary changes are serialized per employee, but a residual race (e.g.
 *  on a different connection) surfaces as a deliberate 409, never a raw
 *  database error. */
export class PrimaryConflictError extends ConflictError {
  constructor() {
    super('PRIMARY_CONFLICT', 'a concurrent primary change was rejected; retry the operation');
  }
}

export class VersionConflictError extends ConflictError {
  constructor(entityType: string) {
    super('VERSION_CONFLICT', `${entityType} was modified concurrently; reload and retry`);
  }
}

export class InvalidStatusTransitionError extends AppError {
  constructor(entityType: string, from: string, to: string) {
    super(409, 'INVALID_STATUS_TRANSITION', `${entityType} cannot transition ${from} -> ${to}`);
  }
}

export class OrgValidationError extends DomainValidationError {
  constructor(field: string, message: string) {
    super('VALIDATION_FAILED', `${field}: ${message}`);
  }
}

// Maps Prisma unique-violation errors to a stable domain conflict.
export function mapOrgWriteError(error: unknown, entityType: string): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    throw new DuplicateCodeError(entityType);
  }
  throw error;
}
