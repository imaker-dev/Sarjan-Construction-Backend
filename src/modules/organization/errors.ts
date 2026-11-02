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
