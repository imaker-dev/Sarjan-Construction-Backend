import { describe, expect, it } from 'vitest';
import {
  calculateHaversineDistanceMeters,
  calculateWorkAndOvertime,
  getBusinessDate,
  type AttendancePolicyLike,
} from '../../../src/modules/attendance/types.js';

describe('Attendance Types & Domain Helpers', () => {
  describe('getBusinessDate (8:00 AM to 8:00 AM Construction Cycle)', () => {
    it('returns the same calendar date for punches after 08:00 AM local time', () => {
      // 08:05 AM in Asia/Kolkata (+05:30) is 02:35 UTC
      const punchMorning = new Date('2026-11-17T02:35:00.000Z');
      expect(getBusinessDate(punchMorning, 'Asia/Kolkata')).toBe('2026-11-17');

      // 11:30 PM in Asia/Kolkata is 18:00 UTC
      const punchNight = new Date('2026-11-17T18:00:00.000Z');
      expect(getBusinessDate(punchNight, 'Asia/Kolkata')).toBe('2026-11-17');
    });

    it('returns the previous calendar date for early morning punches before 08:00 AM', () => {
      // 04:30 AM on Nov 18 in Asia/Kolkata is 23:00 UTC on Nov 17
      const punchNightShift = new Date('2026-11-17T23:00:00.000Z');
      expect(getBusinessDate(punchNightShift, 'Asia/Kolkata')).toBe('2026-11-17');

      // 07:59 AM on Nov 18 in Asia/Kolkata is 02:29 UTC on Nov 18
      const punchJustBeforeRollover = new Date('2026-11-18T02:29:00.000Z');
      expect(getBusinessDate(punchJustBeforeRollover, 'Asia/Kolkata')).toBe('2026-11-17');
    });

    it('rolls over to new date at exactly 08:00 AM local time', () => {
      // 08:00 AM on Nov 18 in Asia/Kolkata is 02:30 UTC on Nov 18
      const punchAtRollover = new Date('2026-11-18T02:30:00.000Z');
      expect(getBusinessDate(punchAtRollover, 'Asia/Kolkata')).toBe('2026-11-18');
    });

    it('handles month-end and year-end rollback across midnight', () => {
      // 03:00 AM on Jan 1st 2026 in Asia/Kolkata -> belongs to 2025-12-31 business day
      const punchNewYear = new Date('2025-12-31T21:30:00.000Z');
      expect(getBusinessDate(punchNewYear, 'Asia/Kolkata')).toBe('2025-12-31');
    });
  });

  describe('calculateHaversineDistanceMeters', () => {
    it('returns 0 for identical coordinates', () => {
      const d = calculateHaversineDistanceMeters(23.23, 72.57, 23.23, 72.57);
      expect(d).toBe(0);
    });

    it('computes accurate distance for site geofence', () => {
      // ~111m apart along latitude (0.001 deg lat ~ 111m)
      const d = calculateHaversineDistanceMeters(23.23, 72.57, 23.231, 72.57);
      expect(d).toBeGreaterThanOrEqual(110);
      expect(d).toBeLessThanOrEqual(112);
    });
  });

  describe('calculateWorkAndOvertime', () => {
    const basePolicy: AttendancePolicyLike = {
      shiftDurationMins: 480, // 8 hours
      halfDayThresholdMins: 240, // 4 hours
      fullDayThresholdMins: 480, // 8 hours
      breakMode: 'FIXED',
      fixedBreakMins: 60,
      minWorkForBreakMins: 240,
      overtimeMode: 'HOURLY',
      minOvertimeMins: 30,
      otSlabMins: 30,
    };

    it('evaluates to 0.0P if net duration is less than half-day threshold', () => {
      const res = calculateWorkAndOvertime({
        grossMinutes: 180, // 3 hours (less than 4h)
        policy: basePolicy,
      });
      expect(res.presentUnits).toBe(0.0);
      expect(res.overtimeHours).toBe(0.0);
      expect(res.totalPUnits).toBe(0.0);
    });

    it('evaluates to 0.5P for half-day shifts', () => {
      const res = calculateWorkAndOvertime({
        grossMinutes: 300, // 5 hours gross - 60 min break = 4 hours net (240 mins)
        policy: basePolicy,
      });
      expect(res.netDurationMins).toBe(240);
      expect(res.presentUnits).toBe(0.5);
      expect(res.overtimeHours).toBe(0.0);
      expect(res.totalPUnits).toBe(0.5);
    });

    it('evaluates to 1.0P for standard 8-hour shift', () => {
      const res = calculateWorkAndOvertime({
        grossMinutes: 540, // 9 hours gross - 60 min break = 8 hours net (480 mins)
        policy: basePolicy,
      });
      expect(res.netDurationMins).toBe(480);
      expect(res.presentUnits).toBe(1.0);
      expect(res.overtimeHours).toBe(0.0);
      expect(res.totalPUnits).toBe(1.0);
    });

    it('calculates regular hourly OT in 30-minute slabs', () => {
      // 540m + 25m extra = 565m gross (8h 25m net -> 25m extra < 30m min)
      const res1 = calculateWorkAndOvertime({
        grossMinutes: 565,
        policy: basePolicy,
      });
      expect(res1.presentUnits).toBe(1.0);
      expect(res1.overtimeHours).toBe(0.0);

      // 540m + 45m extra = 585m gross (8h 45m net -> 45m extra = 1 slab of 30m = 0.5h OT)
      const res2 = calculateWorkAndOvertime({
        grossMinutes: 585,
        policy: basePolicy,
      });
      expect(res2.presentUnits).toBe(1.0);
      expect(res2.overtimeHours).toBe(0.5);
      expect(res2.totalPUnits).toBe(1.0);

      // 540m + 95m extra = 635m gross (8h 95m net -> 3 slabs of 30m = 1.5h OT)
      const res3 = calculateWorkAndOvertime({
        grossMinutes: 635,
        policy: basePolicy,
      });
      expect(res3.presentUnits).toBe(1.0);
      expect(res3.overtimeHours).toBe(1.5);
      expect(res3.totalPUnits).toBe(1.0);
    });

    it('calculates dynamic P multiplier Hazri OT (+2h -> +0.5P, +4h -> +1.0P, +8h -> +2.0P)', () => {
      const pPolicy: AttendancePolicyLike = {
        ...basePolicy,
        overtimeMode: 'P_MULTIPLIER',
        pMultiplierSlabs: [
          { minExtraMins: 120, pUnit: 0.5 },
          { minExtraMins: 240, pUnit: 1.0 },
          { minExtraMins: 480, pUnit: 2.0 },
        ],
      };

      // Case A: 8h baseline + 1h extra (60m < 120m) -> 1.0P, 0 OT
      const res1 = calculateWorkAndOvertime({
        grossMinutes: 540 + 60, // 8h + 1h
        policy: pPolicy,
      });
      expect(res1.presentUnits).toBe(1.0);
      expect(res1.overtimePUnits).toBe(0.0);
      expect(res1.totalPUnits).toBe(1.0);
      expect(res1.overtimeHours).toBe(0.0);

      // Case B: 8h baseline + 2h extra (120m) -> +0.5P (Total 1.5P)
      const res2 = calculateWorkAndOvertime({
        grossMinutes: 540 + 120, // 8h + 2h
        policy: pPolicy,
      });
      expect(res2.presentUnits).toBe(1.0);
      expect(res2.overtimePUnits).toBe(0.5);
      expect(res2.totalPUnits).toBe(1.5);
      expect(res2.overtimeHours).toBe(0.0);

      // Case C: 8h baseline + 3.5h extra (210m) -> +0.5P (Total 1.5P)
      const res3 = calculateWorkAndOvertime({
        grossMinutes: 540 + 210, // 8h + 3.5h
        policy: pPolicy,
      });
      expect(res3.presentUnits).toBe(1.0);
      expect(res3.overtimePUnits).toBe(0.5);
      expect(res3.totalPUnits).toBe(1.5);

      // Case D: 8h baseline + 4h extra (240m) -> +1.0P (Total 2.0P)
      const res4 = calculateWorkAndOvertime({
        grossMinutes: 540 + 240, // 8h + 4h
        policy: pPolicy,
      });
      expect(res4.presentUnits).toBe(1.0);
      expect(res4.overtimePUnits).toBe(1.0);
      expect(res4.totalPUnits).toBe(2.0);

      // Case E: 8h baseline + 8h extra (480m) -> +2.0P (Total 3.0P)
      const res5 = calculateWorkAndOvertime({
        grossMinutes: 540 + 480, // 8h + 8h
        policy: pPolicy,
      });
      expect(res5.presentUnits).toBe(1.0);
      expect(res5.overtimePUnits).toBe(2.0);
      expect(res5.totalPUnits).toBe(3.0);
      expect(res5.overtimeHours).toBe(0.0);

      // Case F: 8h baseline + 9h extra (540m = 8h extra + 1h extra)
      // Meets highest tier (+2.0P = total 3.0P) AND 1 hour extra regular OT!
      const res6 = calculateWorkAndOvertime({
        grossMinutes: 540 + 540, // 8h + 9h
        policy: pPolicy,
      });
      expect(res6.presentUnits).toBe(1.0);
      expect(res6.overtimePUnits).toBe(2.0);
      expect(res6.totalPUnits).toBe(3.0);
      expect(res6.overtimeHours).toBe(1.0); // 60 mins overflow / 30 mins = 1.0h
    });

    it('supports dynamic break deduction when BreakMode is DYNAMIC', () => {
      const dynamicPolicy: AttendancePolicyLike = {
        ...basePolicy,
        breakMode: 'DYNAMIC',
      };

      const res = calculateWorkAndOvertime({
        grossMinutes: 540,
        breakMinutes: 45, // dynamic breaks totaled 45m
        policy: dynamicPolicy,
      });

      expect(res.breakDurationMins).toBe(45);
      expect(res.netDurationMins).toBe(495); // 540 - 45 = 495m
      expect(res.presentUnits).toBe(1.0);
    });
  });
});
