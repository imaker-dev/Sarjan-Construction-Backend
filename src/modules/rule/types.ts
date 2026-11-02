export interface CreateRuleInput {
  key: string;
  name: string;
  description?: string;
  definition?: unknown;
}

export interface UpdateRuleInput {
  name?: string;
  description?: string | null;
  definition?: unknown; // passing null clears the draft
}
