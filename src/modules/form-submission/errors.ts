import { AppError } from '../../common/errors/app-error.js';

// A field type whose values need binary/document storage that does not exist
// yet — a clear domain error, not a validation artifact.
export class SubmissionUnsupportedFieldError extends AppError {
  constructor(fieldKey: string, type: string) {
    super(
      422,
      'SUBMISSION_UNSUPPORTED_FIELD',
      `field ${fieldKey} of type ${type} requires document storage — unsupported`,
    );
  }
}
