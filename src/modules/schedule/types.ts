import { Type, type Static } from '@sinclair/typebox';
import type { OrgNodeStatus } from '@prisma/client';

const DATE_PATTERN = '^\\d{4}-\\d{2}-\\d{2}$';

export const WorkScheduleScopeEnum = Type.Union([
  Type.Literal('COMPANY'),
  Type.Literal('DEPARTMENT'),
  Type.Literal('PROJECT'),
  Type.Literal('SITE'),
  Type.Literal('EMPLOYEE'),
]);
export type WorkScheduleScope = Static<typeof WorkScheduleScopeEnum>;

export const ScheduleOverrideKindEnum = Type.Union([Type.Literal('WORKING'), Type.Literal('OFF')]);
export type ScheduleOverrideKind = Static<typeof ScheduleOverrideKindEnum>;

const DateStr = Type.String({ pattern: DATE_PATTERN });
const Uuid = Type.String({ format: 'uuid' });

/** Weekday numbers 0 (Sun) .. 6 (Sat). May be empty in pure-rotation mode. */
const Weekdays = Type.Array(Type.Integer({ minimum: 0, maximum: 6 }), {
  maxItems: 7,
});

/** Monthly positional off: nths 1..5 = nth occurrence in month, -1 = last. */
export const NthWeekdayOffSchema = Type.Object({
  weekday: Type.Integer({ minimum: 0, maximum: 6 }),
  nths: Type.Array(Type.Integer({ minimum: -1, maximum: 5 }), {
    minItems: 1,
    maxItems: 6,
  }),
});
export type NthWeekdayOffInput = Static<typeof NthWeekdayOffSchema>;

/**
 * Anchored rotating work/off cycle. (date - anchor) mod lengthDays is the
 * cycle offset; workingOffsets force WORKING, offOffsets force OFF (and win).
 * All-or-nothing: supplying any rotation field requires anchor + lengthDays.
 */
export const RotationSchema = Type.Object({
  anchor: DateStr,
  lengthDays: Type.Integer({ minimum: 2, maximum: 366 }),
  workingOffsets: Type.Array(Type.Integer({ minimum: 0, maximum: 365 }), {
    default: [],
  }),
  offOffsets: Type.Array(Type.Integer({ minimum: 0, maximum: 365 }), {
    default: [],
  }),
});
export type RotationInput = Static<typeof RotationSchema>;

/**
 * Pattern fields that make up a schedule revision — the immutable,
 * administrator-configured working pattern.
 */
export const RevisionPatternBody = Type.Object({
  timezone: Type.String({ minLength: 1, maxLength: 64 }),
  workingWeekdays: Weekdays,
  offNthWeekdays: Type.Optional(Type.Array(NthWeekdayOffSchema, { maxItems: 7 })),
  rotation: Type.Optional(RotationSchema),
  holidayCalendarId: Type.Optional(Type.Union([Uuid, Type.Null()])),
});
export type RevisionPatternInput = Static<typeof RevisionPatternBody>;

// ---------------------------------------------------------------------------
// Work schedules
// ---------------------------------------------------------------------------

export const CreateWorkScheduleBody = Type.Object({
  scopeType: WorkScheduleScopeEnum,
  departmentId: Type.Optional(Uuid),
  projectId: Type.Optional(Uuid),
  siteId: Type.Optional(Uuid),
  employeeId: Type.Optional(Uuid),
  name: Type.String({ minLength: 1, maxLength: 120 }),
  description: Type.Optional(Type.String({ maxLength: 500 })),
  effectiveFrom: DateStr,
  effectiveTo: Type.Optional(DateStr),
  /** Initial revision — the first working pattern, effective from this date.
   *  Must be >= the schedule's effectiveFrom (validated in the service). */
  revision: Type.Intersect([
    RevisionPatternBody,
    Type.Object({
      effectiveFrom: DateStr,
      note: Type.Optional(Type.String({ maxLength: 500 })),
    }),
  ]),
});
export type CreateWorkScheduleInput = Static<typeof CreateWorkScheduleBody>;

/** Identity-level edits only: name/description/validity window. Pattern
 *  changes are append-only via POST /schedules/:id/revisions. */
export const UpdateWorkScheduleBody = Type.Object({
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  description: Type.Optional(Type.Union([Type.String({ maxLength: 500 }), Type.Null()])),
  effectiveFrom: Type.Optional(DateStr),
  effectiveTo: Type.Optional(Type.Union([DateStr, Type.Null()])),
  expectedVersion: Type.Integer({ minimum: 0 }),
});
export type UpdateWorkScheduleInput = Static<typeof UpdateWorkScheduleBody>;

export const ArchiveWorkScheduleBody = Type.Object({
  expectedVersion: Type.Integer({ minimum: 0 }),
});
export type ArchiveWorkScheduleInput = Static<typeof ArchiveWorkScheduleBody>;

export const AddRevisionBody = Type.Intersect([
  RevisionPatternBody,
  Type.Object({
    effectiveFrom: DateStr,
    note: Type.Optional(Type.String({ maxLength: 500 })),
    expectedVersion: Type.Integer({ minimum: 0 }),
  }),
]);
export type AddRevisionInput = Static<typeof AddRevisionBody>;

