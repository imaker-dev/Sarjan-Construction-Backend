import { OrgValidationError } from '../organization/errors.js';

// Shared minimum transaction states from rule.md §8. Modules may add domain
// states later; the allowlist is the contract for instance engines.
export const WORKFLOW_STATES = [
  'DRAFT',
  'SUBMITTED',
  'IN_REVIEW',
  'RETURNED',
  'APPROVED',
  'REJECTED',
  'IN_PROGRESS',
  'PARTIALLY_FULFILLED',
  'COMPLETED',
  'CANCELLED',
  'CLOSED',
] as const;

// Terminal states — no outgoing steps allowed.
export const TERMINAL_STATES = new Set(['APPROVED', 'REJECTED', 'CANCELLED', 'CLOSED']);

// Distinct step kinds per rule.md §8.
export const STEP_KINDS = [
  'ASSIGNMENT',
  'EXECUTION',
  'APPROVAL',
  'VERIFICATION',
  'CLOSURE',
] as const;
export type StepKind = (typeof STEP_KINDS)[number];

// Allowlisted action names — arbitrary transition names are never accepted.
export const STEP_ACTIONS = [
  'ASSIGN',
  'SUBMIT',
  'EXECUTE',
  'APPROVE',
  'REJECT',
  'RETURN',
  'VERIFY',
  'CLOSE',
  'CANCEL',
] as const;
export type StepAction = (typeof STEP_ACTIONS)[number];

// Valid action → step-kind combinations. APPROVAL/VERIFICATION may REJECT or
// RETURN; EXECUTION may be cancelled; CLOSURE closes or cancels.
export const KIND_ACTIONS: Record<StepKind, readonly StepAction[]> = {
  ASSIGNMENT: ['ASSIGN'],
  EXECUTION: ['SUBMIT', 'EXECUTE', 'CANCEL'],
  APPROVAL: ['APPROVE', 'REJECT', 'RETURN'],
  VERIFICATION: ['VERIFY', 'REJECT', 'RETURN'],
  CLOSURE: ['CLOSE', 'CANCEL'],
} as const;

// Action → allowed destination states. Each transition's `to` must land in a
// state consistent with the action's semantics (rule.md shared states).
export const ACTION_DESTINATIONS: Record<StepAction, readonly string[]> = {
  ASSIGN: ['IN_REVIEW', 'IN_PROGRESS'],
  SUBMIT: ['SUBMITTED', 'IN_REVIEW'],
  EXECUTE: ['IN_PROGRESS', 'PARTIALLY_FULFILLED', 'COMPLETED'],
  APPROVE: ['APPROVED'],
  REJECT: ['REJECTED'],
  RETURN: ['RETURNED'],
  VERIFY: ['COMPLETED', 'CLOSED'],
  CLOSE: ['CLOSED'],
  CANCEL: ['CANCELLED'],
} as const;

// Assignee specifications — no expressions, no direct users.
export const ASSIGNEE_TYPES = [
  'ROLE_KEY',
  'PERMISSION_KEY',
  'DEPARTMENT_HEAD',
  'INITIATOR',
] as const;

const STEP_KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_DEFINITION_BYTES = 32 * 1024;
const MAX_STEPS = 100;
const MAX_NAME = 300;
const MAX_SLA_HOURS = 8760;

interface AssigneeSpec {
  type: string;
  value?: unknown;
}

interface StepSpec {
  key: string;
  kind: string;
  name?: string;
  from: string;
  action: string;
  to: string;
  assignee?: AssigneeSpec;
  formVersionId?: string;
  ruleVersionId?: string; // optional guard — verified at publish time
  stageKey?: string; // required on APPROVAL steps — groups one stage's outcomes
  selfApprove?: boolean; // APPROVAL steps only; default deny
  slaHours?: number;
}

function fail(field: string, message: string): never {
  throw new OrgValidationError(field, message);
}

