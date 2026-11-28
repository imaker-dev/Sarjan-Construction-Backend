import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type {
  SiteWallet,
  WalletAccountHead,
  WalletCashVoucher,
  WalletFundingRequest,
  WalletLedgerEntry,
  WalletTransfer,
} from '@prisma/client';
import type { ActorContext, AuditRecord } from '../organization/types.js';
import {
  InvalidStatusTransitionError,
  OrgEntityNotFoundError,
  OrgValidationError,
  VersionConflictError,
  mapOrgWriteError,
} from '../organization/errors.js';
import { ForbiddenError } from '../../common/errors/app-error.js';
import type { Authorizer } from '../department/service.js';
import type { ScopeTarget } from '../access-control/service.js';
import { scopeCovers } from '../access-control/service.js';
import type { ScopeChain } from '../access-control/repository.js';
import { IdempotencyConflictError } from '../workflow-instance/errors.js';
import { ensureApprovalStageTask, initialStateOf } from '../workflow-instance/apply.js';
import type { WorkflowState } from '@prisma/client';
import { lockWallet, allocVoucherNo, principalsByRoleCovering } from './repository.js';
import type { WalletRepos, WalletUnitOfWork } from './repository.js';
import { ensureWalletFundingWorkflow } from './provisioning.js';
import { inrToWords } from './voucher-words.js';
import {
  renderCashVoucherPdf,
  renderFundingReceiptPdf,
  type CashVoucherPdfData,
} from './voucher-pdf.js';
import { InsufficientWalletBalanceError, WalletLimitError, WalletStateError } from './errors.js';
import {
  FINANCE_WALLET_MANAGE,
  FINANCE_WALLET_READ,
  INR,
  OPS,
  SITE_WALLET_MANAGE,
  SITE_WALLET_VIEW,
} from './types.js';
import type {
  AccountHeadCreateInput,
  AccountHeadUpdateInput,
  CloseShortInput,
  ConfirmReceiptInput,
  ExpenseCreateInput,
  FundingRequestCreateInput,
  FundingRequestUpdateInput,
  Page,
  ReduceApprovedAmountInput,
  CancelTransferInput,
  ResolveDisputeInput,
  ReversalRequestInput,
  ReverseExecuteInput,
  TransferRecordInput,
} from './types.js';

const Decimal = Prisma.Decimal;
const ZERO = new Decimal(0);
const MAX_LIMIT = 100;

/** Convert Prisma `seq: bigint` to string so Fastify JSON serialization succeeds. */
function serializeLedgerEntry<T extends { seq: bigint }>(
  entry: T,
): Omit<T, 'seq'> & { seq: string } {
  return { ...entry, seq: entry.seq.toString() };
}

/** Convert Prisma `voucherNo: bigint` to string so Fastify JSON serialization succeeds. */
function serializeVoucher<T extends { voucherNo: bigint }>(
  voucher: T,
): Omit<T, 'voucherNo'> & { voucherNo: string } {
  return { ...voucher, voucherNo: voucher.voucherNo.toString() };
}

export interface WalletAuthorizer extends Authorizer {
  hasPermission(principalId: string, permissionKey: string, target: ScopeTarget): Promise<boolean>;
}

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

function money(v: string, field: string): InstanceType<typeof Decimal> {
  let d: InstanceType<typeof Decimal>;
  try {
    d = new Decimal(v);
  } catch {
    throw new OrgValidationError(field, 'must be a decimal string');
  }
  if (!d.isFinite() || d.lte(0)) {
    throw new OrgValidationError(field, 'must be a positive amount');
  }
  if (d.decimalPlaces() > 2) {
    throw new OrgValidationError(field, 'must have at most 2 decimal places');
  }
  return d;
}

function nonneg(v: string, field: string): InstanceType<typeof Decimal> {
  let d: InstanceType<typeof Decimal>;
  try {
    d = new Decimal(v);
  } catch {
    throw new OrgValidationError(field, 'must be a decimal string');
  }
  if (!d.isFinite() || d.lt(0) || d.decimalPlaces() > 2) {
    throw new OrgValidationError(field, 'must be a non-negative amount with ≤ 2 decimals');
  }
  return d;
}

export class WalletService {
  constructor(
    private readonly uow: WalletUnitOfWork,
    private readonly authorizer: WalletAuthorizer,
    private readonly resolveOperations: (
      companyId: string,
      employeeId: string,
    ) => Promise<string[]>,
  ) {}

  // ------------------------------------------------------------- auth helpers

  private async assertOperation(
    repos: WalletRepos,
    actor: ActorContext,
    companyId: string,
    operationKey: string,
  ): Promise<void> {
    const employee = await repos.tx.employee.findFirst({
      where: { companyId, principalId: actor.actorId },
      select: { id: true },
    });
    if (employee !== null) {
      const ops = await this.resolveOperations(companyId, employee.id);
      if (ops.includes(operationKey)) return;
    }
    const owner = await repos.tx.roleAssignment.findFirst({
      where: {
        companyId,
        principalId: actor.actorId,
        revokedAt: null,
        role: { key: 'COMPANY_OWNER' },
      },
      select: { id: true },
    });
    if (owner !== null) return;
    throw new ForbiddenError(
      'OPERATION_NOT_ASSIGNED',
      `operation ${operationKey} is not assigned to the actor`,
    );
  }

  private async assertSite(
    repos: WalletRepos,
    actor: ActorContext,
    companyId: string,
    siteId: string,
    op: string,
    perm: string = SITE_WALLET_MANAGE,
  ): Promise<void> {
    await this.authorizer.assertPermission(actor.actorId, perm, siteTarget(companyId, siteId));
    await this.assertOperation(repos, actor, companyId, op);
  }

  private async assertFinance(
    repos: WalletRepos,
    actor: ActorContext,
    companyId: string,
    perm: string,
    op: string,
  ): Promise<void> {
    await this.authorizer.assertPermission(actor.actorId, perm, companyTarget(companyId));
    await this.assertOperation(repos, actor, companyId, op);
  }

  /**
   * PI gate for wallet writes — the employee operation check alone cannot
   * distinguish a PROJECT_INCHARGE from a PROJECT_DIRECTOR (both inherit the
   * submit-side WALLET ops). Writes require an active PROJECT_INCHARGE
   * assignment covering the site chain; COMPANY_OWNER passes as admin. PD
   * keeps reads only — no confirm/debit/reversal by default.
   */
  private async assertProjectIncharge(
    repos: WalletRepos,
    actor: ActorContext,
    companyId: string,
    chain: ScopeChain,
  ): Promise<void> {
    const rows = await repos.tx.$queryRaw<{ id: string }[]>`
      SELECT ra."id" FROM "RoleAssignment" ra
      JOIN "Role" r ON r."id" = ra."roleId" AND r."companyId" = ra."companyId"
      WHERE ra."companyId" = ${companyId}::uuid
        AND ra."principalId" = ${actor.actorId}::uuid
        AND r."key" = 'PROJECT_INCHARGE'
        AND ra."revokedAt" IS NULL
        AND (ra."effectiveFrom" IS NULL OR ra."effectiveFrom" <= now())
        AND (ra."effectiveTo" IS NULL OR ra."effectiveTo" > now())
        AND (
          ra."scopeType" = 'COMPANY'
          OR (ra."scopeType" = 'HEAD_OFFICE' AND ra."headOfficeId" = ${chain.headOfficeId ?? null}::uuid)
          OR (ra."scopeType" = 'PROJECT' AND ra."projectId" = ${chain.projectId ?? null}::uuid)
          OR (ra."scopeType" = 'SITE' AND ra."siteId" = ${chain.siteId ?? null}::uuid)
        ) LIMIT 1`;
    if (rows.length > 0) return;
    const owner = await repos.tx.roleAssignment.findFirst({
      where: {
        companyId,
        principalId: actor.actorId,
        revokedAt: null,
        role: { key: 'COMPANY_OWNER' },
      },
      select: { id: true },
    });
    if (owner !== null) return;
    throw new ForbiddenError(
      'NOT_SITE_PI',
      'a PROJECT_INCHARGE assignment covering this site is required',
    );
  }

  private async siteChain(
    repos: WalletRepos,
    companyId: string,
    siteId: string,
  ): Promise<ScopeChain> {
    const site = await repos.tx.site.findFirst({
      where: { id: siteId, companyId },
      select: { projectId: true },
    });
    if (site === null) throw new OrgEntityNotFoundError('SITE');
    const project = await repos.tx.project.findFirst({
      where: { id: site.projectId, companyId },
      select: { headOfficeId: true },
    });
    if (project === null) throw new OrgEntityNotFoundError('PROJECT');
    return {
      companyId,
      siteId,
      projectId: site.projectId,
      headOfficeId: project.headOfficeId,
    };
  }

  private async siteRecipients(
    repos: WalletRepos,
    companyId: string,
    chain: ScopeChain,
    extra: (string | null | undefined)[] = [],
  ): Promise<string[]> {
    const fm = await principalsByRoleCovering(repos.tx, companyId, 'FINANCE_MANAGER', chain);
    const pd = await principalsByRoleCovering(repos.tx, companyId, 'PROJECT_DIRECTOR', chain);
    return [...new Set([...fm, ...pd, ...extra.filter((x): x is string => typeof x === 'string')])];
  }

  private async walletForSite(
    repos: WalletRepos,
    companyId: string,
    siteId: string,
  ): Promise<SiteWallet> {
    const wallet = await repos.tx.siteWallet.findFirst({
      where: { companyId, siteId },
    });
    if (wallet === null) throw new OrgEntityNotFoundError('SITE_WALLET');
    return wallet;
  }

  private async requestForSite(
    repos: WalletRepos,
    companyId: string,
    siteId: string,
    requestId: string,
  ): Promise<WalletFundingRequest> {
    const request = await repos.tx.walletFundingRequest.findFirst({
      where: { id: requestId, companyId, siteId },
    });
    if (request === null) throw new OrgEntityNotFoundError('WALLET_FUNDING_REQUEST');
    return request;
  }

  private async employeeFor(repos: WalletRepos, companyId: string, principalId: string) {
    const employee = await repos.tx.employee.findFirst({
      where: { companyId, principalId },
      select: { id: true },
    });
    if (employee === null) {
      throw new ForbiddenError('NOT_AN_EMPLOYEE', 'actor has no employee profile in this company');
    }
    return employee;
  }

  // -------------------------------------------------------------- wallet CRUD

  /** Finance creates (or idempotently returns) the single site wallet — INR. */
  async createSiteWallet(actor: ActorContext, companyId: string, siteId: string) {
    return this.uow.run(async (repos) => {
      await this.assertFinance(repos, actor, companyId, FINANCE_WALLET_MANAGE, OPS.CREDIT_PROCESS);
      const chain = await this.siteChain(repos, companyId, siteId);
      const existing = await repos.tx.siteWallet.findFirst({ where: { companyId, siteId } });
      if (existing !== null) return { wallet: existing, replayed: true };
      const wallet = await repos.tx.siteWallet.create({
        data: { companyId, siteId, currency: INR },
      });
      await repos.audit.record(
        auditEntry(actor, {
          action: 'SITE_WALLET_CREATED',
          entityType: 'SITE_WALLET',
          entityId: wallet.id,
          companyId,
          statusAfter: wallet.status,
          changedFields: {
            siteId: { before: null, after: siteId },
            currency: { before: null, after: INR },
          },
        }),
      );
      await repos.outbox.record({
        companyId,
        eventType: 'SITE_WALLET_CREATED',
        aggregateType: 'SITE_WALLET',
        aggregateId: wallet.id,
        eventKey: randomUUID(),
        recipientPrincipalIds: await this.siteRecipients(repos, companyId, chain),
        summary: { siteId, status: wallet.status },
      });
      return { wallet, replayed: false };
    });
  }

  async getSiteWallet(actor: ActorContext, companyId: string, siteId: string) {
    return this.uow.run(async (repos) => {
      await this.assertSite(repos, actor, companyId, siteId, OPS.LEDGER_VIEW, SITE_WALLET_VIEW);
      const wallet = await this.walletForSite(repos, companyId, siteId);
      const pending = await repos.tx.walletFundingRequest.count({
        where: {
          companyId,
          walletId: wallet.id,
          status: { in: ['SUBMITTED', 'APPROVED', 'PARTIALLY_FUNDED'] },
        },
      });
      const unfunded = await repos.tx.walletFundingRequest.aggregate({
        where: { companyId, walletId: wallet.id, status: { in: ['APPROVED', 'PARTIALLY_FUNDED'] } },
        _sum: { approvedAmount: true, confirmedAmount: true },
      });
      return {
        wallet,
        pendingRequests: pending,
        approvedAmount: unfunded._sum.approvedAmount ?? ZERO,
        confirmedAmount: unfunded._sum.confirmedAmount ?? ZERO,
      };
    });
  }

  async listFinanceWallets(actor: ActorContext, companyId: string, page: Page) {
    return this.uow.run(async (repos) => {
      await this.assertFinance(repos, actor, companyId, FINANCE_WALLET_READ, OPS.FUNDING_REVIEW);
      const limit = Math.min(page.limit ?? 50, MAX_LIMIT);
      const rows = await repos.tx.siteWallet.findMany({
        where: { companyId, ...(page.cursor !== undefined ? { id: { gt: page.cursor } } : {}) },
        orderBy: { id: 'asc' },
        take: limit + 1,
        include: { site: { select: { id: true, code: true, name: true, projectId: true } } },
      });
      const items = rows.slice(0, limit);
      const nextCursor = rows.length > limit ? items[items.length - 1]?.id : undefined;
      return { items, ...(nextCursor !== undefined ? { nextCursor } : {}) };
    });
  }

