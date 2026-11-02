import { ForbiddenError } from '../../common/errors/app-error.js';

export class AccessDeniedError extends ForbiddenError {
  constructor(message = 'Insufficient permission for this scope') {
    super('ACCESS_DENIED', message);
  }
}
