import { AppError, ConflictError, ForbiddenError } from '../../common/errors/app-error.js';

// A transition guard evaluated to NO_MATCH — the action is denied.
export class WorkflowGuardDeniedError extends ForbiddenError {
  constructor(action: string, state: string) {
    super('WORKFLOW_GUARD_DENIED', `guard denied action ${action} from state ${state}`);
  }
}

// Rule evaluation returned INVALID — malformed input, never a match/denial.
export class WorkflowEvaluationError extends AppError {
  constructor(reason: string) {
    super(422, 'WORKFLOW_EVALUATION_ERROR', `guard evaluation failed: ${reason}`);
  }
}

// APPROVAL steps are deferred to the Approval Engine — explicit, not silent.
export class WorkflowUnsupportedActionError extends AppError {
  constructor(action: string) {
    super(
      422,
      'WORKFLOW_UNSUPPORTED_ACTION',
      `action ${action} belongs to a deferred engine (Approval)`,
    );
  }
}

// Same idempotency key bound to a different command fingerprint.
export class IdempotencyConflictError extends ConflictError {
  constructor(key: string) {
    super('IDEMPOTENCY_CONFLICT', `idempotency key ${key} was used for a different command`);
  }
}

// The business back-reference pair must be set together or not at all.
export const BUSINESS_ENTITY_TYPE_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
