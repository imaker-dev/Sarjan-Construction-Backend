export interface CreateWorkflowInput {
  // The published operation version this workflow is defined against.
  operationVersionId: string;
  key: string;
  name: string;
  description?: string;
  definition?: unknown;
}

export interface UpdateWorkflowInput {
  name?: string;
  description?: string | null;
  definition?: unknown; // passing null clears the draft
}
