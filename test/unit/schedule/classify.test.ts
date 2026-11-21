import { describe, expect, it } from 'vitest';
import {
  classifyDay,
  classifyWithOverrides,
  type ScheduleWeekSpec,
} from '../../../src/modules/schedule/classify.js';

const NO_HOLIDAYS = new Set<string>();

const monFri: ScheduleWeekSpec = { workingWeekdays: [1, 2, 3, 4, 5] };
const monSat: ScheduleWeekSpec = { workingWeekdays: [1, 2, 3, 4, 5, 6] };

describe('classifyDay — weekday sets', () => {
  it('classifies working weekdays and weekly offs for a 5-day (HO-style) week', () => {
    // 2026-01-05 is a Monday.
    expect(classifyDay(monFri, '2026-01-05', NO_HOLIDAYS)).toEqual({
      day: 'WORKING',
      reason: 'WORKING',
    });
    // Saturday + Sunday are off.
    expect(classifyDay(monFri, '2026-01-10', NO_HOLIDAYS).day).toBe('WEEKLY_OFF');
    expect(classifyDay(monFri, '2026-01-11', NO_HOLIDAYS).day).toBe('WEEKLY_OFF');
  });

  it('classifies a 6-day (site-style) week with only Sunday off', () => {
    expect(classifyDay(monSat, '2026-01-10', NO_HOLIDAYS).day).toBe('WORKING'); // Sat
    expect(classifyDay(monSat, '2026-01-11', NO_HOLIDAYS).day).toBe('WEEKLY_OFF'); // Sun
  });

  it('reports HOLIDAY even on a weekly off (matters for comp-off later)', () => {
    const holidays = new Set(['2026-01-26']); // Monday
    expect(classifyDay(monFri, '2026-01-26', holidays)).toEqual({
      day: 'HOLIDAY',
      reason: 'HOLIDAY',
    });
    const sunday = new Set(['2026-01-11']);
    expect(classifyDay(monFri, '2026-01-11', sunday).day).toBe('HOLIDAY');
  });
});

describe('classifyDay — monthly nth-weekday offs', () => {
  // 2026-01: Saturdays are 3, 10, 17, 24, 31 → 2nd=10, 4th=24.
  const secondFourth: ScheduleWeekSpec = {
    workingWeekdays: [1, 2, 3, 4, 5, 6],
    offNthWeekdays: [{ weekday: 6, nths: [2, 4] }],
  };

  it('marks only the configured nth Saturdays as off', () => {
    expect(classifyDay(secondFourth, '2026-01-03', NO_HOLIDAYS).day).toBe('WORKING'); // 1st Sat
    expect(classifyDay(secondFourth, '2026-01-10', NO_HOLIDAYS)).toEqual({
      day: 'WEEKLY_OFF',
      reason: 'NTH_WEEKDAY_OFF',
    });
    expect(classifyDay(secondFourth, '2026-01-17', NO_HOLIDAYS).day).toBe('WORKING'); // 3rd
    expect(classifyDay(secondFourth, '2026-01-24', NO_HOLIDAYS).day).toBe('WEEKLY_OFF'); // 4th
    expect(classifyDay(secondFourth, '2026-01-31', NO_HOLIDAYS).day).toBe('WORKING'); // 5th
  });

  it('supports -1 as the last occurrence of a weekday', () => {
    const lastSat: ScheduleWeekSpec = {
      workingWeekdays: [1, 2, 3, 4, 5, 6],
      offNthWeekdays: [{ weekday: 6, nths: [-1] }],
    };
    expect(classifyDay(lastSat, '2026-01-31', NO_HOLIDAYS).day).toBe('WEEKLY_OFF'); // last Sat
    expect(classifyDay(lastSat, '2026-01-24', NO_HOLIDAYS).day).toBe('WORKING');
    // February 2026: last Saturday is the 28th.
    expect(classifyDay(lastSat, '2026-02-28', NO_HOLIDAYS).day).toBe('WEEKLY_OFF');
  });

  it('handles multiple weekday entries independently', () => {
    const spec: ScheduleWeekSpec = {
      workingWeekdays: [1, 2, 3, 4, 5, 6, 0],
      offNthWeekdays: [
        { weekday: 6, nths: [2] },
        { weekday: 0, nths: [-1] },
      ],
    };
    expect(classifyDay(spec, '2026-01-10', NO_HOLIDAYS).day).toBe('WEEKLY_OFF'); // 2nd Sat
    expect(classifyDay(spec, '2026-01-25', NO_HOLIDAYS).day).toBe('WEEKLY_OFF'); // last Sun (25th)
    expect(classifyDay(spec, '2026-01-18', NO_HOLIDAYS).day).toBe('WORKING'); // 3rd Sun
  });
});