function validateAssignee(spec: StepSpec): void {
  const a: unknown = spec.assignee;
  if (a === undefined) return;
  const ctx = `steps.${spec.key}.assignee`;
  if (typeof a !== 'object' || a === null || Array.isArray(a)) fail(ctx, 'must be an object');
  const spec_ = a as AssigneeSpec;
  if (!ASSIGNEE_TYPES.includes(spec_.type as (typeof ASSIGNEE_TYPES)[number])) {
    fail(`${ctx}.type`, `unsupported type ${JSON.stringify(spec_.type)}`);
  }
  if (['ROLE_KEY', 'PERMISSION_KEY'].includes(spec_.type)) {
    // Format-only validation — runtime resolution against role/permission
    // assignments is deferred to the instance engine.
    if (typeof spec_.value !== 'string' || !STEP_KEY_RE.test(spec_.value.toLowerCase())) {
      fail(`${ctx}.value`, 'must be a normalized key');
    }
  } else if (spec_.value !== undefined) {
    fail(`${ctx}.value`, `must be omitted for ${spec_.type}`);
  }
  for (const k of Object.keys(spec_)) {
    if (!['type', 'value'].includes(k)) fail(ctx, `unknown property ${k}`);
  }
}

// Extract declared formVersionIds for publish-time referential checks.
export function formVersionRefs(definition: unknown): string[] {
  const steps = (definition as { steps?: StepSpec[] }).steps ?? [];
  return steps.map((s) => s.formVersionId).filter((id): id is string => typeof id === 'string');
}

// Extract declared ruleVersionIds (transition guards) for publish-time checks.
export function ruleVersionRefs(definition: unknown): string[] {
  const steps = (definition as { steps?: StepSpec[] }).steps ?? [];
  return steps.map((s) => s.ruleVersionId).filter((id): id is string => typeof id === 'string');
}

