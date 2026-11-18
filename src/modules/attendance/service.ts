import { randomUUID } from 'node:crypto';
import type { AttendancePolicy, AttendancePolicyScope, AttendanceSession } from '@prisma/client';
import type { ScopeTarget } from '../access-control/service.js';
import type { ActorContext, AuditRecord } from '../organization/types.js';
import {
  ActiveSessionExistsError,
  AttendanceEntityNotFoundError,
  BreakAlreadyActiveError,
  GeofenceBreachError,
  NoActiveBreakError,
  NoActiveSessionError,
  PunchNotAllowedError,
  TvtSafetyBriefingRequiredError,
} from './errors.js';
import type {
  AttendanceSessionWithDetails,
  AttendanceUnitOfWork,
} from './repository.js';
import {
  calculateHaversineDistanceMeters,
  calculateWorkAndOvertime,
  getBusinessDate,
  type AddTvtAttendeesInput,
  type CreatePolicyInput,
  type CreateTvtSessionInput,
  type DailySummaryFilter,
  type EndBreakInput,
  type KioskBatchPunchInInput,
  type KioskBatchPunchOutInput,
  type KioskOfflineSyncInput,
  type ListSessionsFilter,
  type ListTvtSessionsFilter,
  type MusterRollRangeFilter,
  type PunchInInput,
  type PunchOutInput,
  type RegularizeSessionInput,
  type StartBreakInput,
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

export class AttendanceService {
  constructor(
    private readonly uow: AttendanceUnitOfWork,
    private readonly authorizer: Authorizer,
  ) {}

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
      return {
        id: 'default-fallback',
        companyId,
        scope: 'COMPANY',
        projectId: null,
        siteId: null,
        employeeId: null,
        name: 'Default Construction Policy',
        description: 'Auto-fallback policy (8:00 AM to 8:00 AM cycle)',
        dayStartHour: 8,
        dayStartMinute: 0,
        shiftDurationMins: 480,
        halfDayThresholdMins: 240,
        fullDayThresholdMins: 480,
        breakMode: 'FIXED',
        fixedBreakMins: 60,
        minWorkForBreakMins: 240,
        maxDynamicBreakMins: 90,
        overtimeMode: 'HOURLY',
        minOvertimeMins: 30,
        otSlabMins: 30,
        pMultiplierSlabs: null,
        geofenceStrict: true,
        allowMobilePunch: true,
        allowKioskPunch: true,
        allowBiometric: true,
        requireTvtGate: false,
        tvtGateAction: 'FLAG',
        status: 'ACTIVE',
        version: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
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
    await this.authorizer.assertPermission(
      actor.actorId,
      ATTENDANCE_RECORD,
      siteTarget(companyId, input.siteId),
    );

    return this.uow.run(async (repos) => {
      // 1. Resolve employee
      let employeeId = input.employeeId;
      let supervisorId: string | undefined;
      if (!employeeId) {
        const callerEmp = await repos.employees.findByPrincipal(companyId, actor.actorId);
        if (!callerEmp)
          throw new AttendanceEntityNotFoundError('Employee for caller', actor.actorId);
        employeeId = callerEmp.id;
      } else {
        supervisorId = actor.actorId;
      }

      const emp = await repos.employees.findById(companyId, employeeId);
      if (emp?.status !== 'ACTIVE') {
        throw new AttendanceEntityNotFoundError('Active Employee', employeeId);
      }

      // 2. Validate Site
      const site = await repos.sites.findById(companyId, input.siteId);
      if (!site) throw new AttendanceEntityNotFoundError('Site', input.siteId);

      // 3. Check for existing active session
      const existingSession = await repos.sessions.findActive(companyId, employeeId);
      if (existingSession) {
        throw new ActiveSessionExistsError(existingSession.id);
      }

      // 4. Resolve Effective Policy
      const policy =
        (await repos.policies.findEffective(companyId, {
          employeeId,
          siteId: site.id,
          projectId: site.projectId,
        })) ??
        ({
          id: 'default-fallback',
          dayStartHour: 8,
          dayStartMinute: 0,
          shiftDurationMins: 480,
          halfDayThresholdMins: 240,
          fullDayThresholdMins: 480,
          breakMode: 'FIXED',
          fixedBreakMins: 60,
          minWorkForBreakMins: 240,
          overtimeMode: 'HOURLY',
          minOvertimeMins: 30,
          otSlabMins: 30,
          geofenceStrict: true,
          allowMobilePunch: true,
          allowKioskPunch: true,
          allowBiometric: true,
        } as unknown as AttendancePolicy);

      // If policy id was default-fallback, make sure we persist or connect a real company policy
      let policyIdToPersist = policy.id;
      if (policyIdToPersist === 'default-fallback') {
        // Find or create default company policy
        let compPolicy = await repos.policies.findEffective(companyId, {});
        compPolicy ??= await repos.policies.create(companyId, {
          name: 'Company Default Policy',
          scope: 'COMPANY',
          dayStartHour: 8,
          dayStartMinute: 0,
          shiftDurationMins: 480,
          halfDayThresholdMins: 240,
          fullDayThresholdMins: 480,
          breakMode: 'FIXED',
          fixedBreakMins: 60,
          minWorkForBreakMins: 240,
          overtimeMode: 'HOURLY',
          minOvertimeMins: 30,
          otSlabMins: 30,
          geofenceStrict: true,
        });
        policyIdToPersist = compPolicy.id;
      }

      const source = input.source ?? 'MOBILE_SELF';
      if (source === 'MOBILE_SELF' && !policy.allowMobilePunch) {
        throw new PunchNotAllowedError('Mobile self-punch disabled by policy');
      }
      if (source === 'SUPERVISOR_KIOSK' && !policy.allowKioskPunch) {
        throw new PunchNotAllowedError('Supervisor kiosk punch disabled by policy');
      }
      if (source === 'BIOMETRIC_DEVICE' && !policy.allowBiometric) {
        throw new PunchNotAllowedError('Biometric sync disabled by policy');
      }

      // 5. Geofence Verification
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
          if (policy.geofenceStrict) {
            throw new GeofenceBreachError(distanceM, radiusM);
          }
        }
      }

      // 6. Business Date Calculation (8 AM to 8 AM cycle)
      const now = new Date();
      const timezone = site.timezone ?? site.project.timezone;
      const businessDate = getBusinessDate(
        now,
        timezone,
        policy.dayStartHour,
        policy.dayStartMinute,
      );

      // 7. Safety TVT Gate Check
      let isFlagged = !isWithinGeofence;
      let flagReason = !isWithinGeofence ? 'Geofence breach on punch in' : null;

      if (policy.requireTvtGate) {
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
        site: { connect: { id: site.id } },
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
            siteId: site.id,
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
      let supervisorId: string | undefined;
      if (!employeeId) {
        const callerEmp = await repos.employees.findByPrincipal(companyId, actor.actorId);
        if (!callerEmp)
          throw new AttendanceEntityNotFoundError('Employee for caller', actor.actorId);
        employeeId = callerEmp.id;
      } else {
        supervisorId = actor.actorId;
      }

      // 2. Find active session
      const session = input.sessionId
        ? await repos.sessions.findById(companyId, input.sessionId)
        : await repos.sessions.findActive(companyId, employeeId);

      if (session?.status !== 'IN_PROGRESS') {
        throw new NoActiveSessionError(employeeId);
      }

      await this.authorizer.assertPermission(
        actor.actorId,
        ATTENDANCE_RECORD,
        siteTarget(companyId, session.siteId),
      );

      const site = await repos.sites.findById(companyId, session.siteId);
      if (!site) throw new AttendanceEntityNotFoundError('Site', session.siteId);

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

      // 4. Geofence Verification
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

      // 5. Calculate Durations & Work/Overtime Units
      const policy =
        (await repos.policies.findById(companyId, session.policyId)) ??
        ({
          shiftDurationMins: 480,
          halfDayThresholdMins: 240,
          fullDayThresholdMins: 480,
          breakMode: 'FIXED',
          fixedBreakMins: 60,
          minWorkForBreakMins: 240,
          overtimeMode: 'HOURLY',
          minOvertimeMins: 30,
          otSlabMins: 30,
        } as unknown as AttendancePolicy);

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
            siteId: site.id,
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
      if (!employeeId) {
        const callerEmp = await repos.employees.findByPrincipal(companyId, actor.actorId);
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

      await this.authorizer.assertPermission(
        actor.actorId,
        ATTENDANCE_RECORD,
        siteTarget(companyId, session.siteId),
      );

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
      let employeeId = input.employeeId;
      if (!employeeId && !input.breakId && !input.sessionId) {
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

      const brk = input.breakId
        ? await repos.breaks.findActive(companyId, sessionId ?? '')
        : sessionId
          ? await repos.breaks.findActive(companyId, sessionId)
          : null;

      if (!brk) {
        throw new NoActiveBreakError(sessionId ?? 'unknown');
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
        siteTarget(companyId, session.siteId),
      );

      const presentUnits = input.presentUnits ?? Number(session.presentUnits);
      const overtimePUnits = input.overtimePUnits ?? Number(session.overtimePUnits);
      const totalPUnits = Number((presentUnits + overtimePUnits).toFixed(1));

      const updated = await repos.sessions.update(companyId, sessionId, {
        ...(input.punchInAt ? { punchInAt: new Date(input.punchInAt) } : {}),
        ...(input.punchOutAt ? { punchOutAt: new Date(input.punchOutAt) } : {}),
        presentUnits,
        overtimePUnits,
        totalPUnits,
        ...(input.overtimeHours !== undefined ? { overtimeHours: input.overtimeHours } : {}),
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
            overtimeHours: input.overtimeHours,
          },
        }),
      );

      return updated;
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
        siteTarget(companyId, s.siteId),
      );
      return s;
    });
  }

  async getActiveSession(actor: ActorContext, companyId: string, employeeId?: string) {
    return this.uow.run(async (repos) => {
      let empId = employeeId;
      if (!empId) {
        const callerEmp = await repos.employees.findByPrincipal(companyId, actor.actorId);
        if (!callerEmp) return null;
        empId = callerEmp.id;
      }
      return repos.sessions.findActive(companyId, empId);
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

  async kioskBatchPunchIn(
    actor: ActorContext,
    companyId: string,
    input: KioskBatchPunchInInput,
  ) {
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
        try {
          const emp = await repos.employees.findById(companyId, employeeId);
          if (emp?.status !== 'ACTIVE') {
            results.push({ employeeId, success: false, error: 'EMPLOYEE_NOT_ACTIVE' });
            failureCount++;
            continue;
          }

          const existingSession = await repos.sessions.findActive(companyId, employeeId);
          if (existingSession) {
            results.push({ employeeId, success: false, error: 'ACTIVE_SESSION_EXISTS' });
            failureCount++;
            continue;
          }

          const policy =
            (await repos.policies.findEffective(companyId, {
              employeeId,
              siteId: site.id,
              projectId: site.projectId,
            })) ??
            ({
              id: 'default-fallback',
              dayStartHour: 8,
              dayStartMinute: 0,
              shiftDurationMins: 480,
              halfDayThresholdMins: 240,
              fullDayThresholdMins: 480,
              breakMode: 'FIXED',
              fixedBreakMins: 60,
              minWorkForBreakMins: 240,
              maxDynamicBreakMins: 90,
              overtimeMode: 'HOURLY',
              minOvertimeMins: 30,
              otSlabMins: 30,
              pMultiplierSlabs: null,
              geofenceStrict: true,
              allowMobilePunch: true,
              allowKioskPunch: true,
              allowBiometric: true,
              requireTvtGate: false,
              tvtGateAction: 'FLAG',
              status: 'ACTIVE',
              version: 0,
              createdAt: new Date(),
              updatedAt: new Date(),
            } as unknown as AttendancePolicy);

          let policyIdToPersist = policy.id;
          if (policyIdToPersist === 'default-fallback') {
            let compPolicy = await repos.policies.findEffective(companyId, {});
            compPolicy ??= await repos.policies.create(companyId, {
              name: 'Company Default Policy',
              scope: 'COMPANY',
              dayStartHour: 8,
              dayStartMinute: 0,
              shiftDurationMins: 480,
              halfDayThresholdMins: 240,
              fullDayThresholdMins: 480,
              breakMode: 'FIXED',
              fixedBreakMins: 60,
              minWorkForBreakMins: 240,
              overtimeMode: 'HOURLY',
              minOvertimeMins: 30,
              otSlabMins: 30,
              geofenceStrict: true,
            });
            policyIdToPersist = compPolicy.id;
          }

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
            const hasAttendedTvt = await repos.tvt.hasAttended(
              companyId,
              site.id,
              employeeId,
              businessDate,
            );
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

  async kioskBatchPunchOut(
    actor: ActorContext,
    companyId: string,
    input: KioskBatchPunchOutInput,
  ) {
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
        try {
          const session = await repos.sessions.findActive(companyId, employeeId);
          if (!session) {
            results.push({ employeeId, success: false, error: 'NO_ACTIVE_SESSION' });
            failureCount++;
            continue;
          }

          const policy =
            (await repos.policies.findById(companyId, session.policyId)) ??
            ({
              id: session.policyId,
              breakMode: 'FIXED',
              fixedBreakMins: 60,
              minWorkForBreakMins: 240,
              shiftDurationMins: 480,
              halfDayThresholdMins: 240,
              fullDayThresholdMins: 480,
              overtimeMode: 'HOURLY',
              minOvertimeMins: 30,
              otSlabMins: 30,
              pMultiplierSlabs: null,
            } as unknown as AttendancePolicy);

          const grossDurationMins = Math.max(
            0,
            Math.round((punchOutAt.getTime() - session.punchInAt.getTime()) / 60000),
          );

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

  async kioskOfflineSync(
    actor: ActorContext,
    companyId: string,
    input: KioskOfflineSyncInput,
  ) {
    await this.authorizer.assertPermission(
      actor.actorId,
      ATTENDANCE_RECORD,
      siteTarget(companyId, input.siteId),
    );

    return this.uow.run(async (repos) => {
      const site = await repos.sites.findById(companyId, input.siteId);
      if (!site) throw new AttendanceEntityNotFoundError('Site', input.siteId);

      const timezone = site.timezone ?? site.project.timezone;

      const results: {
        clientSessionId: string;
        status: 'SYNCED' | 'ALREADY_SYNCED';
        sessionId?: string;
      }[] = [];

      let syncedCount = 0;
      let alreadySyncedCount = 0;

      for (const item of input.sessions) {
        const existing = await repos.sessions.findByClientSessionId(
          companyId,
          item.clientSessionId,
        );
        if (existing) {
          results.push({
            clientSessionId: item.clientSessionId,
            status: 'ALREADY_SYNCED',
            sessionId: existing.id,
          });
          alreadySyncedCount++;
          continue;
        }

        const punchInAt = new Date(item.punchInAt);
        const policy =
          (await repos.policies.findEffective(companyId, {
            employeeId: item.employeeId,
            siteId: site.id,
            projectId: site.projectId,
          })) ??
          ({
            id: 'default-fallback',
            dayStartHour: 8,
            dayStartMinute: 0,
            shiftDurationMins: 480,
            halfDayThresholdMins: 240,
            fullDayThresholdMins: 480,
            breakMode: 'FIXED',
            fixedBreakMins: 60,
            minWorkForBreakMins: 240,
            maxDynamicBreakMins: 90,
            overtimeMode: 'HOURLY',
            minOvertimeMins: 30,
            otSlabMins: 30,
            pMultiplierSlabs: null,
            geofenceStrict: false,
            allowMobilePunch: true,
            allowKioskPunch: true,
            allowBiometric: true,
            requireTvtGate: false,
            tvtGateAction: 'FLAG',
            status: 'ACTIVE',
            version: 0,
            createdAt: new Date(),
            updatedAt: new Date(),
          } as unknown as AttendancePolicy);

        let policyIdToPersist = policy.id;
        if (policyIdToPersist === 'default-fallback') {
          let compPolicy = await repos.policies.findEffective(companyId, {});
          compPolicy ??= await repos.policies.create(companyId, {
            name: 'Company Default Policy',
            scope: 'COMPANY',
            dayStartHour: 8,
            dayStartMinute: 0,
            shiftDurationMins: 480,
            halfDayThresholdMins: 240,
            fullDayThresholdMins: 480,
            breakMode: 'FIXED',
            fixedBreakMins: 60,
            minWorkForBreakMins: 240,
            overtimeMode: 'HOURLY',
            minOvertimeMins: 30,
            otSlabMins: 30,
            geofenceStrict: false,
          });
          policyIdToPersist = compPolicy.id;
        }

        const businessDate = getBusinessDate(
          punchInAt,
          timezone,
          policy.dayStartHour,
          policy.dayStartMinute,
        );

        let isFlagged = false;
        let flagReason: string | null = null;

        if (policy.requireTvtGate) {
          const hasAttended = await repos.tvt.hasAttended(
            companyId,
            site.id,
            item.employeeId,
            businessDate,
          );
          if (!hasAttended) {
            isFlagged = true;
            flagReason = 'Safety TVT briefing missed';
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
          punchInSupervisorId: actor.actorId,
          punchInRemarks: item.remarks ?? null,
          punchOutAt,
          ...(item.punchOutLat !== undefined ? { punchOutLat: item.punchOutLat } : {}),
          ...(item.punchOutLng !== undefined ? { punchOutLng: item.punchOutLng } : {}),
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

        results.push({
          clientSessionId: item.clientSessionId,
          status: 'SYNCED',
          sessionId: session.id,
        });
        syncedCount++;
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
          },
        }),
      );

      return {
        syncBatchId: input.syncBatchId,
        siteId: input.siteId,
        totalSubmitted: input.sessions.length,
        syncedCount,
        alreadySyncedCount,
        results,
      };
    });
  }

  // -------------------------------------------------------------------------
  // Safety Toolbox Talk (TVT) Gate Operations
  // -------------------------------------------------------------------------

  async createTvtSession(
    actor: ActorContext,
    companyId: string,
    input: CreateTvtSessionInput,
  ) {
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

  async listTvtSessions(
    actor: ActorContext,
    companyId: string,
    filter: ListTvtSessionsFilter,
  ) {
    const target = filter.siteId
      ? siteTarget(companyId, filter.siteId)
      : companyTarget(companyId);
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

  async getMusterRollRange(
    actor: ActorContext,
    companyId: string,
    filter: MusterRollRangeFilter,
  ) {
    await this.authorizer.assertPermission(
      actor.actorId,
      ATTENDANCE_READ,
      siteTarget(companyId, filter.siteId),
    );

    return this.uow.run((repos) => repos.sessions.getMusterRollRange(companyId, filter));
  }
}
