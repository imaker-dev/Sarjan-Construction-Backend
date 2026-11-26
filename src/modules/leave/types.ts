import { Type, type Static } from '@sinclair/typebox';
import type { OrgNodeStatus } from '@prisma/client';

export const LeaveTypeEnum = Type.Union([
  Type.Literal('CASUAL'),
  Type.Literal('SICK'),
  Type.Literal('PRIVILEGE'),
  Type.Literal('COMP_OFF'),
  Type.Literal('LOSS_OF_PAY'),
  Type.Literal('SPECIAL'),
]);

export const LeaveAccrualFrequencyEnum = Type.Union([
  Type.Literal('ANNUAL'),
  Type.Literal('MONTHLY'),
  Type.Literal('QUARTERLY'),
  Type.Literal('NONE'),
]);

export const LeaveRequestStatusEnum = Type.Union([
  Type.Literal('PENDING'),
  Type.Literal('APPROVED'),
  Type.Literal('REJECTED'),
  Type.Literal('RETURNED'),
  Type.Literal('CANCELLED'),
]);

export const HalfDayPortionEnum = Type.Union([
  Type.Literal('FIRST_HALF'),
  Type.Literal('SECOND_HALF'),
]);

export const LeaveScopeTypeEnum = Type.Union([
  Type.Literal('COMPANY'),
  Type.Literal('PROJECT'),
  Type.Literal('SITE'),
  Type.Literal('EMPLOYEE'),
]);

/** Scope types allowed when authoring NEW policies. DEPARTMENT targets the
 *  actual Department record regardless of where it sits (HO / project / site);
 *  PROJECT/SITE remain only on pre-existing rows. */
export const LeavePolicyWriteScopeEnum = Type.Union([
  Type.Literal('COMPANY'),
  Type.Literal('DEPARTMENT'),
  Type.Literal('EMPLOYEE'),
]);

export const LeaveAccrualModeEnum = Type.Union([
  Type.Literal('MONTHLY_CREDIT'),
  Type.Literal('WORKED_DAYS_RATIO'),
  Type.Literal('NONE'),
]);

const DateStr = Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' });
const Uuid = Type.String({ format: 'uuid' });

// ---------------------------------------------------------------------------
// Leave type definitions (company-configured vocabulary — no seeded amounts)
// ---------------------------------------------------------------------------

export const CreateLeaveTypeDefBody = Type.Object({
  code: Type.String({ minLength: 1, maxLength: 30 }),
  name: Type.String({ minLength: 1, maxLength: 120 }),
  description: Type.Optional(Type.String({ maxLength: 500 })),
  /** Optional mapping to a built-in LeaveType enum value. Defs without a
   *  mapping are fully custom types. */
  leaveType: Type.Optional(LeaveTypeEnum),
});
export type CreateLeaveTypeDefInput = Static<typeof CreateLeaveTypeDefBody>;

export const UpdateLeaveTypeDefBody = Type.Object({
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  description: Type.Optional(Type.Union([Type.String({ maxLength: 500 }), Type.Null()])),
  expectedVersion: Type.Integer({ minimum: 0 }),
});
export type UpdateLeaveTypeDefInput = Static<typeof UpdateLeaveTypeDefBody>;

export const ArchiveLeaveTypeDefBody = Type.Object({
  expectedVersion: Type.Integer({ minimum: 0 }),
});
export type ArchiveLeaveTypeDefInput = Static<typeof ArchiveLeaveTypeDefBody>;

export const ListLeaveTypeDefsQuery = Type.Object({
  status: Type.Optional(
    Type.Union([Type.Literal('ACTIVE'), Type.Literal('INACTIVE'), Type.Literal('ARCHIVED')]),
  ),
});
export type ListLeaveTypeDefsFilter = Static<typeof ListLeaveTypeDefsQuery> & {
  status?: OrgNodeStatus;
};

// ---------------------------------------------------------------------------
// Policy versions (immutable accrual configuration)
// ---------------------------------------------------------------------------

export const PolicyVersionBody = Type.Object({
  effectiveFrom: DateStr,
  mode: LeaveAccrualModeEnum,
  /** MONTHLY_CREDIT: days credited per month (e.g. 4 => 4 days/month). */
  monthlyCreditAmount: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 365 })),
  /** WORKED_DAYS_RATIO: eligible worked days per credit unit. */
  ratioThresholdDays: Type.Optional(Type.Integer({ minimum: 1, maximum: 366 })),
  /** WORKED_DAYS_RATIO: days earned per threshold (e.g. 2 => 2 per 20 days). */
  ratioEarnedAmount: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 365 })),
  note: Type.Optional(Type.String({ maxLength: 500 })),
});
export type PolicyVersionInput = Static<typeof PolicyVersionBody>;

