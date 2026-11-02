import { AppError } from '../../common/errors/app-error.js';

export class NotificationTicketError extends AppError {
  constructor(reason: string) {
    super(401, 'NOTIFICATION_TICKET_INVALID', `notification ticket invalid: ${reason}`);
  }
}

export class NotCompanyMemberError extends AppError {
  constructor() {
    super(403, 'NOT_COMPANY_MEMBER', 'principal has no active membership in this company');
  }
}
