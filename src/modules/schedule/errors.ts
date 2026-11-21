import {
  AppError,
  ConflictError,
  DomainValidationError,
  NotFoundError,
} from '../../common/errors/app-error.js';

export class WorkScheduleNotFoundError extends NotFoundError {
  constructor(message = 'Work schedule not found') {
    super(message);
    this.name = 'WorkScheduleNotFoundError';
  }
}

export class HolidayCalendarNotFoundError extends NotFoundError {
  constructor(message = 'Holiday calendar not found') {
    super(message);
    this.name = 'HolidayCalendarNotFoundError';
  }
}

export class HolidayNotFoundError extends NotFoundError {
  constructor(message = 'Holiday not found') {
    super(message);
    this.name = 'HolidayNotFoundError';
  }
}

export class HolidayCategoryNotFoundError extends NotFoundError {
  constructor(message = 'Holiday category not found') {
    super(message);
    this.name = 'HolidayCategoryNotFoundError';
  }
}

export class ScheduleRevisionNotFoundError extends NotFoundError {
  constructor(message = 'Schedule revision not found') {
    super(message);
    this.name = 'ScheduleRevisionNotFoundError';
  }
}

export class ScheduleOverrideNotFoundError extends NotFoundError {
  constructor(message = 'Schedule override not found') {
    super(message);
    this.name = 'ScheduleOverrideNotFoundError';
  }
}

export class DuplicateOverrideError extends ConflictError {
  constructor(date: string) {
    super('DUPLICATE_OVERRIDE', `An active override already exists on ${date} for this schedule`);
    this.name = 'DuplicateOverrideError';
  }
}

export class LastActiveRevisionError extends ConflictError {
  constructor() {
    super(
      'LAST_ACTIVE_REVISION',
      "Cannot cancel the schedule's only active revision; archive the schedule instead",
    );
    this.name = 'LastActiveRevisionError';
  }
}

export class ScheduleScopeShapeError extends DomainValidationError {
  constructor(message: string) {
    super('INVALID_SCOPE_SHAPE', message);
    this.name = 'ScheduleScopeShapeError';
  }
}

export class ScheduleValidationError extends DomainValidationError {
  constructor(field: string, message: string) {
    super('VALIDATION_FAILED', `${field}: ${message}`);
    this.name = 'ScheduleValidationError';
  }
}

export class ScheduleTargetNotFoundError extends DomainValidationError {
  constructor(entityType: string, id: string) {
    super('SCOPE_TARGET_NOT_FOUND', `${entityType} ${id} does not exist in this company`);
    this.name = 'ScheduleTargetNotFoundError';
  }
}

export class ScheduleRangeConflictError extends ConflictError {
  constructor() {
    super(
      'SCHEDULE_RANGE_CONFLICT',
      'An ACTIVE schedule already covers overlapping effective dates for this scope target',
    );
    this.name = 'ScheduleRangeConflictError';
  }
}

export class AmbiguousScheduleContextError extends ConflictError {
  constructor() {
    super(
      'AMBIGUOUS_SCHEDULE_CONTEXT',
      'Employee has multiple active department memberships with no primary; schedule cannot be resolved deterministically',
    );
    this.name = 'AmbiguousScheduleContextError';
  }
}

export class NoEffectiveScheduleError extends NotFoundError {
  constructor(message = 'No effective work schedule found for the given criteria') {
    super(message);
    this.name = 'NoEffectiveScheduleError';
  }
}

export class InvalidScheduleStateError extends AppError {
  constructor(message: string) {
    super(400, 'INVALID_SCHEDULE_STATE', message);
    this.name = 'InvalidScheduleStateError';
  }
}

export class DuplicateHolidayError extends ConflictError {
  constructor(date: string) {
    super('DUPLICATE_HOLIDAY', `A holiday already exists on ${date} in this calendar`);
    this.name = 'DuplicateHolidayError';
  }
}

export class HolidayCalendarInUseError extends ConflictError {
  constructor() {
    super(
      'CALENDAR_IN_USE',
      'Calendar is referenced by non-archived work schedules and cannot be archived',
    );
    this.name = 'HolidayCalendarInUseError';
  }
}