  async getFinanceWallet(actor: ActorContext, companyId: string, walletId: string) {
    return this.uow.run(async (repos) => {
      await this.assertFinance(repos, actor, companyId, FINANCE_WALLET_READ, OPS.FUNDING_REVIEW);
      const wallet = await repos.tx.siteWallet.findFirst({
        where: { id: walletId, companyId },
        include: { site: { select: { id: true, code: true, name: true, projectId: true } } },
      });
      if (wallet === null) throw new OrgEntityNotFoundError('SITE_WALLET');
      return wallet;
    });
  }

  private async listLedger(
    repos: WalletRepos,
    companyId: string,
    walletId: string,
    filter: Page & { from?: string; to?: string; type?: string },
  ) {
    const limit = Math.min(filter.limit ?? 50, MAX_LIMIT);
    const rows = await repos.tx.walletLedgerEntry.findMany({
      where: {
        companyId,
        walletId,
        ...(filter.type !== undefined ? { type: filter.type as WalletLedgerEntry['type'] } : {}),
        ...(filter.from !== undefined || filter.to !== undefined
          ? {
              postedAt: {
                ...(filter.from !== undefined ? { gte: new Date(filter.from) } : {}),
                ...(filter.to !== undefined ? { lte: new Date(filter.to) } : {}),
              },
            }
          : {}),
        ...(filter.cursor !== undefined ? { seq: { lt: BigInt(filter.cursor) } } : {}),
      },
      orderBy: { seq: 'desc' },
      take: limit + 1,
      include: {
        expense: {
          select: {
            id: true,
            payee: true,
            description: true,
            cashVoucher: { select: { id: true, voucherNo: true } },
          },
        },
      },
    });
    const items = rows.slice(0, limit).map((row) => {
      const { expense, ...entry } = row;
      const voucherId = expense?.cashVoucher?.id ?? null;
      const voucherNo =
        expense?.cashVoucher !== null && expense?.cashVoucher !== undefined
          ? expense.cashVoucher.voucherNo.toString()
          : null;
      return {
        ...serializeLedgerEntry(entry),
        voucherId,
        voucherNo,
        expense:
          expense !== null
            ? {
                id: expense.id,
                voucherId,
                payee: expense.payee,
                description: expense.description,
              }
            : null,
      };
    });
    const nextCursor = rows.length > limit ? items[items.length - 1]?.seq : undefined;
    return { items, ...(nextCursor !== undefined ? { nextCursor } : {}) };
  }

  async listSiteLedger(
    actor: ActorContext,
    companyId: string,
    siteId: string,
    filter: Page & { from?: string; to?: string; type?: string },
  ) {
    return this.uow.run(async (repos) => {
      await this.assertSite(repos, actor, companyId, siteId, OPS.LEDGER_VIEW, SITE_WALLET_VIEW);
      const wallet = await this.walletForSite(repos, companyId, siteId);
      return this.listLedger(repos, companyId, wallet.id, filter);
    });
  }

  async listFinanceLedger(
    actor: ActorContext,
    companyId: string,
    walletId: string,
    filter: Page & { from?: string; to?: string; type?: string },
  ) {
    return this.uow.run(async (repos) => {
      await this.assertFinance(repos, actor, companyId, FINANCE_WALLET_READ, OPS.LEDGER_VIEW);
      const wallet = await repos.tx.siteWallet.findFirst({ where: { id: walletId, companyId } });
      if (wallet === null) throw new OrgEntityNotFoundError('SITE_WALLET');
      return this.listLedger(repos, companyId, wallet.id, filter);
    });
  }

  async siteWalletReport(
    actor: ActorContext,
    companyId: string,
    siteId: string,
    range: { from?: string; to?: string },
  ) {
    return this.uow.run(async (repos) => {
      await this.assertSite(
        repos,
        actor,
        companyId,
        siteId,
        OPS.SITE_REPORT_VIEW,
        SITE_WALLET_VIEW,
      );
      const wallet = await this.walletForSite(repos, companyId, siteId);
      const postedRange = {
        ...(range.from !== undefined ? { gte: new Date(range.from) } : {}),
        ...(range.to !== undefined ? { lte: new Date(range.to) } : {}),
      };
      const ledger = await repos.tx.walletLedgerEntry.groupBy({
        by: ['type'],
        where: {
          companyId,
          walletId: wallet.id,
          ...(range.from !== undefined || range.to !== undefined ? { postedAt: postedRange } : {}),
        },
        _sum: { amount: true },
        _count: true,
      });
      const expenseCount = await repos.tx.walletExpense.count({
        where: { companyId, walletId: wallet.id, status: 'POSTED' },
      });
      return {
        walletId: wallet.id,
        siteId,
        balance: wallet.balance,
        currency: wallet.currency,
        byType: ledger.map((g) => ({ type: g.type, count: g._count, total: g._sum.amount })),
        postedExpenses: expenseCount,
      };
    });
  }

  /**
   * Batched detailed report builder for Finance — zero N+1 queries across all
   * requested wallets.
   */
  private async buildDetailedWalletReports(
    repos: WalletRepos,
    companyId: string,
    wallets: (SiteWallet & {
      site: {
        id: string;
        code: string;
        name: string;
        projectId: string;
        project: { id: string; code: string; name: string };
      };
    })[],
    range: { from?: string; to?: string },
  ) {
    if (wallets.length === 0) return [];
    const walletIds = wallets.map((w) => w.id);
    const postedRange =
      range.from !== undefined || range.to !== undefined
        ? {
            postedAt: {
              ...(range.from !== undefined ? { gte: new Date(range.from) } : {}),
              ...(range.to !== undefined ? { lte: new Date(range.to) } : {}),
            },
          }
        : {};
    const expenseDateRange =
      range.from !== undefined || range.to !== undefined
        ? {
            expenseDate: {
              ...(range.from !== undefined ? { gte: new Date(range.from) } : {}),
              ...(range.to !== undefined ? { lte: new Date(range.to) } : {}),
            },
          }
        : {};

    const [ledgerGroups, fundingGroups, transferGroups, expenseGroups, totalVouchers, signedVouchers] =
      await Promise.all([
        repos.tx.walletLedgerEntry.groupBy({
          by: ['walletId', 'type'],
          where: { companyId, walletId: { in: walletIds }, ...postedRange },
          _sum: { amount: true },
          _count: true,
        }),
        repos.tx.walletFundingRequest.groupBy({
          by: ['walletId', 'status'],
          where: { companyId, walletId: { in: walletIds } },
          _sum: { draftAmount: true, approvedAmount: true, confirmedAmount: true },
          _count: true,
        }),
        repos.tx.walletTransfer.groupBy({
          by: ['walletId', 'status'],
          where: { companyId, walletId: { in: walletIds } },
          _sum: { amount: true, confirmedAmount: true, discrepancyAmount: true },
          _count: true,
        }),
        repos.tx.walletExpense.groupBy({
          by: ['walletId', 'status'],
          where: { companyId, walletId: { in: walletIds }, ...expenseDateRange },
          _sum: { amount: true },
          _count: true,
        }),
        repos.tx.walletCashVoucher.groupBy({
          by: ['walletId'],
          where: { companyId, walletId: { in: walletIds } },
          _count: true,
        }),
        repos.tx.walletCashVoucher.groupBy({
          by: ['walletId'],
          where: { companyId, walletId: { in: walletIds }, signedDocumentId: { not: null } },
          _count: true,
        }),
      ]);

    const voucherTotalByWallet = new Map(totalVouchers.map((v) => [v.walletId, v._count]));
    const voucherSignedByWallet = new Map(signedVouchers.map((v) => [v.walletId, v._count]));

    return wallets.map((w) => {
      const wLedger = ledgerGroups.filter((g) => g.walletId === w.id);
      const wFunding = fundingGroups.filter((g) => g.walletId === w.id);
      const wTransfers = transferGroups.filter((g) => g.walletId === w.id);
      const wExpenses = expenseGroups.filter((g) => g.walletId === w.id);

      const posted = wExpenses.find((e) => e.status === 'POSTED');
      const reversed = wExpenses.find((e) => e.status === 'REVERSED');
      const totalV = voucherTotalByWallet.get(w.id) ?? 0;
      const signedV = voucherSignedByWallet.get(w.id) ?? 0;

      let totalRequested = ZERO;
      let totalApproved = ZERO;
      let totalConfirmed = ZERO;
      for (const f of wFunding) {
        totalRequested = totalRequested.add(f._sum.draftAmount ?? ZERO);
        totalApproved = totalApproved.add(f._sum.approvedAmount ?? ZERO);
        totalConfirmed = totalConfirmed.add(f._sum.confirmedAmount ?? ZERO);
      }

      let totalTransferred = ZERO;
      let totalDisputed = ZERO;
      for (const t of wTransfers) {
        totalTransferred = totalTransferred.add(t._sum.amount ?? ZERO);
        totalDisputed = totalDisputed.add(t._sum.discrepancyAmount ?? ZERO);
      }

      return {
        walletId: w.id,
        status: w.status,
        currency: w.currency,
        balance: w.balance,
        site: { id: w.site.id, code: w.site.code, name: w.site.name },
        project: w.site.project,
        ledgerSummary: {
          byType: wLedger.map((g) => ({
            type: g.type,
            count: g._count,
            total: g._sum.amount ?? ZERO,
          })),
        },
        fundingSummary: {
          totalRequested,
          totalApproved,
          totalConfirmed,
          byStatus: wFunding.map((f) => ({
            status: f.status,
            count: f._count,
            requestedAmount: f._sum.draftAmount ?? ZERO,
            approvedAmount: f._sum.approvedAmount ?? ZERO,
            confirmedAmount: f._sum.confirmedAmount ?? ZERO,
          })),
        },
        transferSummary: {
          totalTransferred,
          totalDisputed,
          byStatus: wTransfers.map((t) => ({
            status: t.status,
            count: t._count,
            amount: t._sum.amount ?? ZERO,
            confirmedAmount: t._sum.confirmedAmount ?? ZERO,
            discrepancyAmount: t._sum.discrepancyAmount ?? ZERO,
          })),
        },
        expenseSummary: {
          postedCount: posted?._count ?? 0,
          postedTotal: posted?._sum.amount ?? ZERO,
          reversedCount: reversed?._count ?? 0,
          reversedTotal: reversed?._sum.amount ?? ZERO,
        },
        voucherSummary: {
          total: totalV,
          signed: signedV,
          unsigned: Math.max(0, totalV - signedV),
        },
      };
    });
  }

  /** Finance detailed report across all sites (paginated, filterable by project/site/date). */
  async financeWalletsReport(
    actor: ActorContext,
    companyId: string,
    filter: Page & { projectId?: string; siteId?: string; from?: string; to?: string },
  ) {
    return this.uow.run(async (repos) => {
      await this.assertFinance(
        repos,
        actor,
        companyId,
        FINANCE_WALLET_READ,
        OPS.FINANCE_REPORT_VIEW,
      );
      const limit = Math.min(filter.limit ?? 50, MAX_LIMIT);
      let siteIds: string[] | undefined;
      if (filter.projectId !== undefined) {
        const sites = await repos.tx.site.findMany({
          where: { companyId, projectId: filter.projectId },
          select: { id: true },
        });
        siteIds = sites.map((s) => s.id);
        if (filter.siteId !== undefined && !siteIds.includes(filter.siteId)) {
          return { items: [] };
        }
      }
      const rows = await repos.tx.siteWallet.findMany({
        where: {
          companyId,
          ...(filter.siteId !== undefined ? { siteId: filter.siteId } : {}),
          ...(siteIds !== undefined ? { siteId: { in: siteIds } } : {}),
          ...(filter.cursor !== undefined ? { id: { gt: filter.cursor } } : {}),
        },
        orderBy: { id: 'asc' },
        take: limit + 1,
        include: {
          site: {
            select: {
              id: true,
              code: true,
              name: true,
              projectId: true,
              project: { select: { id: true, code: true, name: true } },
            },
          },
        },
      });
      const slice = rows.slice(0, limit);
      const nextCursor = rows.length > limit ? slice[slice.length - 1]?.id : undefined;
      const items = await this.buildDetailedWalletReports(repos, companyId, slice, filter);
      return { items, ...(nextCursor !== undefined ? { nextCursor } : {}) };
    });
  }

  /** Finance detailed report for a single site wallet, including account-head breakdown. */
  async financeWalletReport(
    actor: ActorContext,
    companyId: string,
    walletId: string,
    range: { from?: string; to?: string },
  ) {
    return this.uow.run(async (repos) => {
      await this.assertFinance(
        repos,
        actor,
        companyId,
        FINANCE_WALLET_READ,
        OPS.FINANCE_REPORT_VIEW,
      );
      const wallet = await repos.tx.siteWallet.findFirst({
        where: { id: walletId, companyId },
        include: {
          site: {
            select: {
              id: true,
              code: true,
              name: true,
              projectId: true,
              project: { select: { id: true, code: true, name: true } },
            },
          },
        },
      });
      if (wallet === null) throw new OrgEntityNotFoundError('SITE_WALLET');
      const [report] = await this.buildDetailedWalletReports(repos, companyId, [wallet], range);
      const headLines = await repos.tx.walletCashVoucherLine.groupBy({
        by: ['accountHeadId', 'accountCode', 'accountHeadName'],
        where: {
          companyId,
          voucher: {
            walletId: wallet.id,
            ...(range.from !== undefined || range.to !== undefined
              ? {
                  date: {
                    ...(range.from !== undefined ? { gte: new Date(range.from) } : {}),
                    ...(range.to !== undefined ? { lte: new Date(range.to) } : {}),
                  },
                }
              : {}),
          },
        },
        _sum: { amount: true },
        _count: true,
      });
      return {
        ...report,
        accountHeadBreakdown: headLines.map((h) => ({
          accountHeadId: h.accountHeadId,
          accountCode: h.accountCode,
          accountHeadName: h.accountHeadName,
          count: h._count,
          total: h._sum.amount ?? ZERO,
        })),
      };
    });
  }

