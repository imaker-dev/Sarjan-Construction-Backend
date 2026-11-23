import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import type { ScopeTarget } from '../access-control/service.js';
import type { ActorContext } from './types.js';
import { recordCompanyAuditLog } from '../audit/service.js';
import { VersionConflictError } from './errors.js';

/**
 * Company-controlled delegation switches for scoped project/site
 * administration. Every flag defaults OFF — a missing policy row means
 * nothing is delegated (fail closed). Policy updates are versioned and audit
 * the mutation atomically.
 */
export type DelegationFlag =
  | 'siteCreate'
  | 'siteUpdate'
  | 'deptManage'
  | 'placement'
  | 'employeeOnboard'
  | 'memberSuspend'
  | 'memberExit';

export const DELEGATION_FLAGS: readonly DelegationFlag[] = [
  'siteCreate',
  'siteUpdate',
  'deptManage',
  'placement',
  'employeeOnboard',
  'memberSuspend',
  'memberExit',
];

export interface DelegationPolicyDto {
  siteCreate: boolean;
  siteUpdate: boolean;
  deptManage: boolean;
  placement: boolean;
  employeeOnboard: boolean;
  /** Scoped suspend + reinstate of project/site workforce. */
  memberSuspend: boolean;
  /** Scoped permanent exit of project/site workforce — separately delegated. */
  memberExit: boolean;
  version: number;
}

export interface UpdateDelegationPolicyInput {
  expectedVersion: number;
  siteCreate?: boolean;
  siteUpdate?: boolean;
  deptManage?: boolean;
  placement?: boolean;
  employeeOnboard?: boolean;
  memberSuspend?: boolean;
  memberExit?: boolean;
}

interface Authorizer {
  assertPermission(principalId: string, permissionKey: string, target: ScopeTarget): Promise<void>;
}

const COMPANY_TARGET = (companyId: string): ScopeTarget => ({
  companyId,
  scopeType: 'COMPANY',
  scopeId: companyId,
});

export class DelegationService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly authorizer: Authorizer,
  ) {}

  /**
   * Internal probe used by domain services — NO authorization here; callers
   * are trusted boundaries that have already authenticated. Missing row →
   * false (fail closed).
   */
  async isEnabled(companyId: string, flag: DelegationFlag): Promise<boolean> {
    const row = await this.prisma.companyDelegationPolicy.findUnique({
      where: { companyId },
      select: {
        siteCreate: true,
        siteUpdate: true,
        deptManage: true,
        placement: true,
        employeeOnboard: true,
        memberSuspend: true,
        memberExit: true,
      },
    });
    return row?.[flag] ?? false;
  }

  async getPolicy(actor: ActorContext, companyId: string): Promise<DelegationPolicyDto> {
    await this.authorizer.assertPermission(
      actor.actorId,
      'ORG_COMPANY_READ',
      COMPANY_TARGET(companyId),
    );
    const row = await this.prisma.companyDelegationPolicy.findUnique({
      where: { companyId },
    });
    return row === null
      ? {
          siteCreate: false,
          siteUpdate: false,
          deptManage: false,
          placement: false,
          employeeOnboard: false,
          memberSuspend: false,
          memberExit: false,
          version: 0,
        }
      : {
          siteCreate: row.siteCreate,
          siteUpdate: row.siteUpdate,
          deptManage: row.deptManage,
          placement: row.placement,
          employeeOnboard: row.employeeOnboard,
          memberSuspend: row.memberSuspend,
          memberExit: row.memberExit,
          version: row.version,
        };
  }

  async updatePolicy(
    actor: ActorContext,
    companyId: string,
    input: UpdateDelegationPolicyInput,
  ): Promise<DelegationPolicyDto> {
    await this.authorizer.assertPermission(
      actor.actorId,
      'ORG_COMPANY_UPDATE',
      COMPANY_TARGET(companyId),
    );

    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.companyDelegationPolicy.findUnique({ where: { companyId } });
      const currentVersion = existing?.version ?? 0;
      if (currentVersion !== input.expectedVersion) {
        throw new VersionConflictError('DELEGATION_POLICY');
      }

      const next = {
        siteCreate: input.siteCreate ?? existing?.siteCreate ?? false,
        siteUpdate: input.siteUpdate ?? existing?.siteUpdate ?? false,
        deptManage: input.deptManage ?? existing?.deptManage ?? false,
        placement: input.placement ?? existing?.placement ?? false,
        employeeOnboard: input.employeeOnboard ?? existing?.employeeOnboard ?? false,
        memberSuspend: input.memberSuspend ?? existing?.memberSuspend ?? false,
        memberExit: input.memberExit ?? existing?.memberExit ?? false,
      };
      const changed = (Object.keys(next) as DelegationFlag[]).filter(
        (k) => next[k] !== (existing?.[k] ?? false),
      );
      if (existing === null && changed.length === 0) {
        // Nothing to delegate — keep the "no row" canonical state.
        return { ...next, version: 0 };
      }

      let row;
      if (existing === null) {
        // Two concurrent first-PATCHes: the loser's unique-key violation maps
        // to the same conflict response as a stale version.
        try {
          row = await tx.companyDelegationPolicy.create({ data: { companyId, ...next } });
        } catch (e) {
          if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
            throw new VersionConflictError('DELEGATION_POLICY');
          }
          throw e;
        }
      } else {
        const { count } = await tx.companyDelegationPolicy.updateMany({
          where: { companyId, version: input.expectedVersion },
          data: { ...next, version: { increment: 1 } },
        });
        if (count === 0) throw new VersionConflictError('DELEGATION_POLICY');
        row = { ...existing, ...next, version: input.expectedVersion + 1 };
      }

      if (changed.length > 0) {
        await recordCompanyAuditLog(tx, {
          companyId,
          actor,
          action: 'DELEGATION_POLICY_UPDATED',
          entityType: 'COMPANY',
          entityId: companyId,
          changedFields: Object.fromEntries(
            changed.map((k) => [k, { before: existing?.[k] ?? false, after: next[k] }]),
          ),
        });
      }
      return {
        siteCreate: row.siteCreate,
        siteUpdate: row.siteUpdate,
        deptManage: row.deptManage,
        placement: row.placement,
        employeeOnboard: row.employeeOnboard,
        memberSuspend: row.memberSuspend,
        memberExit: row.memberExit,
        version: row.version,
      };
    });
  }
}
