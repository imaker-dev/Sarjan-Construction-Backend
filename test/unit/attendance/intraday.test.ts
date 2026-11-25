import { describe, expect, it } from 'vitest';
import {
  calcPolicyFromSnapshot,
  dynamicBreakCapMins,
  isEarlyOut,
  isLateIn,
  localDateStr,
  localMinutesOfDay,
  localMinutesToInstant,
  resolveShiftWindow,
  type PolicySnapshot,
} from '../../../src/modules/attendance/types.js';

const TZ = 'Asia/Kolkata'; // UTC+05:30, no DST

const baseSnapshot = (over: Partial<PolicySnapshot> = {}): PolicySnapshot => ({
  shiftDurationMins: 480,
  halfDayThresholdMins: 240,
  fullDayThresholdMins: 420,
  policyBreakMode: 'DYNAMIC',
  fixedBreakMins: 60,
  minWorkForBreakMins: 240,
  maxDynamicBreakMins: 120,
  overtimeMode: 'HOURLY',
  minOvertimeMins: 30,
  otSlabMins: 60,
  dayStartHour: 8,
  dayStartMinute: 0,
  timezone: TZ,
  intraday: null,
  scheduleRevisionId: null,
  ...over,
});

describe('localMinutesToInstant', () => {
  it('converts local minutes to the UTC instant in the revision timezone', () => {
    // 10:00 IST == 04:30 UTC
    expect(localMinutesToInstant('2026-03-02', 600, TZ).toISOString()).toBe(
      '2026-03-02T04:30:00.000Z',
    );
    // 19:00 IST == 13:30 UTC
    expect(localMinutesToInstant('2026-03-02', 1140, TZ).toISOString()).toBe(
      '2026-03-02T13:30:00.000Z',
    );
  });

  it('round-trips with localMinutesOfDay/localDateStr', () => {
    const instant = localMinutesToInstant('2026-03-02', 480, TZ);
    expect(localDateStr(instant, TZ)).toBe('2026-03-02');
    expect(localMinutesOfDay(instant, TZ)).toBe(480);
  });
});

describe('resolveShiftWindow', () => {
  it('binds an on-time punch to today (HO 10:00–19:00)', () => {
    const now = localMinutesToInstant('2026-03-02', 605, TZ);
    const w = resolveShiftWindow(now, 600, 1140, TZ);
    expect(w.scheduledStartAt.toISOString()).toBe('2026-03-02T04:30:00.000Z');
    expect(w.scheduledEndAt.toISOString()).toBe('2026-03-02T13:30:00.000Z');
  });

  it('binds an early-in punch (07:50 for an 08:00 start) to today', () => {
    const now = localMinutesToInstant('2026-03-02', 470, TZ);
    const w = resolveShiftWindow(now, 480, 1020, TZ); // site 08:00–17:00
    expect(localDateStr(w.scheduledStartAt, TZ)).toBe('2026-03-02');
    expect(localMinutesOfDay(w.scheduledStartAt, TZ)).toBe(480);
    expect(localMinutesOfDay(w.scheduledEndAt, TZ)).toBe(1020);
  });

  it('binds a 03:00 punch to yesterday for an overnight 22:00–06:00 shift', () => {
    const now = localMinutesToInstant('2026-03-02', 180, TZ);
    const w = resolveShiftWindow(now, 1320, 360, TZ);
    expect(localDateStr(w.scheduledStartAt, TZ)).toBe('2026-03-01');
    expect(localDateStr(w.scheduledEndAt, TZ)).toBe('2026-03-02');
    expect(localMinutesOfDay(w.scheduledEndAt, TZ)).toBe(360);
  });

  it('binds a 23:00 punch to today for an overnight 22:00–06:00 shift', () => {
    const now = localMinutesToInstant('2026-03-02', 1380, TZ);
    const w = resolveShiftWindow(now, 1320, 360, TZ);
    expect(localDateStr(w.scheduledStartAt, TZ)).toBe('2026-03-02');
    expect(localDateStr(w.scheduledEndAt, TZ)).toBe('2026-03-03');
  });
});

describe('isLateIn / isEarlyOut', () => {
  const start = localMinutesToInstant('2026-03-02', 600, TZ);
  const end = localMinutesToInstant('2026-03-02', 1140, TZ);

  it('flags late only beyond graceInMins', () => {
    const atGrace = new Date(start.getTime() + 10 * 60000);
    const pastGrace = new Date(start.getTime() + 11 * 60000);
    expect(isLateIn(atGrace, start, 10)).toBe(false);
    expect(isLateIn(pastGrace, start, 10)).toBe(true);
  });

  it('flags early out only beyond graceOutMins', () => {
    const atGrace = new Date(end.getTime() - 15 * 60000);
    const pastGrace = new Date(end.getTime() - 16 * 60000);
    expect(isEarlyOut(atGrace, end, 15)).toBe(false);
    expect(isEarlyOut(pastGrace, end, 15)).toBe(true);
  });
});

describe('calcPolicyFromSnapshot / dynamicBreakCapMins', () => {
  it('FIXED_WINDOW owns deduction: breakMode FIXED + schedule duration', () => {
    const snap = baseSnapshot({
      intraday: {
        scheduledStartMins: 480,
        scheduledEndMins: 1020,
        graceInMins: 10,
        graceOutMins: 10,
        breakWindowMode: 'FIXED_WINDOW',
        breakWindowStartMins: 780,
        breakWindowEndMins: 840,
        breakDurationMins: 60,
        autoClockOutMode: 'AT_SCHEDULED_END',
        autoClockOutGraceMins: null,
      },
    });
    const p = calcPolicyFromSnapshot(snap);
    expect(p.breakMode).toBe('FIXED');
    expect(p.fixedBreakMins).toBe(60);
    expect(p.shiftDurationMins).toBe(480);
  });

  it('DYNAMIC keeps punch breaks; schedule duration caps the day total', () => {
    const snap = baseSnapshot({
      intraday: {
        scheduledStartMins: 600,
        scheduledEndMins: 1140,
        graceInMins: 10,
        graceOutMins: 10,
        breakWindowMode: 'DYNAMIC',
        breakWindowStartMins: 720,
        breakWindowEndMins: 900,
        breakDurationMins: 60,
        autoClockOutMode: 'AT_SCHEDULED_END',
        autoClockOutGraceMins: null,
      },
    });
    const p = calcPolicyFromSnapshot(snap);
    expect(p.breakMode).toBe('DYNAMIC');
    expect(dynamicBreakCapMins(snap)).toBe(60); // schedule cap wins over the 120 policy cap
  });

  it('no intraday → pinned policy fields govern unchanged', () => {
    const snap = baseSnapshot();
    const p = calcPolicyFromSnapshot(snap);
    expect(p.breakMode).toBe('DYNAMIC');
    expect(p.fixedBreakMins).toBe(60);
    expect(dynamicBreakCapMins(snap)).toBe(120); // falls back to the policy cap
  });
});
