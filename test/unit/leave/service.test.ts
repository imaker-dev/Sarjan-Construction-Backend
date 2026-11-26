import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Prisma,
  type LeaveBalance,
  type LeavePolicy,
  type LeavePolicyVersion,
  type LeaveTypeDef,
} from '@prisma/client';
import type { ActorContext } from '../../../src/modules/organization/types.js';
import {
  AmbiguousLeaveScopeError,
  InsufficientLeaveBalanceError,
  InvalidLeavePolicyStateError,
  LastActiveLeavePolicyVersionError,
  LeaveDateConflictError,
  LeaveNoticePeriodError,
  LeavePeriodBoundaryError,
  LeavePolicyValidationError,
  LeaveRequestStateError,
  LeaveScopeShapeError,
  NoEffectiveLeavePolicyError,
  SelfApprovalNotAllowedError,
} from '../../../src/modules/leave/errors.js';
import type {
  LeaveRepos,
  LeaveRequestWithDetails,
  LeaveUnitOfWork,
} from '../../../src/modules/leave/repository.js';
import { LeaveService } from '../../../src/modules/leave/service.js';

function createMockUow(repos: Partial<LeaveRepos>): LeaveUnitOfWork {
  const defaultEmployees: LeaveRepos['employees'] = {
    findByPrincipal: vi.fn().mockImplementation(async (_cid: string, pid: string) => ({
      id: pid === 'u1' ? 'emp-1' : `emp-${pid}`,
      displayName: pid === 'u1' ? 'Ramesh' : `User ${pid}`,
      status: 'ACTIVE',
      principalId: pid,
    })),
    findById: vi.fn().mockImplementation(async (_cid: string, id: string) => ({
      id,
      displayName: id === 'emp-1' ? 'Ramesh' : `User ${id}`,
      status: 'ACTIVE',
      principalId: id === 'emp-1' ? 'u1' : `u-${id}`,
    })),
    lockForUpdate: vi.fn().mockResolvedValue(undefined),
  };

  const defaultMemberships: LeaveRepos['memberships'] = {
    findActiveByEmployee: vi.fn().mockResolvedValue([]),
    findCoveringByEmployee: vi.fn().mockResolvedValue([]),
    findByEmployeesInWindow: vi.fn().mockResolvedValue([]),
  };

  const completeRepos: LeaveRepos = {
    employees: defaultEmployees,
    memberships: defaultMemberships,
    ...repos,
  } as LeaveRepos;

  return {
    run: async <T>(fn: (r: LeaveRepos) => Promise<T>): Promise<T> => {
      return fn(completeRepos);
    },
  };
}

