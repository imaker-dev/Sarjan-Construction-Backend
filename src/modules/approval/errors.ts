import { ConflictError, ForbiddenError } from '../../common/errors/app-error.js';

// The task already reached a terminal status — decision is a stale write.
export class ApprovalTaskClosedError extends ConflictError {
  constructor(taskId: string) {
    super('APPROVAL_TASK_CLOSED', `approval task ${taskId} is not pending`);
  }
}

// The actor does not satisfy the stage's configured assignee rule.
export class NotTaskAssigneeError extends ForbiddenError {
  constructor() {
    super('NOT_TASK_ASSIGNEE', 'actor does not match the approval assignee rule');
  }
}

// Self-approval is disabled for this stage and the actor is the initiator.
export class SeparationOfDutiesError extends ForbiddenError {
  constructor() {
    super(
      'SEPARATION_OF_DUTIES',
      'the initiator cannot decide this approval stage (self-approval disabled)',
    );
  }
}
