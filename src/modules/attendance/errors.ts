export class AttendanceError extends Error {
  public readonly statusCode: number;
  public readonly code: string;

  constructor(message: string, statusCode = 400, code = 'ATTENDANCE_ERROR') {
    super(message);
    this.name = 'AttendanceError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export class GeofenceBreachError extends AttendanceError {
  public readonly distanceMeters: number;
  public readonly allowedRadiusMeters: number;

  constructor(distanceMeters: number, allowedRadiusMeters: number) {
    super(
      `Location is outside site geofence: ${distanceMeters}m away (allowed: ${allowedRadiusMeters}m)`,
      422,
      'GEOFENCE_BREACH',
    );
    this.name = 'GeofenceBreachError';
    this.distanceMeters = distanceMeters;
    this.allowedRadiusMeters = allowedRadiusMeters;
  }
}

export class ActiveSessionExistsError extends AttendanceError {
  public readonly sessionId: string;

  constructor(sessionId: string) {
    super(
      `Employee already has an active attendance session in progress (${sessionId})`,
      409,
      'ACTIVE_SESSION_EXISTS',
    );
    this.name = 'ActiveSessionExistsError';
    this.sessionId = sessionId;
  }
}

export class NoActiveSessionError extends AttendanceError {
  constructor(employeeId: string) {
    super(
      `No active attendance session found for employee ${employeeId}`,
      404,
      'NO_ACTIVE_SESSION',
    );
    this.name = 'NoActiveSessionError';
  }
}

export class BreakAlreadyActiveError extends AttendanceError {
  public readonly breakId: string;

  constructor(breakId: string) {
    super(`A break is already active for this session (${breakId})`, 409, 'BREAK_ALREADY_ACTIVE');
    this.name = 'BreakAlreadyActiveError';
    this.breakId = breakId;
  }
}

export class NoActiveBreakError extends AttendanceError {
  constructor(sessionId: string) {
    super(`No active break found for session ${sessionId}`, 404, 'NO_ACTIVE_BREAK');
    this.name = 'NoActiveBreakError';
  }
}

export class BreakOutsideWindowError extends AttendanceError {
  constructor() {
    super('Break punch rejected: outside the configured break window', 422, 'BREAK_OUTSIDE_WINDOW');
    this.name = 'BreakOutsideWindowError';
  }
}

export class PunchNotAllowedError extends AttendanceError {
  constructor(reason: string) {
    super(`Punch not permitted: ${reason}`, 403, 'PUNCH_NOT_ALLOWED');
    this.name = 'PunchNotAllowedError';
  }
}

export class AttendanceEntityNotFoundError extends AttendanceError {
  constructor(entity: string, id: string) {
    super(`${entity} ${id} not found`, 404, 'NOT_FOUND');
    this.name = 'AttendanceEntityNotFoundError';
  }
}

export class TvtSafetyBriefingRequiredError extends AttendanceError {
  constructor(employeeId: string, businessDate: string) {
    super(
      `Employee ${employeeId} has not attended the required Safety Toolbox Talk (TVT) for business date ${businessDate}`,
      422,
      'TVT_SAFETY_BRIEFING_REQUIRED',
    );
    this.name = 'TvtSafetyBriefingRequiredError';
  }
}

export class InvalidDateRangeError extends AttendanceError {
  constructor(message: string) {
    super(message, 400, 'INVALID_DATE_RANGE');
    this.name = 'InvalidDateRangeError';
  }
}

export class BreakModeConflictError extends AttendanceError {
  constructor(policyBreakMode: string, scheduleBreakWindowMode: string) {
    super(
      `Contradictory break configuration: AttendancePolicy.breakMode='${policyBreakMode}' ` +
        `conflicts with schedule breakWindowMode='${scheduleBreakWindowMode}'. ` +
        `Align the policy and schedule (FIXED ↔ FIXED_WINDOW, DYNAMIC ↔ DYNAMIC) or ` +
        `remove breakWindowMode from the revision`,
      422,
      'BREAK_MODE_CONFLICT',
    );
    this.name = 'BreakModeConflictError';
  }
}

export class AttendanceValidationError extends AttendanceError {
  constructor(message: string) {
    super(message, 400, 'ATTENDANCE_VALIDATION_ERROR');
    this.name = 'AttendanceValidationError';
  }
}

export class DailyReportNotFoundError extends AttendanceError {
  constructor(id: string) {
    super(`Daily site report ${id} not found`, 404, 'DAILY_REPORT_NOT_FOUND');
    this.name = 'DailyReportNotFoundError';
  }
}

export class DailyReportAlreadyLockedError extends AttendanceError {
  constructor(id: string) {
    super(
      `Daily site report ${id} is locked and cannot be modified`,
      409,
      'DAILY_REPORT_ALREADY_LOCKED',
    );
    this.name = 'DailyReportAlreadyLockedError';
  }
}

export class DailyReportInvalidStateTransitionError extends AttendanceError {
  constructor(currentStatus: string, targetStatus: string) {
    super(
      `Cannot transition daily site report from ${currentStatus} to ${targetStatus}`,
      422,
      'DAILY_REPORT_INVALID_STATE_TRANSITION',
    );
    this.name = 'DailyReportInvalidStateTransitionError';
  }
}

export class DailyReportConflictError extends AttendanceError {
  constructor(message: string) {
    super(message, 409, 'DAILY_REPORT_CONFLICT');
    this.name = 'DailyReportConflictError';
  }
}
