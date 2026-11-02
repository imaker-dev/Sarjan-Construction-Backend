export interface CreateFormInput {
  key: string;
  name: string;
  description?: string;
  schema?: unknown; // draft descriptor — validated before persistence
}

export interface UpdateFormInput {
  name?: string;
  description?: string | null;
  schema?: unknown; // passing null clears the draft
}
