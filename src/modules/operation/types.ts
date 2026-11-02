export interface CreateOperationInput {
  key: string;
  name: string;
  capabilityKey?: string;
  description?: string;
  definition?: unknown; // bounded JSON draft — validated before persistence
}

export interface UpdateOperationInput {
  name?: string;
  capabilityKey?: string | null;
  description?: string | null;
  definition?: unknown; // passing null clears the draft
}