export function assertValidWorkflowDefinition(definition: unknown): void {
  if (definition === null || typeof definition !== 'object' || Array.isArray(definition)) {
    fail('definition', 'must be a JSON object');
  }
  const serialized = JSON.stringify(definition);
  if (serialized.length > MAX_DEFINITION_BYTES) {
    fail('definition', `exceeds ${MAX_DEFINITION_BYTES} bytes`);
  }
  const root = definition as Record<string, unknown>;
  for (const k of Object.keys(root)) {
    if (!['initialState', 'steps'].includes(k)) {
      fail('definition', `unknown top-level key ${JSON.stringify(k)}`);
    }
  }
  if (
    typeof root.initialState !== 'string' ||
    !WORKFLOW_STATES.includes(root.initialState as (typeof WORKFLOW_STATES)[number])
  ) {
    fail('definition.initialState', `must be one of ${WORKFLOW_STATES.join(', ')}`);
  }
  const initialState = root.initialState;
  if (TERMINAL_STATES.has(initialState)) {
    fail('definition.initialState', 'cannot be a terminal state');
  }

  const rawSteps = root.steps;
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
    fail('definition.steps', 'must be a non-empty array');
  }
  if (rawSteps.length > MAX_STEPS) fail('definition.steps', `exceeds ${MAX_STEPS} steps`);

  const seenKeys = new Set<string>();
  const seenTransitions = new Set<string>();
  const steps: StepSpec[] = [];
  for (const raw of rawSteps) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      fail('definition.steps', 'each step must be an object');
    }
    const step = raw as StepSpec;
    if (typeof step.key !== 'string' || !STEP_KEY_RE.test(step.key)) {
      fail('definition.steps', `invalid step key ${JSON.stringify(step.key)}`);
    }
    if (seenKeys.has(step.key)) fail('definition.steps', `duplicate step key ${step.key}`);
    seenKeys.add(step.key);
    for (const k of Object.keys(step)) {
      if (
        ![
          'key',
          'kind',
          'name',
          'from',
          'action',
          'to',
          'assignee',
          'formVersionId',
          'ruleVersionId',
          'stageKey',
          'selfApprove',
          'slaHours',
        ].includes(k)
      ) {
        fail(`steps.${step.key}`, `unknown property ${k}`);
      }
    }
    if (!STEP_KINDS.includes(step.kind as StepKind)) {
      fail(`steps.${step.key}.kind`, `unsupported kind ${JSON.stringify(step.kind)}`);
    }
    if (step.name !== undefined && (typeof step.name !== 'string' || step.name.length > MAX_NAME)) {
      fail(`steps.${step.key}.name`, `must be a string of up to ${MAX_NAME} chars`);
    }
    if (!WORKFLOW_STATES.includes(step.from as (typeof WORKFLOW_STATES)[number])) {
      fail(`steps.${step.key}.from`, `unknown state ${JSON.stringify(step.from)}`);
    }
    if (TERMINAL_STATES.has(step.from)) {
      fail(`steps.${step.key}.from`, `terminal state ${step.from} cannot have outgoing steps`);
    }
    if (!WORKFLOW_STATES.includes(step.to as (typeof WORKFLOW_STATES)[number])) {
      fail(`steps.${step.key}.to`, `unknown state ${JSON.stringify(step.to)}`);
    }
    if (!STEP_ACTIONS.includes(step.action as StepAction)) {
      fail(`steps.${step.key}.action`, `unknown action ${JSON.stringify(step.action)}`);
    }
    if (!KIND_ACTIONS[step.kind as StepKind].includes(step.action as StepAction)) {
      fail(`steps.${step.key}.action`, `action ${step.action} is not valid for ${step.kind} steps`);
    }
    if (!ACTION_DESTINATIONS[step.action as StepAction].includes(step.to)) {
      fail(`steps.${step.key}.to`, `action ${step.action} cannot transition to ${step.to}`);
    }
    if (step.formVersionId !== undefined) {
      if (typeof step.formVersionId !== 'string' || !UUID_RE.test(step.formVersionId)) {
        fail(`steps.${step.key}.formVersionId`, 'must be a UUID');
      }
    }
    if (step.ruleVersionId !== undefined) {
      if (typeof step.ruleVersionId !== 'string' || !UUID_RE.test(step.ruleVersionId)) {
        fail(`steps.${step.key}.ruleVersionId`, 'must be a UUID');
      }
    }
    if (step.kind === 'APPROVAL') {
      // Approval steps group into a named stage so a decision unambiguously
      // maps to its APPROVE/REJECT/RETURN outcomes.
      if (typeof step.stageKey !== 'string' || !STEP_KEY_RE.test(step.stageKey)) {
        fail(`steps.${step.key}.stageKey`, 'required normalized stage key on APPROVAL steps');
      }
      if (step.assignee === undefined) {
        fail(`steps.${step.key}.assignee`, 'required on APPROVAL steps');
      }
      if (step.selfApprove !== undefined && typeof step.selfApprove !== 'boolean') {
        fail(`steps.${step.key}.selfApprove`, 'must be a boolean');
      }
    } else {
      if (step.stageKey !== undefined) {
        fail(`steps.${step.key}.stageKey`, 'only valid on APPROVAL steps');
      }
      if (step.selfApprove !== undefined) {
        fail(`steps.${step.key}.selfApprove`, 'only valid on APPROVAL steps');
      }
    }
    if (
      step.slaHours !== undefined &&
      (typeof step.slaHours !== 'number' ||
        !Number.isInteger(step.slaHours) ||
        step.slaHours < 1 ||
        step.slaHours > MAX_SLA_HOURS)
    ) {
      fail(`steps.${step.key}.slaHours`, `must be an integer 1-${MAX_SLA_HOURS}`);
    }
    validateAssignee(step);
    // Each (fromState, action) must identify exactly one step — ambiguous
    // transitions are rejected outright.
    const pair = `${step.from}|${step.action}`;
    if (seenTransitions.has(pair)) {
      fail(`steps.${step.key}`, `duplicate transition ${step.from} + ${step.action} — ambiguous`);
    }
    seenTransitions.add(pair);
    steps.push(step);
  }

  validateApprovalStages(steps);
  validateFormVersionUniqueness(steps);
  validateStateGraph(initialState, steps);
}

// One FormVersion may back at most one step in a definition (v1): guard
// resolution maps (instance, formVersionId) → submission, so a repeated
// version would make submissions ambiguous.
function validateFormVersionUniqueness(steps: StepSpec[]): void {
  const seen = new Map<string, string>();
  for (const s of steps) {
    if (s.formVersionId === undefined) continue;
    const prev = seen.get(s.formVersionId);
    if (prev !== undefined) {
      fail(
        `steps.${s.key}.formVersionId`,
        `form version already bound at steps.${prev} — one step per form version`,
      );
    }
    seen.set(s.formVersionId, s.key);
  }
}

