import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { ActorContext, AuditRecord } from '../organization/types.js';
import { OrgEntityNotFoundError, OrgValidationError } from '../organization/errors.js';
import { WalletStateError } from './errors.js';
import type { DecisionCompletionContext, DecisionCompletionHook } from '../approval/types.js';
import { WALLET_FUNDING_OPERATION_KEY } from './types.js';
import { principalsByRoleCovering } from './repository.js';

const Decimal = Prisma.Decimal;

function auditEntry(
  actor: ActorContext,
  base: Omit<AuditRecord, 'eventKey' | 'actorId' | 'actorType' | 'correlationId'>,
): AuditRecord {
  return {
    eventKey: randomUUID(),
    actorId: actor.actorId,
    actorType: actor.actorType,
    ...(actor.correlationId !== undefined ? { correlationId: actor.correlationId } : {}),
    ...base,
  };
}

/**
 * Wallet completion hook for the shared approval engine — runs inside the
 * SAME transaction as the decision, task close, and pinned transition.
 *
 * APPROVE: decisionPayload.approvedAmount is required — a positive decimal
 * no greater than the submitted attempt amount. REJECT/RETURN carry no
 * payload. Any violation throws → the whole decision rolls back. Approval
 * never credits the wallet; only PI receipt confirmation does.
 */
export function walletFundingDecisionHook(): DecisionCompletionHook {
  return {
    operationKey: WALLET_FUNDING_OPERATION_KEY,
    run: async (ctx: DecisionCompletionContext) => {
      const { tx, repos, actor, companyId, instance, decision, input } = ctx;
      const attempt = await tx.walletFundingAttempt.findFirst({
        where: { workflowInstanceId: instance.id, companyId },
      });
      if (attempt === null) {
        // Instance not bound to a wallet attempt — misconfiguration, fail closed.
        throw new OrgEntityNotFoundError('WALLET_FUNDING_ATTEMPT');
      }
      if (attempt.status !== 'SUBMITTED') {
        throw new WalletStateError(`attempt is ${attempt.status}`);
      }
      const request = await tx.walletFundingRequest.findFirstOrThrow({
        where: { id: attempt.requestId, companyId },
      });

      let approvedAmount: InstanceType<typeof Decimal> | null = null;
      if (input.action === 'APPROVE') {
        const raw = input.decisionPayload?.approvedAmount;
        if (typeof raw !== 'string') {
          throw new OrgValidationError(
            'decisionPayload.approvedAmount',
            'required for APPROVE — a decimal INR string',
          );
        }
        try {
          approvedAmount = new Decimal(raw);
        } catch {
          throw new OrgValidationError(
            'decisionPayload.approvedAmount',
            'must be a decimal string',
          );
        }
        if (
          !approvedAmount.isFinite() ||
          approvedAmount.lte(0) ||
          approvedAmount.decimalPlaces() > 2
        ) {
          throw new OrgValidationError(
            'decisionPayload.approvedAmount',
            'must be positive with ≤ 2 decimals',
          );
        }
        if (approvedAmount.gt(attempt.amount)) {
          throw new OrgValidationError(
            'decisionPayload.approvedAmount',
            `exceeds the submitted attempt amount ${new Decimal(attempt.amount).toFixed(2)}`,
          );
        }
      } else if (input.decisionPayload !== undefined) {
        throw new OrgValidationError('decisionPayload', `not allowed for ${input.action}`);
      }

      const attemptStatus =
        input.action === 'APPROVE'
          ? 'APPROVED'
          : input.action === 'REJECT'
            ? 'REJECTED'
            : 'RETURNED';
      await tx.walletFundingAttempt.update({
        where: { id: attempt.id, companyId },
        data: {
          status: attemptStatus,
          ...(approvedAmount !== null ? { approvedAmount } : {}),
          decidedByPrincipalId: actor.actorType === 'USER' ? actor.actorId : null,
          decidedAt: new Date(),
          ...(input.reason !== undefined ? { decisionReason: input.reason.trim() } : {}),
        },
      });
      await tx.walletFundingRequest.update({
        where: { id: request.id, companyId },
        data: {
          status: attemptStatus,
          ...(approvedAmount !== null ? { approvedAmount, confirmedAmount: new Decimal(0) } : {}),
          version: { increment: 1 },
        },
      });
      await repos.audit.record(
        auditEntry(actor, {
          action: `WALLET_FUNDING_${attemptStatus}`,
          entityType: 'WALLET_FUNDING_REQUEST',
          entityId: request.id,
          companyId,
          statusBefore: request.status,
          statusAfter: attemptStatus,
          changedFields: {
            attemptNo: { before: null, after: attempt.attemptNo },
            ...(approvedAmount !== null
              ? { approvedAmount: { before: null, after: approvedAmount.toFixed(2) } }
              : {}),
            decisionId: { before: null, after: decision.id },
          },
        }),
      );
      const site = await tx.site.findFirst({
        where: { id: request.siteId, companyId },
        select: { projectId: true },
      });
      const project =
        site === null
          ? null
          : await tx.project.findFirst({
              where: { id: site.projectId, companyId },
              select: { headOfficeId: true },
            });
      const recipients = await principalsByRoleCovering(tx, companyId, 'FINANCE_MANAGER', {
        siteId: request.siteId,
        ...(site !== null ? { projectId: site.projectId } : {}),
        ...(project?.headOfficeId != null ? { headOfficeId: project.headOfficeId } : {}),
      });
      const oversight = await principalsByRoleCovering(tx, companyId, 'PROJECT_DIRECTOR', {
        siteId: request.siteId,
        ...(site !== null ? { projectId: site.projectId } : {}),
        ...(project?.headOfficeId != null ? { headOfficeId: project.headOfficeId } : {}),
      });
      // The requester is deliberately excluded — the engine's generic
      // APPROVAL_TASK_DECIDED event already notifies them of this same
      // transition, so including them here would double-notify.
      await repos.outbox.record({
        companyId,
        eventType: `WALLET_FUNDING_${attemptStatus}`,
        aggregateType: 'WALLET_FUNDING_REQUEST',
        aggregateId: request.id,
        eventKey: randomUUID(),
        recipientPrincipalIds: [...new Set([...recipients, ...oversight])],
        summary: { siteId: request.siteId, status: attemptStatus },
      });
    },
  };
}