describe('LeaveService', () => {
  const actor: ActorContext = { actorId: 'u1', actorType: 'USER' };
  const companyId = 'c1';
  const authorizer = {
    assertPermission: vi.fn().mockResolvedValue(undefined),
    hasPermission: vi.fn().mockResolvedValue(false),
  };

  const samplePolicy: LeavePolicy = {
    id: 'pol-1',
    companyId,
    scopeType: 'COMPANY',
    departmentId: null,
    projectId: null,
    siteId: null,
    employeeId: null,
    typeDefId: null,
    leaveType: 'CASUAL',
    name: 'Casual Leave Policy',
    description: null,
    annualAllowance: new Prisma.Decimal(12),
    accrualFrequency: 'ANNUAL',
    maxConsecutiveDays: 3,
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

  const sampleBalance: LeaveBalance = {
    id: 'bal-1',
    companyId,
    employeeId: 'emp-1',
    leaveType: 'CASUAL',
    year: 2026,
    allocatedDays: new Prisma.Decimal(12),
    usedDays: new Prisma.Decimal(2),
    pendingDays: new Prisma.Decimal(0),
    carriedOverDays: new Prisma.Decimal(0),
    version: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  it('creates a leave policy with immutable version 1', async () => {
    let recordedAudit = 0;
    const typeDefRow: LeaveTypeDef = {
      id: 'td-1',
      companyId,
      code: 'CL',
      name: 'Casual Leave',
      description: null,
      leaveType: 'CASUAL',
      status: 'ACTIVE',
      version: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const versionRow: LeavePolicyVersion = {
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
    const mockRepos: Partial<LeaveRepos> = {
      typeDefs: {
        findById: vi.fn().mockResolvedValue(typeDefRow),
      } as unknown as LeaveRepos['typeDefs'],
      policies: {
        create: vi.fn().mockResolvedValue({ ...samplePolicy, typeDefId: 'td-1' }),
      } as unknown as LeaveRepos['policies'],
      versions: {
        create: vi.fn().mockResolvedValue(versionRow),
      } as unknown as LeaveRepos['versions'],
      audit: {
        record: vi.fn().mockImplementation(async () => {
          recordedAudit += 1;
        }),
      },
    };

    const service = new LeaveService(createMockUow(mockRepos), authorizer);
    const result = await service.createPolicy(actor, companyId, {
      scopeType: 'COMPANY',
      typeDefId: 'td-1',
      name: 'Casual Leave Policy',
      version: {
        effectiveFrom: '2026-01-01',
        mode: 'NONE',
      },
    });

    expect(result.policy.name).toBe('Casual Leave Policy');
    expect(result.policy.leaveType).toBe('CASUAL');
    expect(result.version.version).toBe(1);
    expect(recordedAudit).toBe(2);
  });

  it('resolves effective leave policy hierarchically', async () => {
    const mockRepos: Partial<LeaveRepos> = {
      policies: {
        resolveEffective: vi.fn().mockResolvedValue(samplePolicy),
      } as unknown as LeaveRepos['policies'],
    };

    const service = new LeaveService(createMockUow(mockRepos), authorizer);
    const effective = await service.resolveEffectivePolicy(actor, companyId, 'CASUAL', {
      employeeId: 'emp-1',
    });

    expect(effective.id).toBe('pol-1');
  });

  it('allocates leave balance for an employee', async () => {
    let recordedAudit = false;
    const mockRepos: Partial<LeaveRepos> = {
      balances: {
        upsertAllocation: vi.fn().mockResolvedValue(sampleBalance),
      } as unknown as LeaveRepos['balances'],
      audit: {
        record: vi.fn().mockImplementation(async () => {
          recordedAudit = true;
        }),
      },
    };

    const service = new LeaveService(createMockUow(mockRepos), authorizer);
    const balance = await service.allocateBalance(actor, companyId, {
      employeeId: 'emp-1',
      leaveType: 'CASUAL',
      year: 2026,
      allocatedDays: 12,
    });

    expect(balance.allocatedDays.toNumber()).toBe(12);
    expect(recordedAudit).toBe(true);
  });

  it('submits a leave request with sufficient balance and reserves pending days', async () => {
    let reservedPending = false;
    const mockCreatedRequest: LeaveRequestWithDetails = {
      id: 'req-1',
      companyId,
      employeeId: 'emp-1',
      leaveType: 'CASUAL',
      startDate: new Date('2026-11-20T00:00:00.000Z'),
      endDate: new Date('2026-11-20T00:00:00.000Z'),
      isHalfDay: false,
      halfDayPortion: null,
      totalDays: new Prisma.Decimal(1.0),
      reason: 'Personal errand',
      documentId: null,
      status: 'PENDING',
      reviewedBy: null,
      reviewedAt: null,
      reviewRemarks: null,
      version: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      employee: {
        id: 'emp-1',
        employeeCode: 'E01',
        displayName: 'Ramesh',
        designation: 'Engineer',
        principalId: 'p-1',
      },
    };

    const mockRepos: Partial<LeaveRepos> = {
      policies: {
        resolveEffective: vi.fn().mockResolvedValue(samplePolicy),
      } as unknown as LeaveRepos['policies'],
      balances: {
        find: vi.fn().mockResolvedValue(sampleBalance),
        reservePending: vi.fn().mockImplementation(async () => {
          reservedPending = true;
          return sampleBalance;
        }),
      } as unknown as LeaveRepos['balances'],
      requests: {
        findConflicting: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue(mockCreatedRequest),
      } as unknown as LeaveRepos['requests'],
      audit: {
        record: vi.fn().mockResolvedValue(undefined),
      },
    };

    const service = new LeaveService(createMockUow(mockRepos), authorizer);
    const req = await service.submitRequest(actor, companyId, {
      employeeId: 'emp-1',
      leaveType: 'CASUAL',
      startDate: '2026-11-20',
      endDate: '2026-11-20',
      reason: 'Personal errand',
    });

    expect(req.id).toBe('req-1');
    expect(req.status).toBe('PENDING');
    expect(reservedPending).toBe(true);
  });

  it('rejects leave submission when balance is insufficient', async () => {
    const lowBalance: LeaveBalance = {
      ...sampleBalance,
      allocatedDays: new Prisma.Decimal(2),
      usedDays: new Prisma.Decimal(2), // 0 available
    };

    const mockRepos: Partial<LeaveRepos> = {
      policies: {
        resolveEffective: vi.fn().mockResolvedValue(samplePolicy),
      } as unknown as LeaveRepos['policies'],
      balances: {
        find: vi.fn().mockResolvedValue(lowBalance),
      } as unknown as LeaveRepos['balances'],
      requests: {
        findConflicting: vi.fn().mockResolvedValue(null),
      } as unknown as LeaveRepos['requests'],
    };

    const service = new LeaveService(createMockUow(mockRepos), authorizer);
    await expect(
      service.submitRequest(actor, companyId, {
        employeeId: 'emp-1',
        leaveType: 'CASUAL',
        startDate: '2026-11-20',
        endDate: '2026-11-20',
        reason: 'Personal errand',
      }),
    ).rejects.toBeInstanceOf(InsufficientLeaveBalanceError);
  });

  it('rejects leave submission when dates conflict with an existing request', async () => {
    const mockRepos: Partial<LeaveRepos> = {
      policies: {
        resolveEffective: vi.fn().mockResolvedValue(samplePolicy),
      } as unknown as LeaveRepos['policies'],
      requests: {
        findConflicting: vi.fn().mockResolvedValue({ id: 'conflicting-1' }),
      } as unknown as LeaveRepos['requests'],
    };

    const service = new LeaveService(createMockUow(mockRepos), authorizer);
    await expect(
      service.submitRequest(actor, companyId, {
        employeeId: 'emp-1',
        leaveType: 'CASUAL',
        startDate: '2026-11-20',
        endDate: '2026-11-20',
        reason: 'Personal errand',
      }),
    ).rejects.toBeInstanceOf(LeaveDateConflictError);
  });

  it('rejects leave submission when advance notice requirement is violated', async () => {
    const strictPolicy: LeavePolicy = {
      ...samplePolicy,
      leaveType: 'PRIVILEGE',
      minNoticeDays: 15,
    };

    const mockRepos: Partial<LeaveRepos> = {
      policies: {
        resolveEffective: vi.fn().mockResolvedValue(strictPolicy),
      } as unknown as LeaveRepos['policies'],
    };

    const service = new LeaveService(createMockUow(mockRepos), authorizer);
    // Submitting for tomorrow (1 day notice < 15 days required)
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    await expect(
      service.submitRequest(actor, companyId, {
        employeeId: 'emp-1',
        leaveType: 'PRIVILEGE',
        startDate: tomorrow,
        endDate: tomorrow,
        reason: 'Vacation',
      }),
    ).rejects.toBeInstanceOf(LeaveNoticePeriodError);
  });

  it('reviews and approves a pending leave request, moving pending balance to used', async () => {
    let committedApproved = false;
    const existingReq: LeaveRequestWithDetails = {
      id: 'req-1',
      companyId,
      employeeId: 'emp-1',
      leaveType: 'CASUAL',
      startDate: new Date('2026-11-20T00:00:00.000Z'),
      endDate: new Date('2026-11-20T00:00:00.000Z'),
      isHalfDay: false,
      halfDayPortion: null,
      totalDays: new Prisma.Decimal(1.0),
      reason: 'Personal',
      documentId: null,
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
        designation: 'Eng',
        principalId: 'p-1',
      },
    };

    const approverActor: ActorContext = { actorId: 'mgr-1', actorType: 'USER' };
    const updatedReq: LeaveRequestWithDetails = {
      ...existingReq,
      status: 'APPROVED',
      reviewedBy: approverActor.actorId,
      reviewedAt: new Date(),
      version: 1,
    };

    const mockRepos: Partial<LeaveRepos> = {
      requests: {
        findById: vi.fn().mockResolvedValue(existingReq),
        updateStatus: vi.fn().mockResolvedValue(updatedReq),
      } as unknown as LeaveRepos['requests'],
      balances: {
        commitApproved: vi.fn().mockImplementation(async () => {
          committedApproved = true;
          return sampleBalance;
        }),
      } as unknown as LeaveRepos['balances'],
      audit: {
        record: vi.fn().mockResolvedValue(undefined),
      },
    };

    const service = new LeaveService(createMockUow(mockRepos), authorizer);
    const result = await service.reviewRequest(approverActor, companyId, 'req-1', {
      action: 'APPROVE',
      remarks: 'Approved by PM',
      expectedVersion: 0,
    });

    expect(result.status).toBe('APPROVED');
    expect(committedApproved).toBe(true);
  });

  it('reviews and rejects a pending leave request, refunding pending balance', async () => {
    let rejectedPending = false;
    const existingReq: LeaveRequestWithDetails = {
      id: 'req-1',
      companyId,
      employeeId: 'emp-1',
      leaveType: 'CASUAL',
      startDate: new Date('2026-11-20T00:00:00.000Z'),
      endDate: new Date('2026-11-20T00:00:00.000Z'),
      isHalfDay: false,
      halfDayPortion: null,
      totalDays: new Prisma.Decimal(1.0),
      reason: 'Personal',
      documentId: null,
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
        designation: 'Eng',
        principalId: 'p-1',
      },
    };

    const approverActor: ActorContext = { actorId: 'mgr-1', actorType: 'USER' };
    const updatedReq: LeaveRequestWithDetails = {
      ...existingReq,
      status: 'REJECTED',
      reviewedBy: approverActor.actorId,
      reviewedAt: new Date(),
      reviewRemarks: 'Site workload heavy',
      version: 1,
    };

    const mockRepos: Partial<LeaveRepos> = {
      requests: {
        findById: vi.fn().mockResolvedValue(existingReq),
        updateStatus: vi.fn().mockResolvedValue(updatedReq),
      } as unknown as LeaveRepos['requests'],
      balances: {
        rejectPending: vi.fn().mockImplementation(async () => {
          rejectedPending = true;
          return sampleBalance;
        }),
      } as unknown as LeaveRepos['balances'],
      audit: {
        record: vi.fn().mockResolvedValue(undefined),
      },
    };

    const service = new LeaveService(createMockUow(mockRepos), authorizer);
    const result = await service.reviewRequest(approverActor, companyId, 'req-1', {
      action: 'REJECT',
      remarks: 'Site workload heavy',
      expectedVersion: 0,
    });

    expect(result.status).toBe('REJECTED');
    expect(rejectedPending).toBe(true);
  });

  it('cancels an approved leave request, refunding used days back to balance', async () => {
    let refundedApproved = false;
    const approvedReq: LeaveRequestWithDetails = {
      id: 'req-1',
      companyId,
      employeeId: 'emp-1',
      leaveType: 'CASUAL',
      startDate: new Date('2026-11-20T00:00:00.000Z'),
      endDate: new Date('2026-11-20T00:00:00.000Z'),
      isHalfDay: false,
      halfDayPortion: null,
      totalDays: new Prisma.Decimal(1.0),
      reason: 'Personal',
      documentId: null,
      status: 'APPROVED',
      reviewedBy: 'mgr-1',
      reviewedAt: new Date(),
      reviewRemarks: 'OK',
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
      employee: {
        id: 'emp-1',
        employeeCode: 'E1',
        displayName: 'Ramesh',
        designation: 'Eng',
        principalId: 'p-1',
      },
    };

    const cancelledReq: LeaveRequestWithDetails = {
      ...approvedReq,
      status: 'CANCELLED',
      version: 2,
    };

    const mockRepos: Partial<LeaveRepos> = {
      requests: {
        findById: vi.fn().mockResolvedValue(approvedReq),
        updateStatus: vi.fn().mockResolvedValue(cancelledReq),
      } as unknown as LeaveRepos['requests'],
      balances: {
        refundApproved: vi.fn().mockImplementation(async () => {
          refundedApproved = true;
          return sampleBalance;
        }),
      } as unknown as LeaveRepos['balances'],
      audit: {
        record: vi.fn().mockResolvedValue(undefined),
      },
    };

    const service = new LeaveService(createMockUow(mockRepos), authorizer);
    const result = await service.cancelRequest(actor, companyId, 'req-1', {
      reason: 'Trip cancelled',
      expectedVersion: 1,
    });

    expect(result.status).toBe('CANCELLED');
    expect(refundedApproved).toBe(true);
  });

  it('throws error when trying to cancel an already cancelled leave', async () => {
    const cancelledReq: LeaveRequestWithDetails = {
      id: 'req-1',
      companyId,
      employeeId: 'emp-1',
      leaveType: 'CASUAL',
      startDate: new Date('2026-11-20T00:00:00.000Z'),
      endDate: new Date('2026-11-20T00:00:00.000Z'),
      isHalfDay: false,
      halfDayPortion: null,
      totalDays: new Prisma.Decimal(1.0),
      reason: 'Personal',
      documentId: null,
      status: 'CANCELLED',
      reviewedBy: null,
      reviewedAt: null,
      reviewRemarks: null,
      version: 2,
      createdAt: new Date(),
      updatedAt: new Date(),
      employee: {
        id: 'emp-1',
        employeeCode: 'E1',
        displayName: 'Ramesh',
        designation: 'Eng',
        principalId: 'p-1',
      },
    };

    const mockRepos: Partial<LeaveRepos> = {
      requests: {
        findById: vi.fn().mockResolvedValue(cancelledReq),
      } as unknown as LeaveRepos['requests'],
    };

    const service = new LeaveService(createMockUow(mockRepos), authorizer);
    await expect(
      service.cancelRequest(actor, companyId, 'req-1', {
        expectedVersion: 2,
      }),
    ).rejects.toBeInstanceOf(LeaveRequestStateError);
  });

  describe('Defect Fixes', () => {
    // Bug 1: Self-apply resolution & proxy apply gating
    it('resolves employeeId to caller employee when omitted in submitRequest', async () => {
      let createdWithEmployeeId = '';
      const mockCreated: LeaveRequestWithDetails = {
        id: 'req-self',
        companyId,
        employeeId: 'emp-1',
        leaveType: 'CASUAL',
        startDate: new Date('2026-11-20T00:00:00.000Z'),
        endDate: new Date('2026-11-20T00:00:00.000Z'),
        isHalfDay: false,
        halfDayPortion: null,
        totalDays: new Prisma.Decimal(1.0),
        reason: 'Self apply test',
        documentId: null,
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
          designation: 'Eng',
          principalId: 'u1',
        },
      };

      const mockRepos: Partial<LeaveRepos> = {
        policies: {
          resolveEffective: vi.fn().mockResolvedValue(samplePolicy),
        } as unknown as LeaveRepos['policies'],
        balances: {
          find: vi.fn().mockResolvedValue(sampleBalance),
          reservePending: vi.fn().mockResolvedValue(sampleBalance),
        } as unknown as LeaveRepos['balances'],
        requests: {
          findConflicting: vi.fn().mockResolvedValue(null),
          create: vi
            .fn()
            .mockImplementation(
              async (
                _cid: string,
                data: { employee: { connect: { id_companyId: { id: string } } } },
              ) => {
                createdWithEmployeeId = data.employee.connect.id_companyId.id;
                return mockCreated;
              },
            ),
        } as unknown as LeaveRepos['requests'],
        audit: { record: vi.fn().mockResolvedValue(undefined) },
      };

      const service = new LeaveService(createMockUow(mockRepos), authorizer);
      const req = await service.submitRequest(actor, companyId, {
        leaveType: 'CASUAL',
        startDate: '2026-11-20',
        endDate: '2026-11-20',
        reason: 'Self apply test',
      });

      expect(req.id).toBe('req-self');
      expect(createdWithEmployeeId).toBe('emp-1');
    });

    it('throws error when caller has no employee record on self-apply', async () => {
      const mockRepos: Partial<LeaveRepos> = {
        employees: {
          findByPrincipal: vi.fn().mockResolvedValue(null),
          findById: vi.fn().mockResolvedValue(null),
          lockForUpdate: vi.fn().mockResolvedValue(undefined),
        },
      };

      const service = new LeaveService(createMockUow(mockRepos), authorizer);
      await expect(
        service.submitRequest(actor, companyId, {
          leaveType: 'CASUAL',
          startDate: '2026-11-20',
          endDate: '2026-11-20',
          reason: 'No emp profile',
        }),
      ).rejects.toBeInstanceOf(LeaveRequestStateError);
    });

    it('requires LEAVE_MANAGE when submitting on behalf of another employee', async () => {
      const strictAuthorizer = {
        assertPermission: vi.fn().mockImplementation(async (_pid: string, perm: string) => {
          if (perm === 'LEAVE_MANAGE') {
            throw new Error('Permission denied: LEAVE_MANAGE');
          }
        }),
        hasPermission: vi.fn().mockResolvedValue(false),
      };

      const mockRepos: Partial<LeaveRepos> = {
        policies: {
          resolveEffective: vi.fn().mockResolvedValue(samplePolicy),
        } as unknown as LeaveRepos['policies'],
        employees: {
          findByPrincipal: vi.fn().mockResolvedValue({
            id: 'emp-1',
            displayName: 'Ramesh',
            status: 'ACTIVE',
            principalId: 'u1',
          }),
          findById: vi.fn().mockResolvedValue({
            id: 'emp-other',
            displayName: 'Other',
            status: 'ACTIVE',
            principalId: 'u2',
          }),
          lockForUpdate: vi.fn().mockResolvedValue(undefined),
        },
      };

      const service = new LeaveService(createMockUow(mockRepos), strictAuthorizer);
      await expect(
        service.submitRequest(actor, companyId, {
          employeeId: 'emp-other',
          leaveType: 'CASUAL',
          startDate: '2026-11-20',
          endDate: '2026-11-20',
          reason: 'Applying for other',
        }),
      ).rejects.toThrow('Permission denied: LEAVE_MANAGE');
    });

    // Bug 2: Self-approval separation of duties
    it('blocks self-approval when reviewer is the applicant', async () => {
      const existingReq: LeaveRequestWithDetails = {
        id: 'req-self-appr',
        companyId,
        employeeId: 'emp-1',
        leaveType: 'CASUAL',
        startDate: new Date('2026-11-20T00:00:00.000Z'),
        endDate: new Date('2026-11-20T00:00:00.000Z'),
        isHalfDay: false,
        halfDayPortion: null,
        totalDays: new Prisma.Decimal(1.0),
        reason: 'Personal',
        documentId: null,
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
          designation: 'Eng',
          principalId: 'u1',
        },
      };

      const mockRepos: Partial<LeaveRepos> = {
        requests: {
          findById: vi.fn().mockResolvedValue(existingReq),
        } as unknown as LeaveRepos['requests'],
      };

      const service = new LeaveService(createMockUow(mockRepos), authorizer);
      await expect(
        service.reviewRequest(actor, companyId, 'req-self-appr', {
          action: 'APPROVE',
          expectedVersion: 0,
        }),
      ).rejects.toBeInstanceOf(SelfApprovalNotAllowedError);
    });

    // Bug 3: Anyone cancelling anyone's leave
    it('blocks non-owner from cancelling leave without LEAVE_MANAGE', async () => {
      const existingReq: LeaveRequestWithDetails = {
        id: 'req-other',
        companyId,
        employeeId: 'emp-other',
        leaveType: 'CASUAL',
        startDate: new Date('2026-11-20T00:00:00.000Z'),
        endDate: new Date('2026-11-20T00:00:00.000Z'),
        isHalfDay: false,
        halfDayPortion: null,
        totalDays: new Prisma.Decimal(1.0),
        reason: 'Personal',
        documentId: null,
        status: 'PENDING',
        reviewedBy: null,
        reviewedAt: null,
        reviewRemarks: null,
        version: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
        employee: {
          id: 'emp-other',
          employeeCode: 'E2',
          displayName: 'Other',
          designation: 'Eng',
          principalId: 'u-other',
        },
      };

      const mockRepos: Partial<LeaveRepos> = {
        requests: {
          findById: vi.fn().mockResolvedValue(existingReq),
        } as unknown as LeaveRepos['requests'],
      };

      const strictAuthorizer = {
        assertPermission: vi.fn().mockImplementation(async (_pid: string, perm: string) => {
          if (perm === 'LEAVE_MANAGE') {
            throw new Error('Permission denied: LEAVE_MANAGE');
          }
        }),
        hasPermission: vi.fn().mockResolvedValue(false),
      };

      const service = new LeaveService(createMockUow(mockRepos), strictAuthorizer);
      await expect(
        service.cancelRequest(actor, companyId, 'req-other', {
          reason: 'Unauthorized cancel attempt',
          expectedVersion: 0,
        }),
      ).rejects.toThrow('Permission denied: LEAVE_MANAGE');
    });

    // Bug 6: Privacy enforcement
    it('restricts ordinary employee to only their own records in listBalances', async () => {
      let queriedFilter: unknown;
      const mockRepos: Partial<LeaveRepos> = {
        balances: {
          list: vi.fn().mockImplementation(async (_cid, filter) => {
            queriedFilter = filter;
            return [];
          }),
        } as unknown as LeaveRepos['balances'],
      };

      const normalEmployeeAuthorizer = {
        assertPermission: vi.fn().mockImplementation(async (_pid: string, perm: string) => {
          if (perm === 'LEAVE_MANAGE' || perm === 'LEAVE_APPROVE') {
            throw new Error('Not supervisor');
          }
        }),
        hasPermission: vi.fn().mockResolvedValue(false),
      };

      const service = new LeaveService(createMockUow(mockRepos), normalEmployeeAuthorizer);
      await service.listBalances(actor, companyId);

      expect((queriedFilter as { employeeId: string }).employeeId).toBe('emp-1');
    });

    it('rejects ordinary employee attempting to query another employee balance directly', async () => {
      const mockRepos: Partial<LeaveRepos> = {
        balances: {
          find: vi.fn().mockResolvedValue(null),
        } as unknown as LeaveRepos['balances'],
      };

      const normalEmployeeAuthorizer = {
        assertPermission: vi.fn().mockImplementation(async (_pid: string, perm: string) => {
          if (perm === 'LEAVE_MANAGE' || perm === 'LEAVE_APPROVE') {
            throw new Error('Access denied to other employee balance');
          }
        }),
        hasPermission: vi.fn().mockResolvedValue(false),
      };

      const service = new LeaveService(createMockUow(mockRepos), normalEmployeeAuthorizer);
      await expect(
        service.getEmployeeBalance(actor, companyId, 'emp-other', 'CASUAL', 2026),
      ).rejects.toThrow('Access denied to other employee balance');
    });

    it('rejects ordinary employee attempting to read another employee leave request details', async () => {
      const otherReq: LeaveRequestWithDetails = {
        id: 'req-confidential',
        companyId,
        employeeId: 'emp-other',
        leaveType: 'SICK',
        startDate: new Date('2026-11-20T00:00:00.000Z'),
        endDate: new Date('2026-11-20T00:00:00.000Z'),
        isHalfDay: false,
        halfDayPortion: null,
        totalDays: new Prisma.Decimal(1.0),
        reason: 'Sensitive Medical Surgery',
        documentId: null,
        status: 'APPROVED',
        reviewedBy: 'mgr-1',
        reviewedAt: new Date(),
        reviewRemarks: null,
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
        employee: {
          id: 'emp-other',
          employeeCode: 'E2',
          displayName: 'Other',
          designation: 'Eng',
          principalId: 'u-other',
        },
      };

      const mockRepos: Partial<LeaveRepos> = {
        requests: {
          findById: vi.fn().mockResolvedValue(otherReq),
        } as unknown as LeaveRepos['requests'],
      };

      const normalEmployeeAuthorizer = {
        assertPermission: vi.fn().mockImplementation(async (_pid: string, perm: string) => {
          if (perm === 'LEAVE_MANAGE' || perm === 'LEAVE_APPROVE') {
            throw new Error('Access denied: supervisor permission required');
          }
        }),
        hasPermission: vi.fn().mockResolvedValue(false),
      };

      const service = new LeaveService(createMockUow(mockRepos), normalEmployeeAuthorizer);
      await expect(service.getRequestById(actor, companyId, 'req-confidential')).rejects.toThrow(
        'Access denied: supervisor permission required',
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Milestone 2A — dynamic leave types, policy versions, effective resolution
// ---------------------------------------------------------------------------

describe('LeaveService — types, versions, resolution', () => {
  const actor: ActorContext = { actorId: 'u1', actorType: 'USER' };
  const companyId = 'c1';
  const authorizer = {
    assertPermission: vi.fn().mockResolvedValue(undefined),
    hasPermission: vi.fn().mockResolvedValue(false),
  };

  const typeDefRow = (over: Partial<LeaveTypeDef> = {}): LeaveTypeDef => ({
    id: 'td-1',
    companyId,
    code: 'CL',
    name: 'Casual Leave',
    description: null,
    leaveType: 'CASUAL',
    status: 'ACTIVE',
    version: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  });

  const versionRow = (over: Partial<LeavePolicyVersion> = {}): LeavePolicyVersion => ({
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
    ...over,
  });

  const policyRow = (over: Partial<LeavePolicy> = {}): LeavePolicy => ({
    id: 'pol-1',
    companyId,
    scopeType: 'COMPANY',
    departmentId: null,
    projectId: null,
    siteId: null,
    employeeId: null,
    typeDefId: 'td-1',
    leaveType: 'CASUAL',
    name: 'Casual Leave Policy',
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
    ...over,
  });

  const balanceRow: LeaveBalance = {
    id: 'bal-1',
    companyId,
    employeeId: 'emp-1',
    leaveType: 'CASUAL',
    year: 2026,
    allocatedDays: new Prisma.Decimal(12),
    usedDays: new Prisma.Decimal(2),
    pendingDays: new Prisma.Decimal(0),
    carriedOverDays: new Prisma.Decimal(0),
    version: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const baseInput = {
    scopeType: 'COMPANY' as const,
    typeDefId: 'td-1',
    name: 'Policy',
    version: { effectiveFrom: '2026-01-01', mode: 'NONE' as const },
  };

  describe('createPolicy validation', () => {
    it('rejects DEPARTMENT scope without departmentId', async () => {
      const service = new LeaveService(createMockUow({}), authorizer);
      await expect(
        service.createPolicy(actor, companyId, { ...baseInput, scopeType: 'DEPARTMENT' }),
      ).rejects.toBeInstanceOf(LeaveScopeShapeError);
    });

    it('rejects COMPANY scope with an employeeId', async () => {
      const service = new LeaveService(createMockUow({}), authorizer);
      await expect(
        service.createPolicy(actor, companyId, { ...baseInput, employeeId: 'emp-1' }),
      ).rejects.toBeInstanceOf(LeaveScopeShapeError);
    });

    it('rejects MONTHLY_CREDIT without monthlyCreditAmount', async () => {
      const service = new LeaveService(createMockUow({}), authorizer);
      await expect(
        service.createPolicy(actor, companyId, {
          ...baseInput,
          version: { effectiveFrom: '2026-01-01', mode: 'MONTHLY_CREDIT' },
        }),
      ).rejects.toBeInstanceOf(LeavePolicyValidationError);
    });

    it('rejects MONTHLY_CREDIT with ratio fields (contradictory)', async () => {
      const service = new LeaveService(createMockUow({}), authorizer);
      await expect(
        service.createPolicy(actor, companyId, {
          ...baseInput,
          version: {
            effectiveFrom: '2026-01-01',
            mode: 'MONTHLY_CREDIT',
            monthlyCreditAmount: 4,
            ratioThresholdDays: 20,
            ratioEarnedAmount: 1,
          },
        }),
      ).rejects.toBeInstanceOf(LeavePolicyValidationError);
    });

    it('rejects WORKED_DAYS_RATIO missing one of the pair', async () => {
      const service = new LeaveService(createMockUow({}), authorizer);
      await expect(
        service.createPolicy(actor, companyId, {
          ...baseInput,
          version: {
            effectiveFrom: '2026-01-01',
            mode: 'WORKED_DAYS_RATIO',
            ratioThresholdDays: 20,
          },
        }),
      ).rejects.toBeInstanceOf(LeavePolicyValidationError);
    });

    it('rejects NONE with accrual parameters', async () => {
      const service = new LeaveService(createMockUow({}), authorizer);
      await expect(
        service.createPolicy(actor, companyId, {
          ...baseInput,
          version: { effectiveFrom: '2026-01-01', mode: 'NONE', monthlyCreditAmount: 1 },
        }),
      ).rejects.toBeInstanceOf(LeavePolicyValidationError);
    });

    it('rejects an archived type definition', async () => {
      const mockRepos: Partial<LeaveRepos> = {
        typeDefs: {
          findById: vi.fn().mockResolvedValue(typeDefRow({ status: 'ARCHIVED' })),
        } as unknown as LeaveRepos['typeDefs'],
      };
      const service = new LeaveService(createMockUow(mockRepos), authorizer);
      await expect(service.createPolicy(actor, companyId, baseInput)).rejects.toBeInstanceOf(
        LeavePolicyValidationError,
      );
    });
  });

  describe('addVersion / cancelVersion', () => {
    it('rejects a past effectiveFrom (retro protection)', async () => {
      const service = new LeaveService(createMockUow({}), authorizer);
      await expect(
        service.addVersion(actor, companyId, 'pol-1', {
          effectiveFrom: '2020-01-01',
          mode: 'NONE',
          expectedVersion: 0,
        }),
      ).rejects.toBeInstanceOf(LeavePolicyValidationError);
    });

    it('appends version with next number and bumps policy version', async () => {
      const created = versionRow({ version: 2, mode: 'MONTHLY_CREDIT' });
      const update = vi.fn().mockResolvedValue(policyRow({ version: 1 }));
      const mockRepos: Partial<LeaveRepos> = {
        policies: {
          findById: vi.fn().mockResolvedValue(policyRow()),
          update,
        } as unknown as LeaveRepos['policies'],
        versions: {
          create: vi.fn().mockResolvedValue(created),
          nextVersionNumber: vi.fn().mockResolvedValue(2),
          findActiveAtDate: vi.fn().mockResolvedValue(null),
        } as unknown as LeaveRepos['versions'],
        audit: { record: vi.fn() },
      };
      const service = new LeaveService(createMockUow(mockRepos), authorizer);
      const result = await service.addVersion(actor, companyId, 'pol-1', {
        effectiveFrom: '2099-01-01',
        mode: 'MONTHLY_CREDIT',
        monthlyCreditAmount: 4,
        expectedVersion: 0,
      });
      expect(result.version).toBe(2);
      expect(update).toHaveBeenCalledWith(companyId, 'pol-1', {}, 0);
    });

    it('refuses to cancel the last active version', async () => {
      const mockRepos: Partial<LeaveRepos> = {
        policies: {
          findById: vi.fn().mockResolvedValue(policyRow()),
        } as unknown as LeaveRepos['policies'],
        versions: {
          findById: vi.fn().mockResolvedValue(versionRow()),
          countActive: vi.fn().mockResolvedValue(1),
        } as unknown as LeaveRepos['versions'],
      };
      const service = new LeaveService(createMockUow(mockRepos), authorizer);
      await expect(service.cancelVersion(actor, companyId, 'pol-1', 'pv-1')).rejects.toBeInstanceOf(
        LastActiveLeavePolicyVersionError,
      );
    });
  });

  describe('resolveEffectiveConfig precedence', () => {
    const employeeId = 'emp-1';
    const makeRepos = (hits: {
      employee?: LeavePolicy | null;
      department?: LeavePolicy | null;
      company?: LeavePolicy | null;
      memberships?: { departmentId: string; isPrimary: boolean }[];
      version?: LeavePolicyVersion | null;
    }): Partial<LeaveRepos> => ({
      typeDefs: {
        findById: vi.fn().mockResolvedValue(typeDefRow()),
        findByLeaveType: vi.fn().mockResolvedValue(typeDefRow()),
      } as unknown as LeaveRepos['typeDefs'],
      employees: {
        findById: vi.fn().mockResolvedValue({ id: employeeId, status: 'ACTIVE' }),
        findByPrincipal: vi.fn().mockResolvedValue({ id: 'emp-1', principalId: 'u1' }),
      },
      memberships: {
        findActiveByEmployee: vi.fn().mockResolvedValue(hits.memberships ?? []),
        findCoveringByEmployee: vi.fn().mockResolvedValue([]),
      },
      policies: {
        findAtScope: vi
          .fn()
          .mockImplementation(async (_cid: string, target: { scopeType: string }) => {
            if (target.scopeType === 'EMPLOYEE') return hits.employee ?? null;
            if (target.scopeType === 'DEPARTMENT') return hits.department ?? null;
            return hits.company ?? null;
          }),
      } as unknown as LeaveRepos['policies'],
      versions: {
        findEffective: vi
          .fn()
          .mockResolvedValue(hits.version === undefined ? versionRow() : hits.version),
      } as unknown as LeaveRepos['versions'],
    });

    it('employee override wins over department and company', async () => {
      const service = new LeaveService(
        createMockUow(
          makeRepos({
            employee: policyRow({ id: 'pol-emp', scopeType: 'EMPLOYEE' }),
            department: policyRow({ id: 'pol-dept', scopeType: 'DEPARTMENT' }),
            company: policyRow({ id: 'pol-co' }),
            memberships: [{ departmentId: 'd1', isPrimary: true }],
          }),
        ),
        authorizer,
      );
      const result = await service.resolveEffectiveConfig(actor, companyId, {
        typeDefId: 'td-1',
        employeeId,
      });
      expect(result.resolvedVia).toBe('EMPLOYEE');
      expect(result.policy.id).toBe('pol-emp');
    });

    it('primary department membership wins over company fallback', async () => {
      const service = new LeaveService(
        createMockUow(
          makeRepos({
            department: policyRow({ id: 'pol-dept', scopeType: 'DEPARTMENT' }),
            company: policyRow({ id: 'pol-co' }),
            memberships: [
              { departmentId: 'd1', isPrimary: false },
              { departmentId: 'd2', isPrimary: true },
            ],
          }),
        ),
        authorizer,
      );
      const result = await service.resolveEffectiveConfig(actor, companyId, {
        typeDefId: 'td-1',
        employeeId,
      });
      expect(result.resolvedVia).toBe('DEPARTMENT');
      expect(result.policy.id).toBe('pol-dept');
    });

    it('single non-primary membership resolves deterministically', async () => {
      const service = new LeaveService(
        createMockUow(
          makeRepos({
            department: policyRow({ id: 'pol-dept', scopeType: 'DEPARTMENT' }),
            memberships: [{ departmentId: 'd1', isPrimary: false }],
          }),
        ),
        authorizer,
      );
      const result = await service.resolveEffectiveConfig(actor, companyId, {
        typeDefId: 'td-1',
        employeeId,
      });
      expect(result.resolvedVia).toBe('DEPARTMENT');
    });

    it('multiple memberships with no primary fails closed', async () => {
      const service = new LeaveService(
        createMockUow(
          makeRepos({
            memberships: [
              { departmentId: 'd1', isPrimary: false },
              { departmentId: 'd2', isPrimary: false },
            ],
          }),
        ),
        authorizer,
      );
      await expect(
        service.resolveEffectiveConfig(actor, companyId, { typeDefId: 'td-1', employeeId }),
      ).rejects.toBeInstanceOf(AmbiguousLeaveScopeError);
    });

    it('falls back to COMPANY and fails closed with no match', async () => {
      const withCompany = new LeaveService(
        createMockUow(makeRepos({ company: policyRow({ id: 'pol-co' }) })),
        authorizer,
      );
      const result = await withCompany.resolveEffectiveConfig(actor, companyId, {
        typeDefId: 'td-1',
        employeeId,
      });
      expect(result.resolvedVia).toBe('COMPANY');

      const noneService = new LeaveService(createMockUow(makeRepos({})), authorizer);
      await expect(
        noneService.resolveEffectiveConfig(actor, companyId, { typeDefId: 'td-1', employeeId }),
      ).rejects.toBeInstanceOf(NoEffectiveLeavePolicyError);
    });

    it('a policy with no effective version does not resolve', async () => {
      const service = new LeaveService(
        createMockUow(makeRepos({ company: policyRow(), version: null })),
        authorizer,
      );
      await expect(
        service.resolveEffectiveConfig(actor, companyId, { typeDefId: 'td-1', employeeId }),
      ).rejects.toBeInstanceOf(NoEffectiveLeavePolicyError);
    });
  });

  describe('archive guards', () => {
    it('refuses to archive a type still referenced by active policies', async () => {
      const mockRepos: Partial<LeaveRepos> = {
        typeDefs: {
          findById: vi.fn().mockResolvedValue(typeDefRow()),
        } as unknown as LeaveRepos['typeDefs'],
        policies: {
          countActiveReferencingTypeDef: vi.fn().mockResolvedValue(2),
        } as unknown as LeaveRepos['policies'],
      };
      const service = new LeaveService(createMockUow(mockRepos), authorizer);
      await expect(service.archiveTypeDef(actor, companyId, 'td-1', 0)).rejects.toBeInstanceOf(
        InvalidLeavePolicyStateError,
      );
    });

    it('refuses to update an archived type', async () => {
      const mockRepos: Partial<LeaveRepos> = {
        typeDefs: {
          findById: vi.fn().mockResolvedValue(typeDefRow({ status: 'ARCHIVED' })),
        } as unknown as LeaveRepos['typeDefs'],
      };
      const service = new LeaveService(createMockUow(mockRepos), authorizer);
      await expect(
        service.updateTypeDef(actor, companyId, 'td-1', { name: 'X', expectedVersion: 0 }),
      ).rejects.toBeInstanceOf(InvalidLeavePolicyStateError);
    });
  });

  describe('department tier in request-time resolution', () => {
    it('preview passes the primary membership department to resolveEffective', async () => {
      const resolveEffective = vi.fn().mockResolvedValue(policyRow({ scopeType: 'DEPARTMENT' }));
      const mockRepos: Partial<LeaveRepos> = {
        memberships: {
          findActiveByEmployee: vi
            .fn()
            .mockResolvedValue([{ departmentId: 'dept-1', isPrimary: true }]),
          findCoveringByEmployee: vi
            .fn()
            .mockResolvedValue([{ departmentId: 'dept-1', isPrimary: true }]),
        },
        policies: { resolveEffective } as unknown as LeaveRepos['policies'],
      };
      const service = new LeaveService(createMockUow(mockRepos), authorizer);
      await service.resolveEffectivePolicy(actor, companyId, 'CASUAL', { employeeId: 'emp-1' });
      expect(resolveEffective).toHaveBeenCalledWith(companyId, 'CASUAL', {
        employeeId: 'emp-1',
        departmentId: 'dept-1',
      });
    });

    it('submitRequest resolves through the department tier', async () => {
      const resolveEffective = vi.fn().mockResolvedValue(policyRow({ scopeType: 'DEPARTMENT' }));
      const mockRepos: Partial<LeaveRepos> = {
        memberships: {
          findActiveByEmployee: vi
            .fn()
            .mockResolvedValue([{ departmentId: 'dept-1', isPrimary: true }]),
          findCoveringByEmployee: vi
            .fn()
            .mockResolvedValue([{ departmentId: 'dept-1', isPrimary: true }]),
        },
        policies: { resolveEffective } as unknown as LeaveRepos['policies'],
        versions: {
          findEffective: vi.fn().mockResolvedValue(versionRow()),
          findNextEffective: vi.fn().mockResolvedValue(null),
        } as unknown as LeaveRepos['versions'],
        balances: {
          find: vi.fn().mockResolvedValue(balanceRow),
          reservePending: vi.fn().mockResolvedValue(balanceRow),
        } as unknown as LeaveRepos['balances'],
        requests: {
          findConflicting: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({
            id: 'req-1',
            companyId,
            employeeId: 'emp-1',
            leaveType: 'CASUAL',
            status: 'PENDING',
            totalDays: new Prisma.Decimal(1),
            startDate: new Date(),
            endDate: new Date(),
            isHalfDay: false,
            halfDayPortion: null,
            reason: 'x',
            documentId: null,
            reviewedBy: null,
            reviewedAt: null,
            reviewRemarks: null,
            version: 0,
            createdAt: new Date(),
            updatedAt: new Date(),
            employee: {
              id: 'emp-1',
              employeeCode: 'E01',
              displayName: 'Ramesh',
              designation: 'Eng',
              principalId: 'p-1',
            },
          }),
        } as unknown as LeaveRepos['requests'],
        audit: { record: vi.fn() },
      };
      const service = new LeaveService(createMockUow(mockRepos), authorizer);
      await service.submitRequest(actor, companyId, {
        employeeId: 'emp-1',
        leaveType: 'CASUAL',
        startDate: '2026-11-20',
        endDate: '2026-11-20',
        reason: 'Personal errand',
      });
      expect(resolveEffective).toHaveBeenCalledWith(companyId, 'CASUAL', {
        employeeId: 'emp-1',
        departmentId: 'dept-1',
      });
    });

    it('submitRequest fails closed on ambiguous memberships', async () => {
      const mockRepos: Partial<LeaveRepos> = {
        memberships: {
          findActiveByEmployee: vi.fn().mockResolvedValue([
            { departmentId: 'dept-1', isPrimary: false },
            { departmentId: 'dept-2', isPrimary: false },
          ]),
          findCoveringByEmployee: vi.fn().mockResolvedValue([]),
        },
      };
      const service = new LeaveService(createMockUow(mockRepos), authorizer);
      await expect(
        service.submitRequest(actor, companyId, {
          employeeId: 'emp-1',
          leaveType: 'CASUAL',
          startDate: '2026-11-20',
          endDate: '2026-11-20',
          reason: 'Personal errand',
        }),
      ).rejects.toBeInstanceOf(AmbiguousLeaveScopeError);
    });
  });

  describe('window boundary semantics', () => {
    const baseSubmit = {
      employeeId: 'emp-1',
      leaveType: 'CASUAL' as const,
      startDate: '2026-11-20',
      endDate: '2026-11-25',
      reason: 'Personal errand',
    };

    const submitMocks = (over: {
      membershipsByAsOf?: (asOf?: Date) => { departmentId: string; isPrimary: boolean }[];
      covering?: { departmentId: string; isPrimary: boolean }[];
      policy?: LeavePolicy;
      effective?: LeavePolicyVersion | null;
      next?: LeavePolicyVersion | null;
    }): Partial<LeaveRepos> => ({
      memberships: {
        findActiveByEmployee: vi
          .fn()
          .mockImplementation(
            async (_c: string, _e: string, asOf?: Date) => over.membershipsByAsOf?.(asOf) ?? [],
          ),
        findCoveringByEmployee: vi.fn().mockResolvedValue(over.covering ?? []),
      },
      policies: {
        resolveEffective: vi.fn().mockResolvedValue(over.policy ?? policyRow()),
      } as unknown as LeaveRepos['policies'],
      versions: {
        findEffective: vi
          .fn()
          .mockResolvedValue(over.effective === undefined ? versionRow() : over.effective),
        findNextEffective: vi.fn().mockResolvedValue(over.next ?? null),
      } as unknown as LeaveRepos['versions'],
      balances: {
        find: vi.fn().mockResolvedValue(balanceRow),
        reservePending: vi.fn().mockResolvedValue(balanceRow),
      } as unknown as LeaveRepos['balances'],
      requests: {
        findConflicting: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: 'req-1', status: 'PENDING' }),
      } as unknown as LeaveRepos['requests'],
      audit: { record: vi.fn() },
    });

    it('a mid-request department transfer fails closed', async () => {
      const service = new LeaveService(
        createMockUow(
          submitMocks({
            membershipsByAsOf: (asOf) =>
              asOf !== undefined && asOf.getTime() >= new Date('2026-11-23').getTime()
                ? [{ departmentId: 'dept-new', isPrimary: true }]
                : [{ departmentId: 'dept-old', isPrimary: true }],
          }),
        ),
        authorizer,
      );
      await expect(service.submitRequest(actor, companyId, baseSubmit)).rejects.toBeInstanceOf(
        LeavePeriodBoundaryError,
      );
    });

    it('a membership lapse inside the window fails closed', async () => {
      const service = new LeaveService(
        createMockUow(
          submitMocks({
            // Same dept at both ends, but no single membership covers the gap.
            membershipsByAsOf: () => [{ departmentId: 'dept-1', isPrimary: true }],
            covering: [],
          }),
        ),
        authorizer,
      );
      await expect(service.submitRequest(actor, companyId, baseSubmit)).rejects.toBeInstanceOf(
        LeavePeriodBoundaryError,
      );
    });

    it('a policy version taking effect mid-request fails closed', async () => {
      const service = new LeaveService(
        createMockUow(
          submitMocks({
            next: versionRow({
              version: 2,
              effectiveFrom: new Date('2026-11-22T00:00:00Z'),
            }),
          }),
        ),
        authorizer,
      );
      await expect(service.submitRequest(actor, companyId, baseSubmit)).rejects.toBeInstanceOf(
        LeavePeriodBoundaryError,
      );
    });

    it('a request with no effective version at start fails closed', async () => {
      const service = new LeaveService(createMockUow(submitMocks({ effective: null })), authorizer);
      await expect(service.submitRequest(actor, companyId, baseSubmit)).rejects.toBeInstanceOf(
        LeavePeriodBoundaryError,
      );
    });

    it('a single version covering the whole window is allowed', async () => {
      const service = new LeaveService(
        createMockUow(
          submitMocks({
            next: versionRow({
              version: 2,
              effectiveFrom: new Date('2026-12-01T00:00:00Z'),
            }),
          }),
        ),
        authorizer,
      );
      const result = await service.submitRequest(actor, companyId, baseSubmit);
      expect(result.status).toBe('PENDING');
    });

    it('a request ending before any version boundary is allowed', async () => {
      const service = new LeaveService(createMockUow(submitMocks({})), authorizer);
      const result = await service.submitRequest(actor, companyId, {
        ...baseSubmit,
        endDate: '2026-11-20',
      });
      expect(result.status).toBe('PENDING');
    });

    it('addVersion rejects a duplicate ACTIVE effectiveFrom', async () => {
      const mockRepos: Partial<LeaveRepos> = {
        policies: {
          findById: vi.fn().mockResolvedValue(policyRow()),
        } as unknown as LeaveRepos['policies'],
        versions: {
          findActiveAtDate: vi.fn().mockResolvedValue(versionRow()),
        } as unknown as LeaveRepos['versions'],
      };
      const service = new LeaveService(createMockUow(mockRepos), authorizer);
      await expect(
        service.addVersion(actor, companyId, 'pol-1', {
          effectiveFrom: '2099-01-01',
          mode: 'NONE',
          expectedVersion: 0,
        }),
      ).rejects.toBeInstanceOf(LeavePolicyValidationError);
    });

    it('preview resolution queries memberships at the asOf date', async () => {
      const findActiveByEmployee = vi
        .fn()
        .mockResolvedValue([{ departmentId: 'dept-1', isPrimary: true }]);
      const mockRepos: Partial<LeaveRepos> = {
        typeDefs: {
          findById: vi.fn().mockResolvedValue(typeDefRow()),
        } as unknown as LeaveRepos['typeDefs'],
        employees: {
          findById: vi.fn().mockResolvedValue({ id: 'emp-1', status: 'ACTIVE' }),
          findByPrincipal: vi.fn().mockResolvedValue({ id: 'emp-1', principalId: 'u1' }),
        },
        memberships: {
          findActiveByEmployee,
          findCoveringByEmployee: vi.fn().mockResolvedValue([]),
        },
        policies: {
          findAtScope: vi
            .fn()
            .mockImplementation(async (_c: string, target: { scopeType: string }) =>
              target.scopeType === 'DEPARTMENT'
                ? policyRow({ scopeType: 'DEPARTMENT', id: 'pol-dept' })
                : null,
            ),
        } as unknown as LeaveRepos['policies'],
        versions: {
          findEffective: vi.fn().mockResolvedValue(versionRow()),
        } as unknown as LeaveRepos['versions'],
      };
      const service = new LeaveService(createMockUow(mockRepos), authorizer);
      const result = await service.resolveEffectiveConfig(actor, companyId, {
        typeDefId: 'td-1',
        employeeId: 'emp-1',
        asOf: '2026-06-15',
      });
      expect(result.resolvedVia).toBe('DEPARTMENT');
      expect(findActiveByEmployee).toHaveBeenCalledWith(
        companyId,
        'emp-1',
        new Date('2026-06-15T00:00:00.000Z'),
      );
    });
  });
});

// ---------------------------------------------------------------------------
// PI/PD-scoped leave authorization — site/project-department workforce
// ---------------------------------------------------------------------------

describe('LeaveService — scoped PI/PD authorization', () => {
  const companyId = 'c1';
  const piActor: ActorContext = { actorId: 'u-pi', actorType: 'USER' };
  const siblingPiActor: ActorContext = { actorId: 'u-pi-b', actorType: 'USER' };
  const financeActor: ActorContext = { actorId: 'u-fin', actorType: 'USER' };

  const SITE_A1 = 'site-a1';
  const SITE_A2 = 'site-a2';
  const PROJ_A = 'proj-a';
  const SITE_B1 = 'site-b1';
  const HO_1 = 'ho-1';

  interface DeptScope {
    id: string;
    status: string;
    siteId: string | null;
    projectId: string | null;
    baseHeadOfficeId: string | null;
    site: { projectId: string } | null;
  }

  const siteDept = (id: string, siteId: string): DeptScope => ({
    id,
    status: 'ACTIVE',
    siteId,
    projectId: null,
    baseHeadOfficeId: null,
    site: { projectId: PROJ_A },
  });
  const siblingDept = (id: string): DeptScope => ({
    id,
    status: 'ACTIVE',
    siteId: SITE_B1,
    projectId: null,
    baseHeadOfficeId: null,
    site: { projectId: 'proj-b' },
  });
  const hoDept = (id: string): DeptScope => ({
    id,
    status: 'ACTIVE',
    siteId: null,
    projectId: null,
    baseHeadOfficeId: HO_1,
    site: null,
  });

  const membershipOf = (departmentId: string, department: DeptScope) => ({
    departmentId,
    isPrimary: true,
    department,
  });

  /**
   * PI grant model: LEAVE_APPROVE at sites a1/a2 of proj-a (a project grant
   * covers child-site targets). LEAVE_READ / LEAVE_APPLY come from the
   * company-scope EMPLOYEE baseline, so they always resolve — the scope
   * barrier lives entirely on the approver keys.
   */
  const piAuthorizer = {
    assertPermission: vi
      .fn()
      .mockImplementation(
        async (_pid: string, perm: string, target?: { scopeType: string; scopeId: string }) => {
          if (perm === 'LEAVE_READ' || perm === 'LEAVE_APPLY') return;
          const t = target ?? { scopeType: 'COMPANY', scopeId: companyId };
          const covered =
            (t.scopeType === 'SITE' && (t.scopeId === SITE_A1 || t.scopeId === SITE_A2)) ||
            (t.scopeType === 'PROJECT' && t.scopeId === PROJ_A);
          if (!covered) throw new Error('Access denied: out of scope');
          if (perm === 'LEAVE_APPROVE') return;
          throw new Error(`Permission denied: ${perm}`);
        },
      ),
    hasPermission: vi
      .fn()
      .mockImplementation(async (pid: string, perm: string, target: { scopeId: string }) => {
        if (perm !== 'LEAVE_APPROVE') return false;
        if (pid === 'u-pi' || pid === 'u-pi-b') {
          return (
            target.scopeId === SITE_A1 || target.scopeId === SITE_A2 || target.scopeId === PROJ_A
          );
        }
        return false;
      }),
  };

  /** Finance/Admin: company-level authority — every target resolves. */
  const financeAuthorizer = {
    assertPermission: vi.fn().mockResolvedValue(undefined),
    hasPermission: vi.fn().mockResolvedValue(true),
  };

  const pendingRequest = (
    over: {
      id?: string;
      employeeId?: string;
      principalId?: string;
      status?: 'PENDING' | 'RETURNED' | 'APPROVED';
      version?: number;
    } = {},
  ): LeaveRequestWithDetails => ({
    id: over.id ?? 'req-1',
    companyId,
    employeeId: over.employeeId ?? 'emp-site',
    leaveType: 'CASUAL',
    startDate: new Date('2026-11-20T00:00:00.000Z'),
    endDate: new Date('2026-11-20T00:00:00.000Z'),
    isHalfDay: false,
    halfDayPortion: null,
    totalDays: new Prisma.Decimal(1.0),
    reason: 'Site work',
    documentId: null,
    status: over.status ?? 'PENDING',
    reviewedBy: null,
    reviewedAt: null,
    reviewRemarks: null,
    version: over.version ?? 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    employee: {
      id: over.employeeId ?? 'emp-site',
      employeeCode: 'E9',
      displayName: 'Site Worker',
      designation: 'Mason',
      principalId: over.principalId ?? 'u-emp',
    },
  });

  const sampleBalance: LeaveBalance = {
    id: 'bal-1',
    companyId,
    employeeId: 'emp-site',
    leaveType: 'CASUAL',
    year: 2026,
    allocatedDays: new Prisma.Decimal(12),
    usedDays: new Prisma.Decimal(2),
    pendingDays: new Prisma.Decimal(0),
    carriedOverDays: new Prisma.Decimal(0),
    version: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const commitApproved = vi.fn().mockResolvedValue(sampleBalance);
  const rejectPending = vi.fn().mockResolvedValue(sampleBalance);
  const reservePending = vi.fn().mockResolvedValue(sampleBalance);

  beforeEach(() => {
    commitApproved.mockClear();
    rejectPending.mockClear();
    reservePending.mockClear();
    piAuthorizer.assertPermission.mockClear();
  });

  const requestRepos = (department: DeptScope, req: LeaveRequestWithDetails) =>
    ({
      requests: {
        findById: vi.fn().mockResolvedValue(req),
        updateStatus: vi
          .fn()
          .mockImplementation(async (_c: string, _i: string, status: string) => ({
            ...req,
            status,
            version: req.version + 1,
          })),
      } as unknown as LeaveRepos['requests'],
      memberships: {
        findActiveByEmployee: vi.fn().mockResolvedValue([membershipOf(department.id, department)]),
        findCoveringByEmployee: vi
          .fn()
          .mockResolvedValue([membershipOf(department.id, department)]),
      } as unknown as LeaveRepos['memberships'],
      balances: {
        commitApproved,
        rejectPending,
        reservePending,
        find: vi.fn().mockResolvedValue(sampleBalance),
      } as unknown as LeaveRepos['balances'],
      audit: { record: vi.fn().mockResolvedValue(undefined) },
    }) satisfies Partial<LeaveRepos>;

  it('PI approves a site-department employee request inside the assigned site', async () => {
    const req = pendingRequest();
    const repos = requestRepos(siteDept('dept-a1', SITE_A1), req);
    const service = new LeaveService(createMockUow(repos), piAuthorizer);

    const result = await service.reviewRequest(piActor, companyId, 'req-1', {
      action: 'APPROVE',
      expectedVersion: 0,
    });

    expect(result.status).toBe('APPROVED');
    expect(commitApproved).toHaveBeenCalledWith(companyId, 'emp-site', 'CASUAL', 2026, 1);
    expect(piAuthorizer.assertPermission).toHaveBeenCalledWith(
      'u-pi',
      'LEAVE_APPROVE',
      expect.objectContaining({ scopeType: 'SITE', scopeId: SITE_A1 }),
    );
  });

  it('PI authority covers site labour regardless of engagement type — membership, not engagement, drives access', async () => {
    const req = pendingRequest({ id: 'req-lab', employeeId: 'emp-labour', principalId: 'u-lab' });
    const repos = requestRepos(siteDept('dept-lab-a', SITE_A2), req);
    const service = new LeaveService(createMockUow(repos), piAuthorizer);

    const result = await service.reviewRequest(piActor, companyId, 'req-lab', {
      action: 'APPROVE',
      expectedVersion: 0,
    });

    expect(result.status).toBe('APPROVED');
    expect(piAuthorizer.assertPermission).toHaveBeenCalledWith(
      'u-pi',
      'LEAVE_APPROVE',
      expect.objectContaining({ scopeType: 'SITE', scopeId: SITE_A2 }),
    );
  });

  it('PI cannot review a request in a sibling site', async () => {
    const req = pendingRequest();
    const repos = requestRepos(siblingDept('dept-b1'), req);
    const service = new LeaveService(createMockUow(repos), piAuthorizer);

    await expect(
      service.reviewRequest(piActor, companyId, 'req-1', {
        action: 'APPROVE',
        expectedVersion: 0,
      }),
    ).rejects.toThrow(/Access denied|Permission denied/);
    expect(commitApproved).not.toHaveBeenCalled();
  });

  it('PI cannot review a head-office department request', async () => {
    const req = pendingRequest();
    const repos = requestRepos(hoDept('dept-ho'), req);
    const service = new LeaveService(createMockUow(repos), piAuthorizer);

    await expect(
      service.reviewRequest(piActor, companyId, 'req-1', {
        action: 'REJECT',
        remarks: 'nope',
        expectedVersion: 0,
      }),
    ).rejects.toThrow(/Access denied|Permission denied/);
  });

  it('Finance retains company-level authority over site-department requests', async () => {
    const req = pendingRequest();
    const repos = requestRepos(siteDept('dept-a1', SITE_A1), req);
    const service = new LeaveService(createMockUow(repos), financeAuthorizer);

    const result = await service.reviewRequest(financeActor, companyId, 'req-1', {
      action: 'APPROVE',
      expectedVersion: 0,
    });
    expect(result.status).toBe('APPROVED');
  });

  it("a PI's own leave request cannot be approved by another scoped approver — it requires company authority", async () => {
    const req = pendingRequest({ principalId: 'u-pi', employeeId: 'emp-pi' });
    const repos = requestRepos(siteDept('dept-a1', SITE_A1), req);
    const service = new LeaveService(createMockUow(repos), piAuthorizer);

    await expect(
      service.reviewRequest(siblingPiActor, companyId, 'req-1', {
        action: 'APPROVE',
        expectedVersion: 0,
      }),
    ).rejects.toThrow(/Access denied|Permission denied/);
    expect(piAuthorizer.assertPermission).toHaveBeenCalledWith(
      'u-pi-b',
      'LEAVE_APPROVE',
      expect.objectContaining({ scopeType: 'COMPANY', scopeId: companyId }),
    );
  });

  it("a PI's own leave request CAN be approved by company-level Finance", async () => {
    const req = pendingRequest({ principalId: 'u-pi', employeeId: 'emp-pi' });
    const repos = requestRepos(siteDept('dept-a1', SITE_A1), req);
    const service = new LeaveService(createMockUow(repos), financeAuthorizer);

    const result = await service.reviewRequest(financeActor, companyId, 'req-1', {
      action: 'APPROVE',
      expectedVersion: 0,
    });
    expect(result.status).toBe('APPROVED');
  });

  it('PI can view a site employee balance but not a sibling-site balance', async () => {
    const memberships = {
      findActiveByEmployee: vi
        .fn()
        .mockImplementation(async (_c: string, employeeId: string) =>
          employeeId === 'emp-site'
            ? [membershipOf('dept-a1', siteDept('dept-a1', SITE_A1))]
            : [membershipOf('dept-b1', siblingDept('dept-b1'))],
        ),
    };
    const repos: Partial<LeaveRepos> = {
      memberships: memberships as unknown as LeaveRepos['memberships'],
      balances: {
        find: vi.fn().mockResolvedValue(sampleBalance),
      } as unknown as LeaveRepos['balances'],
    };
    const service = new LeaveService(createMockUow(repos), piAuthorizer);

    const bal = await service.getEmployeeBalance(piActor, companyId, 'emp-site', 'CASUAL', 2026);
    expect(bal?.leaveType).toBe('CASUAL');

    await expect(
      service.getEmployeeBalance(piActor, companyId, 'emp-sibling', 'CASUAL', 2026),
    ).rejects.toThrow(/Access denied|Permission denied/);
  });

  it('scoped request listing asserts approver at the site target and excludes sibling-site rows', async () => {
    const rowA = pendingRequest({ id: 'req-a', employeeId: 'emp-a' });
    const rowB = pendingRequest({ id: 'req-b', employeeId: 'emp-b' });
    const repos: Partial<LeaveRepos> = {
      requests: {
        list: vi.fn().mockResolvedValue([rowA, rowB]),
      } as unknown as LeaveRepos['requests'],
      memberships: {
        findActiveByEmployee: vi.fn().mockResolvedValue([]),
        findCoveringByEmployee: vi.fn().mockResolvedValue([]),
        findByEmployeesInWindow: vi.fn().mockResolvedValue([
          {
            employeeId: 'emp-a',
            departmentId: 'dept-a1',
            isPrimary: true,
            startedAt: new Date('2026-01-01T00:00:00.000Z'),
            endedAt: null,
            department: siteDept('dept-a1', SITE_A1),
          },
          {
            employeeId: 'emp-b',
            departmentId: 'dept-b1',
            isPrimary: true,
            startedAt: new Date('2026-01-01T00:00:00.000Z'),
            endedAt: null,
            department: siblingDept('dept-b1'),
          },
        ]),
      },
    };
    const service = new LeaveService(createMockUow(repos), piAuthorizer);

    const rows = await service.listRequests(piActor, companyId, { siteId: SITE_A1 });
    expect(rows.map((r) => r.id)).toEqual(['req-a']);
    expect(piAuthorizer.assertPermission).toHaveBeenCalledWith(
      'u-pi',
      'LEAVE_APPROVE',
      expect.objectContaining({ scopeType: 'SITE', scopeId: SITE_A1 }),
    );
  });

  it('PI cannot list requests filtered to a sibling site', async () => {
    const service = new LeaveService(createMockUow({}), piAuthorizer);
    await expect(service.listRequests(piActor, companyId, { siteId: SITE_B1 })).rejects.toThrow(
      /Access denied|Permission denied/,
    );
  });

  it('RETURN requires remarks', async () => {
    const req = pendingRequest();
    const repos = requestRepos(siteDept('dept-a1', SITE_A1), req);
    const service = new LeaveService(createMockUow(repos), piAuthorizer);

    await expect(
      service.reviewRequest(piActor, companyId, 'req-1', {
        action: 'RETURN',
        expectedVersion: 0,
      }),
    ).rejects.toBeInstanceOf(LeaveRequestStateError);
  });

  it('RETURN releases the pending reservation and sets RETURNED status', async () => {
    const req = pendingRequest();
    const repos = requestRepos(siteDept('dept-a1', SITE_A1), req);
    const service = new LeaveService(createMockUow(repos), piAuthorizer);

    const result = await service.reviewRequest(piActor, companyId, 'req-1', {
      action: 'RETURN',
      remarks: 'Fix the dates',
      expectedVersion: 0,
    });

    expect(result.status).toBe('RETURNED');
    expect(rejectPending).toHaveBeenCalledWith(companyId, 'emp-site', 'CASUAL', 2026, 1);
  });

  it('only the owner may resubmit a RETURNED request', async () => {
    const req = pendingRequest({ status: 'RETURNED' });
    const service = new LeaveService(
      createMockUow({
        requests: { findById: vi.fn().mockResolvedValue(req) } as unknown as LeaveRepos['requests'],
      }),
      piAuthorizer,
    );

    await expect(
      service.resubmitRequest(piActor, companyId, 'req-1', { expectedVersion: 1 }),
    ).rejects.toBeInstanceOf(LeaveRequestStateError);
  });

  it('owner resubmission re-runs the submission pipeline, re-reserves balance, and re-enters PENDING', async () => {
    const req = pendingRequest({ status: 'RETURNED', version: 1, principalId: 'u1' });
    const dept = siteDept('dept-a1', SITE_A1);
    const policy: LeavePolicy = {
      id: 'pol-1',
      companyId,
      scopeType: 'COMPANY',
      departmentId: null,
      projectId: null,
      siteId: null,
      employeeId: null,
      typeDefId: 'td-1',
      leaveType: 'CASUAL',
      name: 'Casual Leave Policy',
      description: null,
      annualAllowance: new Prisma.Decimal(12),
      accrualFrequency: 'ANNUAL',
      maxConsecutiveDays: 3,
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
    const resubmitMock = vi
      .fn()
      .mockImplementation(async (_c: string, _i: string, data: { totalDays: number }) => ({
        ...req,
        ...data,
        totalDays: new Prisma.Decimal(data.totalDays),
        status: 'PENDING',
        version: 2,
      }));
    const repos: Partial<LeaveRepos> = {
      requests: {
        findById: vi.fn().mockResolvedValue(req),
        findConflicting: vi.fn().mockResolvedValue(null),
        resubmit: resubmitMock,
      } as unknown as LeaveRepos['requests'],
      memberships: {
        findActiveByEmployee: vi.fn().mockResolvedValue([membershipOf(dept.id, dept)]),
        findCoveringByEmployee: vi.fn().mockResolvedValue([membershipOf(dept.id, dept)]),
      },
      policies: {
        resolveEffective: vi.fn().mockResolvedValue(policy),
      } as unknown as LeaveRepos['policies'],
      versions: {
        findEffective: vi.fn().mockResolvedValue({ id: 'pv-1', version: 1 }),
        findNextEffective: vi.fn().mockResolvedValue(null),
      } as unknown as LeaveRepos['versions'],
      balances: {
        find: vi.fn().mockResolvedValue(sampleBalance),
        reservePending,
      } as unknown as LeaveRepos['balances'],
      audit: { record: vi.fn().mockResolvedValue(undefined) },
    };
    const resubmitter: ActorContext = { actorId: 'u1', actorType: 'USER' };
    const service = new LeaveService(createMockUow(repos), piAuthorizer);

    const result = await service.resubmitRequest(resubmitter, companyId, 'req-1', {
      startDate: '2026-11-25',
      endDate: '2026-11-25',
      expectedVersion: 1,
    });

    expect(result.status).toBe('PENDING');
    expect(reservePending).toHaveBeenCalledWith(companyId, 'emp-site', 'CASUAL', 2026, 1);
    expect(resubmitMock).toHaveBeenCalledWith(
      companyId,
      'req-1',
      expect.objectContaining({
        startDate: new Date('2026-11-25T00:00:00.000Z'),
        endDate: new Date('2026-11-25T00:00:00.000Z'),
      }),
      1,
    );
  });

  it('resolveScope maps a request to its site target via the requester department', async () => {
    const req = pendingRequest();
    const repos = requestRepos(siteDept('dept-a1', SITE_A1), req);
    const service = new LeaveService(createMockUow(repos), piAuthorizer);

    const target = await service.resolveScope(companyId, 'request', 'req-1');
    expect(target).toEqual({ companyId, scopeType: 'SITE', scopeId: SITE_A1 });
  });

  it('resolveScope falls back to COMPANY for an unresolvable request', async () => {
    const service = new LeaveService(
      createMockUow({
        requests: {
          findById: vi.fn().mockResolvedValue(null),
        } as unknown as LeaveRepos['requests'],
      }),
      piAuthorizer,
    );
    const target = await service.resolveScope(companyId, 'request', 'req-ghost');
    expect(target.scopeType).toBe('COMPANY');
  });
});

// ---------------------------------------------------------------------------
// Delegated leave-policy management — CompanyDelegationPolicy.leavePolicyManage
// ---------------------------------------------------------------------------

describe('LeaveService — delegated site leave-policy management', () => {
  const companyId = 'c1';
  const piActor: ActorContext = { actorId: 'u-pi', actorType: 'USER' };
  const financeActor: ActorContext = { actorId: 'u-fin', actorType: 'USER' };

  const SITE_A1 = 'site-a1';
  const SITE_B1 = 'site-b1';
  const PROJ_A = 'proj-a';
  const HO_1 = 'ho-1';

  interface DeptScope {
    id: string;
    status: string;
    siteId: string | null;
    projectId: string | null;
    baseHeadOfficeId: string | null;
    site: { projectId: string } | null;
  }

  const siteDept = (id: string, siteId: string, projectId = PROJ_A): DeptScope => ({
    id,
    status: 'ACTIVE',
    siteId,
    projectId: null,
    baseHeadOfficeId: null,
    site: { projectId },
  });
  const hoDept = (id: string): DeptScope => ({
    id,
    status: 'ACTIVE',
    siteId: null,
    projectId: null,
    baseHeadOfficeId: HO_1,
    site: null,
  });

  const typeDefRow: LeaveTypeDef = {
    id: 'td-1',
    companyId,
    code: 'CL',
    name: 'Casual Leave',
    description: null,
    leaveType: 'CASUAL',
    status: 'ACTIVE',
    version: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const policyOf = (over: Partial<LeavePolicy> = {}): LeavePolicy => ({
    id: 'pol-1',
    companyId,
    scopeType: 'DEPARTMENT',
    departmentId: 'dept-a1',
    projectId: null,
    siteId: null,
    employeeId: null,
    typeDefId: 'td-1',
    leaveType: 'CASUAL',
    name: 'Site CL Policy',
    description: null,
    annualAllowance: new Prisma.Decimal(24),
    accrualFrequency: 'MONTHLY',
    maxConsecutiveDays: 3,
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
    ...over,
  });

  const versionRow: LeavePolicyVersion = {
    id: 'pv-2',
    companyId,
    policyId: 'pol-1',
    version: 2,
    effectiveFrom: new Date('2099-06-01T00:00:00Z'),
    mode: 'MONTHLY_CREDIT',
    monthlyCreditAmount: new Prisma.Decimal(2),
    ratioThresholdDays: null,
    ratioEarnedAmount: null,
    note: null,
    legacyConfig: null,
    status: 'ACTIVE',
    createdByPrincipalId: 'u-pi',
    createdAt: new Date(),
  };

  /** PI grant model: LEAVE_MANAGE + LEAVE_APPROVE at site a1 of proj-a —
   *  a project grant covers child-site targets. Company-wide and
   *  sibling-site targets deny; hasPermission never reports a
   *  company-wide grant. */
  const piAuthorizer = {
    assertPermission: vi
      .fn()
      .mockImplementation(
        async (_pid: string, perm: string, target?: { scopeType: string; scopeId: string }) => {
          if (perm === 'LEAVE_READ' || perm === 'LEAVE_APPLY') return;
          const t = target ?? { scopeType: 'COMPANY', scopeId: companyId };
          const covered =
            (t.scopeType === 'SITE' && t.scopeId === SITE_A1) ||
            (t.scopeType === 'PROJECT' && t.scopeId === PROJ_A);
          if (!covered) throw new Error('Access denied: out of scope');
          if (perm === 'LEAVE_MANAGE' || perm === 'LEAVE_APPROVE') return;
          throw new Error(`Permission denied: ${perm}`);
        },
      ),
    hasPermission: vi.fn().mockResolvedValue(false),
  };

  const financeAuthorizer = {
    assertPermission: vi.fn().mockResolvedValue(undefined),
    hasPermission: vi.fn().mockResolvedValue(true),
  };

  const flagOn = vi.fn().mockResolvedValue(true);
  const flagOff = vi.fn().mockResolvedValue(false);

  beforeEach(() => {
    flagOn.mockClear();
    flagOff.mockClear();
    piAuthorizer.assertPermission.mockClear();
  });

  const createInput = {
    scopeType: 'DEPARTMENT' as const,
    departmentId: 'dept-a1',
    typeDefId: 'td-1',
    name: 'Site CL',
    version: {
      effectiveFrom: '2099-01-01',
      mode: 'MONTHLY_CREDIT' as const,
      monthlyCreditAmount: 2,
    },
  };

  const createRepos = (department: DeptScope | null): Partial<LeaveRepos> => ({
    typeDefs: {
      findById: vi.fn().mockResolvedValue(typeDefRow),
    } as unknown as LeaveRepos['typeDefs'],
    departments: {
      findById: vi.fn().mockResolvedValue(department),
    },
    policies: {
      create: vi.fn().mockResolvedValue(policyOf()),
    } as unknown as LeaveRepos['policies'],
    versions: {
      create: vi.fn().mockResolvedValue(versionRow),
    } as unknown as LeaveRepos['versions'],
    audit: { record: vi.fn().mockResolvedValue(undefined) },
  });

  const policyRepos = (policy: LeavePolicy, department: DeptScope | null): Partial<LeaveRepos> => ({
    departments: {
      findById: vi.fn().mockResolvedValue(department),
    },
    policies: {
      findById: vi.fn().mockResolvedValue(policy),
      update: vi.fn().mockImplementation(async (_c: string, _i: string, patch: object) => ({
        ...policy,
        ...patch,
      })),
    } as unknown as LeaveRepos['policies'],
    versions: {
      findById: vi.fn().mockResolvedValue(versionRow),
      findActiveAtDate: vi.fn().mockResolvedValue(null),
      countActive: vi.fn().mockResolvedValue(2),
      nextVersionNumber: vi.fn().mockResolvedValue(2),
      create: vi.fn().mockResolvedValue(versionRow),
      cancel: vi.fn().mockResolvedValue({ ...versionRow, status: 'ARCHIVED' }),
    } as unknown as LeaveRepos['versions'],
    audit: { record: vi.fn().mockResolvedValue(undefined) },
  });

  it('flag OFF → PI cannot create a site-department leave policy', async () => {
    const service = new LeaveService(
      createMockUow(createRepos(siteDept('dept-a1', SITE_A1))),
      piAuthorizer,
      undefined,
      flagOff,
    );
    await expect(service.createPolicy(piActor, companyId, createInput)).rejects.toMatchObject({
      code: 'DELEGATION_DISABLED',
    });
  });

  it('flag ON → PI creates a leave policy on an assigned site department', async () => {
    const service = new LeaveService(
      createMockUow(createRepos(siteDept('dept-a1', SITE_A1))),
      piAuthorizer,
      undefined,
      flagOn,
    );
    const result = await service.createPolicy(piActor, companyId, createInput);
    expect(result.policy.scopeType).toBe('DEPARTMENT');
    expect(piAuthorizer.assertPermission).toHaveBeenCalledWith('u-pi', 'LEAVE_MANAGE', {
      companyId,
      scopeType: 'SITE',
      scopeId: SITE_A1,
    });
  });

  it('flag ON → PI is denied on a sibling-site department', async () => {
    const service = new LeaveService(
      createMockUow(createRepos(siteDept('dept-b1', SITE_B1, 'proj-b'))),
      piAuthorizer,
      undefined,
      flagOn,
    );
    await expect(
      service.createPolicy(piActor, companyId, {
        ...createInput,
        departmentId: 'dept-b1',
      }),
    ).rejects.toThrow('Access denied');
  });

  it('flag ON → COMPANY-scope policy creation stays company-only', async () => {
    const service = new LeaveService(
      createMockUow(createRepos(null)),
      piAuthorizer,
      undefined,
      flagOn,
    );
    await expect(
      service.createPolicy(piActor, companyId, {
        ...createInput,
        scopeType: 'COMPANY',
        departmentId: undefined,
      } as never),
    ).rejects.toThrow('Access denied');
  });

  it('flag ON → EMPLOYEE-scope policy creation stays company-only', async () => {
    const service = new LeaveService(
      createMockUow(createRepos(null)),
      piAuthorizer,
      undefined,
      flagOn,
    );
    await expect(
      service.createPolicy(piActor, companyId, {
        ...createInput,
        scopeType: 'EMPLOYEE',
        departmentId: undefined,
        employeeId: 'emp-site',
      } as never),
    ).rejects.toThrow('Access denied');
  });

  it('flag ON → HO-department policy creation is denied for PI', async () => {
    const service = new LeaveService(
      createMockUow(createRepos(hoDept('dept-ho'))),
      piAuthorizer,
      undefined,
      flagOn,
    );
    await expect(
      service.createPolicy(piActor, companyId, { ...createInput, departmentId: 'dept-ho' }),
    ).rejects.toThrow('Access denied');
  });

  it('Finance manages a site-department policy regardless of the flag', async () => {
    const service = new LeaveService(
      createMockUow(createRepos(siteDept('dept-a1', SITE_A1))),
      financeAuthorizer,
      undefined,
      flagOff,
    );
    const result = await service.createPolicy(financeActor, companyId, createInput);
    expect(result.policy.scopeType).toBe('DEPARTMENT');
    expect(flagOff).not.toHaveBeenCalled();
  });

  it('flag OFF → PI cannot update a site-department policy', async () => {
    const service = new LeaveService(
      createMockUow(policyRepos(policyOf(), siteDept('dept-a1', SITE_A1))),
      piAuthorizer,
      undefined,
      flagOff,
    );
    await expect(
      service.updatePolicy(piActor, companyId, 'pol-1', {
        name: 'Renamed',
        expectedVersion: 0,
      }),
    ).rejects.toMatchObject({ code: 'DELEGATION_DISABLED' });
  });

  it('flag ON → PI updates a site-department policy inside their scope', async () => {
    const service = new LeaveService(
      createMockUow(policyRepos(policyOf(), siteDept('dept-a1', SITE_A1))),
      piAuthorizer,
      undefined,
      flagOn,
    );
    const updated = await service.updatePolicy(piActor, companyId, 'pol-1', {
      name: 'Site CL v2',
      expectedVersion: 0,
    });
    expect(updated.name).toBe('Site CL v2');
  });

  it('flag ON → PI appends a new accrual version to a site-department policy', async () => {
    const service = new LeaveService(
      createMockUow(policyRepos(policyOf(), siteDept('dept-a1', SITE_A1))),
      piAuthorizer,
      undefined,
      flagOn,
    );
    const version = await service.addVersion(piActor, companyId, 'pol-1', {
      effectiveFrom: '2099-06-01',
      mode: 'MONTHLY_CREDIT',
      monthlyCreditAmount: 2,
      expectedVersion: 0,
    });
    expect(version.version).toBe(2);
  });

  it('flag ON → PI archives a site-department policy inside their scope', async () => {
    const service = new LeaveService(
      createMockUow(policyRepos(policyOf(), siteDept('dept-a1', SITE_A1))),
      piAuthorizer,
      undefined,
      flagOn,
    );
    const archived = await service.archivePolicy(piActor, companyId, 'pol-1', 0);
    expect(archived.isActive).toBe(false);
  });

  it('flag ON → a COMPANY-scope policy cannot be touched by PI', async () => {
    const companyPolicy = policyOf({
      scopeType: 'COMPANY',
      departmentId: null,
    });
    const service = new LeaveService(
      createMockUow(policyRepos(companyPolicy, null)),
      piAuthorizer,
      undefined,
      flagOn,
    );
    await expect(
      service.updatePolicy(piActor, companyId, 'pol-1', {
        name: 'Hijack',
        expectedVersion: 0,
      }),
    ).rejects.toThrow('Access denied');
  });

  it('flag ON → an EMPLOYEE-scope policy cannot be touched by PI', async () => {
    const employeePolicy = policyOf({
      scopeType: 'EMPLOYEE',
      departmentId: null,
      employeeId: 'emp-site',
    });
    const service = new LeaveService(
      createMockUow(policyRepos(employeePolicy, siteDept('dept-a1', SITE_A1))),
      piAuthorizer,
      undefined,
      flagOn,
    );
    await expect(service.archivePolicy(piActor, companyId, 'pol-1', 0)).rejects.toThrow(
      'Access denied',
    );
  });

  it('flag ON → PI cannot update a sibling-site department policy', async () => {
    const service = new LeaveService(
      createMockUow(policyRepos(policyOf(), siteDept('dept-a1', SITE_B1, 'proj-b'))),
      piAuthorizer,
      undefined,
      flagOn,
    );
    await expect(
      service.updatePolicy(piActor, companyId, 'pol-1', {
        name: 'Cross-site edit',
        expectedVersion: 0,
      }),
    ).rejects.toThrow('Access denied');
  });

  it('Finance manages a COMPANY-scope policy regardless of the flag', async () => {
    const companyPolicy = policyOf({ scopeType: 'COMPANY', departmentId: null });
    const service = new LeaveService(
      createMockUow(policyRepos(companyPolicy, null)),
      financeAuthorizer,
      undefined,
      flagOff,
    );
    const updated = await service.updatePolicy(financeActor, companyId, 'pol-1', {
      name: 'Company baseline v2',
      expectedVersion: 0,
    });
    expect(updated.name).toBe('Company baseline v2');
    expect(flagOff).not.toHaveBeenCalled();
  });
});
