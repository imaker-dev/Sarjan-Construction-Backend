import type { WorkflowInstance } from '@prisma/client';
import { AppError } from '../../common/errors/app-error.js';
import { validateBoundValue } from '../form/value-validation.js';
import type { BoundFieldSpec } from '../form/value-validation.js';

// Trusted context for a guard could not be obtained or validated — a distinct
// failure, never NO_MATCH and never an empty-context evaluation.
export class WorkflowContextUnavailableError extends AppError {
  constructor(reason: string) {
    super(422, 'WORKFLOW_CONTEXT_UNAVAILABLE', `guard context unavailable: ${reason}`);
  }
}

// Server-controlled keys — always present in the guard context, always
// written by the engine, never overridable by caller input.
export const PROTECTED_CONTEXT_KEYS = new Set([
  'companyId',
  'operationId',
  'workflowId',
  'workflowInstanceId',
  'state',
  'action',
]);

export interface GuardLeafRef {
  formVersionId: string;
  fieldKey: string;
}

export interface GuardLeaf {
  field: string;
  ref?: GuardLeafRef;
}

// Extract every leaf predicate field from a rule's `when` tree.
export function collectGuardFields(when: unknown): GuardLeaf[] {
  const leaves: GuardLeaf[] = [];
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return;
    const n = node as { all?: unknown[]; any?: unknown[]; field?: unknown; ref?: GuardLeafRef };
    for (const list of [n.all, n.any]) {
      if (Array.isArray(list)) for (const c of list) walk(c);
    }
    if (typeof n.field === 'string') {
      leaves.push({ field: n.field, ...(n.ref !== undefined ? { ref: n.ref } : {}) });
    }
  };
  walk(when);
  return leaves;
}

export type { BoundFieldSpec };

// Narrow boundary for resolving pinned, PERSISTED field values: the spec
// descriptor and the latest submitted revision value for this instance.
export interface GuardFieldResolver {
  findFieldSpec(
    companyId: string,
    formVersionId: string,
    fieldKey: string,
  ): Promise<BoundFieldSpec | null>;
  /** Latest submitted revision value for (instance, formVersion) — null when absent. */
  findSubmittedFieldValue(
    companyId: string,
    workflowInstanceId: string,
    formVersionId: string,
    fieldKey: string,
  ): Promise<{ value: unknown } | null>;
}

/**
 * Build the ONLY context a guard may see. Provenance:
 *  - protected keys: server-verified instance/tenant fields (always present)
 *  - leaf fields bound via `ref` to a pinned FormVersion: read from the
 *    instance's persisted, validated SubmissionRevision — the canonical
 *    store. Caller input can never supply or override these values.
 *  - everything else: unavailable — fail closed, never evaluated
 */
export async function buildVerifiedGuardContext(
  instance: WorkflowInstance,
  action: string,
  leaves: GuardLeaf[],
  resolver: GuardFieldResolver,
): Promise<Record<string, unknown>> {
  const ctx: Record<string, unknown> = {
    companyId: instance.companyId,
    operationId: instance.operationId,
    workflowId: instance.workflowId,
    workflowInstanceId: instance.id,
    state: instance.state,
    action,
  };
  for (const leaf of leaves) {
    if (PROTECTED_CONTEXT_KEYS.has(leaf.field)) continue; // server value present
    if (leaf.ref === undefined) {
      throw new WorkflowContextUnavailableError(
        `field ${leaf.field} has no verified context source`,
      );
    }
    const spec = await resolver.findFieldSpec(
      instance.companyId,
      leaf.ref.formVersionId,
      leaf.ref.fieldKey,
    );
    if (spec === null) {
      throw new WorkflowContextUnavailableError(
        `pinned form version ${leaf.ref.formVersionId} field ${leaf.ref.fieldKey} not found`,
      );
    }
    const persisted = await resolver.findSubmittedFieldValue(
      instance.companyId,
      instance.id,
      leaf.ref.formVersionId,
      leaf.ref.fieldKey,
    );
    if (persisted === null) {
      throw new WorkflowContextUnavailableError(
        `no submitted revision value for bound field ${leaf.field}`,
      );
    }
    if (!validateBoundValue(persisted.value, spec)) {
      throw new WorkflowContextUnavailableError(
        `persisted value for field ${leaf.field} failed bound-type validation (${spec.type})`,
      );
    }
    ctx[leaf.field] = persisted.value;
  }
  return ctx;
}