// Approval stage consistency: every APPROVAL step sharing a stageKey must
// agree on from-state, assignee, selfApprove, and guard so a decision maps to
// one unambiguous stage — no loose grouping of unrelated steps. At most one
// approval stage may originate from a state.
function validateApprovalStages(steps: StepSpec[]): void {
  const byStage = new Map<string, StepSpec[]>();
  for (const s of steps) {
    if (s.kind !== 'APPROVAL' || s.stageKey === undefined) continue;
    if (!byStage.has(s.stageKey)) byStage.set(s.stageKey, []);
    byStage.get(s.stageKey)?.push(s);
  }
  for (const [stageKey, group] of byStage) {
    const first = group[0];
    if (first === undefined) continue;
    for (const s of group.slice(1)) {
      if (s.from !== first.from) {
        fail(`steps.${s.key}`, `stage ${stageKey} steps must share a from-state`);
      }
      if (JSON.stringify(s.assignee) !== JSON.stringify(first.assignee)) {
        fail(`steps.${s.key}`, `stage ${stageKey} steps must share an assignee`);
      }
      if ((s.selfApprove ?? false) !== (first.selfApprove ?? false)) {
        fail(`steps.${s.key}`, `stage ${stageKey} steps must share selfApprove`);
      }
      if (s.ruleVersionId !== first.ruleVersionId) {
        fail(`steps.${s.key}`, `stage ${stageKey} steps must share a guard rule`);
      }
    }
    const stageByFrom = new Set(group.map((s) => s.from));
    if (stageByFrom.size !== 1) {
      fail('definition.steps', `stage ${stageKey} spans multiple from-states`);
    }
  }
  const stagePerFrom = new Map<string, string>();
  for (const s of steps) {
    if (s.kind !== 'APPROVAL' || s.stageKey === undefined) continue;
    const prev = stagePerFrom.get(s.from);
    if (prev !== undefined && prev !== s.stageKey) {
      fail(`steps.${s.key}`, `multiple approval stages on ${s.from} — only one allowed`);
    }
    stagePerFrom.set(s.from, s.stageKey);
  }
}

// Reachability + terminal-path checks. Cycles are intentional (return/
// resubmission); unreachable steps and dead ends without a terminal path are
// rejected.
function validateStateGraph(initialState: string, steps: StepSpec[]): void {
  const edges = new Map<string, Set<string>>();
  for (const s of steps) {
    if (!edges.has(s.from)) edges.set(s.from, new Set());
    edges.get(s.from)?.add(s.to);
  }
  if (!edges.has(initialState)) {
    fail('definition.initialState', 'no step transitions out of the initial state');
  }
  // BFS from initialState.
  const reachable = new Set<string>([initialState]);
  const queue = [initialState];
  while (queue.length > 0) {
    const state = queue.shift();
    for (const next of edges.get(state ?? '') ?? []) {
      if (!reachable.has(next)) {
        reachable.add(next);
        queue.push(next);
      }
    }
  }
  for (const s of steps) {
    if (!reachable.has(s.from)) {
      fail(`steps.${s.key}.from`, `state ${s.from} is unreachable from ${initialState}`);
    }
    if (!reachable.has(s.to)) {
      // Unreachable implies a dead edge — same failure category.
      fail(`steps.${s.key}.to`, `state ${s.to} is unreachable from ${initialState}`);
    }
  }
  // Every reachable non-terminal state must have a path to a terminal state.
  const reverse = new Map<string, Set<string>>();
  for (const s of steps) {
    if (!reverse.has(s.to)) reverse.set(s.to, new Set());
    reverse.get(s.to)?.add(s.from);
  }
  const canReachTerminal = new Set<string>();
  const tQueue = [...TERMINAL_STATES].filter((s) => reachable.has(s));
  for (const t of tQueue) canReachTerminal.add(t);
  while (tQueue.length > 0) {
    const state = tQueue.shift();
    for (const prev of reverse.get(state ?? '') ?? []) {
      if (!canReachTerminal.has(prev)) {
        canReachTerminal.add(prev);
        tQueue.push(prev);
      }
    }
  }
  for (const state of reachable) {
    if (!TERMINAL_STATES.has(state) && !canReachTerminal.has(state)) {
      fail('definition.steps', `state ${state} has no path to a terminal state`);
    }
  }
}