  // -------------------------------------------------------- funding requests

  async createFundingRequest(
    actor: ActorContext,
    companyId: string,
    siteId: string,
    input: FundingRequestCreateInput,
  ) {
    const amount = money(input.amount, 'amount');
    return this.uow.run(async (repos) => {
      await this.assertSite(repos, actor, companyId, siteId, OPS.FUNDING_SUBMIT);
      const chain = await this.siteChain(repos, companyId, siteId);
      await this.assertProjectIncharge(repos, actor, companyId, chain);
      const wallet = await this.walletForSite(repos, companyId, siteId);
      if (wallet.status !== 'ACTIVE') {
        throw new WalletStateError(`wallet is ${wallet.status} — funding requests need ACTIVE`);
      }
      const employee = await this.employeeFor(repos, companyId, actor.actorId);
      const replay = await repos.tx.walletFundingRequest.findFirst({
        where: {
          companyId,
          requestedByPrincipalId: actor.actorId,
          idempotencyKey: input.idempotencyKey,
        },
      });
      if (replay !== null) {
        if (
          replay.draftAmount === null ||
          !new Decimal(replay.draftAmount).eq(amount) ||
          replay.draftPurpose !== input.purpose
        ) {
          throw new IdempotencyConflictError(input.idempotencyKey);
        }
        return { request: replay, replayed: true };
      }
      let request: WalletFundingRequest;
      try {
        request = await repos.tx.walletFundingRequest.create({
          data: {
            companyId,
            walletId: wallet.id,
            siteId,
            requestedByPrincipalId: actor.actorId,
            requestedByEmployeeId: employee.id,
            draftAmount: amount,
            draftPurpose: input.purpose,
            ...(input.neededByDate !== undefined
              ? { draftNeededByDate: new Date(input.neededByDate) }
              : {}),
            idempotencyKey: input.idempotencyKey,
          },
        });
      } catch (e) {
        mapOrgWriteError(e, 'WALLET_FUNDING_REQUEST');
      }
      await repos.audit.record(
        auditEntry(actor, {
          action: 'WALLET_FUNDING_REQUEST_CREATED',
          entityType: 'WALLET_FUNDING_REQUEST',
          entityId: request.id,
          companyId,
          statusAfter: request.status,
          changedFields: {
            siteId: { before: null, after: siteId },
            amount: { before: null, after: amount.toFixed(2) },
            currency: { before: null, after: INR },
          },
        }),
      );
      return { request, replayed: false, chain };
    });
  }

  async updateFundingRequest(
    actor: ActorContext,
    companyId: string,
    siteId: string,
    requestId: string,
    input: FundingRequestUpdateInput,
  ) {
    return this.uow.run(async (repos) => {
      await this.assertSite(repos, actor, companyId, siteId, OPS.FUNDING_SUBMIT);
      const chain = await this.siteChain(repos, companyId, siteId);
      await this.assertProjectIncharge(repos, actor, companyId, chain);
      const request = await this.requestForSite(repos, companyId, siteId, requestId);
      if (request.requestedByPrincipalId !== actor.actorId) {
        throw new ForbiddenError('NOT_REQUEST_OWNER', 'only the requester may edit this request');
      }
      if (request.status !== 'DRAFT' && request.status !== 'RETURNED') {
        throw new InvalidStatusTransitionError('WALLET_FUNDING_REQUEST', request.status, 'edit');
      }
      const amount = input.amount !== undefined ? money(input.amount, 'amount') : undefined;
      const res = await repos.tx.walletFundingRequest.updateMany({
        where: { id: request.id, companyId, version: input.expectedVersion },
        data: {
          ...(amount !== undefined ? { draftAmount: amount } : {}),
          ...(input.purpose !== undefined ? { draftPurpose: input.purpose } : {}),
          ...(input.neededByDate !== undefined
            ? {
                draftNeededByDate:
                  input.neededByDate === null ? null : new Date(input.neededByDate),
              }
            : {}),
          version: { increment: 1 },
        },
      });
      if (res.count === 0) throw new VersionConflictError('WALLET_FUNDING_REQUEST');
      const updated = await repos.tx.walletFundingRequest.findFirstOrThrow({
        where: { id: request.id, companyId },
      });
      await repos.audit.record(
        auditEntry(actor, {
          action: 'WALLET_FUNDING_REQUEST_UPDATED',
          entityType: 'WALLET_FUNDING_REQUEST',
          entityId: request.id,
          companyId,
          statusBefore: request.status,
          statusAfter: updated.status,
          changedFields: {
            ...(amount !== undefined
              ? {
                  draftAmount: {
                    before: request.draftAmount?.toString() ?? null,
                    after: amount.toFixed(2),
                  },
                }
              : {}),
          },
        }),
      );
      return updated;
    });
  }

  /**
   * Submit: numbered immutable attempt + workflow instance + pending approval
   * task — one transaction. Replays by (request, idempotencyKey).
   */
  async submitFundingRequest(
    actor: ActorContext,
    companyId: string,
    siteId: string,
    requestId: string,
    input: { idempotencyKey: string },
  ) {
    return this.uow.run(async (repos) => {
      await this.assertSite(repos, actor, companyId, siteId, OPS.FUNDING_SUBMIT);
      const chain = await this.siteChain(repos, companyId, siteId);
      await this.assertProjectIncharge(repos, actor, companyId, chain);
      const request = await this.requestForSite(repos, companyId, siteId, requestId);
      if (request.requestedByPrincipalId !== actor.actorId) {
        throw new ForbiddenError('NOT_REQUEST_OWNER', 'only the requester may submit this request');
      }
      const existing = await repos.tx.walletFundingAttempt.findFirst({
        where: { companyId, requestId, idempotencyKey: input.idempotencyKey },
      });
      if (existing !== null) return { request, attempt: existing, replayed: true };
      if (request.status !== 'DRAFT' && request.status !== 'RETURNED') {
        throw new InvalidStatusTransitionError('WALLET_FUNDING_REQUEST', request.status, 'submit');
      }
      if (request.draftAmount === null || request.draftPurpose === null) {
        throw new OrgValidationError('draft', 'amount and purpose must be set before submit');
      }

      const workflowId = await ensureWalletFundingWorkflow(repos.tx, companyId);
      const workflow = await repos.wf.workflows.findForStart(companyId, workflowId);
      if (workflow === null) {
        throw new OrgEntityNotFoundError('WORKFLOW');
      }
      if (workflow.currentVersionId === null) {
        throw new OrgValidationError('currentVersionId', 'workflow has no published version');
      }
      const wfVersion = await repos.wf.workflowVersions.findById(
        companyId,
        workflowId,
        workflow.currentVersionId,
      );
      if (wfVersion === null) throw new OrgEntityNotFoundError('WORKFLOW_VERSION');
      const state = initialStateOf(wfVersion.definition);
      if (state === null)
        throw new OrgValidationError('definition', 'snapshot has no initialState');

      const instance = await repos.wf.instances.create(companyId, {
        operationId: workflow.operationId,
        workflowId,
        workflowVersionId: wfVersion.id,
        operationVersionId: workflow.operationVersionId,
        state: state as WorkflowState,
        businessEntityType: 'WALLET_FUNDING_REQUEST',
        businessEntityId: request.id,
        startedByPrincipalId: actor.actorId,
      });
      const task = await ensureApprovalStageTask(
        repos.wf,
        actor,
        companyId,
        instance,
        wfVersion.definition,
      );

      const maxNo = await repos.tx.walletFundingAttempt.aggregate({
        where: { requestId: request.id },
        _max: { attemptNo: true },
      });
      const attempt = await repos.tx.walletFundingAttempt.create({
        data: {
          companyId,
          requestId: request.id,
          attemptNo: (maxNo._max.attemptNo ?? 0) + 1,
          amount: request.draftAmount,
          currency: INR,
          purpose: request.draftPurpose,
          ...(request.draftNeededByDate !== null
            ? { neededByDate: request.draftNeededByDate }
            : {}),
          workflowInstanceId: instance.id,
          ...(task !== null ? { approvalTaskId: task.id } : {}),
          submittedByPrincipalId: actor.actorId,
          idempotencyKey: input.idempotencyKey,
        },
      });
      const updated = await repos.tx.walletFundingRequest.update({
        where: { id: request.id, companyId },
        data: { status: 'SUBMITTED', currentAttemptId: attempt.id, version: { increment: 1 } },
      });
      await repos.audit.record(
        auditEntry(actor, {
          action: 'WALLET_FUNDING_REQUEST_SUBMITTED',
          entityType: 'WALLET_FUNDING_REQUEST',
          entityId: request.id,
          companyId,
          statusBefore: request.status,
          statusAfter: 'SUBMITTED',
          changedFields: {
            attemptNo: { before: null, after: attempt.attemptNo },
            workflowInstanceId: { before: null, after: instance.id },
            amount: { before: null, after: attempt.amount.toString() },
          },
        }),
      );
      const recipients = await this.siteRecipients(repos, companyId, chain, [
        request.requestedByPrincipalId,
      ]);
      await repos.outbox.record({
        companyId,
        eventType: 'WALLET_FUNDING_SUBMITTED',
        aggregateType: 'WALLET_FUNDING_REQUEST',
        aggregateId: request.id,
        eventKey: randomUUID(),
        recipientPrincipalIds: recipients,
        summary: { siteId, attemptNo: String(attempt.attemptNo), status: 'SUBMITTED' },
      });
      return { request: updated, attempt, replayed: false };
    });
  }

  async cancelFundingRequest(
    actor: ActorContext,
    companyId: string,
    siteId: string,
    requestId: string,
  ) {
    return this.uow.run(async (repos) => {
      await this.assertSite(repos, actor, companyId, siteId, OPS.FUNDING_SUBMIT);
      const chain = await this.siteChain(repos, companyId, siteId);
      await this.assertProjectIncharge(repos, actor, companyId, chain);
      const request = await this.requestForSite(repos, companyId, siteId, requestId);
      if (request.requestedByPrincipalId !== actor.actorId) {
        throw new ForbiddenError('NOT_REQUEST_OWNER', 'only the requester may cancel this request');
      }
      // Cancellable while nothing is under Finance review: DRAFT or RETURNED.
      if (request.status !== 'DRAFT' && request.status !== 'RETURNED') {
        throw new InvalidStatusTransitionError('WALLET_FUNDING_REQUEST', request.status, 'cancel');
      }
      const updated = await repos.tx.walletFundingRequest.update({
        where: { id: request.id, companyId },
        data: { status: 'CANCELLED', version: { increment: 1 } },
      });
      await repos.audit.record(
        auditEntry(actor, {
          action: 'WALLET_FUNDING_REQUEST_CANCELLED',
          entityType: 'WALLET_FUNDING_REQUEST',
          entityId: request.id,
          companyId,
          statusBefore: request.status,
          statusAfter: 'CANCELLED',
        }),
      );
      await repos.outbox.record({
        companyId,
        eventType: 'WALLET_FUNDING_CANCELLED',
        aggregateType: 'WALLET_FUNDING_REQUEST',
        aggregateId: request.id,
        eventKey: randomUUID(),
        recipientPrincipalIds: await this.siteRecipients(repos, companyId, chain, [
          request.requestedByPrincipalId,
        ]),
        summary: { siteId, status: 'CANCELLED' },
      });
      return updated;
    });
  }

  async listSiteFundingRequests(
    actor: ActorContext,
    companyId: string,
    siteId: string,
    filter: Page & { status?: string },
  ) {
    return this.uow.run(async (repos) => {
      await this.assertSite(repos, actor, companyId, siteId, OPS.FUNDING_SUBMIT, SITE_WALLET_VIEW);
      const limit = Math.min(filter.limit ?? 50, MAX_LIMIT);
      const rows = await repos.tx.walletFundingRequest.findMany({
        where: {
          companyId,
          siteId,
          ...(filter.status !== undefined
            ? { status: filter.status as WalletFundingRequest['status'] }
            : {}),
          ...(filter.cursor !== undefined ? { id: { gt: filter.cursor } } : {}),
        },
        orderBy: { id: 'asc' },
        take: limit + 1,
      });
      const items = rows.slice(0, limit);
      const nextCursor = rows.length > limit ? items[items.length - 1]?.id : undefined;
      return { items, ...(nextCursor !== undefined ? { nextCursor } : {}) };
    });
  }