/** Cancel transitions are one-way and audited — no version precondition. */

export const ListWorkSchedulesQuery = Type.Object({
  scopeType: Type.Optional(WorkScheduleScopeEnum),
  departmentId: Type.Optional(Uuid),
  projectId: Type.Optional(Uuid),
  siteId: Type.Optional(Uuid),
  employeeId: Type.Optional(Uuid),
  status: Type.Optional(
    Type.Union([Type.Literal('ACTIVE'), Type.Literal('INACTIVE'), Type.Literal('ARCHIVED')]),
  ),
});
export type ListWorkSchedulesFilter = Static<typeof ListWorkSchedulesQuery> & {
  status?: OrgNodeStatus;
};

export const EffectiveScheduleQuery = Type.Object({
  employeeId: Type.Optional(Uuid),
  siteId: Type.Optional(Uuid),
  projectId: Type.Optional(Uuid),
  asOf: Type.Optional(DateStr),
});
export interface EffectiveScheduleCriteria {
  employeeId?: string;
  siteId?: string;
  projectId?: string;
  asOf?: string;
}

// ---------------------------------------------------------------------------
// Date-specific overrides
// ---------------------------------------------------------------------------

export const AddOverrideBody = Type.Object({
  date: DateStr,
  disposition: ScheduleOverrideKindEnum,
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
});
export type AddOverrideInput = Static<typeof AddOverrideBody>;

export const CancelOverrideBody = Type.Object({});

export const ListOverridesQuery = Type.Object({
  from: Type.Optional(DateStr),
  to: Type.Optional(DateStr),
  status: Type.Optional(Type.Union([Type.Literal('ACTIVE'), Type.Literal('ARCHIVED')])),
});
export type ListOverridesFilter = Static<typeof ListOverridesQuery> & {
  status?: OrgNodeStatus;
};

// ---------------------------------------------------------------------------
// Holiday calendars
// ---------------------------------------------------------------------------

export const CreateHolidayCalendarBody = Type.Object({
  code: Type.String({ minLength: 1, maxLength: 30 }),
  name: Type.String({ minLength: 1, maxLength: 120 }),
  description: Type.Optional(Type.String({ maxLength: 500 })),
});
export type CreateHolidayCalendarInput = Static<typeof CreateHolidayCalendarBody>;

export const UpdateHolidayCalendarBody = Type.Object({
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  description: Type.Optional(Type.Union([Type.String({ maxLength: 500 }), Type.Null()])),
  expectedVersion: Type.Integer({ minimum: 0 }),
});
export type UpdateHolidayCalendarInput = Static<typeof UpdateHolidayCalendarBody>;

export const ListHolidayCalendarsQuery = Type.Object({
  status: Type.Optional(
    Type.Union([Type.Literal('ACTIVE'), Type.Literal('INACTIVE'), Type.Literal('ARCHIVED')]),
  ),
});
export type ListHolidayCalendarsFilter = Static<typeof ListHolidayCalendarsQuery> & {
  status?: OrgNodeStatus;
};

// ---------------------------------------------------------------------------
// Holiday categories (administrator-defined vocabulary)
// ---------------------------------------------------------------------------

export const CreateHolidayCategoryBody = Type.Object({
  code: Type.String({ minLength: 1, maxLength: 30 }),
  name: Type.String({ minLength: 1, maxLength: 120 }),
  description: Type.Optional(Type.String({ maxLength: 500 })),
});
export type CreateHolidayCategoryInput = Static<typeof CreateHolidayCategoryBody>;

export const ArchiveHolidayCategoryBody = Type.Object({
  expectedVersion: Type.Integer({ minimum: 0 }),
});
export type ArchiveHolidayCategoryInput = Static<typeof ArchiveHolidayCategoryBody>;

export const ListHolidayCategoriesQuery = Type.Object({
  status: Type.Optional(
    Type.Union([Type.Literal('ACTIVE'), Type.Literal('INACTIVE'), Type.Literal('ARCHIVED')]),
  ),
});
export type ListHolidayCategoriesFilter = Static<typeof ListHolidayCategoriesQuery> & {
  status?: OrgNodeStatus;
};

// ---------------------------------------------------------------------------
// Holidays
// ---------------------------------------------------------------------------

export const AddHolidayBody = Type.Object({
  date: DateStr,
  name: Type.String({ minLength: 1, maxLength: 120 }),
  categoryId: Uuid,
});
export type AddHolidayInput = Static<typeof AddHolidayBody>;

export const BulkAddHolidaysBody = Type.Object({
  holidays: Type.Array(AddHolidayBody, { minItems: 1, maxItems: 366 }),
});
export type BulkAddHolidaysInput = Static<typeof BulkAddHolidaysBody>;

export const CancelHolidayBody = Type.Object({});

export const ListHolidaysQuery = Type.Object({
  from: Type.Optional(DateStr),
  to: Type.Optional(DateStr),
  status: Type.Optional(Type.Union([Type.Literal('ACTIVE'), Type.Literal('ARCHIVED')])),
});
export type ListHolidaysFilter = Static<typeof ListHolidaysQuery> & {
  status?: OrgNodeStatus;
};