export const AddLeavePolicyVersionBody = Type.Intersect([
  PolicyVersionBody,
  Type.Object({ expectedVersion: Type.Integer({ minimum: 0 }) }),
]);
export type AddLeavePolicyVersionInput = Static<typeof AddLeavePolicyVersionBody>;

export const ArchiveLeavePolicyBody = Type.Object({
  expectedVersion: Type.Integer({ minimum: 0 }),
});
export type ArchiveLeavePolicyInput = Static<typeof ArchiveLeavePolicyBody>;

export const CreateLeavePolicyBody = Type.Object({
  scopeType: LeavePolicyWriteScopeEnum,
  departmentId: Type.Optional(Uuid),
  employeeId: Type.Optional(Uuid),
  /** Administrator-defined leave type this policy configures. */
  typeDefId: Uuid,
  name: Type.String({ minLength: 1, maxLength: 120 }),
  description: Type.Optional(Type.String({ maxLength: 500 })),
  /** Initial immutable accrual version. */
  version: PolicyVersionBody,
});

export const UpdateLeavePolicyBody = Type.Object({
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  description: Type.Optional(Type.String({ maxLength: 500 })),
  annualAllowance: Type.Optional(Type.Number({ minimum: 0, maximum: 365 })),
  accrualFrequency: Type.Optional(LeaveAccrualFrequencyEnum),
  maxConsecutiveDays: Type.Optional(
    Type.Union([Type.Integer({ minimum: 1, maximum: 90 }), Type.Null()]),
  ),
  minNoticeDays: Type.Optional(Type.Integer({ minimum: 0, maximum: 90 })),
  allowHalfDay: Type.Optional(Type.Boolean()),
  sandwichRule: Type.Optional(Type.Boolean()),
  carryoverMaxDays: Type.Optional(Type.Number({ minimum: 0, maximum: 90 })),
  encashable: Type.Optional(Type.Boolean()),
  requiresDocAboveDays: Type.Optional(
    Type.Union([Type.Integer({ minimum: 1, maximum: 30 }), Type.Null()]),
  ),
  isActive: Type.Optional(Type.Boolean()),
  expectedVersion: Type.Integer(),
});

export const AllocateLeaveBalanceBody = Type.Object({
  employeeId: Type.String({ format: 'uuid' }),
  leaveType: LeaveTypeEnum,
  year: Type.Integer({ minimum: 2000, maximum: 2100 }),
  allocatedDays: Type.Number({ minimum: 0, maximum: 365 }),
  carriedOverDays: Type.Optional(Type.Number({ minimum: 0, maximum: 90, default: 0 })),
});

export const SubmitLeaveRequestBody = Type.Object({
  employeeId: Type.Optional(Type.String({ format: 'uuid' })),
  leaveType: LeaveTypeEnum,
  startDate: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
  endDate: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
  isHalfDay: Type.Optional(Type.Boolean({ default: false })),
  halfDayPortion: Type.Optional(HalfDayPortionEnum),
  reason: Type.String({ minLength: 3, maxLength: 500 }),
  documentId: Type.Optional(Type.String({ format: 'uuid' })),
});

export const ReviewLeaveRequestBody = Type.Object({
  action: Type.Union([Type.Literal('APPROVE'), Type.Literal('REJECT'), Type.Literal('RETURN')]),
  /** Required for REJECT and RETURN (the requester needs the reason);
   *  optional for APPROVE. */
  remarks: Type.Optional(Type.String({ maxLength: 500 })),
  expectedVersion: Type.Integer(),
});

/** Owner resubmission of a RETURNED request — any field may be corrected;
 *  the full submission pipeline (boundary, notice, conflict, balance) is
 *  re-validated and pending days are re-reserved. */
