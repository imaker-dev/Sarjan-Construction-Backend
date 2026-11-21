// Pure day-classification helpers for resolved work schedules.
// Dates are plain 'YYYY-MM-DD' strings — the caller is responsible for
// converting instants into dates using the schedule's configured timezone.

export type DayClassification = 'WORKING' | 'WEEKLY_OFF' | 'HOLIDAY';

/** Why a date classified the way it did — surfaced for auditability/debugging. */
export type ClassifyReason =
  | 'OVERRIDE' // explicit date-specific administrator override (wins over all)
  | 'HOLIDAY' // dated holiday in the revision's assigned calendar
  | 'ROTATION_OFF' // offset matches rotationOffOffsets
  | 'NTH_WEEKDAY_OFF' // monthly positional off (e.g. 2nd & 4th Saturday)
  | 'WORKING' // matched a working source
  | 'NOT_WORKING'; // matched no working source

/** Monthly positional off: nths 1..5 = nth occurrence, -1 = last occurrence. */
export interface NthWeekdayOff {
  weekday: number; // 0 = Sunday .. 6 = Saturday
  nths: number[];
}

export interface RotationSpec {
  /** YYYY-MM-DD — cycle day 0 (the first day of the first cycle). */
  anchor: string;
  /** Cycle length in days, 2..366. */
  lengthDays: number;
  /** Cycle offsets forced WORKING (empty unless a rotation is configured). */
  workingOffsets: number[];
  /** Cycle offsets forced OFF — wins over every working source. */
  offOffsets: number[];
}

export interface ScheduleWeekSpec {
  /** ISO weekday numbers that are working days: 0 = Sunday .. 6 = Saturday.
   *  May be empty when rotation.workingOffsets alone defines the pattern. */
  workingWeekdays: number[];
  /** Monthly positional offs (e.g. [{weekday:6, nths:[2,4]}] = 2nd/4th Sat). */
  offNthWeekdays?: NthWeekdayOff[] | null;
  /** Anchored rotating work/off cycle. */
  rotation?: RotationSpec | null;
}

export interface ClassifiedDay {
  day: DayClassification;
  reason: ClassifyReason;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function utcDay(dateStr: string): number {
  return new Date(`${dateStr}T00:00:00.000Z`).getUTCDay();
}

function daysSinceEpoch(dateStr: string): number {
  return Math.round(Date.parse(`${dateStr}T00:00:00.000Z`) / DAY_MS);
}

/** Nth occurrence of the weekday within its month (1-based). */
function nthWeekdayOfMonth(dateStr: string): number {
  const day = Number(dateStr.slice(8, 10));
  return Math.floor((day - 1) / 7) + 1;
}

/** True when the date is the LAST occurrence of its weekday in the month. */
function isLastWeekdayOfMonth(dateStr: string): boolean {
  const next = new Date(`${dateStr}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + 7);
  return next.getUTCMonth() !== new Date(`${dateStr}T00:00:00.000Z`).getUTCMonth();
}

function isNthWeekdayOff(spec: ScheduleWeekSpec, dateStr: string): boolean {
  if (spec.offNthWeekdays == null) return false;
  const weekday = utcDay(dateStr);
  for (const entry of spec.offNthWeekdays) {
    if (entry.weekday !== weekday) continue;
    const nth = nthWeekdayOfMonth(dateStr);
    if (entry.nths.includes(nth)) return true;
    if (entry.nths.includes(-1) && isLastWeekdayOfMonth(dateStr)) return true;
  }
  return false;
}

function rotationOffset(rotation: RotationSpec, dateStr: string): number {
  const diff = daysSinceEpoch(dateStr) - daysSinceEpoch(rotation.anchor);
  return ((diff % rotation.lengthDays) + rotation.lengthDays) % rotation.lengthDays;
}

/**
 * Classify a calendar date under a resolved schedule revision.
 * Precedence:
 *   1. dateOverride (disposition already resolved by caller — pass the
 *      classification directly when present; this function receives only
 *      pattern-level inputs)
 *   2. HOLIDAY — date is an ACTIVE holiday in the assigned calendar
 *   3. ROTATION_OFF — cycle offset is in rotation.offOffsets (wins over
 *      every working source)
 *   4. NTH_WEEKDAY_OFF — monthly positional off
 *   5. WORKING — weekday in workingWeekdays OR offset in workingOffsets
 *   6. NOT_WORKING — no working source matched
 * A holiday on an off day is reported as HOLIDAY (matters later for comp-off
 * eligibility vs weekly-off).
 *
 * Overrides are evaluated by the caller (classifyWithOverrides) so this pure
 * function stays pattern-only.
 */
export function classifyDay(
  spec: ScheduleWeekSpec,
  dateStr: string,
  holidayDates: ReadonlySet<string>,
): ClassifiedDay {
  if (holidayDates.has(dateStr)) return { day: 'HOLIDAY', reason: 'HOLIDAY' };

  const rotation = spec.rotation ?? null;
  const offset = rotation !== null ? rotationOffset(rotation, dateStr) : null;
  if (offset !== null && rotation?.offOffsets.includes(offset) === true) {
    return { day: 'WEEKLY_OFF', reason: 'ROTATION_OFF' };
  }
  if (isNthWeekdayOff(spec, dateStr)) {
    return { day: 'WEEKLY_OFF', reason: 'NTH_WEEKDAY_OFF' };
  }

  const weekday = utcDay(dateStr);
  const baseWorking =
    spec.workingWeekdays.includes(weekday) ||
    (offset !== null && rotation?.workingOffsets.includes(offset) === true);
  return baseWorking
    ? { day: 'WORKING', reason: 'WORKING' }
    : { day: 'WEEKLY_OFF', reason: 'NOT_WORKING' };
}

/**
 * Full classification including date-specific overrides.
 * `override` is the ACTIVE override's disposition for this date, if any.
 */
export function classifyWithOverrides(
  spec: ScheduleWeekSpec,
  dateStr: string,
  holidayDates: ReadonlySet<string>,
  override: 'WORKING' | 'OFF' | null,
): ClassifiedDay {
  if (override === 'WORKING') return { day: 'WORKING', reason: 'OVERRIDE' };
  if (override === 'OFF') return { day: 'WEEKLY_OFF', reason: 'OVERRIDE' };
  return classifyDay(spec, dateStr, holidayDates);
}
