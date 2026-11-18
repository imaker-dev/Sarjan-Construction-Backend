import { randomUUID } from 'node:crypto';
import type { LeaveBalance, LeavePolicy, LeaveRequestStatus, LeaveType } from '@prisma/client';
import type { ScopeTarget } from '../access-control/service.js';
import type { ActorContext, AuditRecord } from '../organization/types.js';
import {
  InsufficientLeaveBalanceError,
  LeaveDateConflictError,
  LeaveDocumentRequiredError,
  LeaveNoticePeriodError,
  LeavePolicyNotFoundError,
  LeaveRequestStateError,
  MaxConsecutiveLeaveDaysExceededError,
} from './errors.js';
import type {
  LeaveRequestWithDetails,
  LeaveUnitOfWork,
} from './repository.js';
import {
  calculateNetLeaveDays,
  type AllocateLeaveBalanceInput,
  type CancelLeaveRequestInput,
  type CreateLeavePolicyInput,
  type ListLeaveBalancesFilter,
  type ListLeavePoliciesFilter,
  type ListLeaveRequestsFilter,
  type ReviewLeaveRequestInput,
  type SubmitLeaveRequestInput,
  type UpdateLeavePolicyInput,
} from './types.js';

export const LEAVE_APPLY = 'LEAVE_APPLY';
export const LEAVE_READ = 'LEAVE_READ';
export const LEAVE_APPROVE = 'LEAVE_APPROVE';
export const LEAVE_MANAGE = 'LEAVE_MANAGE';

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

export class LeaveService {
  constructor(
    private readonly uow: LeaveUnitOfWork,
    private readonly authorizer: Authorizer,
  ) {}

  // ---------------------------------------------------------------------------
  // Leave Policies
  // ---------------------------------------------------------------------------

  async createPolicy(
    actor: ActorContext,
    companyId: string,
    input: CreateLeavePolicyInput,
  ): Promise<LeavePolicy> {
    await this.authorizer.assertPermission(actor.actorId, LEAVE_MANAGE, companyTarget(companyId));

    return this.uow.run(async (repos) => {
      const created = await repos.policies.create(companyId, {
        scopeType: input.scopeType,
        ...(input.projectId !== undefined
          ? { project: { connect: { id_companyId: { id: input.projectId, companyId } } } }
          : {}),
        ...(input.siteId !== undefined
          ? { site: { connect: { id_companyId: { id: input.siteId, companyId } } } }
          : {}),
        ...(input.employeeId !== undefined
          ? { employee: { connect: { id_companyId: { id: input.employeeId, companyId } } } }
          : {}),
        leaveType: input.leaveType,
        name: input.name,
        description: input.description ?? null,
        annualAllowance: input.annualAllowance ?? 12,
        accrualFrequency: input.accrualFrequency ?? 'ANNUAL',
        maxConsecutiveDays: input.maxConsecutiveDays ?? null,
        minNoticeDays: input.minNoticeDays ?? 0,
        allowHalfDay: input.allowHalfDay ?? true,
        sandwichRule: input.sandwichRule ?? false,
        carryoverMaxDays: input.carryoverMaxDays ?? 0,
        encashable: input.encashable ?? false,
        requiresDocAboveDays: input.requiresDocAboveDays ?? null,
      });

      await repos.audit.record(
        auditEntry(actor, {
          action: 'LEAVE_POLICY_CREATED',
          entityType: 'LEAVE_POLICY',
          entityId: created.id,
          companyId,
          metadata: { name: created.name, scopeType: created.scopeType, leaveType: created.leaveType },
        }),
      );

      return created;
    });
  }

  async listPolicies(
    actor: ActorContext,
    companyId: string,
    filter?: ListLeavePoliciesFilter,
  ): Promise<LeavePolicy[]> {
    await this.authorizer.assertPermission(actor.actorId, LEAVE_READ, companyTarget(companyId));
    return this.uow.run((repos) => repos.policies.list(companyId, filter));
  }