  async getFundingRequest(
    actor: ActorContext,
    companyId: string,
    siteId: string,
    requestId: string,
  ) {
    return this.uow.run(async (repos) => {
      await this.assertSite(repos, actor, companyId, siteId, OPS.LEDGER_VIEW, SITE_WALLET_VIEW);
      const request = await this.requestForSite(repos, companyId, siteId, requestId);
      const attempts = await repos.tx.walletFundingAttempt.findMany({
        where: { companyId, requestId },
        orderBy: { attemptNo: 'asc' },
      });
      const transfers = await repos.tx.walletTransfer.findMany({
        where: { companyId, requestId },
        orderBy: { createdAt: 'asc' },
      });
      const links = await repos.tx.documentLink.findMany({
        where: { companyId, walletFundingRequestId: requestId, unlinkedAt: null },
      });
      return { request, attempts, transfers, documentLinks: links };
    });
  }

  async listAttempts(actor: ActorContext, companyId: string, siteId: string, requestId: string) {
    return this.uow.run(async (repos) => {
      await this.assertSite(repos, actor, companyId, siteId, OPS.LEDGER_VIEW, SITE_WALLET_VIEW);
      await this.requestForSite(repos, companyId, siteId, requestId);
      return repos.tx.walletFundingAttempt.findMany({
        where: { companyId, requestId },
        orderBy: { attemptNo: 'asc' },
      });
    });
  }

  async listFinanceFundingRequests(
    actor: ActorContext,
    companyId: string,
    filter: Page & { status?: string; siteId?: string; projectId?: string },
  ) {
    return this.uow.run(async (repos) => {
      await this.assertFinance(repos, actor, companyId, FINANCE_WALLET_READ, OPS.FUNDING_REVIEW);
      const limit = Math.min(filter.limit ?? 50, MAX_LIMIT);
      let siteIds: string[] | undefined;
      if (filter.projectId !== undefined) {
        const sites = await repos.tx.site.findMany({
          where: { companyId, projectId: filter.projectId },
          select: { id: true },
        });
        siteIds = sites.map((s) => s.id);
        if (filter.siteId !== undefined && !siteIds.includes(filter.siteId)) {
          return { items: [] };
        }
      }
      const rows = await repos.tx.walletFundingRequest.findMany({
        where: {
          companyId,
          ...(filter.siteId !== undefined ? { siteId: filter.siteId } : {}),
          ...(siteIds !== undefined ? { siteId: { in: siteIds } } : {}),
          ...(filter.status !== undefined
            ? { status: filter.status as WalletFundingRequest['status'] }
            : {}),
          ...(filter.cursor !== undefined ? { id: { gt: filter.cursor } } : {}),
        },
        orderBy: { id: 'asc' },
        take: limit + 1,
        include: { site: { select: { id: true, code: true, name: true, projectId: true } } },
      });
      const items = rows.slice(0, limit);
      const nextCursor = rows.length > limit ? items[items.length - 1]?.id : undefined;
      return { items, ...(nextCursor !== undefined ? { nextCursor } : {}) };
    });
  }

  async getFinanceFundingRequest(actor: ActorContext, companyId: string, requestId: string) {
    return this.uow.run(async (repos) => {
      await this.assertFinance(repos, actor, companyId, FINANCE_WALLET_READ, OPS.FUNDING_REVIEW);
      const request = await repos.tx.walletFundingRequest.findFirst({
        where: { id: requestId, companyId },
        include: { site: { select: { id: true, code: true, name: true, projectId: true } } },
      });
      if (request === null) throw new OrgEntityNotFoundError('WALLET_FUNDING_REQUEST');
      const attempts = await repos.tx.walletFundingAttempt.findMany({
        where: { companyId, requestId },
        orderBy: { attemptNo: 'asc' },
      });
      const transfers = await repos.tx.walletTransfer.findMany({
        where: { companyId, requestId },
        orderBy: { createdAt: 'asc' },
      });
      return { request, attempts, transfers };
    });
  }

  // ------------------------------------------------------ transfers & receipts

  async recordTransfer(
    actor: ActorContext,
    companyId: string,
    requestId: string,
    input: TransferRecordInput,
  ) {
    const amount = money(input.amount, 'amount');
    return this.uow.run(async (repos) => {
      await this.assertFinance(repos, actor, companyId, FINANCE_WALLET_MANAGE, OPS.CREDIT_PROCESS);
      const request = await repos.tx.walletFundingRequest.findFirst({
        where: { id: requestId, companyId },
      });
      if (request === null) throw new OrgEntityNotFoundError('WALLET_FUNDING_REQUEST');
      const chain = await this.siteChain(repos, companyId, request.siteId);
      const replay = await repos.tx.walletTransfer.findFirst({
        where: {
          companyId,
          recordedByPrincipalId: actor.actorId,
          idempotencyKey: input.idempotencyKey,
        },
      });
      if (replay !== null) {
        if (
          replay.requestId !== requestId ||
          !new Decimal(replay.amount).eq(amount) ||
          replay.reference !== input.reference
        ) {
          throw new IdempotencyConflictError(input.idempotencyKey);
        }
        return { transfer: replay, replayed: true };
      }
      if (request.status !== 'APPROVED' && request.status !== 'PARTIALLY_FUNDED') {
        throw new InvalidStatusTransitionError(
          'WALLET_FUNDING_REQUEST',
          request.status,
          'record transfer',
        );
      }
      if (request.currentAttemptId === null || request.approvedAmount === null) {
        throw new WalletStateError('request has no approved attempt');
      }
      const remaining = new Decimal(request.approvedAmount).sub(request.confirmedAmount);
      // Σ recorded transfers may not exceed the remaining approved amount.
      const prior = await repos.tx.walletTransfer.aggregate({
        where: { companyId, requestId, status: { in: ['RECORDED', 'CONFIRMED', 'DISPUTED'] } },
        _sum: { amount: true },
      });
      const inFlight = new Decimal(prior._sum.amount ?? 0);
      if (inFlight.add(amount).gt(new Decimal(request.approvedAmount))) {
        throw new WalletLimitError(
          `transfer exceeds approved amount — remaining ${remaining.toFixed(2)} INR`,
        );
      }
      let transfer: WalletTransfer;
      try {
        transfer = await repos.tx.walletTransfer.create({
          data: {
            companyId,
            requestId,
            attemptId: request.currentAttemptId,
            walletId: request.walletId,
            siteId: request.siteId,
            amount,
            currency: INR,
            reference: input.reference,
            transferredAt:
              input.transferredAt !== undefined ? new Date(input.transferredAt) : new Date(),
            recordedByPrincipalId: actor.actorId,
            idempotencyKey: input.idempotencyKey,
          },
        });
      } catch (e) {
        mapOrgWriteError(e, 'WALLET_TRANSFER');
      }
      await repos.audit.record(
        auditEntry(actor, {
          action: 'WALLET_TRANSFER_RECORDED',
          entityType: 'WALLET_TRANSFER',
          entityId: transfer.id,
          companyId,
          statusAfter: transfer.status,
          changedFields: {
            requestId: { before: null, after: requestId },
            amount: { before: null, after: amount.toFixed(2) },
            currency: { before: null, after: INR },
          },
        }),
      );
      await repos.outbox.record({
        companyId,
        eventType: 'WALLET_TRANSFER_RECORDED',
        aggregateType: 'WALLET_TRANSFER',
        aggregateId: transfer.id,
        eventKey: randomUUID(),
        recipientPrincipalIds: await this.siteRecipients(repos, companyId, chain, [
          request.requestedByPrincipalId,
        ]),
        summary: { siteId: request.siteId, requestId, status: 'RECORDED' },
      });
      return { transfer, replayed: false };
    });
  }

  async listTransfers(actor: ActorContext, companyId: string, requestId: string) {
    return this.uow.run(async (repos) => {
      await this.assertFinance(repos, actor, companyId, FINANCE_WALLET_READ, OPS.FUNDING_REVIEW);
      const request = await repos.tx.walletFundingRequest.findFirst({
        where: { id: requestId, companyId },
      });
      if (request === null) throw new OrgEntityNotFoundError('WALLET_FUNDING_REQUEST');
      return repos.tx.walletTransfer.findMany({
        where: { companyId, requestId },
        orderBy: { createdAt: 'asc' },
      });
    });
  }

  async getSiteTransfer(
    actor: ActorContext,
    companyId: string,
    siteId: string,
    transferId: string,
  ) {
    return this.uow.run(async (repos) => {
      await this.assertSite(repos, actor, companyId, siteId, OPS.LEDGER_VIEW, SITE_WALLET_VIEW);
      const transfer = await repos.tx.walletTransfer.findFirst({
        where: { id: transferId, companyId, siteId },
      });
      if (transfer === null) throw new OrgEntityNotFoundError('WALLET_TRANSFER');
      return transfer;
    });
  }

  /**
   * PI-only receipt confirmation. Only the positive confirmed amount posts a
   * CREDIT_FUNDING — a shortfall becomes a dispute, never a credit. Replays
   * safely through the ledger entry's (wallet, idempotencyKey) unique index.
   */
  async confirmReceipt(
    actor: ActorContext,
    companyId: string,
    siteId: string,
    transferId: string,
    input: ConfirmReceiptInput,
  ) {
    const received = nonneg(input.receivedAmount, 'receivedAmount');
    return this.uow.run(async (repos) => {
      await this.assertSite(repos, actor, companyId, siteId, OPS.RECEIPT_CONFIRM);
      const chain = await this.siteChain(repos, companyId, siteId);
      await this.assertProjectIncharge(repos, actor, companyId, chain);
      const transfer = await repos.tx.walletTransfer.findFirst({
        where: { id: transferId, companyId, siteId },
      });
      if (transfer === null) throw new OrgEntityNotFoundError('WALLET_TRANSFER');
      const request = await repos.tx.walletFundingRequest.findFirstOrThrow({
        where: { id: transfer.requestId, companyId },
      });
      if (request.requestedByPrincipalId !== actor.actorId) {
        throw new ForbiddenError(
          'NOT_RECEIPT_CONFIRMER',
          'only the requesting PI may confirm receipt',
        );
      }
      const priorEntry = await repos.tx.walletLedgerEntry.findFirst({
        where: { companyId, walletId: transfer.walletId, idempotencyKey: input.idempotencyKey },
      });
      if (priorEntry !== null) {
        if (!new Decimal(priorEntry.amount).eq(received)) {
          throw new IdempotencyConflictError(input.idempotencyKey);
        }
        const fresh = await repos.tx.walletTransfer.findFirstOrThrow({
          where: { id: transferId, companyId },
        });
        return {
          transfer: fresh,
          ledgerEntry: serializeLedgerEntry(priorEntry),
          pdfUrl: `/api/v1/sites/${siteId}/wallet/transfers/${transferId}/pdf`,
          replayed: true,
        };
      }
      // Zero-receipt replays leave no ledger row — the disputed transfer
      // state is the replay marker instead.
      if (received.eq(ZERO) && transfer.status === 'DISPUTED') {
        return {
          transfer,
          ledgerEntry: null,
          pdfUrl: `/api/v1/sites/${siteId}/wallet/transfers/${transferId}/pdf`,
          replayed: true,
        };
      }
      if (transfer.status !== 'RECORDED') {
        throw new InvalidStatusTransitionError('WALLET_TRANSFER', transfer.status, 'confirm');
      }
      if (received.gt(transfer.amount)) {
        throw new OrgValidationError('receivedAmount', 'exceeds the recorded transfer amount');
      }
      const wallet = await lockWallet(repos.tx, companyId, transfer.walletId);
      if (wallet === null) throw new OrgEntityNotFoundError('SITE_WALLET');
      if (wallet.status !== 'ACTIVE') {
        throw new WalletStateError(`wallet is ${wallet.status}`);
      }
      if (request.approvedAmount === null) {
        throw new WalletStateError('request is not approved');
      }
      if (new Decimal(request.confirmedAmount).add(received).gt(request.approvedAmount)) {
        throw new WalletLimitError('confirmed funds would exceed the approved amount');
      }
      const disputed = received.lt(transfer.amount);
      let ledgerEntry: WalletLedgerEntry | null = null;
      if (received.gt(ZERO)) {
        ledgerEntry = await repos.tx.walletLedgerEntry.create({
          data: {
            companyId,
            walletId: transfer.walletId,
            type: 'CREDIT_FUNDING',
            amount: received,
            currency: INR,
            balanceAfter: new Decimal(wallet.balance).add(received),
            fundingRequestId: request.id,
            transferId: transfer.id,
            postedByPrincipalId: actor.actorId,
            idempotencyKey: input.idempotencyKey,
          },
        });
      }
      const newConfirmed = new Decimal(request.confirmedAmount).add(received);
      const newStatus = newConfirmed.gte(request.approvedAmount) ? 'FUNDED' : 'PARTIALLY_FUNDED';
      const updatedTransfer = await repos.tx.walletTransfer.update({
        where: { id: transfer.id, companyId },
        data: {
          confirmedAmount: received,
          confirmedByPrincipalId: actor.actorId,
          confirmedAt: new Date(),
          status: disputed ? 'DISPUTED' : 'CONFIRMED',
          ...(disputed
            ? {
                discrepancyAmount: new Decimal(transfer.amount).sub(received),
                ...(input.discrepancyNote !== undefined
                  ? { discrepancyNote: input.discrepancyNote }
                  : {}),
              }
            : {}),
          version: { increment: 1 },
        },
      });
      await repos.tx.walletFundingRequest.update({
        where: { id: request.id, companyId },
        data: { confirmedAmount: newConfirmed, status: newStatus, version: { increment: 1 } },
      });
      await repos.audit.record(
        auditEntry(actor, {
          action: disputed ? 'WALLET_RECEIPT_DISPUTED' : 'WALLET_RECEIPT_CONFIRMED',
          entityType: 'WALLET_TRANSFER',
          entityId: transfer.id,
          companyId,
          statusBefore: transfer.status,
          statusAfter: updatedTransfer.status,
          changedFields: {
            confirmedAmount: { before: '0', after: received.toFixed(2) },
            ...(ledgerEntry !== null
              ? { ledgerEntryId: { before: null, after: ledgerEntry.id } }
              : {}),
          },
        }),
      );
      await repos.outbox.record({
        companyId,
        eventType: disputed ? 'WALLET_RECEIPT_DISPUTED' : 'WALLET_RECEIPT_CONFIRMED',
        aggregateType: 'WALLET_TRANSFER',
        aggregateId: transfer.id,
        eventKey: randomUUID(),
        recipientPrincipalIds: await this.siteRecipients(repos, companyId, chain, [
          request.requestedByPrincipalId,
        ]),
        summary: {
          siteId,
          requestId: request.id,
          transferId: transfer.id,
          receivedAmount: received.toFixed(2),
          status: updatedTransfer.status,
          requestStatus: newStatus,
        },
      });
      return {
        transfer: updatedTransfer,
        ledgerEntry: ledgerEntry !== null ? serializeLedgerEntry(ledgerEntry) : null,
        pdfUrl: `/api/v1/sites/${siteId}/wallet/transfers/${transfer.id}/pdf`,
        replayed: false,
      };
    });
  }

