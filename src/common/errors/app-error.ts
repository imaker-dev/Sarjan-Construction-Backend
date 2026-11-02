export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Resource not found') {
    super(404, 'NOT_FOUND', message);
  }
}

export class ConflictError extends AppError {
  constructor(code: string, message: string) {
    super(409, code, message);
  }
}

export class DomainValidationError extends AppError {
  constructor(code: string, message: string) {
    super(422, code, message);
  }
}

export class UnauthorizedError extends AppError {
  constructor(code = 'UNAUTHENTICATED', message = 'Authentication required') {
    super(401, code, message);
  }
}

export class ForbiddenError extends AppError {
  constructor(code = 'FORBIDDEN', message = 'Access denied') {
    super(403, code, message);
  }
}