  async updatePolicy(
    actor: ActorContext,
    companyId: string,
    id: string,
    input: UpdateLeavePolicyInput,
  ): Promise<LeavePolicy> {
    await this.authorizer.assertPermission(actor.actorId, LEAVE_MANAGE, companyTarget(companyId));

    const { expectedVersion, ...patch } = input;
    return this.uow.run(async (repos) => {
      const existing = await repos.policies.findById(companyId, id);
      if (!existing) throw new LeavePolicyNotFoundError(`Leave policy ${id} not found`);

      const updated = await repos.policies.update(companyId, id, patch, expectedVersion);

      const changedFields: Record<string, { before: unknown; after: unknown }> = {};
      for (const [key, value] of Object.entries(patch)) {
        changedFields[key] = {
          before: (existing as unknown as Record<string, unknown>)[key],
          after: value,
        };
      }

      await repos.audit.record(
        auditEntry(actor, {
          action: 'LEAVE_POLICY_UPDATED',
          entityType: 'LEAVE_POLICY',
          entityId: id,
          companyId,
          changedFields,
        }),
      );

      return updated;
    });
  }

  async resolveEffectivePolicy(
    actor: ActorContext,
    companyId: string,
    leaveType: LeaveType,
    criteria: { employeeId?: string; siteId?: string; projectId?: string },
  ): Promise<LeavePolicy> {
    await this.authorizer.assertPermission(actor.actorId, LEAVE_READ, companyTarget(companyId));
    return this.uow.run((repos) => repos.policies.resolveEffective(companyId, leaveType, criteria));
  }

  // ---------------------------------------------------------------------------
  // Leave Allocations & Balances
  // ---------------------------------------------------------------------------

  async allocateBalance(
    actor: ActorContext,
    companyId: string,
    input: AllocateLeaveBalanceInput,
  ): Promise<LeaveBalance> {
    await this.authorizer.assertPermission(actor.actorId, LEAVE_MANAGE, companyTarget(companyId));

    return this.uow.run(async (repos) => {
      const balance = await repos.balances.upsertAllocation(
        companyId,
        input.employeeId,
        input.leaveType,
        input.year,
        input.allocatedDays,
        input.carriedOverDays ?? 0,
      );

      await repos.audit.record(
        auditEntry(actor, {
          action: 'LEAVE_BALANCE_ALLOCATED',
          entityType: 'LEAVE_BALANCE',
          entityId: balance.id,
          companyId,
          metadata: {
            employeeId: input.employeeId,
            leaveType: input.leaveType,
            year: input.year,
            allocatedDays: input.allocatedDays,
          },
        }),
      );

      return balance;
    });
  }

  async listBalances(
    actor: ActorContext,
    companyId: string,
    filter?: ListLeaveBalancesFilter,
  ): Promise<LeaveBalance[]> {
    await this.authorizer.assertPermission(actor.actorId, LEAVE_READ, companyTarget(companyId));
    return this.uow.run((repos) => repos.balances.list(companyId, filter));
  }

  async getEmployeeBalance(
    actor: ActorContext,
    companyId: string,
    employeeId: string,
    leaveType: LeaveType,
    year: number,
  ): Promise<LeaveBalance | null> {
    await this.authorizer.assertPermission(actor.actorId, LEAVE_READ, companyTarget(companyId));
    return this.uow.run((repos) => repos.balances.find(companyId, employeeId, leaveType, year));
  }

  // ---------------------------------------------------------------------------
  // Leave Requests & Lifecycle
  // ---------------------------------------------------------------------------

