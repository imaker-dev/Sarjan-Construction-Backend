import type {
  ApprovalDecision,
  ApprovalOutcome,
  Employee,
  Prisma,
  PrismaClient,
  RoleAssignment,
} from '@prisma/client';
import { mapOrgWriteError } from '../organization/errors.js';
import { makeWorkflowInstanceRepos } from '../workflow-instance/repository.js';
import type { WorkflowInstanceRepos } from '../workflow-instance/repository.js';

type Tx = Prisma.TransactionClient;

// Append-only: create/find/list only — no update or delete paths exist.
export interface ApprovalDecisionRepository {
  create(data: {
    companyId: string;
    approvalTaskId: string;
    outcome: ApprovalOutcome;
    action: string;
    actorPrincipalId?: string;
    actorType: string;
    reason?: string;
    idempotencyKey?: string;
    requestFingerprint?: string;
    eventKey: string;
  }): Promise<ApprovalDecision>;
  findByIdempotencyKey(
    companyId: string,
    approvalTaskId: string,
    key: string,
  ): Promise<ApprovalDecision | null>;
  listByTask(companyId: string, approvalTaskId: string): Promise<ApprovalDecision[]>;
}

export interface AssignmentRow extends RoleAssignment {
  role: { key: string };
}

export interface ApprovalRepos extends WorkflowInstanceRepos {
  approvalDecisions: ApprovalDecisionRepository;
  roleAssignments: {
    /** Active (unrevoked, in-window) assignments for the principal in-company. */
    listActiveForPrincipal(
      principalId: string,
      companyId: string,
      now: Date,
    ): Promise<AssignmentRow[]>;
  };
  employees: {
    findById(companyId: string, id: string): Promise<Employee | null>;
  };
  sites: {
    findChain(companyId: string, siteId: string): Promise<{ projectId: string } | null>;
  };
  projects: {
    findChain(
      companyId: string,
      projectId: string,
    ): Promise<{ headOfficeId: string | null } | null>;
  };
}

export function makeApprovalRepos(tx: Tx): ApprovalRepos {
  return {
    ...makeWorkflowInstanceRepos(tx),
    approvalDecisions: {
      create: async (data) => {
        try {
          return await tx.approvalDecision.create({ data });
        } catch (error) {
          mapOrgWriteError(error, 'APPROVAL_DECISION');
        }
      },
      findByIdempotencyKey: (companyId, approvalTaskId, key) =>
        tx.approvalDecision.findFirst({
          where: { companyId, approvalTaskId, idempotencyKey: key },
        }),
      listByTask: (companyId, approvalTaskId) =>
        tx.approvalDecision.findMany({
          where: { companyId, approvalTaskId },
          orderBy: [{ decidedAt: 'asc' }, { id: 'asc' }],
        }),
    },
    roleAssignments: {
      listActiveForPrincipal: (principalId, companyId, now) =>
        tx.roleAssignment.findMany({
          where: {
            principalId,
            companyId,
            revokedAt: null,
            OR: [{ effectiveFrom: null }, { effectiveFrom: { lte: now } }],
            AND: [{ OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }] }],
          },
          include: { role: { select: { key: true } } },
        }),
    },
    employees: {
      findById: (companyId, id) => tx.employee.findFirst({ where: { id, companyId } }),
    },
    sites: {
      findChain: (companyId, siteId) =>
        tx.site.findFirst({ where: { id: siteId, companyId }, select: { projectId: true } }),
    },
    projects: {
      findChain: (companyId, projectId) =>
        tx.project.findFirst({
          where: { id: projectId, companyId },
          select: { headOfficeId: true },
        }),
    },
  };
}

export interface ApprovalUnitOfWork {
  run<T>(fn: (repos: ApprovalRepos) => Promise<T>): Promise<T>;
}

export class PrismaApprovalUnitOfWork implements ApprovalUnitOfWork {
  constructor(private readonly prisma: PrismaClient) {}
  run<T>(fn: (repos: ApprovalRepos) => Promise<T>): Promise<T> {
    return this.prisma.$transaction((tx) => fn(makeApprovalRepos(tx)));
  }
}