  async resolveDispute(
    actor: ActorContext,
    companyId: string,
    transferId: string,
    input: ResolveDisputeInput,
  ) {
    return this.uow.run(async (repos) => {
      await this.assertFinance(repos, actor, companyId, FINANCE_WALLET_MANAGE, OPS.RECONCILE);
      const transfer = await repos.tx.walletTransfer.findFirst({
        where: { id: transferId, companyId },
      });
      if (transfer === null) throw new OrgEntityNotFoundError('WALLET_TRANSFER');
      const chain = await this.siteChain(repos, companyId, transfer.siteId);
      const request = await repos.tx.walletFundingRequest.findFirstOrThrow({
        where: { id: transfer.requestId, companyId },
      });
      const replay = await repos.tx.walletLedgerEntry.findFirst({
        where: { companyId, walletId: transfer.walletId, idempotencyKey: input.idempotencyKey },
      });
      if (replay !== null) {
        return { transfer, replayed: true };
      }
      if (transfer.status !== 'DISPUTED') {
        throw new InvalidStatusTransitionError(
          'WALLET_TRANSFER',
          transfer.status,
          'resolve dispute',
        );
      }
      const updated = await repos.tx.walletTransfer.update({
        where: { id: transfer.id, companyId },
        data: {
          status: 'CLOSED',
          disputeResolution: `${input.resolution}: ${input.note}`,
          version: { increment: 1 },
        },
      });
      await repos.audit.record(
        auditEntry(actor, {
          action: 'WALLET_DISPUTE_RESOLVED',
          entityType: 'WALLET_TRANSFER',
          entityId: transfer.id,
          companyId,
          statusBefore: 'DISPUTED',
          statusAfter: 'CLOSED',
          changedFields: {
            resolution: { before: null, after: input.resolution },
          },
        }),
      );
      await repos.outbox.record({
        companyId,
        eventType: 'WALLET_DISPUTE_RESOLVED',
        aggregateType: 'WALLET_TRANSFER',
        aggregateId: transfer.id,
        eventKey: randomUUID(),
        recipientPrincipalIds: await this.siteRecipients(repos, companyId, chain, [
          request.requestedByPrincipalId,
        ]),
        summary: { siteId: transfer.siteId, status: 'CLOSED', resolution: input.resolution },
      });
      return { transfer: updated, replayed: false };
    });
  }

  async closeShort(
    actor: ActorContext,
    companyId: string,
    requestId: string,
    input: CloseShortInput,
  ) {
    return this.uow.run(async (repos) => {
      await this.assertFinance(repos, actor, companyId, FINANCE_WALLET_MANAGE, OPS.RECONCILE);
      const request = await repos.tx.walletFundingRequest.findFirst({
        where: { id: requestId, companyId },
      });
      if (request === null) throw new OrgEntityNotFoundError('WALLET_FUNDING_REQUEST');
      const chain = await this.siteChain(repos, companyId, request.siteId);
      if (request.status !== 'APPROVED' && request.status !== 'PARTIALLY_FUNDED') {
        throw new InvalidStatusTransitionError(
          'WALLET_FUNDING_REQUEST',
          request.status,
          'close short',
        );
      }
      if (request.approvedAmount === null) {
        throw new WalletStateError('request is not approved');
      }
      if (new Decimal(request.confirmedAmount).gte(request.approvedAmount)) {
        throw new WalletStateError('request is fully funded — nothing to close short');
      }
      const open = await repos.tx.walletTransfer.count({
        where: { companyId, requestId, status: { in: ['RECORDED', 'DISPUTED'] } },
      });
      if (open > 0) {
        throw new WalletStateError(
          'open or disputed transfers must be resolved before close-short',
        );
      }
      const updated = await repos.tx.walletFundingRequest.update({
        where: { id: request.id, companyId },
        data: {
          status: 'CLOSED_SHORT',
          closedShortReason: input.reason,
          version: { increment: 1 },
        },
      });
      await repos.audit.record(
        auditEntry(actor, {
          action: 'WALLET_REQUEST_CLOSED_SHORT',
          entityType: 'WALLET_FUNDING_REQUEST',
          entityId: request.id,
          companyId,
          statusBefore: request.status,
          statusAfter: 'CLOSED_SHORT',
          changedFields: { reason: { before: null, after: input.reason } },
        }),
      );
      await repos.outbox.record({
        companyId,
        eventType: 'WALLET_REQUEST_CLOSED_SHORT',
        aggregateType: 'WALLET_FUNDING_REQUEST',
        aggregateId: request.id,
        eventKey: randomUUID(),
        recipientPrincipalIds: await this.siteRecipients(repos, companyId, chain, [
          request.requestedByPrincipalId,
        ]),
        summary: { siteId: request.siteId, status: 'CLOSED_SHORT' },
      });
      return updated;
    });
  }

  /** Finance reduces the approved amount on an APPROVED / PARTIALLY_FUNDED request. */
  async reduceApprovedAmount(
    actor: ActorContext,
    companyId: string,
    requestId: string,
    input: ReduceApprovedAmountInput,
  ) {
    const newAmount = money(input.approvedAmount, 'approvedAmount');
    return this.uow.run(async (repos) => {
      await this.assertFinance(repos, actor, companyId, FINANCE_WALLET_MANAGE, OPS.FUNDING_REVIEW);
      const request = await repos.tx.walletFundingRequest.findFirst({
        where: { id: requestId, companyId },
      });
      if (request === null) throw new OrgEntityNotFoundError('WALLET_FUNDING_REQUEST');
      if (request.version !== input.expectedVersion) {
        throw new VersionConflictError('WALLET_FUNDING_REQUEST');
      }
      if (request.status !== 'APPROVED' && request.status !== 'PARTIALLY_FUNDED') {
        throw new InvalidStatusTransitionError(
          'WALLET_FUNDING_REQUEST',
          request.status,
          'reduce approved amount',
        );
      }
      if (request.approvedAmount === null) {
        throw new WalletStateError('request is not approved');
      }
      const prevApproved = new Decimal(request.approvedAmount);
      if (newAmount.gte(prevApproved)) {
        throw new OrgValidationError(
          'approvedAmount',
          'must be strictly less than the current approvedAmount',
        );
      }
      if (newAmount.lt(request.confirmedAmount)) {
        throw new WalletLimitError('cannot reduce approvedAmount below already confirmedAmount');
      }
      const inFlightAgg = await repos.tx.walletTransfer.aggregate({
        where: { companyId, requestId, status: { in: ['RECORDED', 'CONFIRMED', 'DISPUTED'] } },
        _sum: { amount: true },
      });
      const inFlight = new Decimal(inFlightAgg._sum.amount ?? 0);
      if (newAmount.lt(inFlight)) {
        throw new WalletLimitError(
          `cannot reduce approvedAmount below recorded transfers (${inFlight.toFixed(2)} INR)`,
        );
      }
      const nextStatus = new Decimal(request.confirmedAmount).gte(newAmount)
        ? 'FUNDED'
        : request.status;
      const chain = await this.siteChain(repos, companyId, request.siteId);
      const updated = await repos.tx.walletFundingRequest.update({
        where: { id: request.id, companyId },
        data: {
          approvedAmount: newAmount,
          status: nextStatus,
          version: { increment: 1 },
        },
      });
      await repos.audit.record(
        auditEntry(actor, {
          action: 'WALLET_FUNDING_REDUCED',
          entityType: 'WALLET_FUNDING_REQUEST',
          entityId: request.id,
          companyId,
          statusBefore: request.status,
          statusAfter: nextStatus,
          changedFields: {
            approvedAmount: { before: prevApproved.toFixed(2), after: newAmount.toFixed(2) },
            reason: { before: null, after: input.reason },
          },
        }),
      );
      await repos.outbox.record({
        companyId,
        eventType: 'WALLET_FUNDING_REDUCED',
        aggregateType: 'WALLET_FUNDING_REQUEST',
        aggregateId: request.id,
        eventKey: randomUUID(),
        recipientPrincipalIds: await this.siteRecipients(repos, companyId, chain, [
          request.requestedByPrincipalId,
        ]),
        summary: {
          siteId: request.siteId,
          status: nextStatus,
          approvedAmount: newAmount.toFixed(2),
        },
      });
      return updated;
    });
  }

  /** Finance cancels an unconfirmed (RECORDED) transfer so a smaller/corrected one can be sent. */
  async cancelTransfer(
    actor: ActorContext,
    companyId: string,
    transferId: string,
    input: CancelTransferInput,
  ) {
    return this.uow.run(async (repos) => {
      await this.assertFinance(repos, actor, companyId, FINANCE_WALLET_MANAGE, OPS.CREDIT_PROCESS);
      const transfer = await repos.tx.walletTransfer.findFirst({
        where: { id: transferId, companyId },
      });
      if (transfer === null) throw new OrgEntityNotFoundError('WALLET_TRANSFER');
      if (transfer.version !== input.expectedVersion) {
        throw new VersionConflictError('WALLET_TRANSFER');
      }
      if (transfer.status !== 'RECORDED') {
        throw new InvalidStatusTransitionError('WALLET_TRANSFER', transfer.status, 'cancel');
      }
      const request = await repos.tx.walletFundingRequest.findFirstOrThrow({
        where: { id: transfer.requestId, companyId },
      });
      const chain = await this.siteChain(repos, companyId, transfer.siteId);
      const updated = await repos.tx.walletTransfer.update({
        where: { id: transfer.id, companyId },
        data: {
          status: 'CLOSED',
          disputeResolution: `CANCELLED: ${input.reason}`,
          version: { increment: 1 },
        },
      });
      await repos.audit.record(
        auditEntry(actor, {
          action: 'WALLET_TRANSFER_CANCELLED',
          entityType: 'WALLET_TRANSFER',
          entityId: transfer.id,
          companyId,
          statusBefore: transfer.status,
          statusAfter: 'CLOSED',
          changedFields: { reason: { before: null, after: input.reason } },
        }),
      );
      await repos.outbox.record({
        companyId,
        eventType: 'WALLET_TRANSFER_CANCELLED',
        aggregateType: 'WALLET_TRANSFER',
        aggregateId: transfer.id,
        eventKey: randomUUID(),
        recipientPrincipalIds: await this.siteRecipients(repos, companyId, chain, [
          request.requestedByPrincipalId,
        ]),
        summary: { siteId: transfer.siteId, requestId: transfer.requestId, status: 'CLOSED' },
      });
      return updated;
    });
  }

  // ----------------------------------------------------------- expenses

  private async validateExpenseDocuments(
    repos: WalletRepos,
    companyId: string,
    chain: ScopeChain,
    documentIds: string[],
  ): Promise<void> {
    for (const documentId of documentIds) {
      const doc = await repos.tx.document.findFirst({ where: { id: documentId, companyId } });
      if (doc === null) throw new OrgEntityNotFoundError('DOCUMENT');
      if (doc.status !== 'AVAILABLE') {
        throw new OrgValidationError('documentIds', `document ${documentId} is ${doc.status}`);
      }
      const covers = scopeCovers(
        {
          scopeType: doc.scopeType,
          headOfficeId: doc.headOfficeId,
          projectId: doc.projectId,
          siteId: doc.siteId,
          companyId: doc.companyId,
        },
        chain,
      );
      if (!covers) {
        throw new ForbiddenError(
          'DOCUMENT_SCOPE_MISMATCH',
          `document ${documentId} scope does not cover this site`,
        );
      }
    }
  }

