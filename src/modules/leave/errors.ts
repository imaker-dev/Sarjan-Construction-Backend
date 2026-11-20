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

