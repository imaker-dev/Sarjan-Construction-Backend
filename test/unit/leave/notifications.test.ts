import { describe, expect, it, vi, type MockedFunction } from 'vitest';
import { Prisma, type LeaveBalance, type LeavePolicy } from '@prisma/client';
import type { LeavePolicyVersion } from '@prisma/client';
import type { ActorContext } from '../../../src/modules/organization/types.js';
import type {
  LeaveRepos,
  LeaveRequestWithDetails,
  LeaveUnitOfWork,
} from '../../../src/modules/leave/repository.js';
import { LeaveService } from '../../../src/modules/leave/service.js';
import type { OutboxEmitInput } from '../../../src/modules/notification/types.js';

/**
 * Durable notification emission — the outbox event is written inside the same
 * uow as the leave mutation + audit row; delivery happens strictly after
 * commit. These tests assert the EMITTED contract (event name, recipients,
 * per-recipient titles/emails, privacy-safe payload); relay-side delivery is
 * covered by test/unit/notification/service.test.ts.
 */

const companyId = 'c1';
const actor: ActorContext = { actorId: 'u1', actorType: 'USER' };
/** Approver actor — never the request owner (self-approval is rejected). */
const approverActor: ActorContext = { actorId: 'approver-1', actorType: 'USER' };

function mockUow(repos: Partial<LeaveRepos>): LeaveUnitOfWork {
  const completeRepos: LeaveRepos = {
    employees: {
      findByPrincipal: vi.fn().mockImplementation(async (_c: string, pid: string) => ({
        id: pid === 'u1' ? 'emp-1' : `emp-${pid}`,
        displayName: 'User',
        status: 'ACTIVE',
        principalId: pid,
      })),
      findById: vi.fn().mockImplementation(async (_c: string, id: string) => ({
        id,
        displayName: 'User',
        status: 'ACTIVE',
        principalId: id === 'emp-1' ? 'u1' : `u-${id}`,
      })),
      lockForUpdate: vi.fn().mockResolvedValue(undefined),
    },
    memberships: {
      findActiveByEmployee: vi.fn().mockResolvedValue([]),
      findCoveringByEmployee: vi.fn().mockResolvedValue([]),
      findByEmployeesInWindow: vi.fn().mockResolvedValue([]),
    },
    outbox: { record: vi.fn().mockResolvedValue(undefined) },
    assignments: { findActivePrincipals: vi.fn().mockResolvedValue([]) },
    ...repos,
  } as LeaveRepos;
  return { run: async <T>(fn: (r: LeaveRepos) => Promise<T>) => fn(completeRepos) };
}

const authorizer = {
  assertPermission: vi.fn().mockResolvedValue(undefined),
  hasPermission: vi.fn().mockResolvedValue(false),
};