  /**
   * Immediate wallet debit — expense, ledger entry, optional voucher, and
   * optional document links in one transaction under the wallet row lock.
   */
  async createExpense(
    actor: ActorContext,
    companyId: string,
    siteId: string,
    input: ExpenseCreateInput,
  ) {
    const amount = money(input.amount, 'amount');
    if (input.accountLines.length === 0) {
      throw new OrgValidationError('accountLines', 'at least one account line is required');
    }
    if (
      new Set(input.accountLines.map((l) => l.accountHeadId)).size !== input.accountLines.length
    ) {
      throw new OrgValidationError('accountLines', 'duplicate account head in lines');
    }
    const lineAmounts = input.accountLines.map((l, i) =>
      money(l.amount, `accountLines.${i}.amount`),
    );
    const total = lineAmounts.reduce((a, b) => a.add(b), ZERO);
    if (!total.eq(amount)) {
      throw new OrgValidationError(
        'accountLines',
        `line total ${total.toFixed(2)} ≠ amount ${amount.toFixed(2)}`,
      );
    }
    return this.uow.run(async (repos) => {
      await this.assertSite(repos, actor, companyId, siteId, OPS.EXPENSE_SUBMIT);
      const chain = await this.siteChain(repos, companyId, siteId);
      await this.assertProjectIncharge(repos, actor, companyId, chain);
      const replay = await repos.tx.walletExpense.findFirst({
        where: {
          companyId,
          createdByPrincipalId: actor.actorId,
          idempotencyKey: input.idempotencyKey,
        },
        include: { cashVoucher: { include: { lines: true } } },
      });
      if (replay !== null) {
        if (!new Decimal(replay.amount).eq(amount)) {
          throw new IdempotencyConflictError(input.idempotencyKey);
        }
        const serializedVoucher =
          replay.cashVoucher !== null ? serializeVoucher(replay.cashVoucher) : null;
        return {
          expense: { ...replay, cashVoucher: serializedVoucher },
          voucher: serializedVoucher,
          pdfUrl:
            serializedVoucher !== null
              ? `/api/v1/sites/${siteId}/wallet/vouchers/${serializedVoucher.id}/pdf`
              : null,
          replayed: true,
        };
      }
      const heads = await repos.tx.walletAccountHead.findMany({
        where: { companyId, id: { in: input.accountLines.map((l) => l.accountHeadId) } },
      });
      const headById = new Map(heads.map((h) => [h.id, h]));
      for (const line of input.accountLines) {
        const h = headById.get(line.accountHeadId);
        if (h === undefined) throw new OrgEntityNotFoundError('WALLET_ACCOUNT_HEAD');
        if (h.status !== 'ACTIVE') {
          throw new OrgValidationError('accountLines', `account head ${h.code} is ${h.status}`);
        }
      }
      const documentIds = input.documentIds ?? [];
      await this.validateExpenseDocuments(repos, companyId, chain, documentIds);
      const wallet = await lockWallet(
        repos.tx,
        companyId,
        (await this.walletForSite(repos, companyId, siteId)).id,
      );
      if (wallet === null) throw new OrgEntityNotFoundError('SITE_WALLET');
      if (wallet.status !== 'ACTIVE') {
        throw new WalletStateError(`wallet is ${wallet.status}`);
      }
      const balanceAfter = new Decimal(wallet.balance).sub(amount);
      if (balanceAfter.lt(ZERO)) throw new InsufficientWalletBalanceError();
      const employee = await this.employeeFor(repos, companyId, actor.actorId);
      const ledgerId = randomUUID();
      const expense = await repos.tx.walletExpense.create({
        data: {
          companyId,
          walletId: wallet.id,
          amount,
          currency: INR,
          expenseDate: new Date(input.expenseDate),
          category: input.accountLines.length === 1 ? 'SINGLE' : 'SPLIT',
          description: input.description,
          ...(input.payee !== undefined ? { payee: input.payee } : {}),
          ...(input.reference !== undefined ? { reference: input.reference } : {}),
          status: 'POSTED',
          evidenceState: documentIds.length > 0 ? 'ATTACHED' : 'NONE',
          ledgerEntryId: ledgerId,
          createdByPrincipalId: actor.actorId,
          idempotencyKey: input.idempotencyKey,
        },
      });
      const ledgerEntry = await repos.tx.walletLedgerEntry.create({
        data: {
          id: ledgerId,
          companyId,
          walletId: wallet.id,
          type: 'DEBIT_EXPENSE',
          amount,
          currency: INR,
          balanceAfter,
          expenseId: expense.id,
          postedByPrincipalId: actor.actorId,
          idempotencyKey: input.idempotencyKey,
        },
      });
      let voucher: WalletCashVoucher | null = null;
      if (input.voucher !== undefined) {
        const voucherNo = await allocVoucherNo(repos.tx, companyId);
        const created = await repos.tx.walletCashVoucher.create({
          data: {
            companyId,
            voucherNo,
            expenseId: expense.id,
            walletId: wallet.id,
            siteId,
            date: new Date(input.expenseDate),
            currency: INR,
            preparedByPrincipalId: actor.actorId,
            preparedByEmployeeId: employee.id,
            ...(input.voucher.paidTo !== undefined ? { paidTo: input.voucher.paidTo } : {}),
            ...(input.voucher.narration !== undefined
              ? { narration: input.voucher.narration }
              : {}),
          },
        });
        await repos.tx.walletCashVoucherLine.createMany({
          data: input.accountLines.map((line, i) => {
            const head = headById.get(line.accountHeadId);
            return {
              companyId,
              voucherId: created.id,
              lineNo: i + 1,
              accountHeadId: line.accountHeadId,
              accountCode: head?.code ?? '',
              accountHeadName: head?.name ?? '',
              amount: lineAmounts[i] ?? ZERO,
            };
          }),
        });
        voucher = await repos.tx.walletCashVoucher.findFirstOrThrow({
          where: { id: created.id, companyId },
          include: { lines: { orderBy: { lineNo: 'asc' } } },
        });
      }
      for (const documentId of documentIds) {
        try {
          await repos.tx.documentLink.create({
            data: {
              companyId,
              documentId,
              entityType: 'WALLET_EXPENSE',
              walletExpenseId: expense.id,
              linkedByPrincipalId: actor.actorId,
            },
          });
        } catch (e) {
          mapOrgWriteError(e, 'DOCUMENT_LINK');
        }
      }
      await repos.audit.record(
        auditEntry(actor, {
          action: 'WALLET_EXPENSE_POSTED',
          entityType: 'WALLET_EXPENSE',
          entityId: expense.id,
          companyId,
          statusAfter: 'POSTED',
          changedFields: {
            walletId: { before: null, after: wallet.id },
            amount: { before: null, after: amount.toFixed(2) },
            currency: { before: null, after: INR },
            ledgerEntryId: { before: null, after: ledgerEntry.id },
            ...(voucher !== null
              ? { voucherNo: { before: null, after: voucher.voucherNo.toString() } }
              : {}),
          },
        }),
      );
      await repos.outbox.record({
        companyId,
        eventType: 'WALLET_EXPENSE_POSTED',
        aggregateType: 'WALLET_EXPENSE',
        aggregateId: expense.id,
        eventKey: randomUUID(),
        recipientPrincipalIds: await this.siteRecipients(repos, companyId, chain, [actor.actorId]),
        summary: {
          siteId,
          walletId: wallet.id,
          expenseId: expense.id,
          amount: amount.toFixed(2),
          status: 'POSTED',
        },
      });
      if (voucher !== null) {
        await repos.outbox.record({
          companyId,
          eventType: 'WALLET_VOUCHER_CREATED',
          aggregateType: 'WALLET_CASH_VOUCHER',
          aggregateId: voucher.id,
          eventKey: randomUUID(),
          recipientPrincipalIds: await this.siteRecipients(repos, companyId, chain, [
            actor.actorId,
          ]),
          summary: {
            siteId,
            voucherId: voucher.id,
            voucherNo: voucher.voucherNo.toString(),
          },
        });
      }
      return {
        expense,
        ledgerEntry: serializeLedgerEntry(ledgerEntry),
        voucher: voucher !== null ? serializeVoucher(voucher) : null,
        pdfUrl:
          voucher !== null
            ? `/api/v1/sites/${siteId}/wallet/vouchers/${voucher.id}/pdf`
            : null,
        replayed: false,
      };
    });
  }

  async listExpenses(
    actor: ActorContext,
    companyId: string,
    siteId: string,
    filter: Page & { from?: string; to?: string; accountHeadId?: string },
  ) {
    return this.uow.run(async (repos) => {
      await this.assertSite(repos, actor, companyId, siteId, OPS.LEDGER_VIEW, SITE_WALLET_VIEW);
      const wallet = await this.walletForSite(repos, companyId, siteId);
      const limit = Math.min(filter.limit ?? 50, MAX_LIMIT);
      const rows = await repos.tx.walletExpense.findMany({
        where: {
          companyId,
          walletId: wallet.id,
          ...(filter.from !== undefined || filter.to !== undefined
            ? {
                expenseDate: {
                  ...(filter.from !== undefined ? { gte: new Date(filter.from) } : {}),
                  ...(filter.to !== undefined ? { lte: new Date(filter.to) } : {}),
                },
              }
            : {}),
          ...(filter.accountHeadId !== undefined
            ? { cashVoucher: { lines: { some: { accountHeadId: filter.accountHeadId } } } }
            : {}),
          ...(filter.cursor !== undefined ? { id: { gt: filter.cursor } } : {}),
        },
        orderBy: { id: 'asc' },
        take: limit + 1,
      });
      const items = rows.slice(0, limit);
      const nextCursor = rows.length > limit ? items[items.length - 1]?.id : undefined;
      return { items, ...(nextCursor !== undefined ? { nextCursor } : {}) };
    });
  }

  async getExpense(actor: ActorContext, companyId: string, siteId: string, expenseId: string) {
    return this.uow.run(async (repos) => {
      await this.assertSite(repos, actor, companyId, siteId, OPS.LEDGER_VIEW, SITE_WALLET_VIEW);
      const wallet = await this.walletForSite(repos, companyId, siteId);
      const expense = await repos.tx.walletExpense.findFirst({
        where: { id: expenseId, companyId, walletId: wallet.id },
        include: {
          cashVoucher: { include: { lines: { orderBy: { lineNo: 'asc' } } } },
          documentLinks: { where: { unlinkedAt: null } },
        },
      });
      if (expense === null) throw new OrgEntityNotFoundError('WALLET_EXPENSE');
      return {
        ...expense,
        cashVoucher:
          expense.cashVoucher !== null ? serializeVoucher(expense.cashVoucher) : null,
      };
    });
  }

  // ------------------------------------------------------------- vouchers

  private async voucherForSite(
    repos: WalletRepos,
    companyId: string,
    siteId: string,
    voucherId: string,
  ) {
    const voucher = await repos.tx.walletCashVoucher.findFirst({
      where: { id: voucherId, companyId, siteId },
      include: { lines: { orderBy: { lineNo: 'asc' } } },
    });
    if (voucher === null) throw new OrgEntityNotFoundError('WALLET_CASH_VOUCHER');
    return voucher;
  }

  async getVoucher(actor: ActorContext, companyId: string, siteId: string, voucherId: string) {
    return this.uow.run(async (repos) => {
      await this.assertSite(repos, actor, companyId, siteId, OPS.LEDGER_VIEW, SITE_WALLET_VIEW);
      const voucher = await this.voucherForSite(repos, companyId, siteId, voucherId);
      const total = voucher.lines.reduce((a, l) => a.add(new Decimal(l.amount)), ZERO);
      return { voucher: serializeVoucher(voucher), total, amountInWords: inrToWords(total) };
    });
  }

  private async buildVoucherPdfData(
    repos: WalletRepos,
    companyId: string,
    siteId: string,
    voucher: Awaited<ReturnType<WalletService['voucherForSite']>>,
  ): Promise<CashVoucherPdfData> {
    const [company, site, preparer, checker] = await Promise.all([
      repos.tx.company.findFirstOrThrow({ where: { id: companyId } }),
      repos.tx.site.findFirstOrThrow({ where: { id: siteId, companyId } }),
      repos.tx.employee.findFirst({ where: { id: voucher.preparedByEmployeeId, companyId } }),
      voucher.checkedByEmployeeId !== null
        ? repos.tx.employee.findFirst({ where: { id: voucher.checkedByEmployeeId, companyId } })
        : Promise.resolve(null),
    ]);
    const total = voucher.lines.reduce((a, l) => a.add(new Decimal(l.amount)), ZERO);
    const addr = [
      company.regAddressLine1,
      company.regAddressLine2,
      company.regLocality,
      [company.regCity, company.regDistrict].filter(Boolean).join(', '),
      [company.regStateUt, company.regPin].filter(Boolean).join(' - '),
      company.regCountry,
    ]
      .filter((p) => p !== null && p !== '')
      .join(', ');
    return {
      companyName: company.legalName ?? company.tradeName ?? company.name,
      companyAddress: addr,
      voucherRef: `CV-${voucher.voucherNo.toString().padStart(6, '0')}`,
      date: voucher.date.toISOString().slice(0, 10),
      siteName: site.name,
      siteCode: site.code,
      paidTo: voucher.paidTo ?? '',
      totalAmount: total.toFixed(2),
      amountInWords: inrToWords(total),
      narration: voucher.narration ?? '',
      preparedBy: preparer?.displayName ?? '',
      checkedBy: checker?.displayName ?? '',
      lines: voucher.lines.map((l) => ({
        accountCode: l.accountCode,
        accountHeadName: l.accountHeadName,
        amount: new Decimal(l.amount).toFixed(2),
      })),
    };
  }

