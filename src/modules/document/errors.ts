import { AppError } from '../../common/errors/app-error.js';

export class DocumentUnsupportedTypeError extends AppError {
  constructor(contentType: string | null) {
    super(
      422,
      'DOCUMENT_UNSUPPORTED_TYPE',
      `content type ${contentType ?? 'unknown'} is not supported — allowed: PNG, JPEG, PDF`,
    );
  }
}

export class DocumentTooLargeError extends AppError {
  constructor(sizeBytes: number, maxBytes: number) {
    super(413, 'DOCUMENT_TOO_LARGE', `document is ${sizeBytes} bytes — maximum is ${maxBytes}`);
  }
}

export class DocumentNotAvailableError extends AppError {
  constructor(status: string) {
    super(422, 'DOCUMENT_NOT_AVAILABLE', `document is ${status} — only AVAILABLE documents apply`);
  }
}

export class DocumentStorageError extends AppError {
  constructor(reason: string) {
    super(500, 'DOCUMENT_STORAGE_ERROR', `document storage failure: ${reason}`);
  }
}
