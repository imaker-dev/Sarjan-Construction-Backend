import { randomUUID } from 'node:crypto';
import type {
  AttendanceBreak,
  AttendancePolicy,
  AttendancePolicyScope,
  AttendanceSession,
  DailySiteReport,
  DailySiteReportLabour,
  LabourCategory,
  Prisma,
} from '@prisma/client';
import type { ScopeTarget } from '../access-control/service.js';
import type { ActorContext, AuditRecord } from '../organization/types.js';
import {
  ActiveSessionExistsError,
  AttendanceEntityNotFoundError,
  AttendanceValidationError,
  BreakAlreadyActiveError,
  DailyReportAlreadyLockedError,
  DailyReportInvalidStateTransitionError,
  DailyReportNotFoundError,
  GeofenceBreachError,
  InvalidDateRangeError,
  NoActiveBreakError,
  NoActiveSessionError,
  PunchNotAllowedError,
  TvtSafetyBriefingRequiredError,
} from './errors.js';
import type {
  AttendanceRepos,
  AttendanceSessionWithDetails,
  AttendanceUnitOfWork,
} from './repository.js';
import {
  calculateHaversineDistanceMeters,
  calculateWorkAndOvertime,
  DEFAULT_ATTENDANCE_POLICY,
  getBusinessDate,
  MAX_MUSTER_ROLL_DAYS,
  type AddTvtAttendeesInput,
  type CalculateDailyReportInput,
  type CreatePolicyInput,
  type CreateTvtSessionInput,
  type DailySummaryFilter,
  type EndBreakInput,
  type KioskBatchPunchInInput,
  type KioskBatchPunchOutInput,
  type KioskOfflineSyncInput,
  type ListDailyReportsFilter,
  type ListSessionsFilter,
  type ListTvtSessionsFilter,
  type LockDailyReportInput,
  type MusterRollRangeFilter,
  type PunchInInput,
  type PunchOutInput,
  type RegularizeSessionInput,
  type RejectDailyReportInput,
  type StartBreakInput,
  type UpdateDailyReportInput,
  type UpdateLabourSummaryInput,
  type UpdatePolicyInput,
} from './types.js';

export const ATTENDANCE_RECORD = 'ATTENDANCE_RECORD';
export const ATTENDANCE_READ = 'ATTENDANCE_READ';
export const ATTENDANCE_MANAGE = 'ATTENDANCE_MANAGE';

interface Authorizer {
  assertPermission(principalId: string, permissionKey: string, target: ScopeTarget): Promise<void>;
}

const auditEntry = (
  actor: ActorContext,
  base: Omit<AuditRecord, 'eventKey' | 'actorId' | 'actorType' | 'correlationId'>,
): AuditRecord => ({
  eventKey: randomUUID(),
  actorId: actor.actorId,
  actorType: actor.actorType,
  ...(actor.correlationId !== undefined ? { correlationId: actor.correlationId } : {}),
  ...base,
});

const companyTarget = (companyId: string): ScopeTarget => ({
  companyId,
  scopeType: 'COMPANY',
  scopeId: companyId,
});

const siteTarget = (companyId: string, siteId: string): ScopeTarget => ({
  companyId,
  scopeType: 'SITE',
  scopeId: siteId,
});

const headOfficeTarget = (companyId: string, headOfficeId: string): ScopeTarget => ({
  companyId,
  scopeType: 'HEAD_OFFICE',
  scopeId: headOfficeId,
});

/** Authorization target for a session's location anchor (site or head office). */
const sessionLocationTarget = (
  companyId: string,
  session: { siteId?: string | null; headOfficeId?: string | null },
): ScopeTarget =>
  session.siteId != null
    ? siteTarget(companyId, session.siteId)
    : headOfficeTarget(companyId, session.headOfficeId ?? companyId);

export const createDefaultPolicyFallback = (companyId?: string): AttendancePolicy =>
  ({
    id: 'default-fallback',
    companyId: companyId ?? 'default-company',
    scope: 'COMPANY',
    projectId: null,
    siteId: null,
    employeeId: null,
    name: 'Default Construction Policy',
    description: 'Auto-fallback policy (8:00 AM to 8:00 AM cycle)',
    ...DEFAULT_ATTENDANCE_POLICY,
    createdAt: new Date(),
    updatedAt: new Date(),
  }) as unknown as AttendancePolicy;

export class AttendanceService {
  constructor(
    private readonly uow: AttendanceUnitOfWork,
    private readonly authorizer: Authorizer,
  ) { }

  // -------------------------------------------------------------------------
  // Policy Management
  // -------------------------------------------------------------------------

  async createPolicy(
    actor: ActorContext,
    companyId: string,
    input: CreatePolicyInput,
  ): Promise<AttendancePolicy> {
    await this.authorizer.assertPermission(
      actor.actorId,
      ATTENDANCE_MANAGE,
      companyTarget(companyId),
    );

    return this.uow.run(async (repos) => {
      const policy = await repos.policies.create(companyId, {
        name: input.name,
        description: input.description ?? null,
        scope: input.scope ?? 'COMPANY',
        ...(input.projectId ? { project: { connect: { id: input.projectId } } } : {}),
        ...(input.siteId ? { site: { connect: { id: input.siteId } } } : {}),
        ...(input.employeeId ? { employee: { connect: { id: input.employeeId } } } : {}),
        dayStartHour: input.dayStartHour ?? 8,
        dayStartMinute: input.dayStartMinute ?? 0,
        shiftDurationMins: input.shiftDurationMins ?? 480,
        halfDayThresholdMins: input.halfDayThresholdMins ?? 240,
        fullDayThresholdMins: input.fullDayThresholdMins ?? 480,
        breakMode: input.breakMode ?? 'FIXED',
        fixedBreakMins: input.fixedBreakMins ?? 60,
        minWorkForBreakMins: input.minWorkForBreakMins ?? 240,
        maxDynamicBreakMins: input.maxDynamicBreakMins ?? 90,
        overtimeMode: input.overtimeMode ?? 'HOURLY',
        minOvertimeMins: input.minOvertimeMins ?? 30,
        otSlabMins: input.otSlabMins ?? 30,
        ...(input.pMultiplierSlabs ? { pMultiplierSlabs: input.pMultiplierSlabs } : {}),
        geofenceStrict: input.geofenceStrict ?? true,
        allowMobilePunch: input.allowMobilePunch ?? true,
        allowKioskPunch: input.allowKioskPunch ?? true,
        allowBiometric: input.allowBiometric ?? true,
        requireTvtGate: input.requireTvtGate ?? false,
        tvtGateAction: input.tvtGateAction ?? 'FLAG',
      });

      await repos.audit.record(
        auditEntry(actor, {
          action: 'ATTENDANCE_POLICY_CREATED',
          entityType: 'ATTENDANCE_POLICY',
          entityId: policy.id,
          companyId,
          statusAfter: policy.status,
          metadata: { name: policy.name, scope: policy.scope },
        }),
      );

      return policy;
    });
  }