export const ResubmitLeaveRequestBody = Type.Object({
  startDate: Type.Optional(Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' })),
  endDate: Type.Optional(Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' })),
  reason: Type.Optional(Type.String({ minLength: 3, maxLength: 500 })),
  documentId: Type.Optional(Type.Union([Type.String({ format: 'uuid' }), Type.Null()])),
  expectedVersion: Type.Integer(),
});
export type ResubmitLeaveRequestInput = Static<typeof ResubmitLeaveRequestBody>;

export const CancelLeaveRequestBody = Type.Object({
  reason: Type.Optional(Type.String({ maxLength: 500 })),
  expectedVersion: Type.Integer(),
});

export const ListLeavePoliciesQuery = Type.Object({
  scopeType: Type.Optional(LeaveScopeTypeEnum),
  leaveType: Type.Optional(LeaveTypeEnum),
  typeDefId: Type.Optional(Uuid),
  departmentId: Type.Optional(Uuid),
  projectId: Type.Optional(Uuid),
  siteId: Type.Optional(Uuid),
  employeeId: Type.Optional(Uuid),
});

export const EffectiveLeavePolicyQuery = Type.Object({
  /** Administrator-defined type. Either typeDefId or leaveType is required. */
  typeDefId: Type.Optional(Uuid),
  leaveType: Type.Optional(LeaveTypeEnum),
  employeeId: Type.Optional(Uuid),
  asOf: Type.Optional(DateStr),
});
export interface EffectiveLeavePolicyCriteria {
  typeDefId?: string;
  leaveType?: import('@prisma/client').LeaveType;
  employeeId?: string;
  asOf?: string;
}

export const ListLeaveBalancesQuery = Type.Object({
  employeeId: Type.Optional(Type.String({ format: 'uuid' })),
  leaveType: Type.Optional(LeaveTypeEnum),
  year: Type.Optional(Type.Integer({ minimum: 2000, maximum: 2100 })),
  /** Scoped-approver filters — each resolves to a permission scope target;
   *  a scoped caller must pass a filter inside their grant. */
  siteId: Type.Optional(Uuid),
  projectId: Type.Optional(Uuid),
  departmentId: Type.Optional(Uuid),
});

export const ListLeaveRequestsQuery = Type.Object({
  employeeId: Type.Optional(Type.String({ format: 'uuid' })),
  leaveType: Type.Optional(LeaveTypeEnum),
  status: Type.Optional(LeaveRequestStatusEnum),
  /** Scoped-approver filters — resolved server-side against each request's
   *  department membership effective at the request start date. */
  siteId: Type.Optional(Uuid),
  projectId: Type.Optional(Uuid),
  departmentId: Type.Optional(Uuid),
  from: Type.Optional(Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' })),
  to: Type.Optional(Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 50 })),
  cursor: Type.Optional(Type.String()),
});

export type CreateLeavePolicyInput = Static<typeof CreateLeavePolicyBody>;
export type UpdateLeavePolicyInput = Static<typeof UpdateLeavePolicyBody>;
export type AllocateLeaveBalanceInput = Static<typeof AllocateLeaveBalanceBody>;
export type SubmitLeaveRequestInput = Static<typeof SubmitLeaveRequestBody>;
export type ReviewLeaveRequestInput = Static<typeof ReviewLeaveRequestBody>;
export type CancelLeaveRequestInput = Static<typeof CancelLeaveRequestBody>;
export type ListLeavePoliciesFilter = Static<typeof ListLeavePoliciesQuery>;
export type ListLeaveBalancesFilter = Static<typeof ListLeaveBalancesQuery>;
export type ListLeaveRequestsFilter = Static<typeof ListLeaveRequestsQuery>;

/**
 * Calculates net leave days.
 * - If isHalfDay is true: exactly 0.5 days.
 * - If sandwichRule is true: counts every calendar day from startDate to endDate inclusive.
 * - If sandwichRule is false: counts days from startDate to endDate inclusive, excluding Sundays.
 */
export function calculateNetLeaveDays(
  startDateStr: string,
  endDateStr: string,
  isHalfDay: boolean,
  sandwichRule: boolean,
): number {
  if (isHalfDay) {
    return 0.5;
  }

  const start = new Date(`${startDateStr}T00:00:00.000Z`);
  const end = new Date(`${endDateStr}T00:00:00.000Z`);

  if (start.getTime() > end.getTime()) {
    throw new Error('startDate cannot be after endDate');
  }

  let count = 0;
  const current = new Date(start);

  while (current.getTime() <= end.getTime()) {
    const dayOfWeek = current.getUTCDay(); // 0 = Sunday
    if (sandwichRule || dayOfWeek !== 0) {
      count++;
    }
    current.setUTCDate(current.getUTCDate() + 1);
  }

  return count;
}