describe('LeaveService — notification outbox emission', () => {
  const PI_A = 'pid-pi-site-a';
  const PI_B = 'pid-pi-site-b';
  const HO_ADMIN_P = 'pid-ho-admin';
  const REQUESTER = 'u1';

  const nvPolicy: LeavePolicy = {
    id: 'pol-1',
    companyId,
    scopeType: 'COMPANY',
    departmentId: null,
    projectId: null,
    siteId: null,
    employeeId: null,
    typeDefId: 'td-1',
    leaveType: 'CASUAL',
    name: 'Casual',
    description: null,
    annualAllowance: new Prisma.Decimal(12),
    accrualFrequency: 'ANNUAL',
    maxConsecutiveDays: null,
    minNoticeDays: 0,
    allowHalfDay: true,
    sandwichRule: false,
    carryoverMaxDays: new Prisma.Decimal(0),
    encashable: false,
    requiresDocAboveDays: null,
    isActive: true,
    version: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const nvVersion: LeavePolicyVersion = {
    id: 'pv-1',
    companyId,
    policyId: 'pol-1',
    version: 1,
    effectiveFrom: new Date('2026-01-01T00:00:00Z'),
    mode: 'NONE',
    monthlyCreditAmount: null,
    ratioThresholdDays: null,
    ratioEarnedAmount: null,
    note: null,
    legacyConfig: null,
    status: 'ACTIVE',
    createdByPrincipalId: 'u1',
    createdAt: new Date(),
  };

  const nvBalance: LeaveBalance = {
    id: 'bal-1',
    companyId,
    employeeId: 'emp-1',
    leaveType: 'CASUAL',
    year: 2026,
    allocatedDays: new Prisma.Decimal(12),
    usedDays: new Prisma.Decimal(0),
    pendingDays: new Prisma.Decimal(0),
    carriedOverDays: new Prisma.Decimal(0),
    version: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const siteADept = {
    id: 'dept-a1',
    status: 'ACTIVE',
    siteId: 'site-a1',
    projectId: 'proj-1',
    baseHeadOfficeId: null,
    site: { projectId: 'proj-1' },
  };

  const requestRow = (over: Partial<LeaveRequestWithDetails> = {}): LeaveRequestWithDetails => ({
    id: 'req-1',
    companyId,
    employeeId: 'emp-1',
    leaveType: 'CASUAL',
    startDate: new Date('2026-11-20T00:00:00.000Z'),
    endDate: new Date('2026-11-25T00:00:00.000Z'),
    isHalfDay: false,
    halfDayPortion: null,
    totalDays: new Prisma.Decimal(6),
    reason: 'Sensitive medical reason',
    documentId: 'doc-secret-1',
    status: 'PENDING',
    reviewedBy: null,
    reviewedAt: null,
    reviewRemarks: null,
    version: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    employee: {
      id: 'emp-1',
      employeeCode: 'E1',
      displayName: 'Ramesh',
      designation: null,
      principalId: REQUESTER,
    },
    ...over,
  });

  /** Scope-aware assignment stub: SITE site-a1 → PI_A only (PI_B is the
   *  sibling site and must never resolve); company-wide → HO_ADMIN_P. */
  const scopedAssignments = () => ({
    findActivePrincipals: vi
      .fn()
      .mockImplementation(
        async (_cid: string, _roles: string[], scope?: { scopeType: string; scopeId: string }) => {
          if (scope?.scopeType === 'SITE' && scope.scopeId === 'site-a1') return [PI_A];
          if (scope?.scopeType === 'PROJECT' && scope.scopeId === 'proj-1') return [];
          if (scope === undefined) return [HO_ADMIN_P];
          return [];
        },
      ),
  });

  const submitPipeline = (capture: { record: (entry: OutboxEmitInput) => Promise<void> }) => ({
    memberships: {
      findActiveByEmployee: vi
        .fn()
        .mockResolvedValue([{ departmentId: 'dept-a1', isPrimary: true, department: siteADept }]),
      findCoveringByEmployee: vi
        .fn()
        .mockResolvedValue([{ departmentId: 'dept-a1', isPrimary: true, department: siteADept }]),
      findByEmployeesInWindow: vi.fn().mockResolvedValue([]),
    },
    policies: {
      resolveEffective: vi.fn().mockResolvedValue(nvPolicy),
    } as unknown as LeaveRepos['policies'],
    versions: {
      findEffective: vi.fn().mockResolvedValue(nvVersion),
      findNextEffective: vi.fn().mockResolvedValue(null),
    } as unknown as LeaveRepos['versions'],
    balances: {
      find: vi.fn().mockResolvedValue(nvBalance),
      reservePending: vi.fn().mockResolvedValue(nvBalance),
      commitApproved: vi.fn().mockResolvedValue(nvBalance),
      rejectPending: vi.fn().mockResolvedValue(nvBalance),
      refundApproved: vi.fn().mockResolvedValue(nvBalance),
    } as unknown as LeaveRepos['balances'],
    requests: {
      findConflicting: vi.fn().mockResolvedValue(null),
      create: vi
        .fn()
        .mockImplementation(async (_cid: string, data: Prisma.LeaveRequestCreateInput) =>
          requestRow({
            leaveType: data.leaveType,
            startDate: data.startDate as Date,
            endDate: data.endDate as Date,
            reason: data.reason ?? null,
            documentId: typeof data.documentId === 'string' ? data.documentId : null,
          }),
        ),
    } as unknown as LeaveRepos['requests'],
    assignments: scopedAssignments(),
    outbox: { record: capture.record },
    audit: { record: vi.fn().mockResolvedValue(undefined) },
  });

  const reviewPipeline = (
    capture: { record: (entry: OutboxEmitInput) => Promise<void> },
    existing: LeaveRequestWithDetails,
    updated: LeaveRequestWithDetails,
  ) => ({
    memberships: {
      findActiveByEmployee: vi
        .fn()
        .mockResolvedValue([{ departmentId: 'dept-a1', isPrimary: true, department: siteADept }]),
      findCoveringByEmployee: vi.fn().mockResolvedValue([]),
      findByEmployeesInWindow: vi.fn().mockResolvedValue([]),
    },
    balances: {
      find: vi.fn().mockResolvedValue(nvBalance),
      commitApproved: vi.fn().mockResolvedValue(nvBalance),
      rejectPending: vi.fn().mockResolvedValue(nvBalance),
      refundApproved: vi.fn().mockResolvedValue(nvBalance),
    } as unknown as LeaveRepos['balances'],
    requests: {
      findById: vi.fn().mockResolvedValue(existing),
      updateStatus: vi.fn().mockResolvedValue(updated),
    } as unknown as LeaveRepos['requests'],
    assignments: scopedAssignments(),
    outbox: { record: capture.record },
    audit: { record: vi.fn().mockResolvedValue(undefined) },
  });

  const recorded = (
    record: MockedFunction<(entry: OutboxEmitInput) => Promise<void>>,
  ): OutboxEmitInput => {
    const entry = record.mock.calls[0]?.[0];
    if (entry === undefined) throw new Error('expected one outbox event');
    return entry;
  };

  const submit = () =>
    ({
      employeeId: 'emp-1',
      leaveType: 'CASUAL' as const,
      startDate: '2026-11-20',
      endDate: '2026-11-25',
      reason: 'Sensitive medical reason',
      documentId: 'doc-secret-1',
    }) as Parameters<LeaveService['submitRequest']>[2];

  it('submit emits one durable event: requester confirmation + scoped + company approver alerts', async () => {
    const record = vi.fn<(entry: OutboxEmitInput) => Promise<void>>().mockResolvedValue(undefined);
    const service = new LeaveService(mockUow(submitPipeline({ record })), authorizer);
    await service.submitRequest(actor, companyId, submit());

    expect(record).toHaveBeenCalledTimes(1);
    const entry = recorded(record);
    expect(entry.eventType).toBe('LEAVE_REQUEST_SUBMITTED');
    expect(entry.aggregateType).toBe('LEAVE_REQUEST');
    expect(entry.eventKey).toBe('evt:leave:req-1:LEAVE_REQUEST_SUBMITTED:v0');
    // site PI + company admin + requester — never the sibling-site PI
    expect(new Set(entry.recipientPrincipalIds)).toEqual(new Set([PI_A, HO_ADMIN_P, REQUESTER]));
    expect(entry.recipientPrincipalIds).not.toContain(PI_B);
    // distinct titles: approver alert vs requester confirmation
    expect(entry.titles?.[PI_A]).toContain('New leave request');
    expect(entry.titles?.[REQUESTER]).toContain('Your CASUAL leave request was submitted');
    // both recipients get email intents with an app link
    expect(entry.emails?.[PI_A]?.appPath).toBe('/leave/requests/req-1');
    expect(entry.emails?.[REQUESTER]?.subject).toContain('submitted');
    // privacy: no reason, no document id, no remarks anywhere in the payload
    const payloadText = JSON.stringify(entry);
    expect(payloadText).not.toContain('Sensitive medical reason');
    expect(payloadText).not.toContain('doc-secret-1');
  });

  it('a PI own request skips site approvers — company-authority routing only', async () => {
    const record = vi.fn<(entry: OutboxEmitInput) => Promise<void>>().mockResolvedValue(undefined);
    const scopedAuthorizer = {
      assertPermission: vi.fn().mockResolvedValue(undefined),
      hasPermission: vi.fn().mockResolvedValue(true),
    };
    const service = new LeaveService(mockUow(submitPipeline({ record })), scopedAuthorizer);
    await service.submitRequest(actor, companyId, { ...submit() });
    const entry = recorded(record);
    expect(new Set(entry.recipientPrincipalIds)).toEqual(new Set([HO_ADMIN_P, REQUESTER]));
    expect(entry.recipientPrincipalIds).not.toContain(PI_A);
  });

  it('requester is never notified as their own approver', async () => {
    const record = vi.fn<(entry: OutboxEmitInput) => Promise<void>>().mockResolvedValue(undefined);
    const repos = submitPipeline({ record });
    (
      repos.assignments.findActivePrincipals as MockedFunction<
        LeaveRepos['assignments']['findActivePrincipals']
      >
    ).mockImplementation(async (_cid: string, _roles: string[], scope?: { scopeType: string }) =>
      scope === undefined ? [REQUESTER, HO_ADMIN_P] : [],
    );
    const service = new LeaveService(mockUow(repos), authorizer);
    await service.submitRequest(actor, companyId, { ...submit() });
    const entry = recorded(record);
    expect(entry.recipientPrincipalIds.filter((p) => p === REQUESTER)).toHaveLength(1);
    expect(entry.titles?.[REQUESTER]).toContain('Your CASUAL leave request was submitted');
  });

  it('approve emits a requester-only event with no decision remarks in the payload', async () => {
    const record = vi.fn<(entry: OutboxEmitInput) => Promise<void>>().mockResolvedValue(undefined);
    const existing = requestRow({ status: 'PENDING' });
    const updated = requestRow({ status: 'APPROVED', version: 1 });
    const service = new LeaveService(
      mockUow(reviewPipeline({ record }, existing, updated)),
      authorizer,
    );
    await service.reviewRequest(approverActor, companyId, 'req-1', {
      action: 'APPROVE',
      remarks: 'approved, medical docs verified',
      expectedVersion: 0,
    });
    expect(record).toHaveBeenCalledTimes(1);
    const entry = recorded(record);
    expect(entry.eventType).toBe('LEAVE_REQUEST_APPROVED');
    expect(entry.recipientPrincipalIds).toEqual([REQUESTER]);
    expect(entry.emails?.[REQUESTER]?.subject).toContain('approved');
    const payloadText = JSON.stringify(entry);
    expect(payloadText).not.toContain('medical docs');
    expect(payloadText).not.toContain('Sensitive medical reason');
  });

  it('return emits a requester-only correction prompt without remarks', async () => {
    const record = vi.fn<(entry: OutboxEmitInput) => Promise<void>>().mockResolvedValue(undefined);
    const existing = requestRow({ status: 'PENDING' });
    const updated = requestRow({ status: 'RETURNED', version: 1 });
    const service = new LeaveService(
      mockUow(reviewPipeline({ record }, existing, updated)),
      authorizer,
    );
    await service.reviewRequest(approverActor, companyId, 'req-1', {
      action: 'RETURN',
      remarks: 'fix the dates please',
      expectedVersion: 0,
    });
    const entry = recorded(record);
    expect(entry.eventType).toBe('LEAVE_REQUEST_RETURNED');
    expect(entry.recipientPrincipalIds).toEqual([REQUESTER]);
    expect(entry.emails?.[REQUESTER]?.bodyText).toContain('returned for correction');
    expect(JSON.stringify(entry)).not.toContain('fix the dates');
  });

  it('cancel alerts approvers in-app/realtime only — no email intents', async () => {
    const record = vi.fn<(entry: OutboxEmitInput) => Promise<void>>().mockResolvedValue(undefined);
    const existing = requestRow({ status: 'PENDING' });
    const updated = requestRow({ status: 'CANCELLED', version: 1 });
    const service = new LeaveService(
      mockUow(reviewPipeline({ record }, existing, updated)),
      authorizer,
    );
    await service.cancelRequest(approverActor, companyId, 'req-1', {
      reason: 'plans changed',
      expectedVersion: 0,
    });
    const entry = recorded(record);
    expect(entry.eventType).toBe('LEAVE_REQUEST_CANCELLED');
    expect(new Set(entry.recipientPrincipalIds)).toEqual(new Set([PI_A, HO_ADMIN_P]));
    expect(entry.recipientPrincipalIds).not.toContain(REQUESTER);
    expect(entry.emails).toBeUndefined();
    expect(JSON.stringify(entry)).not.toContain('plans changed');
  });
});
