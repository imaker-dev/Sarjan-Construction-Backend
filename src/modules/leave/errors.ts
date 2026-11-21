export class LeaveError extends Error {
  public readonly statusCode: number;
  public readonly code: string;

  constructor(message: string, statusCode = 400, code = 'LEAVE_ERROR') {
    super(message);
    this.name = 'LeaveError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export class InsufficientLeaveBalanceError extends LeaveError {
  public readonly availableDays: number;
  public readonly requestedDays: number;

  constructor(availableDays: number, requestedDays: number) {
    super(
      `Insufficient leave balance: available ${availableDays} days, requested ${requestedDays} days`,
      422,
      'INSUFFICIENT_LEAVE_BALANCE',
    );
    this.name = 'InsufficientLeaveBalanceError';
    this.availableDays = availableDays;
    this.requestedDays = requestedDays;
  }
}

export class LeaveDateConflictError extends LeaveError {
  public readonly conflictingRequestId: string;

  constructor(conflictingRequestId: string) {
    super(
      `Leave dates conflict with an existing request (${conflictingRequestId})`,
      409,
      'LEAVE_DATE_CONFLICT',
    );
    this.name = 'LeaveDateConflictError';
    this.conflictingRequestId = conflictingRequestId;
  }
}

export class LeaveRequestStateError extends LeaveError {
  constructor(message: string) {
    super(message, 400, 'INVALID_LEAVE_STATE');
    this.name = 'LeaveRequestStateError';
  }
}

export class LeavePolicyNotFoundError extends LeaveError {
  constructor(message = 'Leave policy not found') {
    super(message, 404, 'LEAVE_POLICY_NOT_FOUND');
    this.name = 'LeavePolicyNotFoundError';
  }
}

export class LeaveNoticePeriodError extends LeaveError {
  public readonly requiredNoticeDays: number;

  constructor(requiredNoticeDays: number) {
    super(
      `Leave application requires at least ${requiredNoticeDays} days advance notice`,
      422,
      'LEAVE_NOTICE_INSUFFICIENT',
    );
    this.name = 'LeaveNoticePeriodError';
    this.requiredNoticeDays = requiredNoticeDays;
  }
}

export class LeaveDocumentRequiredError extends LeaveError {
  public readonly thresholdDays: number;

  constructor(thresholdDays: number) {
    super(
      `Medical/supporting certificate is required for leaves exceeding ${thresholdDays} days`,
      422,
      'LEAVE_DOCUMENT_REQUIRED',
    );
    this.name = 'LeaveDocumentRequiredError';
    this.thresholdDays = thresholdDays;
  }
}

export class MaxConsecutiveLeaveDaysExceededError extends LeaveError {
  public readonly maxAllowedDays: number;

  constructor(maxAllowedDays: number) {
    super(
      `Cannot exceed maximum ${maxAllowedDays} consecutive days for this leave type`,
      422,
      'MAX_CONSECUTIVE_DAYS_EXCEEDED',
    );
    this.name = 'MaxConsecutiveLeaveDaysExceededError';
    this.maxAllowedDays = maxAllowedDays;
  }
}

export class SelfApprovalNotAllowedError extends LeaveError {
  constructor(message = 'Employees cannot approve their own leave requests') {
    super(message, 403, 'SELF_APPROVAL_NOT_ALLOWED');
    this.name = 'SelfApprovalNotAllowedError';
  }
}

// ---------------------------------------------------------------------------
// Dynamic leave types & versioned policy configuration (Milestone 2A)
// ---------------------------------------------------------------------------

export class LeaveTypeDefNotFoundError extends LeaveError {
  constructor(message = 'Leave type definition not found') {
    super(message, 404, 'LEAVE_TYPE_DEF_NOT_FOUND');
    this.name = 'LeaveTypeDefNotFoundError';
  }
}

export class LeavePolicyVersionNotFoundError extends LeaveError {
  constructor(message = 'Leave policy version not found') {
    super(message, 404, 'LEAVE_POLICY_VERSION_NOT_FOUND');
    this.name = 'LeavePolicyVersionNotFoundError';
  }
}

export class NoEffectiveLeavePolicyError extends LeaveError {
  constructor(message = 'No effective leave policy configuration for the given context') {
    super(message, 404, 'NO_EFFECTIVE_LEAVE_POLICY');
    this.name = 'NoEffectiveLeavePolicyError';
  }
}

export class LeaveScopeShapeError extends LeaveError {
  constructor(message: string) {
    super(`Invalid leave policy scope: ${message}`, 400, 'LEAVE_SCOPE_SHAPE');
    this.name = 'LeaveScopeShapeError';
  }
}

export class LeavePolicyValidationError extends LeaveError {
  constructor(field: string, message: string) {
    super(`Invalid leave policy field '${field}': ${message}`, 400, 'LEAVE_POLICY_VALIDATION');
    this.name = 'LeavePolicyValidationError';
  }
}

export class AmbiguousLeaveScopeError extends LeaveError {
  constructor(message = 'Employee has multiple active department memberships with no primary') {
    super(message, 409, 'AMBIGUOUS_LEAVE_SCOPE');
    this.name = 'AmbiguousLeaveScopeError';
  }
}

export class LastActiveLeavePolicyVersionError extends LeaveError {
  constructor(message = 'Cannot cancel the sole active version; archive the policy instead') {
    super(message, 409, 'LAST_ACTIVE_LEAVE_POLICY_VERSION');
    this.name = 'LastActiveLeavePolicyVersionError';
  }
}

export class LeavePeriodBoundaryError extends LeaveError {
  constructor(message: string) {
    super(message, 409, 'LEAVE_PERIOD_BOUNDARY');
    this.name = 'LeavePeriodBoundaryError';
  }
}

export class InvalidLeavePolicyStateError extends LeaveError {
  constructor(message: string) {
    super(message, 400, 'INVALID_LEAVE_POLICY_STATE');
    this.name = 'InvalidLeavePolicyStateError';
  }
}