  async updatePolicy(
    actor: ActorContext,
    companyId: string,
    policyId: string,
    input: UpdatePolicyInput,
    expectedVersion?: number,
  ): Promise<AttendancePolicy> {
    await this.authorizer.assertPermission(
      actor.actorId,
      ATTENDANCE_MANAGE,
      companyTarget(companyId),
    );

    return this.uow.run(async (repos) => {
      const existing = await repos.policies.findById(companyId, policyId);
      if (!existing) throw new AttendanceEntityNotFoundError('AttendancePolicy', policyId);

      const updated = await repos.policies.update(
        companyId,
        policyId,
        {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.dayStartHour !== undefined ? { dayStartHour: input.dayStartHour } : {}),
          ...(input.dayStartMinute !== undefined ? { dayStartMinute: input.dayStartMinute } : {}),
          ...(input.shiftDurationMins !== undefined
            ? { shiftDurationMins: input.shiftDurationMins }
            : {}),
          ...(input.halfDayThresholdMins !== undefined
            ? { halfDayThresholdMins: input.halfDayThresholdMins }
            : {}),
          ...(input.fullDayThresholdMins !== undefined
            ? { fullDayThresholdMins: input.fullDayThresholdMins }
            : {}),
          ...(input.breakMode !== undefined ? { breakMode: input.breakMode } : {}),
          ...(input.fixedBreakMins !== undefined ? { fixedBreakMins: input.fixedBreakMins } : {}),
          ...(input.minWorkForBreakMins !== undefined
            ? { minWorkForBreakMins: input.minWorkForBreakMins }
            : {}),
          ...(input.maxDynamicBreakMins !== undefined
            ? { maxDynamicBreakMins: input.maxDynamicBreakMins }
            : {}),
          ...(input.overtimeMode !== undefined ? { overtimeMode: input.overtimeMode } : {}),
          ...(input.minOvertimeMins !== undefined
            ? { minOvertimeMins: input.minOvertimeMins }
            : {}),
          ...(input.otSlabMins !== undefined ? { otSlabMins: input.otSlabMins } : {}),
          ...(input.pMultiplierSlabs !== undefined
            ? { pMultiplierSlabs: input.pMultiplierSlabs }
            : {}),
          ...(input.geofenceStrict !== undefined ? { geofenceStrict: input.geofenceStrict } : {}),
          ...(input.allowMobilePunch !== undefined
            ? { allowMobilePunch: input.allowMobilePunch }
            : {}),
          ...(input.allowKioskPunch !== undefined
            ? { allowKioskPunch: input.allowKioskPunch }
            : {}),
          ...(input.allowBiometric !== undefined ? { allowBiometric: input.allowBiometric } : {}),
          ...(input.requireTvtGate !== undefined ? { requireTvtGate: input.requireTvtGate } : {}),
          ...(input.tvtGateAction !== undefined ? { tvtGateAction: input.tvtGateAction } : {}),
        },
        expectedVersion,
      );

      await repos.audit.record(
        auditEntry(actor, {
          action: 'ATTENDANCE_POLICY_UPDATED',
          entityType: 'ATTENDANCE_POLICY',
          entityId: policyId,
          companyId,
          statusBefore: existing.status,
          statusAfter: updated.status,
          metadata: { name: updated.name },
        }),
      );

      return updated;
    });
  }

  async getPolicy(
    actor: ActorContext,
    companyId: string,
    policyId: string,
  ): Promise<AttendancePolicy> {
    await this.authorizer.assertPermission(
      actor.actorId,
      ATTENDANCE_READ,
      companyTarget(companyId),
    );
    return this.uow.run(async (repos) => {
      const p = await repos.policies.findById(companyId, policyId);
      if (!p) throw new AttendanceEntityNotFoundError('AttendancePolicy', policyId);
      return p;
    });
  }

  async listPolicies(
    actor: ActorContext,
    companyId: string,
    scope?: AttendancePolicyScope,
  ): Promise<AttendancePolicy[]> {
    await this.authorizer.assertPermission(
      actor.actorId,
      ATTENDANCE_READ,
      companyTarget(companyId),
    );
    return this.uow.run((repos) =>
      repos.policies.list(companyId, scope !== undefined ? { scope } : {}),
    );
  }

  async resolveEffectivePolicy(
    actor: ActorContext,
    companyId: string,
    criteria: { employeeId?: string; siteId?: string },
  ): Promise<AttendancePolicy> {
    await this.authorizer.assertPermission(
      actor.actorId,
      ATTENDANCE_READ,
      companyTarget(companyId),
    );

    return this.uow.run(async (repos) => {
      let projectId: string | undefined;
      if (criteria.siteId) {
        const site = await repos.sites.findById(companyId, criteria.siteId);
        if (site) projectId = site.projectId;
      }

      const lookupCriteria: { employeeId?: string; siteId?: string; projectId?: string } = {};
      if (criteria.employeeId !== undefined) lookupCriteria.employeeId = criteria.employeeId;
      if (criteria.siteId !== undefined) lookupCriteria.siteId = criteria.siteId;
      if (projectId !== undefined) lookupCriteria.projectId = projectId;

      const policy = await repos.policies.findEffective(companyId, lookupCriteria);

      if (policy) return policy;

      // Safe default fallback
      return createDefaultPolicyFallback(companyId);
    });
  }

  // -------------------------------------------------------------------------
  // Punch In / Punch Out
  // -------------------------------------------------------------------------

  async punchIn(
    actor: ActorContext,
    companyId: string,
    input: PunchInInput,
  ): Promise<AttendanceSession> {
    return this.uow.run(async (repos) => {
      // 1. Resolve employee and supervisor context
      let employeeId = input.employeeId;
      let supervisorId: string | undefined;
      const callerEmp = await repos.employees.findByPrincipal(companyId, actor.actorId);
      if (!employeeId) {
        if (!callerEmp)
          throw new AttendanceEntityNotFoundError('Employee for caller', actor.actorId);
        employeeId = callerEmp.id;
      } else if (callerEmp && callerEmp.id !== employeeId) {
        supervisorId = callerEmp.id;
      } else if (!callerEmp) {
        supervisorId = actor.actorId;
      }

      // Exactly one location anchor: siteId (site staff) or headOfficeId
      // (Head-Office-department employees — they have no site).
      const hasSite = input.siteId !== undefined;
      const hasHo = input.headOfficeId !== undefined;
      if (hasSite === hasHo) {
        throw new AttendanceValidationError('Provide exactly one of siteId or headOfficeId');
      }
      const punchTarget = hasSite
        ? siteTarget(companyId, input.siteId!)
        : headOfficeTarget(companyId, input.headOfficeId!);

      // Assert permission: supervisor punch or privileged source requires ATTENDANCE_MANAGE
      const isPrivilegedSource = input.source !== undefined && input.source !== 'MOBILE_SELF';
      if (supervisorId || isPrivilegedSource) {
        await this.authorizer.assertPermission(actor.actorId, ATTENDANCE_MANAGE, punchTarget);
      } else {
        await this.authorizer.assertPermission(actor.actorId, ATTENDANCE_RECORD, punchTarget);
      }

      const emp = await repos.employees.findById(companyId, employeeId);
      if (emp?.status !== 'ACTIVE') {
        throw new AttendanceEntityNotFoundError('Active Employee', employeeId);
      }

      // 2. Validate the location anchor. For head-office punches the employee
      // must hold an active membership in a department based at that office.
      const site =
        input.siteId !== undefined ? await repos.sites.findById(companyId, input.siteId) : null;
      if (input.siteId !== undefined && site === null) {
        throw new AttendanceEntityNotFoundError('Site', input.siteId);
      }
      const headOffice =
        input.headOfficeId !== undefined
          ? await repos.headOffices.findById(companyId, input.headOfficeId)
          : null;
      if (input.headOfficeId !== undefined) {
        if (headOffice?.status !== 'ACTIVE') {
          throw new AttendanceEntityNotFoundError('Active Head Office', input.headOfficeId);
        }
        const atOffice = await repos.memberships.hasActiveAtHeadOffice(
          companyId,
          employeeId,
          headOffice.id,
        );
        if (!atOffice) {
          throw new PunchNotAllowedError(
            'Employee has no active membership in a department based at this head office',
          );
        }
      }

      // 3. Check for existing active session
      const existingSession = await repos.sessions.findActive(companyId, employeeId);
      if (existingSession) {
        throw new ActiveSessionExistsError(existingSession.id);
      }

      // 4. Resolve Effective Policy
      const policy =
        (await repos.policies.findEffective(companyId, {
          employeeId,
          ...(site !== null ? { siteId: site.id, projectId: site.projectId } : {}),
        })) ?? createDefaultPolicyFallback(companyId);

      // If policy id was default-fallback, make sure we persist or connect a real company policy
      let policyIdToPersist = policy.id;
      if (policyIdToPersist === 'default-fallback') {
        const compPolicy = repos.policies.ensureDefaultPolicy
          ? await repos.policies.ensureDefaultPolicy(companyId)
          : await repos.policies.create(companyId, {
            name: 'Company Default Policy',
            scope: 'COMPANY',
          });
        policyIdToPersist = compPolicy.id;
      }

      const source = input.source ?? (supervisorId ? 'SUPERVISOR_KIOSK' : 'MOBILE_SELF');
      if (source === 'MOBILE_SELF' && !policy.allowMobilePunch) {
        throw new PunchNotAllowedError('Mobile self-punch disabled by policy');
      }
      if (source === 'SUPERVISOR_KIOSK' && !policy.allowKioskPunch) {
        throw new PunchNotAllowedError('Supervisor kiosk punch disabled by policy');
      }
      if (source === 'BIOMETRIC_DEVICE' && !policy.allowBiometric) {
        throw new PunchNotAllowedError('Biometric sync disabled by policy');
      }

      // 5. Geofence Verification (site or head-office anchor)
      let distanceM: number | null = null;
      let isWithinGeofence = true;
      const geoLat = site?.geoLatitude ?? headOffice?.geoLatitude ?? null;
      const geoLng = site?.geoLongitude ?? headOffice?.geoLongitude ?? null;
      const fenceRadiusM = site?.geoFenceRadiusM ?? headOffice?.geoFenceRadiusM ?? 100;
      if (geoLat !== null && geoLng !== null) {
        distanceM = calculateHaversineDistanceMeters(
          input.latitude,
          input.longitude,
          Number(geoLat),
          Number(geoLng),
        );
        if (distanceM > fenceRadiusM) {
          isWithinGeofence = false;
          if (policy.geofenceStrict) {
            throw new GeofenceBreachError(distanceM, fenceRadiusM);
          }
        }
      }

      // 6. Business Date Calculation (8 AM to 8 AM cycle)
      const now = new Date();
      const timezone =
        site !== null
          ? (site.timezone ?? site.project.timezone)
          : (headOffice?.timezone ?? 'Asia/Kolkata');
      const businessDate = getBusinessDate(
        now,
        timezone,
        policy.dayStartHour,
        policy.dayStartMinute,
      );

      // 7. Safety TVT Gate Check (sites only — head offices run no TVT)
      let isFlagged = !isWithinGeofence;
      let flagReason = !isWithinGeofence ? 'Geofence breach on punch in' : null;

      if (site !== null && policy.requireTvtGate) {
        const hasAttendedTvt = await repos.tvt.hasAttended(
          companyId,
          site.id,
          employeeId,
          businessDate,
        );
        if (!hasAttendedTvt) {
          if (policy.tvtGateAction === 'BLOCK') {
            throw new TvtSafetyBriefingRequiredError(employeeId, businessDate);
          } else {
            isFlagged = true;
            flagReason = flagReason
              ? `${flagReason}; Safety TVT briefing missed`
              : 'Safety TVT briefing missed';
          }
        }
      }

      // 8. Create Session
      const session = await repos.sessions.create(companyId, {
        employee: { connect: { id: employeeId } },
        ...(site !== null ? { site: { connect: { id: site.id } } } : {}),
        ...(headOffice !== null ? { headOffice: { connect: { id: headOffice.id } } } : {}),
        policy: { connect: { id: policyIdToPersist } },
        businessDate,
        status: 'IN_PROGRESS',
        source,
        punchInAt: now,
        punchInLat: input.latitude,
        punchInLng: input.longitude,
        punchInDistanceM: distanceM,
        punchInWithinGeofence: isWithinGeofence,
        punchInRemarks: input.remarks ?? null,
        punchInSupervisorId: supervisorId ?? null,
        isFlagged,
        flagReason,
      });

      await repos.audit.record(
        auditEntry(actor, {
          action: 'ATTENDANCE_PUNCH_IN',
          entityType: 'ATTENDANCE_SESSION',
          entityId: session.id,
          companyId,
          statusAfter: session.status,
          metadata: {
            employeeId,
            siteId: site?.id ?? null,
            headOfficeId: headOffice?.id ?? null,
            businessDate,
            distanceM,
            isWithinGeofence,
          },
        }),
      );

      return session;
    });
  }

  async punchOut(
    actor: ActorContext,
    companyId: string,
    input: PunchOutInput,
  ): Promise<AttendanceSession> {
    return this.uow.run(async (repos) => {
      // 1. Resolve employee
      let employeeId = input.employeeId;
      const callerEmp = await repos.employees.findByPrincipal(companyId, actor.actorId);
      if (!employeeId) {
        if (!callerEmp)
          throw new AttendanceEntityNotFoundError('Employee for caller', actor.actorId);
        employeeId = callerEmp.id;
      }

      // 2. Find active session
      const session = input.sessionId
        ? await repos.sessions.findById(companyId, input.sessionId)
        : await repos.sessions.findActive(companyId, employeeId);

      if (session?.status !== 'IN_PROGRESS') {
        throw new NoActiveSessionError(employeeId);
      }

      // Resolve supervisor & assert permissions
      let supervisorId: string | undefined;
      if (callerEmp && callerEmp.id !== session.employeeId) {
        supervisorId = callerEmp.id;
      } else if (!callerEmp) {
        supervisorId = actor.actorId;
      }

      const outTarget = sessionLocationTarget(companyId, session);
      if (supervisorId) {
        await this.authorizer.assertPermission(actor.actorId, ATTENDANCE_MANAGE, outTarget);
      } else {
        await this.authorizer.assertPermission(actor.actorId, ATTENDANCE_RECORD, outTarget);
      }

      const site =
        session.siteId != null ? await repos.sites.findById(companyId, session.siteId) : null;
      const headOffice =
        session.headOfficeId != null
          ? await repos.headOffices.findById(companyId, session.headOfficeId)
          : null;
      if (session.siteId != null && !site) {
        throw new AttendanceEntityNotFoundError('Site', session.siteId);
      }

      // 3. Close any active break
      const activeBreak = await repos.breaks.findActive(companyId, session.id);
      const now = new Date();
      if (activeBreak) {
        const breakMins = Math.max(
          1,
          Math.round((now.getTime() - activeBreak.startedAt.getTime()) / 60000),
        );
        await repos.breaks.update(companyId, activeBreak.id, {
          endedAt: now,
          durationMins: breakMins,
        });
      }

      // 4. Geofence Verification (site or head-office anchor)
      let distanceM: number | null = null;
      let isWithinGeofence = true;
      let isFlagged = session.isFlagged;
      let flagReason = session.flagReason;

      const outGeoLat = site?.geoLatitude ?? headOffice?.geoLatitude ?? null;
      const outGeoLng = site?.geoLongitude ?? headOffice?.geoLongitude ?? null;
      const outRadiusM = site?.geoFenceRadiusM ?? headOffice?.geoFenceRadiusM ?? 100;
      if (outGeoLat !== null && outGeoLng !== null) {
        distanceM = calculateHaversineDistanceMeters(
          input.latitude,
          input.longitude,
          Number(outGeoLat),
          Number(outGeoLng),
        );
        const radiusM = outRadiusM;
        if (distanceM > radiusM) {
          isWithinGeofence = false;
          isFlagged = true;
          const outReason = `Punch-out outside geofence (${distanceM}m vs ${radiusM}m)`;
          flagReason = flagReason ? `${flagReason}; ${outReason}` : outReason;
        }
      }

      // 5. Calculate Durations & Work/Overtime Units
      const policy =
        (await repos.policies.findById(companyId, session.policyId)) ??
        createDefaultPolicyFallback(companyId);

      const grossDurationMins = Math.max(
        0,
        Math.round((now.getTime() - session.punchInAt.getTime()) / 60000),
      );

      // Calculate dynamic breaks total
      let dynamicBreaksMins = 0;
      if (policy.breakMode === 'DYNAMIC') {
        const allBreaks = await repos.breaks.listForSession(companyId, session.id);
        dynamicBreaksMins = allBreaks.reduce((acc, b) => acc + (b.durationMins || 0), 0);
      }

      const calc = calculateWorkAndOvertime({
        grossMinutes: grossDurationMins,
        breakMinutes: dynamicBreaksMins,
        policy,
      });

      // 6. Complete Session
      const updated = await repos.sessions.update(companyId, session.id, {
        status: 'COMPLETED',
        punchOutAt: now,
        punchOutLat: input.latitude,
        punchOutLng: input.longitude,
        punchOutDistanceM: distanceM,
        punchOutWithinGeofence: isWithinGeofence,
        punchOutRemarks: input.remarks ?? null,
        punchOutSupervisorId: supervisorId ?? null,
        grossDurationMins,
        breakDurationMins: calc.breakDurationMins,
        netDurationMins: calc.netDurationMins,
        presentUnits: calc.presentUnits,
        overtimePUnits: calc.overtimePUnits,
        totalPUnits: calc.totalPUnits,
        overtimeHours: calc.overtimeHours,
        isFlagged,
        flagReason,
      });

      await repos.audit.record(
        auditEntry(actor, {
          action: 'ATTENDANCE_PUNCH_OUT',
          entityType: 'ATTENDANCE_SESSION',
          entityId: session.id,
          companyId,
          statusBefore: session.status,
          statusAfter: updated.status,
          metadata: {
            employeeId,
            siteId: site?.id ?? null,
            headOfficeId: headOffice?.id ?? null,
            grossDurationMins,
            netDurationMins: calc.netDurationMins,
            presentUnits: calc.presentUnits,
            overtimePUnits: calc.overtimePUnits,
            totalPUnits: calc.totalPUnits,
            overtimeHours: calc.overtimeHours,
          },
        }),
      );

      return updated;
    });
  }

  // -------------------------------------------------------------------------
  // Dynamic Break Management
  // -------------------------------------------------------------------------

  async startBreak(actor: ActorContext, companyId: string, input: StartBreakInput) {
    return this.uow.run(async (repos) => {
      let employeeId = input.employeeId;
      const callerEmp = await repos.employees.findByPrincipal(companyId, actor.actorId);
      if (!employeeId) {
        if (!callerEmp)
          throw new AttendanceEntityNotFoundError('Employee for caller', actor.actorId);
        employeeId = callerEmp.id;
      }

      const session = input.sessionId
        ? await repos.sessions.findById(companyId, input.sessionId)
        : await repos.sessions.findActive(companyId, employeeId);

      if (session?.status !== 'IN_PROGRESS') {
        throw new NoActiveSessionError(employeeId);
      }

      const isSupervisor = callerEmp?.id !== session.employeeId;
      if (isSupervisor) {
        await this.authorizer.assertPermission(
          actor.actorId,
          ATTENDANCE_MANAGE,
          sessionLocationTarget(companyId, session),
        );
      } else {
        await this.authorizer.assertPermission(
          actor.actorId,
          ATTENDANCE_RECORD,
          sessionLocationTarget(companyId, session),
        );
      }

      const activeBreak = await repos.breaks.findActive(companyId, session.id);
      if (activeBreak) {
        throw new BreakAlreadyActiveError(activeBreak.id);
      }

      const brk = await repos.breaks.create(companyId, {
        session: { connect: { id: session.id } },
        breakType: input.breakType ?? 'LUNCH',
        startedAt: new Date(),
        remarks: input.remarks ?? null,
      });

      await repos.audit.record(
        auditEntry(actor, {
          action: 'ATTENDANCE_BREAK_STARTED',
          entityType: 'ATTENDANCE_BREAK',
          entityId: brk.id,
          companyId,
          metadata: { sessionId: session.id, breakType: brk.breakType },
        }),
      );

      return brk;
    });
  }

  async endBreak(actor: ActorContext, companyId: string, input: EndBreakInput) {
    return this.uow.run(async (repos) => {
      let brk: AttendanceBreak | null = null;
      if (input.breakId) {
        brk = await repos.breaks.findById(companyId, input.breakId);
        if (brk?.endedAt !== null) {
          throw new NoActiveBreakError(input.breakId);
        }
      } else {
        let employeeId = input.employeeId;
        if (!employeeId && !input.sessionId) {
          const callerEmp = await repos.employees.findByPrincipal(companyId, actor.actorId);
          if (!callerEmp)
            throw new AttendanceEntityNotFoundError('Employee for caller', actor.actorId);
          employeeId = callerEmp.id;
        }

        let sessionId = input.sessionId;
        if (!sessionId && employeeId) {
          const session = await repos.sessions.findActive(companyId, employeeId);
          if (session) sessionId = session.id;
        }

        if (!sessionId) {
          throw new NoActiveBreakError('unknown');
        }

        brk = await repos.breaks.findActive(companyId, sessionId);
      }

      if (!brk) {
        throw new NoActiveBreakError(input.breakId ?? input.sessionId ?? 'unknown');
      }

      const session = await repos.sessions.findById(companyId, brk.sessionId);
      if (!session) {
        throw new AttendanceEntityNotFoundError('AttendanceSession', brk.sessionId);
      }

      const callerEmp = await repos.employees.findByPrincipal(companyId, actor.actorId);
      const isSupervisor = callerEmp?.id !== session.employeeId;
      if (isSupervisor) {
        await this.authorizer.assertPermission(
          actor.actorId,
          ATTENDANCE_MANAGE,
          sessionLocationTarget(companyId, session),
        );
      } else {
        await this.authorizer.assertPermission(
          actor.actorId,
          ATTENDANCE_RECORD,
          sessionLocationTarget(companyId, session),
        );
      }

      const now = new Date();
      const durationMins = Math.max(
        1,
        Math.round((now.getTime() - brk.startedAt.getTime()) / 60000),
      );

      const updated = await repos.breaks.update(companyId, brk.id, {
        endedAt: now,
        durationMins,
        ...(input.remarks ? { remarks: input.remarks } : {}),
      });

      await repos.audit.record(
        auditEntry(actor, {
          action: 'ATTENDANCE_BREAK_ENDED',
          entityType: 'ATTENDANCE_BREAK',
          entityId: updated.id,
          companyId,
          metadata: { sessionId: brk.sessionId, durationMins },
        }),
      );

      return updated;
    });
  }

  // -------------------------------------------------------------------------
  // Regularization & Queries
  // -------------------------------------------------------------------------

  async regularizeSession(
    actor: ActorContext,
    companyId: string,
    sessionId: string,
    input: RegularizeSessionInput,
  ): Promise<AttendanceSession> {
    return this.uow.run(async (repos) => {
      const session = await repos.sessions.findById(companyId, sessionId);
      if (!session) throw new AttendanceEntityNotFoundError('AttendanceSession', sessionId);

      await this.authorizer.assertPermission(
        actor.actorId,
        ATTENDANCE_MANAGE,
        sessionLocationTarget(companyId, session),
      );

      const effectivePunchInAt = input.punchInAt ? new Date(input.punchInAt) : session.punchInAt;
      const effectivePunchOutAt = input.punchOutAt
        ? new Date(input.punchOutAt)
        : session.punchOutAt;

      if (!effectivePunchOutAt) {
        throw new AttendanceValidationError(
          'Cannot regularize session to completed without punch out timestamp',
        );
      }

      if (effectivePunchOutAt.getTime() <= effectivePunchInAt.getTime()) {
        throw new AttendanceValidationError(
          'Punch out timestamp must be strictly after punch in timestamp',
        );
      }

      const grossDurationMins = Math.max(
        0,
        Math.round((effectivePunchOutAt.getTime() - effectivePunchInAt.getTime()) / 60000),
      );

      const policy =
        (await repos.policies.findById(companyId, session.policyId)) ??
        createDefaultPolicyFallback(companyId);

      let dynamicBreaksMins = 0;
      if (policy.breakMode === 'DYNAMIC') {
        const allBreaks = await repos.breaks.listForSession(companyId, session.id);
        dynamicBreaksMins = allBreaks.reduce((acc, b) => acc + (b.durationMins || 0), 0);
      }

      const calc = calculateWorkAndOvertime({
        grossMinutes: grossDurationMins,
        breakMinutes: dynamicBreaksMins,
        policy,
      });

      const presentUnits = input.presentUnits ?? calc.presentUnits;
      const overtimePUnits = input.overtimePUnits ?? calc.overtimePUnits;
      const totalPUnits = Number((presentUnits + overtimePUnits).toFixed(1));
      const overtimeHours = input.overtimeHours ?? calc.overtimeHours;

      const updated = await repos.sessions.update(companyId, sessionId, {
        punchInAt: effectivePunchInAt,
        punchOutAt: effectivePunchOutAt,
        grossDurationMins,
        breakDurationMins: calc.breakDurationMins,
        netDurationMins: calc.netDurationMins,
        presentUnits,
        overtimePUnits,
        totalPUnits,
        overtimeHours,
        status: 'COMPLETED',
        source: 'MANUAL_CORRECTION',
        approvedBy: actor.actorId,
        approvedAt: new Date(),
        punchOutRemarks: input.remarks,
      });

      await repos.audit.record(
        auditEntry(actor, {
          action: 'ATTENDANCE_REGULARIZED',
          entityType: 'ATTENDANCE_SESSION',
          entityId: sessionId,
          companyId,
          statusBefore: session.status,
          statusAfter: updated.status,
          metadata: {
            reason: input.remarks,
            presentUnits,
            overtimePUnits,
            totalPUnits,
            overtimeHours,
            grossDurationMins,
            netDurationMins: calc.netDurationMins,
          },
        }),
      );

      // Auto-recalculate active DSR if one exists in DRAFT or SUBMITTED
      const existingReport = await repos.dailyReports.findBySiteAndDate(
        companyId,
        session.siteId,
        session.businessDate,
      );
      if (
        existingReport &&
        (existingReport.status === 'DRAFT' || existingReport.status === 'SUBMITTED')
      ) {
        await this.internalRecalculateReport(
          repos,
          companyId,
          session.siteId,
          session.businessDate,
          actor.actorId,
          `Session ${sessionId} regularized`,
        );
      }

      return updated;
    });
  }

  async sweepStaleSessions(companyId?: string, maxShiftDurationHours = 24): Promise<number> {
    const cutoff = new Date(Date.now() - maxShiftDurationHours * 60 * 60 * 1000);
    return this.uow.run(async (repos) => {
      if (repos.sessions.autoCloseStaleSessions) {
        return repos.sessions.autoCloseStaleSessions(cutoff, companyId);
      }
      return 0;
    });
  }

  async getSession(
    actor: ActorContext,
    companyId: string,
    sessionId: string,
  ): Promise<AttendanceSessionWithDetails> {
    return this.uow.run(async (repos) => {
      const s = await repos.sessions.findById(companyId, sessionId);
      if (!s) throw new AttendanceEntityNotFoundError('AttendanceSession', sessionId);
      await this.authorizer.assertPermission(
        actor.actorId,
        ATTENDANCE_READ,
        sessionLocationTarget(companyId, s),
      );
      return s;
    });
  }

  async getActiveSession(actor: ActorContext, companyId: string, employeeId?: string) {
    return this.uow.run(async (repos) => {
      const callerEmp = await repos.employees.findByPrincipal(companyId, actor.actorId);
      const isTargetingOther = employeeId !== undefined && callerEmp?.id !== employeeId;

      const targetEmpId = employeeId ?? callerEmp?.id;
      if (!targetEmpId) return null;

      const session = await repos.sessions.findActive(companyId, targetEmpId);
      if (!session) return null;

      if (isTargetingOther) {
        await this.authorizer.assertPermission(
          actor.actorId,
          ATTENDANCE_READ,
          sessionLocationTarget(companyId, session),
        );
      }

      return session;
    });
  }

  async listSessions(
    actor: ActorContext,
    companyId: string,
    filter: ListSessionsFilter,
  ): Promise<AttendanceSessionWithDetails[]> {
    await this.authorizer.assertPermission(
      actor.actorId,
      ATTENDANCE_READ,
      companyTarget(companyId),
    );
    return this.uow.run((repos) => repos.sessions.list(companyId, filter));
  }

  async getDailySummary(actor: ActorContext, companyId: string, filter: DailySummaryFilter) {
    await this.authorizer.assertPermission(
      actor.actorId,
      ATTENDANCE_READ,
      siteTarget(companyId, filter.siteId),
    );
    return this.uow.run((repos) =>
      repos.sessions.getDailySummary(companyId, filter.siteId, filter.businessDate),
    );
  }

  // -------------------------------------------------------------------------
  // Kiosk Batch Operations & Offline Sync
  // -------------------------------------------------------------------------

  async kioskBatchPunchIn(actor: ActorContext, companyId: string, input: KioskBatchPunchInInput) {
    await this.authorizer.assertPermission(
      actor.actorId,
      ATTENDANCE_RECORD,
      siteTarget(companyId, input.siteId),
    );

    return this.uow.run(async (repos) => {
      const site = await repos.sites.findById(companyId, input.siteId);
      if (!site) throw new AttendanceEntityNotFoundError('Site', input.siteId);

      const punchInAt = input.punchInAt ? new Date(input.punchInAt) : new Date();
      const timezone = site.timezone ?? site.project.timezone;

      let distanceM: number | null = null;
      let isWithinGeofence = true;
      if (site.geoLatitude !== null && site.geoLongitude !== null) {
        distanceM = calculateHaversineDistanceMeters(
          input.latitude,
          input.longitude,
          Number(site.geoLatitude),
          Number(site.geoLongitude),
        );
        const radiusM = site.geoFenceRadiusM ?? 100;
        if (distanceM > radiusM) {
          isWithinGeofence = false;
        }
      }

      // 1. Pre-batch active employees
      const employees = repos.employees.findManyByIds
        ? await repos.employees.findManyByIds(companyId, input.employeeIds)
        : await Promise.all(
          input.employeeIds.map(async (id) => {
            const e = await repos.employees.findById(companyId, id);
            return e ? { id: e.id, displayName: e.displayName, status: e.status } : null;
          }),
        ).then((list) =>
          list.filter(
            (e): e is { id: string; displayName: string; status: string } => e !== null,
          ),
        );
      const employeeMap = new Map(employees.map((e) => [e.id, e]));

      // 2. Pre-batch active sessions
      const activeSessions = repos.sessions.findActiveMany
        ? await repos.sessions.findActiveMany(companyId, input.employeeIds)
        : await Promise.all(
          input.employeeIds.map(async (id) => {
            const s = await repos.sessions.findActive(companyId, id);
            return s
              ? {
                ...s,
                employeeId:
                  'employeeId' in s && typeof s.employeeId === 'string' && s.employeeId
                    ? s.employeeId
                    : id,
              }
              : null;
          }),
        ).then((list) => list.filter((s): s is NonNullable<typeof s> => s !== null));
      const activeSessionEmployeeIds = new Set(activeSessions.map((s) => s.employeeId));

      // 3. Resolve site/project policy ONCE upfront
      const basePolicy =
        (await repos.policies.findEffective(companyId, {
          siteId: site.id,
          projectId: site.projectId,
        })) ?? createDefaultPolicyFallback(companyId);

      const employeePolicies = repos.policies.findEmployeePolicies
        ? await repos.policies.findEmployeePolicies(companyId, input.employeeIds)
        : [];
      const employeePolicyMap = new Map<string, AttendancePolicy>();
      for (const p of employeePolicies) {
        if (p.employeeId) {
          employeePolicyMap.set(p.employeeId, p);
        }
      }

      let fallbackPersistedPolicyId: string | null = null;
      if (basePolicy.id === 'default-fallback') {
        const compPolicy = repos.policies.ensureDefaultPolicy
          ? await repos.policies.ensureDefaultPolicy(companyId)
          : await repos.policies.create(companyId, {
            name: 'Company Default Policy',
            scope: 'COMPANY',
          });
        fallbackPersistedPolicyId = compPolicy.id;
      }

      // 4. Pre-batch TVT attendance if required
      const anyRequiresTvt =
        basePolicy.requireTvtGate || employeePolicies.some((p) => p.requireTvtGate);
      let attendedTvtSet = new Set<string>();
      if (anyRequiresTvt) {
        const businessDate = getBusinessDate(
          punchInAt,
          timezone,
          basePolicy.dayStartHour,
          basePolicy.dayStartMinute,
        );
        if (repos.tvt.findAttendeesForSiteAndDate) {
          const attendees = await repos.tvt.findAttendeesForSiteAndDate(
            companyId,
            site.id,
            businessDate,
            input.employeeIds,
          );
          attendedTvtSet = new Set(attendees);
        } else {
          await Promise.all(
            input.employeeIds.map(async (id) => {
              const has = await repos.tvt.hasAttended(companyId, site.id, id, businessDate);
              if (has) attendedTvtSet.add(id);
            }),
          );
        }
      }

      const results: {
        employeeId: string;
        sessionId?: string;
        success: boolean;
        error?: string;
        isFlagged?: boolean;
        flagReason?: string | null;
      }[] = [];

      let successCount = 0;
      let failureCount = 0;

      for (const employeeId of input.employeeIds) {
        const emp = employeeMap.get(employeeId);
        if (emp?.status !== 'ACTIVE') {
          results.push({ employeeId, success: false, error: 'EMPLOYEE_NOT_ACTIVE' });
          failureCount++;
          continue;
        }

        if (activeSessionEmployeeIds.has(employeeId)) {
          results.push({ employeeId, success: false, error: 'ACTIVE_SESSION_EXISTS' });
          failureCount++;
          continue;
        }

        const policy = employeePolicyMap.get(employeeId) ?? basePolicy;
        const policyIdToPersist =
          policy.id === 'default-fallback' ? (fallbackPersistedPolicyId ?? policy.id) : policy.id;

        if (!isWithinGeofence && policy.geofenceStrict) {
          results.push({ employeeId, success: false, error: 'GEOFENCE_BREACH' });
          failureCount++;
          continue;
        }

        const businessDate = getBusinessDate(
          punchInAt,
          timezone,
          policy.dayStartHour,
          policy.dayStartMinute,
        );

        let isFlagged = !isWithinGeofence;
        let flagReason = !isWithinGeofence ? 'Geofence breach on punch in' : null;

        if (policy.requireTvtGate) {
          const hasAttendedTvt = attendedTvtSet.has(employeeId);
          if (!hasAttendedTvt) {
            if (policy.tvtGateAction === 'BLOCK') {
              results.push({
                employeeId,
                success: false,
                error: 'TVT_SAFETY_BRIEFING_REQUIRED',
              });
              failureCount++;
              continue;
            } else {
              isFlagged = true;
              flagReason = flagReason
                ? `${flagReason}; Safety TVT briefing missed`
                : 'Safety TVT briefing missed';
            }
          }
        }

        try {
          const session = await repos.sessions.create(companyId, {
            employee: { connect: { id: employeeId } },
            site: { connect: { id: site.id } },
            policy: { connect: { id: policyIdToPersist } },
            businessDate,
            status: 'IN_PROGRESS',
            source: 'SUPERVISOR_KIOSK',
            punchInAt,
            punchInLat: input.latitude,
            punchInLng: input.longitude,
            punchInDistanceM: distanceM,
            punchInWithinGeofence: isWithinGeofence,
            punchInRemarks: input.remarks ?? null,
            punchInSupervisorId: actor.actorId,
            isFlagged,
            flagReason,
          });

          activeSessionEmployeeIds.add(employeeId);

          results.push({
            employeeId,
            sessionId: session.id,
            success: true,
            isFlagged,
            flagReason,
          });
          successCount++;
        } catch (err: unknown) {
          results.push({
            employeeId,
            success: false,
            error: err instanceof Error ? err.message : 'UNKNOWN_ERROR',
          });
          failureCount++;
        }
      }

      await repos.audit.record(
        auditEntry(actor, {
          action: 'ATTENDANCE_KIOSK_BATCH_PUNCH_IN',
          entityType: 'ATTENDANCE_SESSION',
          entityId: input.siteId,
          companyId,
          metadata: {
            siteId: input.siteId,
            totalSubmitted: input.employeeIds.length,
            successCount,
            failureCount,
          },
        }),
      );

      return {
        siteId: input.siteId,
        totalSubmitted: input.employeeIds.length,
        successCount,
        failureCount,
        results,
      };
    });
  }

  async kioskBatchPunchOut(actor: ActorContext, companyId: string, input: KioskBatchPunchOutInput) {
    await this.authorizer.assertPermission(
      actor.actorId,
      ATTENDANCE_RECORD,
      siteTarget(companyId, input.siteId),
    );

    return this.uow.run(async (repos) => {
      const site = await repos.sites.findById(companyId, input.siteId);
      if (!site) throw new AttendanceEntityNotFoundError('Site', input.siteId);

      const punchOutAt = input.punchOutAt ? new Date(input.punchOutAt) : new Date();

      let distanceM: number | null = null;
      let isWithinGeofence = true;
      if (site.geoLatitude !== null && site.geoLongitude !== null) {
        distanceM = calculateHaversineDistanceMeters(
          input.latitude,
          input.longitude,
          Number(site.geoLatitude),
          Number(site.geoLongitude),
        );
        const radiusM = site.geoFenceRadiusM ?? 100;
        if (distanceM > radiusM) {
          isWithinGeofence = false;
        }
      }

      // Pre-batch active sessions
      const activeSessions = repos.sessions.findActiveMany
        ? await repos.sessions.findActiveMany(companyId, input.employeeIds)
        : await Promise.all(
          input.employeeIds.map(async (id) => {
            const s = await repos.sessions.findActive(companyId, id);
            return s
              ? {
                ...s,
                employeeId:
                  'employeeId' in s && typeof s.employeeId === 'string' && s.employeeId
                    ? s.employeeId
                    : id,
              }
              : null;
          }),
        ).then((list) => list.filter((s): s is NonNullable<typeof s> => s !== null));

      const sessionMap = new Map(activeSessions.map((s) => [s.employeeId, s]));

      const results: {
        employeeId: string;
        sessionId?: string;
        success: boolean;
        error?: string;
        netDurationMins?: number;
        presentUnits?: number;
        overtimePUnits?: number;
        totalPUnits?: number;
        overtimeHours?: number;
      }[] = [];

      let successCount = 0;
      let failureCount = 0;

      for (const employeeId of input.employeeIds) {
        const session = sessionMap.get(employeeId);
        if (!session) {
          results.push({ employeeId, success: false, error: 'NO_ACTIVE_SESSION' });
          failureCount++;
          continue;
        }

        if (session.siteId && session.siteId !== input.siteId) {
          results.push({ employeeId, success: false, error: 'SESSION_SITE_MISMATCH' });
          failureCount++;
          continue;
        }

        const sessionPolicy =
          'policy' in session && session.policy ? (session.policy as AttendancePolicy) : null;
        const policy: AttendancePolicy =
          sessionPolicy ??
          (await repos.policies.findById(companyId, session.policyId)) ??
          createDefaultPolicyFallback(companyId);

        const grossDurationMins = Math.max(
          0,
          Math.round((punchOutAt.getTime() - session.punchInAt.getTime()) / 60000),
        );

        let dynamicBreaksMins = 0;
        if (policy.breakMode === 'DYNAMIC') {
          const allBreaks = session.breaks;
          dynamicBreaksMins = allBreaks.reduce((acc, b) => acc + (b.durationMins || 0), 0);
        }

        const calc = calculateWorkAndOvertime({
          grossMinutes: grossDurationMins,
          breakMinutes: dynamicBreaksMins,
          policy,
        });

        let isFlagged = session.isFlagged;
        let flagReason = session.flagReason;
        if (!isWithinGeofence) {
          isFlagged = true;
          const radiusM = site.geoFenceRadiusM ?? 100;
          const outReason = `Punch-out outside geofence (${distanceM}m vs ${radiusM}m)`;
          flagReason = flagReason ? `${flagReason}; ${outReason}` : outReason;
        }

        try {
          await repos.sessions.update(companyId, session.id, {
            punchOutAt,
            punchOutLat: input.latitude,
            punchOutLng: input.longitude,
            punchOutDistanceM: distanceM,
            punchOutWithinGeofence: isWithinGeofence,
            punchOutRemarks: input.remarks ?? null,
            punchOutSupervisorId: actor.actorId,
            grossDurationMins,
            breakDurationMins: calc.breakDurationMins,
            netDurationMins: calc.netDurationMins,
            presentUnits: calc.presentUnits,
            overtimePUnits: calc.overtimePUnits,
            totalPUnits: calc.totalPUnits,
            overtimeHours: calc.overtimeHours,
            status: 'COMPLETED',
            isFlagged,
            flagReason,
          });

          results.push({
            employeeId,
            sessionId: session.id,
            success: true,
            netDurationMins: calc.netDurationMins,
            presentUnits: calc.presentUnits,
            overtimePUnits: calc.overtimePUnits,
            totalPUnits: calc.totalPUnits,
            overtimeHours: calc.overtimeHours,
          });
          successCount++;
        } catch (err: unknown) {
          results.push({
            employeeId,
            success: false,
            error: err instanceof Error ? err.message : 'UNKNOWN_ERROR',
          });
          failureCount++;
        }
      }

      await repos.audit.record(
        auditEntry(actor, {
          action: 'ATTENDANCE_KIOSK_BATCH_PUNCH_OUT',
          entityType: 'ATTENDANCE_SESSION',
          entityId: input.siteId,
          companyId,
          metadata: {
            siteId: input.siteId,
            totalSubmitted: input.employeeIds.length,
            successCount,
            failureCount,
          },
        }),
      );

      return {
        siteId: input.siteId,
        totalSubmitted: input.employeeIds.length,
        successCount,
        failureCount,
        results,
      };
    });
  }

  async kioskOfflineSync(actor: ActorContext, companyId: string, input: KioskOfflineSyncInput) {
    await this.authorizer.assertPermission(
      actor.actorId,
      ATTENDANCE_RECORD,
      siteTarget(companyId, input.siteId),
    );

    return this.uow.run(async (repos) => {
      const site = await repos.sites.findById(companyId, input.siteId);
      if (!site) throw new AttendanceEntityNotFoundError('Site', input.siteId);

      const timezone = site.timezone ?? site.project.timezone;

      // Pre-batch check existing client session IDs
      const clientSessionIds = input.sessions.map((s) => s.clientSessionId);
      const existingSessions = repos.sessions.findManyByClientSessionIds
        ? await repos.sessions.findManyByClientSessionIds(companyId, clientSessionIds)
        : await Promise.all(
          clientSessionIds.map((cid) => repos.sessions.findByClientSessionId(companyId, cid)),
        ).then((list) => list.filter((s): s is AttendanceSession => s !== null));
      const existingSessionMap = new Map<string, AttendanceSession>();
      for (const s of existingSessions) {
        if (s.clientSessionId) {
          existingSessionMap.set(s.clientSessionId, s);
        }
      }

      // Resolve base policy once
      const basePolicy =
        (await repos.policies.findEffective(companyId, {
          siteId: site.id,
          projectId: site.projectId,
        })) ?? createDefaultPolicyFallback(companyId);

      const distinctEmployeeIds = [...new Set(input.sessions.map((s) => s.employeeId))];
      const employeePolicies = repos.policies.findEmployeePolicies
        ? await repos.policies.findEmployeePolicies(companyId, distinctEmployeeIds)
        : [];
      const employeePolicyMap = new Map<string, AttendancePolicy>();
      for (const p of employeePolicies) {
        if (p.employeeId) {
          employeePolicyMap.set(p.employeeId, p);
        }
      }

      // Pre-batch employees to verify ACTIVE status
      const employees = repos.employees.findManyByIds
        ? await repos.employees.findManyByIds(companyId, distinctEmployeeIds)
        : await Promise.all(
          distinctEmployeeIds.map(async (id) => repos.employees.findById(companyId, id)),
        ).then((list) => list.filter((e): e is NonNullable<typeof e> => e !== null));
      const employeeMap = new Map(employees.map((e) => [e.id, e]));

      // Pre-batch active sessions to detect duplicate active sessions
      const activeSessions = repos.sessions.findActiveMany
        ? await repos.sessions.findActiveMany(companyId, distinctEmployeeIds)
        : await Promise.all(
          distinctEmployeeIds.map(async (id) => repos.sessions.findActive(companyId, id)),
        ).then((list) => list.filter((s): s is NonNullable<typeof s> => s !== null));
      const activeEmployeeSet = new Set<string>(activeSessions.map((s) => s.employeeId));

      // Pre-batch TVT attendance grouped by business date — each item can map
      // to a different date (its own punchInAt + per-employee dayStart).
      const tvtEmployeeIdsByDate = new Map<string, Set<string>>();
      for (const item of input.sessions) {
        const policy = employeePolicyMap.get(item.employeeId) ?? basePolicy;
        if (!policy.requireTvtGate) continue;
        const businessDate = getBusinessDate(
          new Date(item.punchInAt),
          timezone,
          policy.dayStartHour,
          policy.dayStartMinute,
        );
        const ids = tvtEmployeeIdsByDate.get(businessDate) ?? new Set<string>();
        ids.add(item.employeeId);
        tvtEmployeeIdsByDate.set(businessDate, ids);
      }
      const attendedTvtSet = new Set<string>();
      for (const [businessDate, employeeIds] of tvtEmployeeIdsByDate) {
        if (repos.tvt.findAttendeesForSiteAndDate) {
          const attendees = await repos.tvt.findAttendeesForSiteAndDate(
            companyId,
            site.id,
            businessDate,
            [...employeeIds],
          );
          for (const empId of attendees) attendedTvtSet.add(`${businessDate}|${empId}`);
        } else {
          await Promise.all(
            [...employeeIds].map(async (empId) => {
              const has = await repos.tvt.hasAttended(companyId, site.id, empId, businessDate);
              if (has) attendedTvtSet.add(`${businessDate}|${empId}`);
            }),
          );
        }
      }

      let fallbackPersistedPolicyId: string | null = null;
      if (basePolicy.id === 'default-fallback') {
        const compPolicy = repos.policies.ensureDefaultPolicy
          ? await repos.policies.ensureDefaultPolicy(companyId)
          : await repos.policies.create(companyId, {
            name: 'Company Default Policy',
            scope: 'COMPANY',
          });
        fallbackPersistedPolicyId = compPolicy.id;
      }

      const results: {
        clientSessionId: string;
        status: 'SYNCED' | 'ALREADY_SYNCED' | 'FAILED';
        sessionId?: string;
        error?: string;
      }[] = [];

      let syncedCount = 0;
      let alreadySyncedCount = 0;
      let failedCount = 0;

      for (const item of input.sessions) {
        const existing = existingSessionMap.get(item.clientSessionId);
        if (existing) {
          results.push({
            clientSessionId: item.clientSessionId,
            status: 'ALREADY_SYNCED',
            sessionId: existing.id,
          });
          alreadySyncedCount++;
          continue;
        }

        const emp = employeeMap.get(item.employeeId);
        if (emp?.status !== 'ACTIVE') {
          results.push({
            clientSessionId: item.clientSessionId,
            status: 'FAILED',
            error: 'EMPLOYEE_NOT_ACTIVE',
          });
          failedCount++;
          continue;
        }

        const isStartingNewSession = !item.punchOutAt;
        if (isStartingNewSession && activeEmployeeSet.has(item.employeeId)) {
          results.push({
            clientSessionId: item.clientSessionId,
            status: 'FAILED',
            error: 'ACTIVE_SESSION_EXISTS',
          });
          failedCount++;
          continue;
        }

        const punchInAt = new Date(item.punchInAt);
        const policy = employeePolicyMap.get(item.employeeId) ?? basePolicy;
        const policyIdToPersist =
          policy.id === 'default-fallback' ? (fallbackPersistedPolicyId ?? policy.id) : policy.id;

        const businessDate = getBusinessDate(
          punchInAt,
          timezone,
          policy.dayStartHour,
          policy.dayStartMinute,
        );

        let isFlagged = false;
        let flagReason: string | null = null;
        let punchInDistanceM: number | null = null;
        let punchInWithinGeofence = true;
        let punchOutDistanceM: number | null = null;
        let punchOutWithinGeofence = true;
        const radiusM = site.geoFenceRadiusM ?? 100;

        if (site.geoLatitude !== null && site.geoLongitude !== null) {
          if (item.punchInLat !== undefined && item.punchInLng !== undefined) {
            punchInDistanceM = calculateHaversineDistanceMeters(
              item.punchInLat,
              item.punchInLng,
              Number(site.geoLatitude),
              Number(site.geoLongitude),
            );
            if (punchInDistanceM > radiusM) {
              punchInWithinGeofence = false;
              isFlagged = true;
              flagReason = `Punch-in outside geofence (${punchInDistanceM}m vs ${radiusM}m)`;
            }
          }
          if (item.punchOutLat !== undefined && item.punchOutLng !== undefined) {
            punchOutDistanceM = calculateHaversineDistanceMeters(
              item.punchOutLat,
              item.punchOutLng,
              Number(site.geoLatitude),
              Number(site.geoLongitude),
            );
            if (punchOutDistanceM > radiusM) {
              punchOutWithinGeofence = false;
              isFlagged = true;
              const outReason = `Punch-out outside geofence (${punchOutDistanceM}m vs ${radiusM}m)`;
              flagReason = flagReason ? `${flagReason}; ${outReason}` : outReason;
            }
          }
        }

        if (policy.requireTvtGate) {
          const hasAttended = attendedTvtSet.has(`${businessDate}|${item.employeeId}`);
          if (!hasAttended) {
            if (policy.tvtGateAction === 'BLOCK') {
              results.push({
                clientSessionId: item.clientSessionId,
                status: 'FAILED',
                error: 'TVT_SAFETY_BRIEFING_REQUIRED',
              });
              failedCount++;
              continue;
            } else {
              isFlagged = true;
              flagReason = flagReason
                ? `${flagReason}; Safety TVT briefing missed`
                : 'Safety TVT briefing missed';
            }
          }
        }

        let grossDurationMins = 0;
        let breakDurationMins = 0;
        let netDurationMins = 0;
        let presentUnits = 0;
        let overtimePUnits = 0;
        let totalPUnits = 0;
        let overtimeHours = 0;
        let status: 'IN_PROGRESS' | 'COMPLETED' = 'IN_PROGRESS';
        let punchOutAt: Date | null = null;

        if (item.punchOutAt) {
          punchOutAt = new Date(item.punchOutAt);
          status = 'COMPLETED';
          grossDurationMins = Math.max(
            0,
            Math.round((punchOutAt.getTime() - punchInAt.getTime()) / 60000),
          );
          const calc = calculateWorkAndOvertime({
            grossMinutes: grossDurationMins,
            breakMinutes: 0,
            policy,
          });
          breakDurationMins = calc.breakDurationMins;
          netDurationMins = calc.netDurationMins;
          presentUnits = calc.presentUnits;
          overtimePUnits = calc.overtimePUnits;
          totalPUnits = calc.totalPUnits;
          overtimeHours = calc.overtimeHours;
        }

        try {
          const session = await repos.sessions.create(companyId, {
            employee: { connect: { id: item.employeeId } },
            site: { connect: { id: site.id } },
            policy: { connect: { id: policyIdToPersist } },
            businessDate,
            status,
            source: 'SUPERVISOR_KIOSK',
            punchInAt,
            ...(item.punchInLat !== undefined ? { punchInLat: item.punchInLat } : {}),
            ...(item.punchInLng !== undefined ? { punchInLng: item.punchInLng } : {}),
            punchInDistanceM,
            punchInWithinGeofence,
            punchInSupervisorId: actor.actorId,
            punchInRemarks: item.remarks ?? null,
            punchOutAt,
            ...(item.punchOutLat !== undefined ? { punchOutLat: item.punchOutLat } : {}),
            ...(item.punchOutLng !== undefined ? { punchOutLng: item.punchOutLng } : {}),
            punchOutDistanceM,
            punchOutWithinGeofence,
            punchOutSupervisorId: punchOutAt ? actor.actorId : null,
            grossDurationMins,
            breakDurationMins,
            netDurationMins,
            presentUnits,
            overtimePUnits,
            totalPUnits,
            overtimeHours,
            isFlagged,
            flagReason,
            clientSessionId: item.clientSessionId,
            syncBatchId: input.syncBatchId,
            isSyncedOffline: true,
          });

          if (status === 'IN_PROGRESS') {
            activeEmployeeSet.add(item.employeeId);
          }

          existingSessionMap.set(item.clientSessionId, session);

          results.push({
            clientSessionId: item.clientSessionId,
            status: 'SYNCED',
            sessionId: session.id,
          });
          syncedCount++;
        } catch (err: unknown) {
          if (err instanceof ActiveSessionExistsError) {
            results.push({
              clientSessionId: item.clientSessionId,
              status: 'FAILED',
              error: 'ACTIVE_SESSION_EXISTS',
            });
            failedCount++;
          } else {
            // Concurrent collision or duplicate
            results.push({
              clientSessionId: item.clientSessionId,
              status: 'ALREADY_SYNCED',
            });
            alreadySyncedCount++;
          }
        }
      }

      await repos.audit.record(
        auditEntry(actor, {
          action: 'ATTENDANCE_KIOSK_OFFLINE_SYNC',
          entityType: 'ATTENDANCE_SESSION',
          entityId: input.syncBatchId,
          companyId,
          metadata: {
            siteId: input.siteId,
            syncBatchId: input.syncBatchId,
            totalSubmitted: input.sessions.length,
            syncedCount,
            alreadySyncedCount,
            failedCount,
          },
        }),
      );

      return {
        syncBatchId: input.syncBatchId,
        siteId: input.siteId,
        totalSubmitted: input.sessions.length,
        syncedCount,
        alreadySyncedCount,
        failedCount,
        results,
      };
    });
  }

  // -------------------------------------------------------------------------
  // Safety Toolbox Talk (TVT) Gate Operations
  // -------------------------------------------------------------------------

  async createTvtSession(actor: ActorContext, companyId: string, input: CreateTvtSessionInput) {
    await this.authorizer.assertPermission(
      actor.actorId,
      ATTENDANCE_RECORD,
      siteTarget(companyId, input.siteId),
    );

    return this.uow.run(async (repos) => {
      const site = await repos.sites.findById(companyId, input.siteId);
      if (!site) throw new AttendanceEntityNotFoundError('Site', input.siteId);

      const conductedAt = input.conductedAt ? new Date(input.conductedAt) : new Date();
      const timezone = site.timezone ?? site.project.timezone;
      const businessDate = input.businessDate ?? getBusinessDate(conductedAt, timezone);

      const conductedByEmp = await repos.employees.findByPrincipal(companyId, actor.actorId);
      const conductedBy = conductedByEmp ? conductedByEmp.id : actor.actorId;

      const session = await repos.tvt.create(companyId, {
        siteId: input.siteId,
        businessDate,
        topic: input.topic,
        conductedAt,
        conductedBy,
        ...(input.remarks !== undefined ? { remarks: input.remarks } : {}),
        ...(input.attendeeEmployeeIds !== undefined
          ? { attendeeEmployeeIds: input.attendeeEmployeeIds }
          : {}),
      });

      await repos.audit.record(
        auditEntry(actor, {
          action: 'ATTENDANCE_SAFETY_TVT_CREATED',
          entityType: 'SAFETY_TVT_SESSION',
          entityId: session.id,
          companyId,
          metadata: {
            siteId: input.siteId,
            businessDate,
            topic: input.topic,
            attendeeCount: session.attendees.length,
          },
        }),
      );

      return session;
    });
  }

  async listTvtSessions(actor: ActorContext, companyId: string, filter: ListTvtSessionsFilter) {
    const target = filter.siteId ? siteTarget(companyId, filter.siteId) : companyTarget(companyId);
    await this.authorizer.assertPermission(actor.actorId, ATTENDANCE_READ, target);

    return this.uow.run((repos) => repos.tvt.list(companyId, filter));
  }

  async getTvtSession(actor: ActorContext, companyId: string, id: string) {
    await this.authorizer.assertPermission(
      actor.actorId,
      ATTENDANCE_READ,
      companyTarget(companyId),
    );

    return this.uow.run(async (repos) => {
      const session = await repos.tvt.findById(companyId, id);
      if (!session) throw new AttendanceEntityNotFoundError('SafetyTvtSession', id);
      return session;
    });
  }

  async addTvtAttendees(
    actor: ActorContext,
    companyId: string,
    sessionId: string,
    input: AddTvtAttendeesInput,
  ) {
    const existing = await this.uow.run((repos) => repos.tvt.findById(companyId, sessionId));
    if (!existing) throw new AttendanceEntityNotFoundError('SafetyTvtSession', sessionId);

    await this.authorizer.assertPermission(
      actor.actorId,
      ATTENDANCE_RECORD,
      siteTarget(companyId, existing.siteId),
    );

    return this.uow.run(async (repos) => {
      const addedCount = await repos.tvt.addAttendees(companyId, sessionId, input.employeeIds);

      await repos.audit.record(
        auditEntry(actor, {
          action: 'ATTENDANCE_SAFETY_TVT_ATTENDEES_ADDED',
          entityType: 'SAFETY_TVT_SESSION',
          entityId: sessionId,
          companyId,
          metadata: {
            sessionId,
            addedCount,
            submittedCount: input.employeeIds.length,
          },
        }),
      );

      return {
        sessionId,
        addedCount,
        totalAttendees: existing.attendees.length + addedCount,
      };
    });
  }

  // -------------------------------------------------------------------------
  // Muster Roll Range Settlement Export
  // -------------------------------------------------------------------------

  async getMusterRollRange(actor: ActorContext, companyId: string, filter: MusterRollRangeFilter) {
    await this.authorizer.assertPermission(
      actor.actorId,
      ATTENDANCE_READ,
      siteTarget(companyId, filter.siteId),
    );

    const fromDate = new Date(`${filter.from}T00:00:00.000Z`);
    const toDate = new Date(`${filter.to}T00:00:00.000Z`);

    if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
      throw new InvalidDateRangeError('Invalid date format. Expected YYYY-MM-DD');
    }

    if (fromDate.getTime() > toDate.getTime()) {
      throw new InvalidDateRangeError("'from' date must be on or before 'to' date");
    }

    const diffDays =
      Math.round((toDate.getTime() - fromDate.getTime()) / (1000 * 60 * 60 * 24)) + 1;
    if (diffDays > MAX_MUSTER_ROLL_DAYS) {
      throw new InvalidDateRangeError(
        `Date range cannot exceed ${MAX_MUSTER_ROLL_DAYS} days (requested ${diffDays} days)`,
      );
    }

    return this.uow.run((repos) => repos.sessions.getMusterRollRange(companyId, filter));
  }

  // -------------------------------------------------------------------------
  // Daily Site Report (DSR) & End-of-Day Settlement Engine
  // -------------------------------------------------------------------------

  private async internalRecalculateReport(
    repos: AttendanceRepos,
    companyId: string,
    siteId: string,
    businessDate: string,
    actorId?: string,
    reason?: string,
  ) {
    const site = await repos.sites.findById(companyId, siteId);
    if (!site) return null;

    const summary = await repos.sessions.getDailySummary(companyId, siteId, businessDate);
    const sessions = summary.sessions;

    let catAStaffCount = 0;
    let catAStaffUnits = 0;
    let catBDirectCount = 0;
    let catBDirectUnits = 0;
    let catCSubconCount = 0;
    let catCSubconUnits = 0;

    const labourMap = new Map<
      string,
      {
        category: LabourCategory;
        tradeCategory: string;
        headcount: number;
        presentUnits: number;
        overtimeHours: number;
      }
    >();

    for (const s of sessions) {
      const trade = (s.employee.tradeCategory ?? 'GENERAL').toUpperCase();
      let cat: LabourCategory = 'CAT_B_DIRECT_LABOUR';

      if (
        trade.includes('STAFF') ||
        trade.includes('ENGINEER') ||
        trade.includes('MANAGER') ||
        trade.includes('SUPERVISOR') ||
        trade.includes('OFFICE') ||
        trade.includes('HSE') ||
        trade.includes('QS') ||
        trade.includes('STORE') ||
        trade.includes('ACCOUNTS')
      ) {
        cat = 'CAT_A_STAFF';
        catAStaffCount += 1;
        catAStaffUnits += Number(s.presentUnits);
      } else if (
        trade.includes('SUBCON') ||
        trade.includes('GANG') ||
        trade.includes('CONTRACTOR')
      ) {
        cat = 'CAT_C_SUBCONTRACTOR';
        catCSubconCount += 1;
        catCSubconUnits += Number(s.presentUnits);
      } else {
        cat = 'CAT_B_DIRECT_LABOUR';
        catBDirectCount += 1;
        catBDirectUnits += Number(s.presentUnits);
      }

      const key = `${cat}:${trade}`;
      const entry = labourMap.get(key) ?? {
        category: cat,
        tradeCategory: trade,
        headcount: 0,
        presentUnits: 0,
        overtimeHours: 0,
      };
      entry.headcount += 1;
      entry.presentUnits += Number(s.presentUnits);
      entry.overtimeHours += Number(s.overtimeHours);
      labourMap.set(key, entry);
    }

    const labourSummaries = Array.from(labourMap.values());

    const totalWorkersHeadcount = sessions.length;
    const totalPresentUnits = summary.totalPresentUnits;
    const totalOvertimeHours = summary.totalOvertimeHours;
    const totalOvertimePUnits = summary.totalOvertimePUnits;
    const totalFlaggedSessions = sessions.filter((s) => s.isFlagged).length;

    const report = await repos.dailyReports.upsert(companyId, {
      siteId,
      projectId: site.projectId,
      businessDate,
      totalWorkersHeadcount,
      totalPresentUnits,
      totalOvertimeHours,
      totalOvertimePUnits,
      totalFlaggedSessions,
      catAStaffCount,
      catAStaffUnits,
      catBDirectCount,
      catBDirectUnits,
      catCSubconCount,
      catCSubconUnits,
      labourSummaries,
    });

    if (actorId && reason) {
      await repos.dailyReports.addAuditLog(companyId, report.id, {
        actorId,
        action: 'AUTO_CALCULATED',
        reason,
      });
    }

    return report;
  }

  async calculateDailyReport(
    actor: ActorContext,
    companyId: string,
    input: CalculateDailyReportInput,
  ): Promise<DailySiteReport & { labourSummaries: DailySiteReportLabour[] }> {
    await this.authorizer.assertPermission(
      actor.actorId,
      ATTENDANCE_MANAGE,
      siteTarget(companyId, input.siteId),
    );

    return this.uow.run(async (repos) => {
      const existing = await repos.dailyReports.findBySiteAndDate(
        companyId,
        input.siteId,
        input.businessDate,
      );
      if (existing?.status === 'LOCKED') {
        throw new DailyReportAlreadyLockedError(existing.id);
      }

      // Auto-close in-progress sessions at settlement
      const summary = await repos.sessions.getDailySummary(
        companyId,
        input.siteId,
        input.businessDate,
      );
      for (const s of summary.sessions) {
        if (s.status === 'IN_PROGRESS') {
          await repos.sessions.update(companyId, s.id, {
            status: 'AUTO_CLOSED',
            isFlagged: true,
            flagReason: 'MISSING_PUNCH_OUT',
            punchOutRemarks: 'Auto-closed at daily settlement due to missing punch out',
          });
        }
      }

      const report = await this.internalRecalculateReport(
        repos,
        companyId,
        input.siteId,
        input.businessDate,
        actor.actorId,
        'Triggered manual calculation',
      );
      if (!report) {
        throw new AttendanceEntityNotFoundError('Site', input.siteId);
      }
      return report;
    });
  }

  async getDailyReports(
    actor: ActorContext,
    companyId: string,
    filter: ListDailyReportsFilter,
  ) {
    if (filter.siteId) {
      await this.authorizer.assertPermission(
        actor.actorId,
        ATTENDANCE_READ,
        siteTarget(companyId, filter.siteId),
      );
    } else {
      await this.authorizer.assertPermission(
        actor.actorId,
        ATTENDANCE_READ,
        companyTarget(companyId),
      );
    }
    return this.uow.run((repos) => repos.dailyReports.list(companyId, filter));
  }

  async getDailyReportById(actor: ActorContext, companyId: string, id: string) {
    return this.uow.run(async (repos) => {
      const report = await repos.dailyReports.findById(companyId, id);
      if (!report) {
        throw new DailyReportNotFoundError(id);
      }
      await this.authorizer.assertPermission(
        actor.actorId,
        ATTENDANCE_READ,
        siteTarget(companyId, report.siteId),
      );
      return report;
    });
  }

  async updateDailyReport(
    actor: ActorContext,
    companyId: string,
    id: string,
    input: UpdateDailyReportInput,
  ) {
    return this.uow.run(async (repos) => {
      const report = await repos.dailyReports.findById(companyId, id);
      if (!report) throw new DailyReportNotFoundError(id);
      if (report.status === 'LOCKED') throw new DailyReportAlreadyLockedError(id);

      await this.authorizer.assertPermission(
        actor.actorId,
        ATTENDANCE_MANAGE,
        siteTarget(companyId, report.siteId),
      );

      const updateData: Prisma.DailySiteReportUpdateInput = {
        ...(input.weather ? { weather: input.weather } : {}),
        ...(input.weatherStoppageHours !== undefined
          ? { weatherStoppageHours: input.weatherStoppageHours }
          : {}),
        ...(input.workProgressNotes !== undefined
          ? { workProgressNotes: input.workProgressNotes }
          : {}),
        ...(input.siteObstaclesRemarks !== undefined
          ? { siteObstaclesRemarks: input.siteObstaclesRemarks }
          : {}),
        ...(input.safetyIncidentReported !== undefined
          ? { safetyIncidentReported: input.safetyIncidentReported }
          : {}),
        ...(input.safetyNotes !== undefined ? { safetyNotes: input.safetyNotes } : {}),
      };

      const updated = await repos.dailyReports.update(
        companyId,
        id,
        updateData,
        input.version,
      );

      await repos.dailyReports.addAuditLog(companyId, id, {
        actorId: actor.actorId,
        action: 'EDITED_HEADER',
        reason: 'Updated report header & conditions',
      });

      return updated;
    });
  }

  async updateLabourSummary(
    actor: ActorContext,
    companyId: string,
    id: string,
    summaryId: string,
    input: UpdateLabourSummaryInput,
  ) {
    return this.uow.run(async (repos) => {
      const report = await repos.dailyReports.findById(companyId, id);
      if (!report) throw new DailyReportNotFoundError(id);
      if (report.status === 'LOCKED') throw new DailyReportAlreadyLockedError(id);

      await this.authorizer.assertPermission(
        actor.actorId,
        ATTENDANCE_MANAGE,
        siteTarget(companyId, report.siteId),
      );

      await repos.dailyReports.updateLabourSummary(companyId, id, summaryId, {
        ...(input.headcount !== undefined ? { headcount: input.headcount } : {}),
        ...(input.presentUnits !== undefined ? { presentUnits: input.presentUnits } : {}),
        ...(input.overtimeHours !== undefined ? { overtimeHours: input.overtimeHours } : {}),
        ...(input.remarks !== undefined ? { remarks: input.remarks } : {}),
      });

      // Re-aggregate parent report totals from all labour summaries
      const allSummaries = await repos.dailyReports.findById(companyId, id);
      if (allSummaries) {
        let totalWorkersHeadcount = 0;
        let totalPresentUnits = 0;
        let totalOvertimeHours = 0;
        let catAStaffCount = 0;
        let catAStaffUnits = 0;
        let catBDirectCount = 0;
        let catBDirectUnits = 0;
        let catCSubconCount = 0;
        let catCSubconUnits = 0;

        for (const s of allSummaries.labourSummaries) {
          totalWorkersHeadcount += s.headcount;
          totalPresentUnits += Number(s.presentUnits);
          totalOvertimeHours += Number(s.overtimeHours);

          if (s.category === 'CAT_A_STAFF') {
            catAStaffCount += s.headcount;
            catAStaffUnits += Number(s.presentUnits);
          } else if (s.category === 'CAT_C_SUBCONTRACTOR') {
            catCSubconCount += s.headcount;
            catCSubconUnits += Number(s.presentUnits);
          } else {
            catBDirectCount += s.headcount;
            catBDirectUnits += Number(s.presentUnits);
          }
        }

        await repos.dailyReports.update(companyId, id, {
          totalWorkersHeadcount,
          totalPresentUnits,
          totalOvertimeHours,
          catAStaffCount,
          catAStaffUnits,
          catBDirectCount,
          catBDirectUnits,
          catCSubconCount,
          catCSubconUnits,
        });
      }

      await repos.dailyReports.addAuditLog(companyId, id, {
        actorId: actor.actorId,
        action: 'EDITED_LABOUR_SUMMARY',
        reason: input.reason,
      });

      return repos.dailyReports.findById(companyId, id);
    });
  }

  async submitDailyReport(actor: ActorContext, companyId: string, id: string) {
    return this.uow.run(async (repos) => {
      const report = await repos.dailyReports.findById(companyId, id);
      if (!report) throw new DailyReportNotFoundError(id);
      if (report.status === 'LOCKED') throw new DailyReportAlreadyLockedError(id);
      if (report.status !== 'DRAFT' && report.status !== 'REJECTED') {
        throw new DailyReportInvalidStateTransitionError(report.status, 'SUBMITTED');
      }

      await this.authorizer.assertPermission(
        actor.actorId,
        ATTENDANCE_RECORD,
        siteTarget(companyId, report.siteId),
      );

      const emp = await repos.employees.findByPrincipal(companyId, actor.actorId);

      const updated = await repos.dailyReports.update(companyId, id, {
        status: 'SUBMITTED',
        submittedAt: new Date(),
        rejectionReason: null,
        ...(emp ? { submittedBy: { connect: { id_companyId: { id: emp.id, companyId } } } } : {}),
      });

      await repos.dailyReports.addAuditLog(companyId, id, {
        actorId: actor.actorId,
        action: 'SUBMITTED',
        reason: 'Submitted for PM review',
      });

      return updated;
    });
  }

  async approveDailyReport(actor: ActorContext, companyId: string, id: string) {
    return this.uow.run(async (repos) => {
      const report = await repos.dailyReports.findById(companyId, id);
      if (!report) throw new DailyReportNotFoundError(id);
      if (report.status === 'LOCKED') throw new DailyReportAlreadyLockedError(id);
      if (report.status !== 'SUBMITTED' && report.status !== 'DRAFT') {
        throw new DailyReportInvalidStateTransitionError(report.status, 'APPROVED');
      }

      await this.authorizer.assertPermission(
        actor.actorId,
        ATTENDANCE_MANAGE,
        siteTarget(companyId, report.siteId),
      );

      const emp = await repos.employees.findByPrincipal(companyId, actor.actorId);

      const updated = await repos.dailyReports.update(companyId, id, {
        status: 'APPROVED',
        approvedAt: new Date(),
        ...(emp ? { approvedBy: { connect: { id_companyId: { id: emp.id, companyId } } } } : {}),
      });

      await repos.dailyReports.addAuditLog(companyId, id, {
        actorId: actor.actorId,
        action: 'APPROVED',
        reason: 'Approved by Project Manager',
      });

      return updated;
    });
  }

  async rejectDailyReport(
    actor: ActorContext,
    companyId: string,
    id: string,
    input: RejectDailyReportInput,
  ) {
    return this.uow.run(async (repos) => {
      const report = await repos.dailyReports.findById(companyId, id);
      if (!report) throw new DailyReportNotFoundError(id);
      if (report.status === 'LOCKED') throw new DailyReportAlreadyLockedError(id);
      if (report.status !== 'SUBMITTED') {
        throw new DailyReportInvalidStateTransitionError(report.status, 'REJECTED');
      }

      await this.authorizer.assertPermission(
        actor.actorId,
        ATTENDANCE_MANAGE,
        siteTarget(companyId, report.siteId),
      );

      const updated = await repos.dailyReports.update(companyId, id, {
        status: 'REJECTED',
        rejectionReason: input.reason,
      });

      await repos.dailyReports.addAuditLog(companyId, id, {
        actorId: actor.actorId,
        action: 'REJECTED',
        reason: input.reason,
      });

      return updated;
    });
  }

  async lockDailyReport(
    actor: ActorContext,
    companyId: string,
    id: string,
    input?: LockDailyReportInput,
  ) {
    return this.uow.run(async (repos) => {
      const report = await repos.dailyReports.findById(companyId, id);
      if (!report) throw new DailyReportNotFoundError(id);
      if (report.status === 'LOCKED') throw new DailyReportAlreadyLockedError(id);
      if (report.status !== 'APPROVED') {
        throw new DailyReportInvalidStateTransitionError(report.status, 'LOCKED');
      }

      await this.authorizer.assertPermission(
        actor.actorId,
        ATTENDANCE_MANAGE,
        siteTarget(companyId, report.siteId),
      );

      const emp = await repos.employees.findByPrincipal(companyId, actor.actorId);

      const updated = await repos.dailyReports.update(companyId, id, {
        status: 'LOCKED',
        lockedAt: new Date(),
        ...(emp ? { lockedBy: { connect: { id_companyId: { id: emp.id, companyId } } } } : {}),
      });

      await repos.dailyReports.addAuditLog(companyId, id, {
        actorId: actor.actorId,
        action: 'LOCKED',
        reason: input?.reason ?? 'Locked by HO Admin for payroll and billing',
      });

      return updated;
    });
  }

  async getDailyReportAuditTrail(actor: ActorContext, companyId: string, id: string) {
    return this.uow.run(async (repos) => {
      const report = await repos.dailyReports.findById(companyId, id);
      if (!report) throw new DailyReportNotFoundError(id);

      await this.authorizer.assertPermission(
        actor.actorId,
        ATTENDANCE_READ,
        siteTarget(companyId, report.siteId),
      );

      return repos.dailyReports.getAuditLogs(companyId, id);
    });
  }

  async settleAllActiveSites(companyId?: string): Promise<{ settledCount: number }> {
    return this.uow.run(async (repos) => {
      const sites = await repos.dailyReports.getActiveSitesForSettlement(companyId);
      let settledCount = 0;
      const now = new Date();

      for (const site of sites) {
        try {
          const siteDetails = await repos.sites.findById(site.companyId, site.id);
          const tz = siteDetails?.project.timezone ?? 'Asia/Kolkata';
          const businessDate = getBusinessDate(now, tz);

          const existing = await repos.dailyReports.findBySiteAndDate(
            site.companyId,
            site.id,
            businessDate,
          );
          if (existing?.status === 'LOCKED') {
            continue;
          }

          const summary = await repos.sessions.getDailySummary(
            site.companyId,
            site.id,
            businessDate,
          );
          for (const s of summary.sessions) {
            if (s.status === 'IN_PROGRESS') {
              await repos.sessions.update(site.companyId, s.id, {
                status: 'AUTO_CLOSED',
                isFlagged: true,
                flagReason: 'MISSING_PUNCH_OUT',
                punchOutRemarks: 'Auto-closed at daily settlement due to missing punch out',
              });
            }
          }

          await this.internalRecalculateReport(
            repos,
            site.companyId,
            site.id,
            businessDate,
            'SYSTEM',
            'Scheduled end-of-day settlement',
          );
          settledCount += 1;
        } catch {
          // Continue to next site on individual site failure
        }
      }

      return { settledCount };
    });
  }
}