  async submitRequest(
    actor: ActorContext,
    companyId: string,
    input: SubmitLeaveRequestInput,
  ): Promise<LeaveRequestWithDetails> {
    await this.authorizer.assertPermission(actor.actorId, LEAVE_APPLY, companyTarget(companyId));

    const employeeId = input.employeeId ?? actor.actorId;
    const isHalfDay = input.isHalfDay ?? false;

    if (isHalfDay && input.startDate !== input.endDate) {
      throw new LeaveRequestStateError('Half-day leave must have the same startDate and endDate');
    }

    const start = new Date(`${input.startDate}T00:00:00.000Z`);
    const end = new Date(`${input.endDate}T00:00:00.000Z`);
    if (start.getTime() > end.getTime()) {
      throw new LeaveRequestStateError('startDate cannot be after endDate');
    }

    const year = start.getUTCFullYear();

    return this.uow.run(async (repos) => {
      // 1. Resolve effective policy for sandwich and compliance rules
      const policy = await repos.policies.resolveEffective(companyId, input.leaveType, { employeeId });

      // 2. Minimum advance notice check
      if (policy.minNoticeDays > 0) {
        const diffDays = Math.ceil((start.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
        if (diffDays < policy.minNoticeDays) {
          throw new LeaveNoticePeriodError(policy.minNoticeDays);
        }
      }

      // 3. Net leave days computation
      const totalDays = calculateNetLeaveDays(input.startDate, input.endDate, isHalfDay, policy.sandwichRule);

      // 4. Max consecutive days check
      if (policy.maxConsecutiveDays !== null) {
        if (totalDays > policy.maxConsecutiveDays) {
          throw new MaxConsecutiveLeaveDaysExceededError(policy.maxConsecutiveDays);
        }
      }

      // 5. Supporting document check
      if (
        policy.requiresDocAboveDays !== null &&
        totalDays > policy.requiresDocAboveDays &&
        !input.documentId
      ) {
        throw new LeaveDocumentRequiredError(policy.requiresDocAboveDays);
      }

      // 6. Date conflict check against active requests
      const conflict = await repos.requests.findConflicting(companyId, employeeId, start, end);
      if (conflict) {
        throw new LeaveDateConflictError(conflict.id);
      }

      // 7. Balance check (for non-loss-of-pay)
      if (input.leaveType !== 'LOSS_OF_PAY') {
        const balance = await repos.balances.find(companyId, employeeId, input.leaveType, year);
        const allocated = balance ? Number(balance.allocatedDays) : 0;
        const carried = balance ? Number(balance.carriedOverDays) : 0;
        const used = balance ? Number(balance.usedDays) : 0;
        const pending = balance ? Number(balance.pendingDays) : 0;
        const available = allocated + carried - used - pending;

        if (available < totalDays) {
          throw new InsufficientLeaveBalanceError(available, totalDays);
        }

        // Reserve pending days
        await repos.balances.reservePending(companyId, employeeId, input.leaveType, year, totalDays);
      }

      // 8. Create Leave Request
      const created = await repos.requests.create(companyId, {
        employee: { connect: { id_companyId: { id: employeeId, companyId } } },
        leaveType: input.leaveType,
        startDate: start,
        endDate: end,
        isHalfDay,
        halfDayPortion: input.halfDayPortion ?? null,
        totalDays,
        reason: input.reason,
        documentId: input.documentId ?? null,
        status: 'PENDING',
      });

      await repos.audit.record(
        auditEntry(actor, {
          action: 'LEAVE_REQUEST_SUBMITTED',
          entityType: 'LEAVE_REQUEST',
          entityId: created.id,
          companyId,
          metadata: {
            employeeId,
            leaveType: input.leaveType,
            startDate: input.startDate,
            endDate: input.endDate,
            totalDays,
          },
        }),
      );

      return created;
    });
  }

  async reviewRequest(
    actor: ActorContext,
    companyId: string,
    id: string,
    input: ReviewLeaveRequestInput,
  ): Promise<LeaveRequestWithDetails> {
    await this.authorizer.assertPermission(actor.actorId, LEAVE_APPROVE, companyTarget(companyId));

    return this.uow.run(async (repos) => {
      const existing = await repos.requests.findById(companyId, id);
      if (!existing) {
        throw new LeaveRequestStateError(`Leave request ${id} not found`);
      }
      if (existing.status !== 'PENDING') {
        throw new LeaveRequestStateError(`Leave request is already in ${existing.status} status`);
      }

      const totalDays = Number(existing.totalDays);
      const year = existing.startDate.getUTCFullYear();
      const newStatus: LeaveRequestStatus = input.action === 'APPROVE' ? 'APPROVED' : 'REJECTED';

      if (existing.leaveType !== 'LOSS_OF_PAY') {
        if (input.action === 'APPROVE') {
          await repos.balances.commitApproved(companyId, existing.employeeId, existing.leaveType, year, totalDays);
        } else {
          await repos.balances.rejectPending(companyId, existing.employeeId, existing.leaveType, year, totalDays);
        }
      }

      const updated = await repos.requests.updateStatus(
        companyId,
        id,
        newStatus,
        actor.actorId,
        input.remarks,
        input.expectedVersion,
      );

      await repos.audit.record(
        auditEntry(actor, {
          action: input.action === 'APPROVE' ? 'LEAVE_REQUEST_APPROVED' : 'LEAVE_REQUEST_REJECTED',
          entityType: 'LEAVE_REQUEST',
          entityId: id,
          companyId,
          statusBefore: 'PENDING',
          statusAfter: newStatus,
          metadata: { remarks: input.remarks },
        }),
      );

      return updated;
    });
  }

  async cancelRequest(
    actor: ActorContext,
    companyId: string,
    id: string,
    input: CancelLeaveRequestInput,
  ): Promise<LeaveRequestWithDetails> {
    await this.authorizer.assertPermission(actor.actorId, LEAVE_APPLY, companyTarget(companyId));

    return this.uow.run(async (repos) => {
      const existing = await repos.requests.findById(companyId, id);
      if (!existing) {
        throw new LeaveRequestStateError(`Leave request ${id} not found`);
      }
      if (existing.status !== 'PENDING' && existing.status !== 'APPROVED') {
        throw new LeaveRequestStateError(`Cannot cancel leave in ${existing.status} status`);
      }

      const totalDays = Number(existing.totalDays);
      const year = existing.startDate.getUTCFullYear();

      if (existing.leaveType !== 'LOSS_OF_PAY') {
        if (existing.status === 'PENDING') {
          await repos.balances.rejectPending(companyId, existing.employeeId, existing.leaveType, year, totalDays);
        } else {
          await repos.balances.refundApproved(companyId, existing.employeeId, existing.leaveType, year, totalDays);
        }
      }

      const updated = await repos.requests.updateStatus(
        companyId,
        id,
        'CANCELLED',
        actor.actorId,
        input.reason,
        input.expectedVersion,
      );

      await repos.audit.record(
        auditEntry(actor, {
          action: 'LEAVE_REQUEST_CANCELLED',
          entityType: 'LEAVE_REQUEST',
          entityId: id,
          companyId,
          statusBefore: existing.status,
          statusAfter: 'CANCELLED',
          metadata: { reason: input.reason },
        }),
      );

      return updated;
    });
  }

  async listRequests(
    actor: ActorContext,
    companyId: string,
    filter?: ListLeaveRequestsFilter,
  ): Promise<LeaveRequestWithDetails[]> {
    await this.authorizer.assertPermission(actor.actorId, LEAVE_READ, companyTarget(companyId));
    return this.uow.run((repos) => repos.requests.list(companyId, filter));
  }

  async getRequestById(
    actor: ActorContext,
    companyId: string,
    id: string,
  ): Promise<LeaveRequestWithDetails | null> {
    await this.authorizer.assertPermission(actor.actorId, LEAVE_READ, companyTarget(companyId));
    return this.uow.run((repos) => repos.requests.findById(companyId, id));
  }
}