describe('classifyDay — anchored rotation cycles', () => {
  // 14-day cycle anchored on a Saturday; off offsets {0} => alternate Saturdays off.
  const altSat: ScheduleWeekSpec = {
    workingWeekdays: [1, 2, 3, 4, 5, 6],
    rotation: { anchor: '2026-01-10', lengthDays: 14, workingOffsets: [], offOffsets: [0] },
  };

  it('applies offOffsets every lengthDays from the anchor', () => {
    expect(classifyDay(altSat, '2026-01-10', NO_HOLIDAYS)).toEqual({
      day: 'WEEKLY_OFF',
      reason: 'ROTATION_OFF',
    });
    expect(classifyDay(altSat, '2026-01-17', NO_HOLIDAYS).day).toBe('WORKING'); // next Sat
    expect(classifyDay(altSat, '2026-01-24', NO_HOLIDAYS).day).toBe('WEEKLY_OFF'); // +14
    expect(classifyDay(altSat, '2025-12-27', NO_HOLIDAYS).day).toBe('WEEKLY_OFF'); // -14
  });

  it('supports pure-cycle mode (N-on/M-off roster) with no weekday set', () => {
    // 6 days on, 1 day off, anchored Monday 2026-01-05 (offset 6 is off).
    const roster: ScheduleWeekSpec = {
      workingWeekdays: [],
      rotation: {
        anchor: '2026-01-05',
        lengthDays: 7,
        workingOffsets: [0, 1, 2, 3, 4, 5],
        offOffsets: [6],
      },
    };
    expect(classifyDay(roster, '2026-01-05', NO_HOLIDAYS).day).toBe('WORKING'); // offset 0
    expect(classifyDay(roster, '2026-01-11', NO_HOLIDAYS)).toEqual({
      day: 'WEEKLY_OFF',
      reason: 'ROTATION_OFF',
    });
    expect(classifyDay(roster, '2026-01-12', NO_HOLIDAYS).day).toBe('WORKING'); // wraps
  });

  it('rotation workingOffsets can force-ON a weekday outside workingWeekdays', () => {
    // 14-day cycle anchored on a Sunday: alternate Sundays forced working.
    const spec: ScheduleWeekSpec = {
      workingWeekdays: [1, 2, 3, 4, 5],
      rotation: {
        anchor: '2026-01-11', // a Sunday
        lengthDays: 14,
        workingOffsets: [0],
        offOffsets: [],
      },
    };
    expect(classifyDay(spec, '2026-01-11', NO_HOLIDAYS).day).toBe('WORKING'); // forced-on Sun
    expect(classifyDay(spec, '2026-01-25', NO_HOLIDAYS).day).toBe('WORKING'); // +14 forced-on
    expect(classifyDay(spec, '2026-01-18', NO_HOLIDAYS).day).toBe('WEEKLY_OFF'); // skipped Sun
    expect(classifyDay(spec, '2026-01-04', NO_HOLIDAYS).day).toBe('WEEKLY_OFF'); // -7 skipped
  });

  it('offOffsets win over both weekday and workingOffset sources', () => {
    const spec: ScheduleWeekSpec = {
      workingWeekdays: [1, 2, 3, 4, 5],
      rotation: {
        anchor: '2026-01-05',
        lengthDays: 7,
        workingOffsets: [6],
        offOffsets: [0],
      },
    };
    // offset 0 (Mon) is off even though Monday is a working weekday
    // AND offset 6 (Sun) is forced working — off still wins where they conflict.
    expect(classifyDay(spec, '2026-01-05', NO_HOLIDAYS).day).toBe('WEEKLY_OFF');
  });
});

describe('classifyWithOverrides', () => {
  it('a WORKING override beats holiday, weekly off and rotation off', () => {
    const holidays = new Set(['2026-01-11']);
    expect(classifyWithOverrides(monFri, '2026-01-11', holidays, 'WORKING')).toEqual({
      day: 'WORKING',
      reason: 'OVERRIDE',
    });
  });

  it('an OFF override beats a working day', () => {
    expect(classifyWithOverrides(monSat, '2026-01-05', NO_HOLIDAYS, 'OFF')).toEqual({
      day: 'WEEKLY_OFF',
      reason: 'OVERRIDE',
    });
  });

  it('no override falls through to pattern classification', () => {
    expect(classifyWithOverrides(monSat, '2026-01-05', NO_HOLIDAYS, null)).toEqual({
      day: 'WORKING',
      reason: 'WORKING',
    });
  });
});