  /** Site-scoped Sarjan Cash Voucher PDF matching the printed voucher layout. */
  async printVoucherPdf(
    actor: ActorContext,
    companyId: string,
    siteId: string,
    voucherId: string,
  ): Promise<{ buffer: Buffer; fileName: string }> {
    return this.uow.run(async (repos) => {
      await this.assertSite(repos, actor, companyId, siteId, OPS.LEDGER_VIEW, SITE_WALLET_VIEW);
      const voucher = await this.voucherForSite(repos, companyId, siteId, voucherId);
      const data = await this.buildVoucherPdfData(repos, companyId, siteId, voucher);
      const buffer = await renderCashVoucherPdf(data);
      return { buffer, fileName: `${data.voucherRef}.pdf` };
    });
  }

  /** Finance-scoped Sarjan Cash Voucher PDF for any site wallet. */
  async printFinanceVoucherPdf(
    actor: ActorContext,
    companyId: string,
    walletId: string,
    voucherId: string,
  ): Promise<{ buffer: Buffer; fileName: string }> {
    return this.uow.run(async (repos) => {
      await this.assertFinance(repos, actor, companyId, FINANCE_WALLET_READ, OPS.LEDGER_VIEW);
      const voucher = await repos.tx.walletCashVoucher.findFirst({
        where: { id: voucherId, companyId, walletId },
        include: { lines: { orderBy: { lineNo: 'asc' } } },
      });
      if (voucher === null) throw new OrgEntityNotFoundError('WALLET_CASH_VOUCHER');
      const data = await this.buildVoucherPdfData(repos, companyId, voucher.siteId, voucher);
      const buffer = await renderCashVoucherPdf(data);
      return { buffer, fileName: `${data.voucherRef}.pdf` };
    });
  }

  private async buildTransferPdfBuffer(
    repos: WalletRepos,
    companyId: string,
    transfer: WalletTransfer,
  ): Promise<{ buffer: Buffer; fileName: string }> {
    const [company, site, request, recorder, confirmer] = await Promise.all([
      repos.tx.company.findFirstOrThrow({ where: { id: companyId } }),
      repos.tx.site.findFirstOrThrow({ where: { id: transfer.siteId, companyId } }),
      repos.tx.walletFundingRequest.findFirstOrThrow({
        where: { id: transfer.requestId, companyId },
      }),
      repos.tx.employee.findFirst({
        where: { companyId, principalId: transfer.recordedByPrincipalId },
        select: { displayName: true },
      }),
      transfer.confirmedByPrincipalId !== null
        ? repos.tx.employee.findFirst({
            where: { companyId, principalId: transfer.confirmedByPrincipalId },
            select: { displayName: true },
          })
        : Promise.resolve(null),
    ]);
    const addr = [
      company.regAddressLine1,
      company.regAddressLine2,
      company.regLocality,
      [company.regCity, company.regDistrict].filter(Boolean).join(', '),
      [company.regStateUt, company.regPin].filter(Boolean).join(' - '),
      company.regCountry,
    ]
      .filter((p) => p !== null && p !== '')
      .join(', ');
    const confirmedAmt = new Decimal(transfer.confirmedAmount);
    const effectiveAmt = confirmedAmt.gt(ZERO) ? confirmedAmt : new Decimal(transfer.amount);
    const receiptRef = `FR-${transfer.id.slice(0, 8).toUpperCase()}`;
    const buffer = await renderFundingReceiptPdf({
      companyName: company.legalName ?? company.tradeName ?? company.name,
      companyAddress: addr,
      receiptRef,
      date: (transfer.confirmedAt ?? transfer.transferredAt).toISOString().slice(0, 10),
      siteName: site.name,
      siteCode: site.code,
      transferReference: transfer.reference,
      purpose: request.draftPurpose ?? '',
      transferredAmount: new Decimal(transfer.amount).toFixed(2),
      confirmedAmount: confirmedAmt.toFixed(2),
      amountInWords: inrToWords(effectiveAmt),
      status: transfer.status,
      recordedBy: recorder?.displayName ?? '',
      confirmedBy: confirmer?.displayName ?? '',
    });
    return { buffer, fileName: `${receiptRef}.pdf` };
  }

  /** Site-scoped funding receipt PDF for a transfer. */
  async printTransferReceiptPdf(
    actor: ActorContext,
    companyId: string,
    siteId: string,
    transferId: string,
  ): Promise<{ buffer: Buffer; fileName: string }> {
    return this.uow.run(async (repos) => {
      await this.assertSite(repos, actor, companyId, siteId, OPS.LEDGER_VIEW, SITE_WALLET_VIEW);
      const transfer = await repos.tx.walletTransfer.findFirst({
        where: { id: transferId, companyId, siteId },
      });
      if (transfer === null) throw new OrgEntityNotFoundError('WALLET_TRANSFER');
      return this.buildTransferPdfBuffer(repos, companyId, transfer);
    });
  }

  /** Finance-scoped funding receipt PDF for a transfer. */
  async printFinanceTransferReceiptPdf(
    actor: ActorContext,
    companyId: string,
    transferId: string,
  ): Promise<{ buffer: Buffer; fileName: string }> {
    return this.uow.run(async (repos) => {
      await this.assertFinance(repos, actor, companyId, FINANCE_WALLET_READ, OPS.LEDGER_VIEW);
      const transfer = await repos.tx.walletTransfer.findFirst({
        where: { id: transferId, companyId },
      });
      if (transfer === null) throw new OrgEntityNotFoundError('WALLET_TRANSFER');
      return this.buildTransferPdfBuffer(repos, companyId, transfer);
    });
  }

