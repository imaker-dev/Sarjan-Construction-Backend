import { describe, expect, it, vi } from 'vitest';
import { Prisma, type LeaveBalance, type LeavePolicy } from '@prisma/client';
import type { ActorContext } from '../../../src/modules/organization/types.js';
import {
  InsufficientLeaveBalanceError,
  LeaveDateConflictError,
  LeaveNoticePeriodError,
  LeaveRequestStateError,
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

  const completeRepos: LeaveRepos = {
    employees: defaultEmployees,
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
  };

  const samplePolicy: LeavePolicy = {
    id: 'pol-1',
    companyId,
    scopeType: 'COMPANY',
    projectId: null,
    siteId: null,
    employeeId: null,
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

  it('creates a leave policy', async () => {
    let recordedAudit = false;
    const mockRepos: Partial<LeaveRepos> = {
      policies: {
        create: vi.fn().mockResolvedValue(samplePolicy),
      } as unknown as LeaveRepos['policies'],
      audit: {
        record: vi.fn().mockImplementation(async () => {
          recordedAudit = true;
        }),
      },
    };

    const service = new LeaveService(createMockUow(mockRepos), authorizer);
    const policy = await service.createPolicy(actor, companyId, {
      scopeType: 'COMPANY',
      leaveType: 'CASUAL',
      name: 'Casual Leave Policy',
      annualAllowance: 12,
    });

    expect(policy.name).toBe('Casual Leave Policy');
    expect(policy.leaveType).toBe('CASUAL');
    expect(recordedAudit).toBe(true);
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
      employee: { id: 'emp-1', employeeCode: 'E1', displayName: 'Ramesh', designation: 'Eng', principalId: 'p-1' },
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
      employee: { id: 'emp-1', employeeCode: 'E1', displayName: 'Ramesh', designation: 'Eng', principalId: 'p-1' },
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
      employee: { id: 'emp-1', employeeCode: 'E1', displayName: 'Ramesh', designation: 'Eng', principalId: 'p-1' },
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
      employee: { id: 'emp-1', employeeCode: 'E1', displayName: 'Ramesh', designation: 'Eng', principalId: 'p-1' },
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
        employee: { id: 'emp-1', employeeCode: 'E1', displayName: 'Ramesh', designation: 'Eng', principalId: 'u1' },
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
          create: vi.fn().mockImplementation(
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
      };

      const mockRepos: Partial<LeaveRepos> = {
        policies: {
          resolveEffective: vi.fn().mockResolvedValue(samplePolicy),
        } as unknown as LeaveRepos['policies'],
        employees: {
          findByPrincipal: vi.fn().mockResolvedValue({ id: 'emp-1', displayName: 'Ramesh', status: 'ACTIVE', principalId: 'u1' }),
          findById: vi.fn().mockResolvedValue({ id: 'emp-other', displayName: 'Other', status: 'ACTIVE', principalId: 'u2' }),
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
        employee: { id: 'emp-1', employeeCode: 'E1', displayName: 'Ramesh', designation: 'Eng', principalId: 'u1' },
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
        employee: { id: 'emp-other', employeeCode: 'E2', displayName: 'Other', designation: 'Eng', principalId: 'u-other' },
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
        employee: { id: 'emp-other', employeeCode: 'E2', displayName: 'Other', designation: 'Eng', principalId: 'u-other' },
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
      };

      const service = new LeaveService(createMockUow(mockRepos), normalEmployeeAuthorizer);
      await expect(
        service.getRequestById(actor, companyId, 'req-confidential'),
      ).rejects.toThrow('Access denied: supervisor permission required');
    });
  });
});
