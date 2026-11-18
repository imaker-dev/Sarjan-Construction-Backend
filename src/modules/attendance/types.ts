import { Type, type Static } from '@sinclair/typebox';
import type { BreakMode, OvertimeMode } from '@prisma/client';

// ---------------------------------------------------------------------------
// Pure Domain Helper Functions
// ---------------------------------------------------------------------------

/**
 * Calculates the construction business date ('YYYY-MM-DD') for a given UTC timestamp,
 * anchoring the 24-hour cycle to local site time (default 8:00 AM to 8:00 AM next day).
 */
export function getBusinessDate(
  date: Date,
  timezone = 'Asia/Kolkata',
  dayStartHour = 8,
  dayStartMinute = 0,
): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  const parts = formatter.formatToParts(date);
  const getPart = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';

  let year = parseInt(getPart('year'), 10);
  let month = parseInt(getPart('month'), 10);
  let day = parseInt(getPart('day'), 10);
  let hour = parseInt(getPart('hour'), 10);
  const minute = parseInt(getPart('minute'), 10);

  // Normalize 24:00 (some formatters output 24 for midnight)
  if (hour === 24) hour = 0;

  // If local time is before the cycle start (e.g. 04:30 AM before 08:00 AM),
  // it belongs to the previous calendar day's business day.
  const isBeforeStart = hour < dayStartHour || (hour === dayStartHour && minute < dayStartMinute);
  if (isBeforeStart) {
    const prev = new Date(Date.UTC(year, month - 1, day - 1));
    year = prev.getUTCFullYear();
    month = prev.getUTCMonth() + 1;
    day = prev.getUTCDate();
  }

  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${year}-${mm}-${dd}`;
}

/**
 * Calculates the surface distance in metres between two coordinates using the Haversine formula.
 */
export function calculateHaversineDistanceMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const R = 6371e3; // Earth radius in metres
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const deltaPhi = toRad(lat2 - lat1);
  const deltaLambda = toRad(lon2 - lon1);

  const a =
    Math.sin(deltaPhi / 2) * Math.sin(deltaPhi / 2) +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(deltaLambda / 2) * Math.sin(deltaLambda / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return Math.round(R * c);
}

export interface PMultiplierSlab {
  minExtraMins: number;
  pUnit: number;
}

export interface AttendancePolicyLike {
  shiftDurationMins: number;
  halfDayThresholdMins: number;
  fullDayThresholdMins: number;
  breakMode: BreakMode;
  fixedBreakMins: number;
  minWorkForBreakMins: number;
  overtimeMode: OvertimeMode;
  minOvertimeMins: number;
  otSlabMins: number;
  pMultiplierSlabs?: unknown;
}

export interface WorkAndOvertimeResult {
  netDurationMins: number;
  breakDurationMins: number;
  presentUnits: number;
  overtimePUnits: number;
  totalPUnits: number;
  overtimeHours: number;
}

/**
 * Pure calculation of work units (Present P), Hazri multiplier, and Overtime hours.
 */
export function calculateWorkAndOvertime(params: {
  grossMinutes: number;
  breakMinutes?: number;
  policy: AttendancePolicyLike;
}): WorkAndOvertimeResult {
  const { grossMinutes, policy } = params;
  let breakMinutes = params.breakMinutes ?? 0;

  // Auto fixed-break deduction if applicable
  if (policy.breakMode === 'FIXED') {
    if (grossMinutes >= policy.minWorkForBreakMins) {
      breakMinutes = policy.fixedBreakMins;
    } else {
      breakMinutes = 0;
    }
  }

  const netDurationMins = Math.max(0, grossMinutes - breakMinutes);

  let presentUnits = 0.0;
  let overtimePUnits = 0.0;
  let overtimeHours = 0.0;

  if (netDurationMins < policy.halfDayThresholdMins) {
    // Under minimum threshold -> 0 Hazri
    presentUnits = 0.0;
  } else if (netDurationMins < policy.fullDayThresholdMins) {
    // Meets half-day threshold -> 0.5 Hazri
    presentUnits = 0.5;
  } else {
    // Meets full-day threshold -> 1.0 Hazri baseline
    presentUnits = 1.0;
    const extraMinutes = Math.max(0, netDurationMins - policy.shiftDurationMins);

    if (policy.overtimeMode === 'HOURLY') {
      if (extraMinutes >= policy.minOvertimeMins) {
        const slabMins = policy.otSlabMins > 0 ? policy.otSlabMins : 30;
        const slabs = Math.floor(extraMinutes / slabMins);
        overtimeHours = (slabs * slabMins) / 60;
      }
    } else {
      // Dynamic P Multiplier slabs
      const defaultSlabs: PMultiplierSlab[] = [
        { minExtraMins: 120, pUnit: 0.5 },
        { minExtraMins: 240, pUnit: 1.0 },
        { minExtraMins: 480, pUnit: 2.0 },
      ];

      let rawSlabs = defaultSlabs;
      if (Array.isArray(policy.pMultiplierSlabs) && policy.pMultiplierSlabs.length > 0) {
        rawSlabs = policy.pMultiplierSlabs as PMultiplierSlab[];
      }

      // Sort slabs descending by minExtraMins
      const sortedSlabs = [...rawSlabs].sort((a, b) => b.minExtraMins - a.minExtraMins);
      const maxSlab = sortedSlabs[0];

      // Find the highest slab met
      const matchedSlab = sortedSlabs.find((s) => extraMinutes >= s.minExtraMins);

      if (matchedSlab) {
        overtimePUnits = matchedSlab.pUnit;

        // If extra extends beyond the maximum slab (e.g. > 8 hours extra),
        // calculate any additional leftover time as regular hourly OT!
        if (maxSlab && extraMinutes > maxSlab.minExtraMins) {
          const overflowMins = extraMinutes - maxSlab.minExtraMins;
          const slabMins = policy.otSlabMins > 0 ? policy.otSlabMins : 30;
          if (overflowMins >= policy.minOvertimeMins) {
            const slabs = Math.floor(overflowMins / slabMins);
            overtimeHours = (slabs * slabMins) / 60;
          }
        }
      }
    }
  }

  const totalPUnits = Number((presentUnits + overtimePUnits).toFixed(1));

  return {
    netDurationMins,
    breakDurationMins: breakMinutes,
    presentUnits,
    overtimePUnits,
    totalPUnits,
    overtimeHours: Number(overtimeHours.toFixed(2)),
  };
}

// ---------------------------------------------------------------------------
// TypeBox Schemas for Request & Response
// ---------------------------------------------------------------------------

export const PolicyScopeSchema = Type.Union([
  Type.Literal('COMPANY'),
  Type.Literal('PROJECT'),
  Type.Literal('SITE'),
  Type.Literal('EMPLOYEE'),
]);

export const BreakModeSchema = Type.Union([Type.Literal('FIXED'), Type.Literal('DYNAMIC')]);
export const OvertimeModeSchema = Type.Union([
  Type.Literal('HOURLY'),
  Type.Literal('P_MULTIPLIER'),
]);
export const AttendanceSourceSchema = Type.Union([
  Type.Literal('MOBILE_SELF'),
  Type.Literal('SUPERVISOR_KIOSK'),
  Type.Literal('BIOMETRIC_DEVICE'),
  Type.Literal('MANUAL_CORRECTION'),
]);

export const CreatePolicyBody = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 100 }),
  description: Type.Optional(Type.String({ maxLength: 500 })),
  scope: Type.Optional(PolicyScopeSchema),
  projectId: Type.Optional(Type.String({ format: 'uuid' })),
  siteId: Type.Optional(Type.String({ format: 'uuid' })),
  employeeId: Type.Optional(Type.String({ format: 'uuid' })),
  dayStartHour: Type.Optional(Type.Integer({ minimum: 0, maximum: 23 })),
  dayStartMinute: Type.Optional(Type.Integer({ minimum: 0, maximum: 59 })),
  shiftDurationMins: Type.Optional(Type.Integer({ minimum: 60, maximum: 1440 })),
  halfDayThresholdMins: Type.Optional(Type.Integer({ minimum: 60, maximum: 1440 })),
  fullDayThresholdMins: Type.Optional(Type.Integer({ minimum: 60, maximum: 1440 })),
  breakMode: Type.Optional(BreakModeSchema),
  fixedBreakMins: Type.Optional(Type.Integer({ minimum: 0, maximum: 240 })),
  minWorkForBreakMins: Type.Optional(Type.Integer({ minimum: 60, maximum: 720 })),
  maxDynamicBreakMins: Type.Optional(Type.Integer({ minimum: 0, maximum: 300 })),
  overtimeMode: Type.Optional(OvertimeModeSchema),
  minOvertimeMins: Type.Optional(Type.Integer({ minimum: 0, maximum: 120 })),
  otSlabMins: Type.Optional(Type.Integer({ minimum: 15, maximum: 120 })),
  pMultiplierSlabs: Type.Optional(
    Type.Array(
      Type.Object({
        minExtraMins: Type.Integer({ minimum: 15 }),
        pUnit: Type.Number({ minimum: 0.1, maximum: 10.0 }),
      }),
    ),
  ),
  geofenceStrict: Type.Optional(Type.Boolean()),
  allowMobilePunch: Type.Optional(Type.Boolean()),
  allowKioskPunch: Type.Optional(Type.Boolean()),
  allowBiometric: Type.Optional(Type.Boolean()),
  requireTvtGate: Type.Optional(Type.Boolean()),
  tvtGateAction: Type.Optional(Type.Union([Type.Literal('BLOCK'), Type.Literal('FLAG')])),
});

export const UpdatePolicyBody = Type.Partial(CreatePolicyBody);

export const PunchInBody = Type.Object({
  employeeId: Type.Optional(Type.String({ format: 'uuid' })), // Optional for self-punch
  siteId: Type.String({ format: 'uuid' }),
  latitude: Type.Number({ minimum: -90, maximum: 90 }),
  longitude: Type.Number({ minimum: -180, maximum: 180 }),
  source: Type.Optional(AttendanceSourceSchema),
  remarks: Type.Optional(Type.String({ maxLength: 500 })),
});

export const PunchOutBody = Type.Object({
  employeeId: Type.Optional(Type.String({ format: 'uuid' })), // Optional for self-punch
  siteId: Type.Optional(Type.String({ format: 'uuid' })),
  sessionId: Type.Optional(Type.String({ format: 'uuid' })),
  latitude: Type.Number({ minimum: -90, maximum: 90 }),
  longitude: Type.Number({ minimum: -180, maximum: 180 }),
  source: Type.Optional(AttendanceSourceSchema),
  remarks: Type.Optional(Type.String({ maxLength: 500 })),
});

export const StartBreakBody = Type.Object({
  sessionId: Type.Optional(Type.String({ format: 'uuid' })),
  employeeId: Type.Optional(Type.String({ format: 'uuid' })),
  breakType: Type.Optional(Type.String({ maxLength: 50 })),
  remarks: Type.Optional(Type.String({ maxLength: 200 })),
});

export const EndBreakBody = Type.Object({
  breakId: Type.Optional(Type.String({ format: 'uuid' })),
  sessionId: Type.Optional(Type.String({ format: 'uuid' })),
  employeeId: Type.Optional(Type.String({ format: 'uuid' })),
  remarks: Type.Optional(Type.String({ maxLength: 200 })),
});

export const RegularizeSessionBody = Type.Object({
  punchInAt: Type.Optional(Type.String({ format: 'date-time' })),
  punchOutAt: Type.Optional(Type.String({ format: 'date-time' })),
  presentUnits: Type.Optional(Type.Number({ minimum: 0, maximum: 5 })),
  overtimePUnits: Type.Optional(Type.Number({ minimum: 0, maximum: 5 })),
  overtimeHours: Type.Optional(Type.Number({ minimum: 0, maximum: 24 })),
  remarks: Type.String({ minLength: 3, maxLength: 500 }),
});

export const ListSessionsQuery = Type.Object({
  siteId: Type.Optional(Type.String({ format: 'uuid' })),
  employeeId: Type.Optional(Type.String({ format: 'uuid' })),
  businessDate: Type.Optional(Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' })),
  status: Type.Optional(
    Type.Union([
      Type.Literal('IN_PROGRESS'),
      Type.Literal('COMPLETED'),
      Type.Literal('AUTO_CLOSED'),
      Type.Literal('REJECTED'),
    ]),
  ),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 50 })),
  cursor: Type.Optional(Type.String()),
});

export const DailySummaryQuery = Type.Object({
  siteId: Type.String({ format: 'uuid' }),
  businessDate: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
});

export const KioskBatchPunchInBody = Type.Object({
  siteId: Type.String({ format: 'uuid' }),
  employeeIds: Type.Array(Type.String({ format: 'uuid' }), { minItems: 1, maxItems: 200 }),
  latitude: Type.Number({ minimum: -90, maximum: 90 }),
  longitude: Type.Number({ minimum: -180, maximum: 180 }),
  punchInAt: Type.Optional(Type.String({ format: 'date-time' })),
  remarks: Type.Optional(Type.String({ maxLength: 500 })),
});

export const KioskBatchPunchOutBody = Type.Object({
  siteId: Type.String({ format: 'uuid' }),
  employeeIds: Type.Array(Type.String({ format: 'uuid' }), { minItems: 1, maxItems: 200 }),
  latitude: Type.Number({ minimum: -90, maximum: 90 }),
  longitude: Type.Number({ minimum: -180, maximum: 180 }),
  punchOutAt: Type.Optional(Type.String({ format: 'date-time' })),
  remarks: Type.Optional(Type.String({ maxLength: 500 })),
});

export const KioskOfflineSyncSessionItem = Type.Object({
  clientSessionId: Type.String({ format: 'uuid' }),
  employeeId: Type.String({ format: 'uuid' }),
  punchInAt: Type.String({ format: 'date-time' }),
  punchInLat: Type.Optional(Type.Number({ minimum: -90, maximum: 90 })),
  punchInLng: Type.Optional(Type.Number({ minimum: -180, maximum: 180 })),
  punchOutAt: Type.Optional(Type.String({ format: 'date-time' })),
  punchOutLat: Type.Optional(Type.Number({ minimum: -90, maximum: 90 })),
  punchOutLng: Type.Optional(Type.Number({ minimum: -180, maximum: 180 })),
  remarks: Type.Optional(Type.String({ maxLength: 500 })),
});

export const KioskOfflineSyncBody = Type.Object({
  siteId: Type.String({ format: 'uuid' }),
  syncBatchId: Type.String({ format: 'uuid' }),
  sessions: Type.Array(KioskOfflineSyncSessionItem, { minItems: 1, maxItems: 500 }),
});

export const CreateTvtSessionBody = Type.Object({
  siteId: Type.String({ format: 'uuid' }),
  topic: Type.String({ minLength: 3, maxLength: 255 }),
  businessDate: Type.Optional(Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' })),
  conductedAt: Type.Optional(Type.String({ format: 'date-time' })),
  remarks: Type.Optional(Type.String({ maxLength: 500 })),
  attendeeEmployeeIds: Type.Optional(
    Type.Array(Type.String({ format: 'uuid' }), { maxItems: 500 }),
  ),
});

export const AddTvtAttendeesBody = Type.Object({
  employeeIds: Type.Array(Type.String({ format: 'uuid' }), { minItems: 1, maxItems: 500 }),
});

export const ListTvtSessionsQuery = Type.Object({
  siteId: Type.Optional(Type.String({ format: 'uuid' })),
  businessDate: Type.Optional(Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 50 })),
  cursor: Type.Optional(Type.String()),
});

export const MusterRollRangeQuery = Type.Object({
  siteId: Type.String({ format: 'uuid' }),
  from: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
  to: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
  employeeId: Type.Optional(Type.String({ format: 'uuid' })),
  status: Type.Optional(
    Type.Union([
      Type.Literal('IN_PROGRESS'),
      Type.Literal('COMPLETED'),
      Type.Literal('AUTO_CLOSED'),
      Type.Literal('REJECTED'),
    ]),
  ),
});

export type CreatePolicyInput = Static<typeof CreatePolicyBody>;
export type UpdatePolicyInput = Static<typeof UpdatePolicyBody>;
export type PunchInInput = Static<typeof PunchInBody>;
export type PunchOutInput = Static<typeof PunchOutBody>;
export type StartBreakInput = Static<typeof StartBreakBody>;
export type EndBreakInput = Static<typeof EndBreakBody>;
export type RegularizeSessionInput = Static<typeof RegularizeSessionBody>;
export type ListSessionsFilter = Static<typeof ListSessionsQuery>;
export type DailySummaryFilter = Static<typeof DailySummaryQuery>;
export type KioskBatchPunchInInput = Static<typeof KioskBatchPunchInBody>;
export type KioskBatchPunchOutInput = Static<typeof KioskBatchPunchOutBody>;
export type KioskOfflineSyncInput = Static<typeof KioskOfflineSyncBody>;
export type CreateTvtSessionInput = Static<typeof CreateTvtSessionBody>;
export type AddTvtAttendeesInput = Static<typeof AddTvtAttendeesBody>;
export type ListTvtSessionsFilter = Static<typeof ListTvtSessionsQuery>;
export type MusterRollRangeFilter = Static<typeof MusterRollRangeQuery>;
