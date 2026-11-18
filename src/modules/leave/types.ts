import { Type, type Static } from '@sinclair/typebox';

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

export const CreateLeavePolicyBody = Type.Object({
  scopeType: LeaveScopeTypeEnum,
  projectId: Type.Optional(Type.String({ format: 'uuid' })),
  siteId: Type.Optional(Type.String({ format: 'uuid' })),
  employeeId: Type.Optional(Type.String({ format: 'uuid' })),
  leaveType: LeaveTypeEnum,
  name: Type.String({ minLength: 1, maxLength: 120 }),
  description: Type.Optional(Type.String({ maxLength: 500 })),
  annualAllowance: Type.Optional(Type.Number({ minimum: 0, maximum: 365, default: 12 })),
  accrualFrequency: Type.Optional(LeaveAccrualFrequencyEnum),
  maxConsecutiveDays: Type.Optional(Type.Integer({ minimum: 1, maximum: 90 })),
  minNoticeDays: Type.Optional(Type.Integer({ minimum: 0, maximum: 90, default: 0 })),
  allowHalfDay: Type.Optional(Type.Boolean({ default: true })),
  sandwichRule: Type.Optional(Type.Boolean({ default: false })),
  carryoverMaxDays: Type.Optional(Type.Number({ minimum: 0, maximum: 90, default: 0 })),
  encashable: Type.Optional(Type.Boolean({ default: false })),
  requiresDocAboveDays: Type.Optional(Type.Integer({ minimum: 1, maximum: 30 })),
});

export const UpdateLeavePolicyBody = Type.Object({
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  description: Type.Optional(Type.String({ maxLength: 500 })),
  annualAllowance: Type.Optional(Type.Number({ minimum: 0, maximum: 365 })),
  accrualFrequency: Type.Optional(LeaveAccrualFrequencyEnum),
  maxConsecutiveDays: Type.Optional(Type.Union([Type.Integer({ minimum: 1, maximum: 90 }), Type.Null()])),
  minNoticeDays: Type.Optional(Type.Integer({ minimum: 0, maximum: 90 })),
  allowHalfDay: Type.Optional(Type.Boolean()),
  sandwichRule: Type.Optional(Type.Boolean()),
  carryoverMaxDays: Type.Optional(Type.Number({ minimum: 0, maximum: 90 })),
  encashable: Type.Optional(Type.Boolean()),
  requiresDocAboveDays: Type.Optional(Type.Union([Type.Integer({ minimum: 1, maximum: 30 }), Type.Null()])),
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
  action: Type.Union([Type.Literal('APPROVE'), Type.Literal('REJECT')]),
  remarks: Type.Optional(Type.String({ maxLength: 500 })),
  expectedVersion: Type.Integer(),
});

export const CancelLeaveRequestBody = Type.Object({
  reason: Type.Optional(Type.String({ maxLength: 500 })),
  expectedVersion: Type.Integer(),
});

export const ListLeavePoliciesQuery = Type.Object({
  scopeType: Type.Optional(LeaveScopeTypeEnum),
  leaveType: Type.Optional(LeaveTypeEnum),
  projectId: Type.Optional(Type.String({ format: 'uuid' })),
  siteId: Type.Optional(Type.String({ format: 'uuid' })),
  employeeId: Type.Optional(Type.String({ format: 'uuid' })),
});

export const ListLeaveBalancesQuery = Type.Object({
  employeeId: Type.Optional(Type.String({ format: 'uuid' })),
  leaveType: Type.Optional(LeaveTypeEnum),
  year: Type.Optional(Type.Integer({ minimum: 2000, maximum: 2100 })),
});

export const ListLeaveRequestsQuery = Type.Object({
  employeeId: Type.Optional(Type.String({ format: 'uuid' })),
  leaveType: Type.Optional(LeaveTypeEnum),
  status: Type.Optional(LeaveRequestStatusEnum),
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