  /** Server-rendered print document — company letterhead from the profile. */
  async printVoucher(
    actor: ActorContext,
    companyId: string,
    siteId: string,
    voucherId: string,
  ): Promise<string> {
    return this.uow.run(async (repos) => {
      await this.assertSite(repos, actor, companyId, siteId, OPS.LEDGER_VIEW, SITE_WALLET_VIEW);
      const voucher = await this.voucherForSite(repos, companyId, siteId, voucherId);
      const [company, site, expense, preparer] = await Promise.all([
        repos.tx.company.findFirstOrThrow({ where: { id: companyId } }),
        repos.tx.site.findFirstOrThrow({ where: { id: siteId, companyId } }),
        repos.tx.walletExpense.findFirstOrThrow({ where: { id: voucher.expenseId, companyId } }),
        repos.tx.employee.findFirst({ where: { id: voucher.preparedByEmployeeId, companyId } }),
      ]);
      const total = voucher.lines.reduce((a, l) => a.add(new Decimal(l.amount)), ZERO);
      const esc = (s: string | null | undefined) =>
        (s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
      const addr = [
        company.regAddressLine1,
        company.regAddressLine2,
        company.regLocality,
        [company.regCity, company.regDistrict].filter(Boolean).join(', '),
        [company.regStateUt, company.regPin].filter(Boolean).join(' - '),
        company.regCountry,
      ]
        .filter((p) => p !== null && p !== '')
        .join(', ');
      const rows = voucher.lines
        .map(
          (l) =>
            `<tr><td>${esc(l.accountCode)}</td><td>${esc(l.accountHeadName)}</td>` +
            `<td class="r">${new Decimal(l.amount).toFixed(2)}</td></tr>`,
        )
        .join('');
      const voucherRef = `CV-${voucher.voucherNo.toString().padStart(6, '0')}`;
      return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${voucherRef}</title>
<style>
@page { size: A5 landscape; margin: 12mm; }
body { font-family: "Segoe UI", Arial, sans-serif; font-size: 12px; color: #111; }
.head { text-align: center; border-bottom: 2px solid #333; padding-bottom: 6px; }
.head h1 { font-size: 16px; margin: 0; } .head .sub { font-size: 10px; }
table.meta { width: 100%; margin: 8px 0; border-collapse: collapse; }
table.meta td { padding: 2px 4px; }
table.lines { width: 100%; border-collapse: collapse; margin-top: 8px; }
table.lines th, table.lines td { border: 1px solid #555; padding: 4px 6px; }
table.lines td.r, table.lines th.r { text-align: right; }
.total { font-weight: bold; } .words { font-style: italic; margin-top: 6px; }
.sigs { display: flex; justify-content: space-between; margin-top: 48px; }
.sigs div { width: 30%; border-top: 1px solid #333; text-align: center; padding-top: 4px; font-size: 10px; }
</style></head><body>
<div class="head"><h1>${esc(company.legalName ?? company.tradeName ?? company.name)}</h1>
<div class="sub">${esc(addr)}</div><div><b>CASH VOUCHER</b></div></div>
<table class="meta"><tr>
<td><b>Voucher No:</b> ${voucherRef}</td>
<td><b>Date:</b> ${voucher.date.toISOString().slice(0, 10)}</td>
<td><b>Site:</b> ${esc(site.name)} (${esc(site.code)})</td></tr>
<tr><td colspan="2"><b>Paid to:</b> ${esc(voucher.paidTo)}</td>
<td><b>Ref:</b> ${esc(expense.reference)}</td></tr></table>
<table class="lines"><thead><tr><th>Account Code</th><th>Account Head</th><th class="r">Amount (INR)</th></tr></thead>
<tbody>${rows}<tr class="total"><td colspan="2">Total</td><td class="r">${total.toFixed(2)}</td></tr></tbody></table>
<div class="words">${esc(inrToWords(total))}</div>
<div><b>Narration:</b> ${esc(voucher.narration)}</div>
<div class="sigs"><div>Prepared By<br>${esc(preparer?.displayName ?? '')}</div>
<div>Checked By</div><div>Receiver Sign</div></div>
</body></html>`;
    });
  }

  /** Attach the receiver-signed scan — once; validate via document rules. */
  async attachSignedVoucherDocument(
    actor: ActorContext,
    companyId: string,
    siteId: string,
    voucherId: string,
    documentId: string,
  ) {
    return this.uow.run(async (repos) => {
      await this.assertSite(repos, actor, companyId, siteId, OPS.EXPENSE_SUBMIT);
      const chain = await this.siteChain(repos, companyId, siteId);
      await this.assertProjectIncharge(repos, actor, companyId, chain);
      const voucher = await this.voucherForSite(repos, companyId, siteId, voucherId);
      if (voucher.signedDocumentId !== null) {
        throw new WalletStateError('voucher already has a signed document');
      }
      await this.validateExpenseDocuments(repos, companyId, chain, [documentId]);
      const updated = await repos.tx.walletCashVoucher.update({
        where: { id: voucher.id, companyId },
        data: { signedDocumentId: documentId, signedAt: new Date(), version: { increment: 1 } },
      });
      try {
        await repos.tx.documentLink.create({
          data: {
            companyId,
            documentId,
            entityType: 'WALLET_VOUCHER',
            walletVoucherId: voucher.id,
            linkedByPrincipalId: actor.actorId,
          },
        });
      } catch (e) {
        mapOrgWriteError(e, 'DOCUMENT_LINK');
      }
      await repos.audit.record(
        auditEntry(actor, {
          action: 'WALLET_VOUCHER_SIGNED',
          entityType: 'WALLET_CASH_VOUCHER',
          entityId: voucher.id,
          companyId,
          changedFields: { signedDocumentId: { before: null, after: documentId } },
        }),
      );
      await repos.outbox.record({
        companyId,
        eventType: 'WALLET_VOUCHER_SIGNED',
        aggregateType: 'WALLET_CASH_VOUCHER',
        aggregateId: voucher.id,
        eventKey: randomUUID(),
        recipientPrincipalIds: await this.siteRecipients(repos, companyId, chain),
        summary: { siteId, voucherNo: voucher.voucherNo.toString() },
      });
      return serializeVoucher(updated);
    });
  }

  /** Optional supporting evidence on ANY wallet ledger transaction. */
  async attachLedgerDocument(
    actor: ActorContext,
    companyId: string,
    siteId: string,
    entryId: string,
    documentId: string,
  ) {
    return this.uow.run(async (repos) => {
      await this.assertSite(repos, actor, companyId, siteId, OPS.EXPENSE_SUBMIT);
      const chain = await this.siteChain(repos, companyId, siteId);
      await this.assertProjectIncharge(repos, actor, companyId, chain);
      const wallet = await this.walletForSite(repos, companyId, siteId);
      const entry = await repos.tx.walletLedgerEntry.findFirst({
        where: { id: entryId, companyId, walletId: wallet.id },
      });
      if (entry === null) throw new OrgEntityNotFoundError('WALLET_LEDGER_ENTRY');
      await this.validateExpenseDocuments(repos, companyId, chain, [documentId]);
      let link;
      try {
        link = await repos.tx.documentLink.create({
          data: {
            companyId,
            documentId,
            entityType: 'WALLET_LEDGER_ENTRY',
            walletLedgerEntryId: entry.id,
            linkedByPrincipalId: actor.actorId,
          },
        });
      } catch (e) {
        mapOrgWriteError(e, 'DOCUMENT_LINK');
      }
      await repos.audit.record(
        auditEntry(actor, {
          action: 'WALLET_DOCUMENT_LINKED',
          entityType: 'DOCUMENT_LINK',
          entityId: link.id,
          companyId,
          changedFields: {
            documentId: { before: null, after: documentId },
            ledgerEntryId: { before: null, after: entry.id },
          },
        }),
      );
      await repos.outbox.record({
        companyId,
        eventType: 'WALLET_DOCUMENT_LINKED',
        aggregateType: 'WALLET_LEDGER_ENTRY',
        aggregateId: entry.id,
        eventKey: randomUUID(),
        recipientPrincipalIds: await this.siteRecipients(repos, companyId, chain),
        summary: { siteId },
      });
      return link;
    });
  }

  // ------------------------------------------------------------ reversals

  async requestReversal(
    actor: ActorContext,
    companyId: string,
    siteId: string,
    entryId: string,
    input: ReversalRequestInput,
  ) {
    return this.uow.run(async (repos) => {
      await this.assertSite(repos, actor, companyId, siteId, OPS.RETURN_FUNDS);
      const chain = await this.siteChain(repos, companyId, siteId);
      await this.assertProjectIncharge(repos, actor, companyId, chain);
      const wallet = await this.walletForSite(repos, companyId, siteId);
      const entry = await repos.tx.walletLedgerEntry.findFirst({
        where: { id: entryId, companyId, walletId: wallet.id },
      });
      if (entry === null) throw new OrgEntityNotFoundError('WALLET_LEDGER_ENTRY');
      if (entry.type === 'REVERSAL_DEBIT' || entry.type === 'REVERSAL_CREDIT') {
        throw new WalletStateError('reversal entries cannot be reversed');
      }
      const employee = await this.employeeFor(repos, companyId, actor.actorId);
      const replay = await repos.tx.walletReversalRequest.findFirst({
        where: {
          companyId,
          requestedByPrincipalId: actor.actorId,
          idempotencyKey: input.idempotencyKey,
        },
      });
      if (replay !== null) {
        if (replay.ledgerEntryId !== entryId)
          throw new IdempotencyConflictError(input.idempotencyKey);
        return { reversalRequest: replay, replayed: true };
      }
      let rr;
      try {
        rr = await repos.tx.walletReversalRequest.create({
          data: {
            companyId,
            walletId: wallet.id,
            siteId,
            ledgerEntryId: entry.id,
            reason: input.reason,
            requestedByPrincipalId: actor.actorId,
            requestedByEmployeeId: employee.id,
            idempotencyKey: input.idempotencyKey,
          },
        });
      } catch (e) {
        mapOrgWriteError(e, 'WALLET_REVERSAL_REQUEST');
      }
      await repos.audit.record(
        auditEntry(actor, {
          action: 'WALLET_REVERSAL_REQUESTED',
          entityType: 'WALLET_REVERSAL_REQUEST',
          entityId: rr.id,
          companyId,
          statusAfter: 'REQUESTED',
          changedFields: { ledgerEntryId: { before: null, after: entry.id } },
        }),
      );
      await repos.outbox.record({
        companyId,
        eventType: 'WALLET_REVERSAL_REQUESTED',
        aggregateType: 'WALLET_REVERSAL_REQUEST',
        aggregateId: rr.id,
        eventKey: randomUUID(),
        recipientPrincipalIds: await this.siteRecipients(repos, companyId, chain),
        summary: { siteId, status: 'REQUESTED' },
      });
      return { reversalRequest: rr, replayed: false };
    });
  }

  async listReversalRequests(
    actor: ActorContext,
    companyId: string,
    filter: Page & { status?: string },
  ) {
    return this.uow.run(async (repos) => {
      await this.assertFinance(repos, actor, companyId, FINANCE_WALLET_READ, OPS.RECONCILE);
      const limit = Math.min(filter.limit ?? 50, MAX_LIMIT);
      const rows = await repos.tx.walletReversalRequest.findMany({
        where: {
          companyId,
          ...(filter.status !== undefined
            ? { status: filter.status as 'REQUESTED' | 'EXECUTED' | 'REJECTED' }
            : {}),
          ...(filter.cursor !== undefined ? { id: { gt: filter.cursor } } : {}),
        },
        orderBy: { id: 'asc' },
        take: limit + 1,
      });
      const items = rows.slice(0, limit);
      const nextCursor = rows.length > limit ? items[items.length - 1]?.id : undefined;
      return { items, ...(nextCursor !== undefined ? { nextCursor } : {}) };
    });
  }

  /**
   * Finance executes a FULL reversal — never an edit. Reversing a funding
   * credit needs sufficient balance; reversing an expense debit credits back.
   * At most one reversal per entry (schema unique on reversalOfEntryId).
   */
  async executeReversal(
    actor: ActorContext,
    companyId: string,
    entryId: string,
    input: ReverseExecuteInput,
  ) {
    return this.uow.run(async (repos) => {
      await this.assertFinance(repos, actor, companyId, FINANCE_WALLET_MANAGE, OPS.RECONCILE);
      const original = await repos.tx.walletLedgerEntry.findFirst({
        where: { id: entryId, companyId },
      });
      if (original === null) throw new OrgEntityNotFoundError('WALLET_LEDGER_ENTRY');
      const walletRow = await repos.tx.siteWallet.findFirstOrThrow({
        where: { id: original.walletId, companyId },
        select: { siteId: true },
      });
      const chain = await this.siteChain(repos, companyId, walletRow.siteId);
      return this.executeReversalTx(repos, actor, companyId, original, input, chain);
    });
  }

  private async executeReversalTx(
    repos: WalletRepos,
    actor: ActorContext,
    companyId: string,
    original: WalletLedgerEntry,
    input: ReverseExecuteInput,
    chain: ScopeChain,
  ) {
    const prior = await repos.tx.walletLedgerEntry.findFirst({
      where: { companyId, walletId: original.walletId, idempotencyKey: input.idempotencyKey },
    });
    if (prior !== null) return { entry: serializeLedgerEntry(prior), replayed: true };
    if (original.type === 'REVERSAL_DEBIT' || original.type === 'REVERSAL_CREDIT') {
      throw new WalletStateError('reversal entries cannot be reversed');
    }
    const existing = await repos.tx.walletLedgerEntry.findFirst({
      where: { reversalOfEntryId: original.id },
    });
    if (existing !== null) {
      throw new WalletStateError('entry already reversed');
    }
    const wallet = await lockWallet(repos.tx, companyId, original.walletId);
    if (wallet === null) throw new OrgEntityNotFoundError('SITE_WALLET');
    const isCreditReversal = original.type === 'CREDIT_FUNDING';
    const reversalType = isCreditReversal ? 'REVERSAL_DEBIT' : 'REVERSAL_CREDIT';
    const balanceAfter = isCreditReversal
      ? new Decimal(wallet.balance).sub(original.amount)
      : new Decimal(wallet.balance).add(original.amount);
    if (balanceAfter.lt(ZERO)) throw new InsufficientWalletBalanceError();
    const entry = await repos.tx.walletLedgerEntry.create({
      data: {
        companyId,
        walletId: original.walletId,
        type: reversalType,
        amount: original.amount,
        currency: INR,
        balanceAfter,
        reversalOfEntryId: original.id,
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
        postedByPrincipalId: actor.actorId,
        idempotencyKey: input.idempotencyKey,
      },
    });
    // Roll the source domain state back — full reversal, exactly once.
    if (original.expenseId !== null) {
      await repos.tx.walletExpense.updateMany({
        where: { id: original.expenseId, companyId, status: 'POSTED' },
        data: { status: 'REVERSED' },
      });
    }
    if (original.transferId !== null) {
      await repos.tx.walletTransfer.updateMany({
        where: { id: original.transferId, companyId },
        data: { status: 'REVERSED', version: { increment: 1 } },
      });
    }
    if (original.fundingRequestId !== null) {
      const request = await repos.tx.walletFundingRequest.findFirstOrThrow({
        where: { id: original.fundingRequestId, companyId },
      });
      const newConfirmed = new Decimal(request.confirmedAmount).sub(original.amount);
      const status =
        request.status === 'FUNDED' && newConfirmed.lt(request.approvedAmount ?? ZERO)
          ? 'PARTIALLY_FUNDED'
          : request.status;
      await repos.tx.walletFundingRequest.update({
        where: { id: request.id, companyId },
        data: {
          confirmedAmount: newConfirmed.lt(ZERO) ? ZERO : newConfirmed,
          status,
          version: { increment: 1 },
        },
      });
    }
    if (input.reversalRequestId !== undefined) {
      const rr = await repos.tx.walletReversalRequest.findFirst({
        where: {
          id: input.reversalRequestId,
          companyId,
          ledgerEntryId: original.id,
          status: 'REQUESTED',
        },
      });
      if (rr === null) throw new OrgEntityNotFoundError('WALLET_REVERSAL_REQUEST');
      await repos.tx.walletReversalRequest.update({
        where: { id: rr.id, companyId },
        data: {
          status: 'EXECUTED',
          decidedByPrincipalId: actor.actorId,
          decidedAt: new Date(),
          reversalEntryId: entry.id,
          version: { increment: 1 },
        },
      });
    }
    await repos.audit.record(
      auditEntry(actor, {
        action: 'WALLET_ENTRY_REVERSED',
        entityType: 'WALLET_LEDGER_ENTRY',
        entityId: entry.id,
        companyId,
        changedFields: {
          reversalOfEntryId: { before: null, after: original.id },
          type: { before: null, after: reversalType },
          amount: { before: null, after: new Decimal(original.amount).toFixed(2) },
        },
      }),
    );
    const site = await repos.tx.siteWallet.findFirstOrThrow({
      where: { id: original.walletId, companyId },
      select: { siteId: true },
    });
    await repos.outbox.record({
      companyId,
      eventType: 'WALLET_ENTRY_REVERSED',
      aggregateType: 'WALLET_LEDGER_ENTRY',
      aggregateId: entry.id,
      eventKey: randomUUID(),
      recipientPrincipalIds: await this.siteRecipients(repos, companyId, chain),
      summary: { siteId: site.siteId, type: reversalType },
    });
    return { entry: serializeLedgerEntry(entry), replayed: false };
  }

  // --------------------------------------------------------- account heads

  async createAccountHead(
    actor: ActorContext,
    companyId: string,
    input: AccountHeadCreateInput,
  ): Promise<WalletAccountHead> {
    return this.uow.run(async (repos) => {
      await this.assertFinance(repos, actor, companyId, FINANCE_WALLET_MANAGE, OPS.EXPENSE_REVIEW);
      let head: WalletAccountHead;
      try {
        head = await repos.tx.walletAccountHead.create({
          data: { companyId, code: input.code.trim(), name: input.name },
        });
      } catch (e) {
        mapOrgWriteError(e, 'WALLET_ACCOUNT_HEAD');
      }
      await repos.audit.record(
        auditEntry(actor, {
          action: 'WALLET_ACCOUNT_HEAD_CREATED',
          entityType: 'WALLET_ACCOUNT_HEAD',
          entityId: head.id,
          companyId,
          statusAfter: head.status,
          changedFields: { code: { before: null, after: head.code } },
        }),
      );
      return head;
    });
  }

  async listSiteAccountHeads(
    actor: ActorContext,
    companyId: string,
    siteId: string,
    filter: Page & { status?: string },
  ) {
    return this.uow.run(async (repos) => {
      await this.assertSite(repos, actor, companyId, siteId, OPS.EXPENSE_SUBMIT, SITE_WALLET_VIEW);
      return this.listAccountHeadsTx(repos, companyId, filter);
    });
  }

  async listFinanceAccountHeads(
    actor: ActorContext,
    companyId: string,
    filter: Page & { status?: string },
  ) {
    return this.uow.run(async (repos) => {
      await this.assertFinance(repos, actor, companyId, FINANCE_WALLET_READ, OPS.EXPENSE_REVIEW);
      return this.listAccountHeadsTx(repos, companyId, filter);
    });
  }

  private async listAccountHeadsTx(
    repos: WalletRepos,
    companyId: string,
    filter: Page & { status?: string },
  ) {
    const limit = Math.min(filter.limit ?? 50, MAX_LIMIT);
    const rows = await repos.tx.walletAccountHead.findMany({
      where: {
        companyId,
        ...(filter.status !== undefined ? { status: filter.status as 'ACTIVE' | 'INACTIVE' } : {}),
        ...(filter.cursor !== undefined ? { id: { gt: filter.cursor } } : {}),
      },
      orderBy: [{ code: 'asc' }, { id: 'asc' }],
      take: limit + 1,
    });
    const items = rows.slice(0, limit);
    const nextCursor = rows.length > limit ? items[items.length - 1]?.id : undefined;
    return { items, ...(nextCursor !== undefined ? { nextCursor } : {}) };
  }

  async updateAccountHead(
    actor: ActorContext,
    companyId: string,
    accountHeadId: string,
    input: AccountHeadUpdateInput,
  ) {
    return this.uow.run(async (repos) => {
      await this.assertFinance(repos, actor, companyId, FINANCE_WALLET_MANAGE, OPS.EXPENSE_REVIEW);
      const head = await repos.tx.walletAccountHead.findFirst({
        where: { id: accountHeadId, companyId },
      });
      if (head === null) throw new OrgEntityNotFoundError('WALLET_ACCOUNT_HEAD');
      const res = await repos.tx.walletAccountHead.updateMany({
        where: { id: head.id, companyId, version: input.expectedVersion },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          version: { increment: 1 },
        },
      });
      if (res.count === 0) throw new VersionConflictError('WALLET_ACCOUNT_HEAD');
      const updated = await repos.tx.walletAccountHead.findFirstOrThrow({
        where: { id: head.id, companyId },
      });
      await repos.audit.record(
        auditEntry(actor, {
          action: 'WALLET_ACCOUNT_HEAD_UPDATED',
          entityType: 'WALLET_ACCOUNT_HEAD',
          entityId: head.id,
          companyId,
          changedFields: {
            ...(input.name !== undefined ? { name: { before: head.name, after: input.name } } : {}),
            ...(input.status !== undefined
              ? { status: { before: head.status, after: input.status } }
              : {}),
          },
        }),
      );
      return updated;
    });
  }
}
