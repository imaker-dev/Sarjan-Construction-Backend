import { describe, expect, it } from 'vitest';
import {
  buildDailyActivitySummary,
  calculateActiveSessionTiming,
  calculateHaversineDistanceMeters,
  calculateWeeklyWorkHoursProgress,
  calculateWorkAndOvertime,
  getBusinessDate,
  getScheduledShiftStart,
  resolveDateRangeForPeriod,
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

  describe('getScheduledShiftStart', () => {
    it('returns exact UTC Date for 08:00 AM local time in Asia/Kolkata (+05:30)', () => {
      // 08:00 AM in Asia/Kolkata is 02:30 UTC
      const start = getScheduledShiftStart('2026-11-21', 8, 0, 'Asia/Kolkata');
      expect(start.toISOString()).toBe('2026-11-21T02:30:00.000Z');
    });

    it('supports custom shift start hours and minutes', () => {
      // 09:30 AM in Asia/Kolkata is 04:00 UTC
      const start = getScheduledShiftStart('2026-11-21', 9, 30, 'Asia/Kolkata');
      expect(start.toISOString()).toBe('2026-11-21T04:00:00.000Z');
    });
  });

  describe('calculateActiveSessionTiming', () => {
    it('detects delayed clock-in and calculates delayed minutes and formatted time', () => {
      // Scheduled start: 08:00 AM Kolkata (02:30 UTC)
      // Actual punch in: 08:25 AM Kolkata (02:55 UTC) -> 25 mins late
      const punchInAt = new Date('2026-11-21T02:55:00.000Z');
      const timing = calculateActiveSessionTiming({
        punchInAt,
        businessDate: '2026-11-21',
        timezone: 'Asia/Kolkata',
        policy: {
          dayStartHour: 8,
          dayStartMinute: 0,
          shiftDurationMins: 480,
          breakMode: 'FIXED',
          fixedBreakMins: 60,
        },
      });

      expect(timing.isDelayedClockIn).toBe(true);
      expect(timing.delayedClockInMinutes).toBe(25);
      expect(timing.delayedClockInTime).toBe('00:25');
      expect(timing.delayedClockInFormatted).toBe('25 mins');

      // Clock out time for proper 8 working hours = punchInAt + 8 hours (02:55 UTC + 8h = 10:55 UTC)
      expect(timing.clockOutTimeProper8Hours).toBe('2026-11-21T10:55:00.000Z');
      // Expected clock out including 60m fixed break = punchInAt + 9 hours = 11:55 UTC
      expect(timing.expectedClockOutAt).toBe('2026-11-21T11:55:00.000Z');
      expect(timing.targetWorkDurationMins).toBe(480);
    });

    it('flags punctual or early clock-in as not delayed', () => {
      // Scheduled start: 08:00 AM Kolkata (02:30 UTC)
      // Actual punch in: 07:50 AM Kolkata (02:20 UTC) -> 10 mins early
      const punchInAt = new Date('2026-11-21T02:20:00.000Z');
      const timing = calculateActiveSessionTiming({
        punchInAt,
        businessDate: '2026-11-21',
        timezone: 'Asia/Kolkata',
      });

      expect(timing.isDelayedClockIn).toBe(false);
      expect(timing.delayedClockInMinutes).toBe(0);
      expect(timing.delayedClockInTime).toBeNull();
      expect(timing.delayedClockInFormatted).toBeNull();
      // Proper 8 working hours = 02:20 UTC + 8h = 10:20 UTC
      expect(timing.clockOutTimeProper8Hours).toBe('2026-11-21T10:20:00.000Z');
    });

    it('calculates proper 8 working hours with dynamic breaks', () => {
      const punchInAt = new Date('2026-11-21T03:00:00.000Z');
      const timing = calculateActiveSessionTiming({
        punchInAt,
        businessDate: '2026-11-21',
        timezone: 'Asia/Kolkata',
        policy: {
          dayStartHour: 8,
          dayStartMinute: 0,
          shiftDurationMins: 480,
          breakMode: 'DYNAMIC',
        },
        breaks: [
          { startedAt: new Date('2026-11-21T06:00:00.000Z'), durationMins: 30 },
        ],
      });

      // Proper 8 hours = 03:00 UTC + 8h = 11:00 UTC
      expect(timing.clockOutTimeProper8Hours).toBe('2026-11-21T11:00:00.000Z');
      // Expected clock out including 30m dynamic break = 03:00 UTC + 8.5h = 11:30 UTC
      expect(timing.expectedClockOutAt).toBe('2026-11-21T11:30:00.000Z');
    });
  });

  describe('buildDailyActivitySummary', () => {
    it('aggregates multiple check-ins and check-outs across sessions in a single day', () => {
      const morningSession = {
        id: 'sess-1',
        companyId: 'comp-1',
        employeeId: 'emp-1',
        businessDate: '2026-11-21',
        source: 'MOBILE',
        status: 'COMPLETED',
        punchInAt: new Date('2026-11-21T03:00:00.000Z'), // 08:30 IST
        punchOutAt: new Date('2026-11-21T07:30:00.000Z'), // 13:00 IST
        grossDurationMins: 270,
        breakDurationMins: 30,
        netDurationMins: 240,
        punchInWithinGeofence: true,
        punchInRemarks: 'Morning start',
        breaks: [
          {
            id: 'brk-1',
            sessionId: 'sess-1',
            companyId: 'comp-1',
            startedAt: new Date('2026-11-21T05:00:00.000Z'),
            endedAt: new Date('2026-11-21T05:30:00.000Z'),
            durationMins: 30,
            remarks: 'Tea break',
            createdAt: new Date(),
            updatedAt: new Date(),
            breakType: 'TEA',
            isApproved: true,
          },
        ],
      };

      const afternoonSession = {
        id: 'sess-2',
        companyId: 'comp-1',
        employeeId: 'emp-1',
        businessDate: '2026-11-21',
        source: 'KIOSK',
        status: 'IN_PROGRESS',
        punchInAt: new Date('2026-11-21T08:30:00.000Z'), // 14:00 IST
        punchOutAt: null,
        grossDurationMins: 0,
        breakDurationMins: 0,
        netDurationMins: 0,
        punchInWithinGeofence: true,
        punchInRemarks: 'Post lunch return',
        breaks: [],
      };

      const summary = buildDailyActivitySummary('2026-11-21', [
        morningSession as never,
        afternoonSession as never,
      ]);

      expect(summary.businessDate).toBe('2026-11-21');
      expect(summary.totalCheckInsToday).toBe(2);
      expect(summary.totalCheckOutsToday).toBe(1);
      expect(summary.currentlyCheckedIn).toBe(true);
      expect(summary.totalWorkMinutesToday).toBe(240);
      expect(summary.totalBreakMinutesToday).toBe(30);

      // Verify chronological events:
      // 1. Check in 03:00
      // 2. Break start 05:00
      // 3. Break end 05:30
      // 4. Check out 07:30
      // 5. Check in 08:30
      expect(summary.activityLog).toHaveLength(5);
      expect(summary.activityLog[0]?.type).toBe('CHECK_IN');
      expect(summary.activityLog[0]?.sessionId).toBe('sess-1');
      expect(summary.activityLog[1]?.type).toBe('BREAK_START');
      expect(summary.activityLog[1]?.remarks).toBe('Tea break');
      expect(summary.activityLog[2]?.type).toBe('BREAK_END');
      expect(summary.activityLog[2]?.durationMins).toBe(30);
      expect(summary.activityLog[3]?.type).toBe('CHECK_OUT');
      expect(summary.activityLog[3]?.sessionId).toBe('sess-1');
      expect(summary.activityLog[4]?.type).toBe('CHECK_IN');
      expect(summary.activityLog[4]?.sessionId).toBe('sess-2');
    });

    it('handles empty sessions gracefully', () => {
      const summary = buildDailyActivitySummary('2026-11-21', []);
      expect(summary.totalCheckInsToday).toBe(0);
      expect(summary.totalCheckOutsToday).toBe(0);
      expect(summary.currentlyCheckedIn).toBe(false);
      expect(summary.activityLog).toHaveLength(0);
    });
  });

  describe('resolveDateRangeForPeriod', () => {
    it('resolves DAILY period to the exact single date', () => {
      const res = resolveDateRangeForPeriod('DAILY', '2026-11-25');
      expect(res.from).toBe('2026-11-25');
      expect(res.to).toBe('2026-11-25');
    });

    it('resolves WEEKLY period to Monday through Saturday boundaries', () => {
      // 2026-11-25 is a Wednesday
      const res = resolveDateRangeForPeriod('WEEKLY', '2026-11-25');
      expect(res.from).toBe('2026-11-23'); // Monday
      expect(res.to).toBe('2026-11-28'); // Saturday
    });

    it('resolves MONTHLY period to the 1st through the last day of the calendar month', () => {
      // November 2026 has 30 days
      const res = resolveDateRangeForPeriod('MONTHLY', '2026-11-15');
      expect(res.from).toBe('2026-11-01');
      expect(res.to).toBe('2026-11-30');
    });

    it('preserves custom from and to when period is CUSTOM or omitted', () => {
      const res = resolveDateRangeForPeriod('CUSTOM', undefined, '2026-11-05', '2026-11-20');
      expect(res.from).toBe('2026-11-05');
      expect(res.to).toBe('2026-11-20');
    });
  });

  describe('calculateWeeklyWorkHoursProgress (48-Hour Head Office Bar)', () => {
    it('calculates on-track progress for mid-week work', () => {
      // Wednesday: 24 hours completed (8h Mon, 8h Tue, 8h Wed)
      const weeklySessions = [
        { netDurationMins: 480, businessDate: '2026-11-23' },
        { netDurationMins: 480, businessDate: '2026-11-24' },
        { netDurationMins: 480, businessDate: '2026-11-25' },
      ];

      const res = calculateWeeklyWorkHoursProgress({
        businessDate: '2026-11-25', // Wednesday
        weeklySessions,
        targetWeeklyHours: 48.0,
      });

      expect(res.weekStartDate).toBe('2026-11-23');
      expect(res.weekEndDate).toBe('2026-11-28');
      expect(res.targetWeeklyHours).toBe(48.0);
      expect(res.completedWeeklyHours).toBe(24.0);
      expect(res.remainingWeeklyHours).toBe(24.0);
      expect(res.progressPercentage).toBe(50.0);
      expect(res.isTargetCompleted).toBe(false);
      expect(res.isLastWorkingDay).toBe(false);
      expect(res.status).toBe('ON_TRACK');
    });

    it('enforces that on the last working day (Saturday), all remaining hours must be completed', () => {
      // Saturday (last working day): 40 hours worked so far (Mon-Fri)
      const weeklySessions = [
        { netDurationMins: 480, businessDate: '2026-11-23' },
        { netDurationMins: 480, businessDate: '2026-11-24' },
        { netDurationMins: 480, businessDate: '2026-11-25' },
        { netDurationMins: 480, businessDate: '2026-11-26' },
        { netDurationMins: 480, businessDate: '2026-11-27' },
      ];

      const res = calculateWeeklyWorkHoursProgress({
        businessDate: '2026-11-28', // Saturday (last day)
        weeklySessions,
        targetWeeklyHours: 48.0,
      });

      expect(res.isLastWorkingDay).toBe(true);
      expect(res.completedWeeklyHours).toBe(40.0);
      expect(res.remainingWeeklyHours).toBe(8.0);
      expect(res.requiredHoursToCompleteTarget).toBe(8.0); // Exact 8h deficit on the last day!
      expect(res.progressPercentage).toBe(83.3);
      expect(res.isTargetCompleted).toBe(false);
      expect(res.status).toBe('DEFICIT_PENDING');
    });

    it('marks target completed when 48 hours is achieved', () => {
      const weeklySessions = [
        { netDurationMins: 600, businessDate: '2026-11-23' }, // 10h
        { netDurationMins: 600, businessDate: '2026-11-24' }, // 10h
        { netDurationMins: 600, businessDate: '2026-11-25' }, // 10h
        { netDurationMins: 600, businessDate: '2026-11-26' }, // 10h
        { netDurationMins: 600, businessDate: '2026-11-27' }, // 10h (total 50h)
      ];

      const res = calculateWeeklyWorkHoursProgress({
        businessDate: '2026-11-27',
        weeklySessions,
        targetWeeklyHours: 48.0,
      });

      expect(res.completedWeeklyHours).toBe(50.0);
      expect(res.remainingWeeklyHours).toBe(0);
      expect(res.progressPercentage).toBe(100.0);
      expect(res.isTargetCompleted).toBe(true);
      expect(res.requiredHoursToCompleteTarget).toBe(0);
      expect(res.status).toBe('COMPLETED');
    });
  });
});
