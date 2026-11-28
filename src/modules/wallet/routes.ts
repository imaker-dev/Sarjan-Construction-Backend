import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Type } from '@sinclair/typebox';
import { UnauthorizedError } from '../../common/errors/app-error.js';
import type { ScopeTarget } from '../access-control/service.js';
import type { ActorContext } from '../organization/types.js';
import {
  FINANCE_WALLET_MANAGE,
  FINANCE_WALLET_READ,
  SITE_WALLET_MANAGE,
  SITE_WALLET_VIEW,
} from './types.js';
import type { WalletService } from './service.js';

const actorOf = (r: FastifyRequest): ActorContext => ({
  actorId: (r.principal as { actorId: string }).actorId,
  actorType: 'USER',
});

const companyIdOf = (r: FastifyRequest): string => {
  const c = r.headers['x-company-id'];
  if (typeof c !== 'string' || c.length === 0) {
    throw new UnauthorizedError('COMPANY_REQUIRED', 'x-company-id header required');
  }
  return c;
};

const atCompany = (r: FastifyRequest): ScopeTarget => {
  const companyId = companyIdOf(r);
  return { companyId, scopeType: 'COMPANY', scopeId: companyId };
};

const atSite = (r: FastifyRequest): ScopeTarget => {
  const companyId = companyIdOf(r);
  const { siteId } = r.params as { siteId: string };
  return { companyId, scopeType: 'SITE', scopeId: siteId };
};

const Uuid = Type.String({ format: 'uuid' });
const Money = Type.String({
  pattern: '^\\d{1,16}(\\.\\d{1,2})?$',
  description: 'Positive decimal INR amount with ≤ 2 paise digits — never a float',
});
const MoneyOrZero = Type.String({
  pattern: '^\\d{1,16}(\\.\\d{1,2})?$',
  description: 'Non-negative decimal INR amount — 0.00 allowed for zero-receipt disputes',
});
const IsoDate = Type.String({ format: 'date', description: 'ISO calendar date YYYY-MM-DD' });
const IsoDateTime = Type.String({ format: 'date-time' });
const IdemKey = Type.String({ minLength: 1, maxLength: 80 });
const PageQuery = {
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  cursor: Type.Optional(Type.String({ maxLength: 64 })),
  offset: Type.Optional(Type.Integer({ minimum: 0 })),
  page: Type.Optional(Type.Integer({ minimum: 1 })),
  q: Type.Optional(Type.String({ maxLength: 100 })),
};

const SiteParams = Type.Object({ siteId: Uuid });
const RequestParams = Type.Object({ siteId: Uuid, requestId: Uuid });
const FinanceRequestParams = Type.Object({ requestId: Uuid });
const WalletParams = Type.Object({ walletId: Uuid });
const TransferParams = Type.Object({ siteId: Uuid, transferId: Uuid });
const FinanceTransferParams = Type.Object({ transferId: Uuid });
const ExpenseParams = Type.Object({ siteId: Uuid, expenseId: Uuid });
const VoucherParams = Type.Object({ siteId: Uuid, voucherId: Uuid });
const FinanceVoucherParams = Type.Object({ walletId: Uuid, voucherId: Uuid });
const EntryParams = Type.Object({ siteId: Uuid, entryId: Uuid });
const FinanceEntryParams = Type.Object({ entryId: Uuid });
const AccountHeadParams = Type.Object({ accountHeadId: Uuid });

const FundingCreateBody = Type.Object(
  {
    amount: Money,
    purpose: Type.String({ minLength: 1, maxLength: 500 }),
    neededByDate: Type.Optional(IsoDate),
    currency: Type.Optional(
      Type.Literal('INR', { description: 'INR only — any other value is rejected' }),
    ),
    idempotencyKey: IdemKey,
  },
  { additionalProperties: false },
);

const FundingUpdateBody = Type.Object(
  {
    amount: Type.Optional(Money),
    purpose: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
    neededByDate: Type.Optional(Type.Union([IsoDate, Type.Null()])),
    expectedVersion: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

const SubmitBody = Type.Object({ idempotencyKey: IdemKey }, { additionalProperties: false });

const TransferBody = Type.Object(
  {
    amount: Money,
    reference: Type.String({
      minLength: 1,
      maxLength: 120,
      description: 'UTR / voucher / cheque ref',
    }),
    transferredAt: Type.Optional(IsoDateTime),
    idempotencyKey: IdemKey,
  },
  { additionalProperties: false },
);

const ConfirmBody = Type.Object(
  {
    receivedAmount: MoneyOrZero,
    discrepancyNote: Type.Optional(Type.String({ maxLength: 500 })),
    idempotencyKey: IdemKey,
  },
  { additionalProperties: false },
);

const ResolveDisputeBody = Type.Object(
  {
    resolution: Type.Union([Type.Literal('ACKNOWLEDGED'), Type.Literal('SUPPLEMENTARY_PENDING')]),
    note: Type.String({ minLength: 1, maxLength: 500 }),
    idempotencyKey: IdemKey,
  },
  { additionalProperties: false },
);

const CloseShortBody = Type.Object(
  { reason: Type.String({ minLength: 1, maxLength: 500 }), idempotencyKey: IdemKey },
  { additionalProperties: false },
);

const ReduceApprovedAmountBody = Type.Object(
  {
    approvedAmount: Money,
    reason: Type.String({ minLength: 1, maxLength: 500 }),
    expectedVersion: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

const CancelTransferBody = Type.Object(
  {
    reason: Type.String({ minLength: 1, maxLength: 500 }),
    expectedVersion: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

const AccountLine = Type.Object(
  { accountHeadId: Uuid, amount: Money },
  { additionalProperties: false },
);

const ExpenseBody = Type.Object(
  {
    amount: Money,
    expenseDate: IsoDate,
    description: Type.String({ minLength: 1, maxLength: 500 }),
    payee: Type.Optional(Type.String({ maxLength: 200 })),
    reference: Type.Optional(Type.String({ maxLength: 120 })),
    accountLines: Type.Array(AccountLine, { minItems: 1, maxItems: 50 }),
    documentIds: Type.Optional(Type.Array(Uuid, { maxItems: 20 })),
    voucher: Type.Optional(
      Type.Object(
        {
          paidTo: Type.Optional(Type.String({ maxLength: 200 })),
          narration: Type.Optional(Type.String({ maxLength: 500 })),
        },
        { additionalProperties: false },
      ),
    ),
    idempotencyKey: IdemKey,
  },
  { additionalProperties: false },
);

const AccountHeadCreateBody = Type.Object(
  {
    code: Type.String({ minLength: 1, maxLength: 20 }),
    name: Type.String({ minLength: 1, maxLength: 120 }),
  },
  { additionalProperties: false },
);

const AccountHeadUpdateBody = Type.Object(
  {
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
    status: Type.Optional(Type.Union([Type.Literal('ACTIVE'), Type.Literal('INACTIVE')])),
    expectedVersion: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

const DocumentBody = Type.Object({ documentId: Uuid }, { additionalProperties: false });

const ReversalRequestBody = Type.Object(
  { reason: Type.String({ minLength: 1, maxLength: 500 }), idempotencyKey: IdemKey },
  { additionalProperties: false },
);

const ReverseBody = Type.Object(
  {
    reason: Type.Optional(Type.String({ maxLength: 500 })),
    reversalRequestId: Type.Optional(Uuid),
    idempotencyKey: IdemKey,
  },
  { additionalProperties: false },
);

const WalletTag = { tags: ['site-wallet'] } as const;

/**
 * PI Site Wallet & Finance Funding surface — /api/v1.
 *
 * Money contract: every amount is a decimal INR string ("1250.00"); the wallet
 * is created and stays INR. Wallet balance changes at exactly one point in the
 * funding lifecycle: when the PI confirms receipt of a Finance-recorded
 * transfer. Approval and transfer recording never move money. Expenses debit
 * immediately at post time; corrections are full ledger reversals only.
 */
export function walletRoutes(service: WalletService) {
  return async function routes(app: FastifyInstance) {
    const siteView = {
      preHandler: [
        app.authenticate,
        app.tenantCompanyGuard,
        app.requirePermission(SITE_WALLET_VIEW, atSite),
      ],
    };
    const siteManage = {
      preHandler: [
        app.authenticate,
        app.tenantCompanyGuard,
        app.requirePermission(SITE_WALLET_MANAGE, atSite),
      ],
    };
    const finRead = {
      preHandler: [
        app.authenticate,
        app.tenantCompanyGuard,
        app.requirePermission(FINANCE_WALLET_READ, atCompany),
      ],
    };
    const finManage = {
      preHandler: [
        app.authenticate,
        app.tenantCompanyGuard,
        app.requirePermission(FINANCE_WALLET_MANAGE, atCompany),
      ],
    };

    // ------------------------------------------------------------ wallet setup

    app.post(
      '/finance/sites/:siteId/wallet',
      {
        ...finManage,
        schema: {
          ...WalletTag,
          params: SiteParams,
          body: Type.Object({}, { additionalProperties: false }),
          summary: 'Create the site wallet (INR) — idempotent, returns existing on repeat',
          description:
            'Finance creates the single wallet for a site. A repeated call safely returns the ' +
            'existing wallet (replayed: true). Currency is fixed to INR server-side.',
        },
      },
      async (request, reply) => {
        const { siteId } = request.params as { siteId: string };
        const r = await service.createSiteWallet(actorOf(request), companyIdOf(request), siteId);
        return reply.code(r.replayed ? 200 : 201).send(r);
      },
    );

    app.get(
      '/sites/:siteId/wallet',
      {
        ...siteView,
        schema: {
          ...WalletTag,
          params: SiteParams,
          summary: 'PI/PD view of site wallet balance, status, and pending funding summary',
        },
      },
      async (request) =>
        service.getSiteWallet(
          actorOf(request),
          companyIdOf(request),
          (request.params as { siteId: string }).siteId,
        ),
    );

    app.get(
      '/finance/wallets',
      {
        ...finRead,
        schema: {
          ...WalletTag,
          querystring: Type.Object({ ...PageQuery }, { additionalProperties: false }),
          summary: 'Finance company-wide wallet list',
        },
      },
      async (request) =>
        service.listFinanceWallets(
          actorOf(request),
          companyIdOf(request),
          request.query as { cursor?: string; limit?: number },
        ),
    );

    app.get(
      '/finance/wallets/:walletId',
      {
        ...finRead,
        schema: {
          ...WalletTag,
          params: WalletParams,
          summary: 'Finance wallet detail',
        },
      },
      async (request) =>
        service.getFinanceWallet(
          actorOf(request),
          companyIdOf(request),
          (request.params as { walletId: string }).walletId,
        ),
    );

    // ---------------------------------------------------------------- ledger

    const LedgerQuery = Type.Object(
      {
        ...PageQuery,
        from: Type.Optional(IsoDateTime),
        to: Type.Optional(IsoDateTime),
        type: Type.Optional(
          Type.Union(
            (['CREDIT_FUNDING', 'DEBIT_EXPENSE', 'REVERSAL_DEBIT', 'REVERSAL_CREDIT'] as const).map(
              (t) => Type.Literal(t),
            ),
          ),
        ),
      },
      { additionalProperties: false },
    );

    app.get(
      '/sites/:siteId/wallet/ledger',
      {
        ...siteView,
        schema: {
          ...WalletTag,
          params: SiteParams,
          querystring: LedgerQuery,
          summary: 'Scoped cursor-paginated wallet ledger (seq-desc; cursor = last seen seq)',
        },
      },
      async (request) => {
        const { siteId } = request.params as { siteId: string };
        return service.listSiteLedger(
          actorOf(request),
          companyIdOf(request),
          siteId,
          request.query as {
            cursor?: string;
            limit?: number;
            from?: string;
            to?: string;
            type?: string;
          },
        );
      },
    );

    app.get(
      '/finance/wallets/:walletId/ledger',
      {
        ...finRead,
        schema: {
          ...WalletTag,
          params: WalletParams,
          querystring: LedgerQuery,
          summary: 'Finance ledger view — same append-only ledger, cursor = seq',
        },
      },
      async (request) =>
        service.listFinanceLedger(
          actorOf(request),
          companyIdOf(request),
          (request.params as { walletId: string }).walletId,
          request.query as {
            cursor?: string;
            limit?: number;
            from?: string;
            to?: string;
            type?: string;
          },
        ),
    );

    app.get(
      '/sites/:siteId/wallet/reports',
      {
        ...siteView,
        schema: {
          ...WalletTag,
          params: SiteParams,
          querystring: Type.Object(
            { from: Type.Optional(IsoDateTime), to: Type.Optional(IsoDateTime) },
            { additionalProperties: false },
          ),
          summary: 'Wallet report — balance and ledger totals grouped by entry type',
        },
      },
      async (request) =>
        service.siteWalletReport(
          actorOf(request),
          companyIdOf(request),
          (request.params as { siteId: string }).siteId,
          request.query as { from?: string; to?: string },
        ),
    );

    app.get(
      '/finance/wallets/reports',
      {
        ...finRead,
        schema: {
          ...WalletTag,
          querystring: Type.Object(
            {
              projectId: Type.Optional(Uuid),
              siteId: Type.Optional(Uuid),
              from: Type.Optional(IsoDateTime),
              to: Type.Optional(IsoDateTime),
              ...PageQuery,
            },
            { additionalProperties: false },
          ),
          summary: 'Finance detailed report across all site wallets',
        },
      },
      async (request) =>
        service.financeWalletsReport(
          actorOf(request),
          companyIdOf(request),
          request.query as {
            projectId?: string;
            siteId?: string;
            from?: string;
            to?: string;
            cursor?: string;
            limit?: number;
          },
        ),
    );

    app.get(
      '/finance/wallets/:walletId/reports',
      {
        ...finRead,
        schema: {
          ...WalletTag,
          params: WalletParams,
          querystring: Type.Object(
            { from: Type.Optional(IsoDateTime), to: Type.Optional(IsoDateTime) },
            { additionalProperties: false },
          ),
          summary: 'Finance detailed report for a single site wallet (includes account-head breakdown)',
        },
      },
      async (request) =>
        service.financeWalletReport(
          actorOf(request),
          companyIdOf(request),
          (request.params as { walletId: string }).walletId,
          request.query as { from?: string; to?: string },
        ),
    );

    // ------------------------------------------------------ PI funding requests

    const FundingStatusQuery = Type.Object(
      {
        status: Type.Optional(
          Type.Union(
            (
              [
                'DRAFT',
                'SUBMITTED',
                'APPROVED',
                'REJECTED',
                'RETURNED',
                'PARTIALLY_FUNDED',
                'FUNDED',
                'CLOSED_SHORT',
                'CANCELLED',
              ] as const
            ).map((s) => Type.Literal(s)),
          ),
        ),
        ...PageQuery,
      },
      { additionalProperties: false },
    );

    app.post(
      '/sites/:siteId/wallet/funding-requests',
      {
        ...siteManage,
        schema: {
          ...WalletTag,
          params: SiteParams,
          body: FundingCreateBody,
          summary: 'PI creates a draft funding request (INR)',
          description:
            'Creates a DRAFT envelope. The amount/purpose are editable until submit, when they ' +
            'are snapshotted into an immutable attempt. Idempotent by idempotencyKey per requester.',
        },
      },
      async (request, reply) => {
        const { siteId } = request.params as { siteId: string };
        const r = await service.createFundingRequest(
          actorOf(request),
          companyIdOf(request),
          siteId,
          request.body as never,
        );
        return reply.code(r.replayed ? 200 : 201).send(r);
      },
    );

    app.patch(
      '/sites/:siteId/wallet/funding-requests/:requestId',
      {
        ...siteManage,
        schema: {
          ...WalletTag,
          params: RequestParams,
          body: FundingUpdateBody,
          summary: 'Edit a DRAFT or RETURNED request — expectedVersion required',
        },
      },
      async (request) => {
        const p = request.params as { siteId: string; requestId: string };
        return service.updateFundingRequest(
          actorOf(request),
          companyIdOf(request),
          p.siteId,
          p.requestId,
          request.body as never,
        );
      },
    );

    app.post(
      '/sites/:siteId/wallet/funding-requests/:requestId/submit',
      {
        ...siteManage,
        schema: {
          ...WalletTag,
          params: RequestParams,
          body: SubmitBody,
          summary: 'Submit — creates an immutable numbered attempt + approval workflow instance',
          description:
            'Creates a new WalletFundingAttempt (attemptNo increments on resubmit after RETURN), ' +
            'pins a fresh workflow instance, and opens the Finance approval task. Idempotent.',
        },
      },
      async (request, reply) => {
        const p = request.params as { siteId: string; requestId: string };
        const r = await service.submitFundingRequest(
          actorOf(request),
          companyIdOf(request),
          p.siteId,
          p.requestId,
          request.body as { idempotencyKey: string },
        );
        return reply.code(r.replayed ? 200 : 201).send(r);
      },
    );

    app.post(
      '/sites/:siteId/wallet/funding-requests/:requestId/cancel',
      {
        ...siteManage,
        schema: {
          ...WalletTag,
          params: RequestParams,
          body: Type.Object({}, { additionalProperties: false }),
          summary: 'Cancel — allowed only while DRAFT or RETURNED',
        },
      },
      async (request) => {
        const p = request.params as { siteId: string; requestId: string };
        return service.cancelFundingRequest(
          actorOf(request),
          companyIdOf(request),
          p.siteId,
          p.requestId,
        );
      },
    );

    app.get(
      '/sites/:siteId/wallet/funding-requests',
      {
        ...siteView,
        schema: {
          ...WalletTag,
          params: SiteParams,
          querystring: FundingStatusQuery,
          summary: 'PI site funding-request list',
        },
      },
      async (request) =>
        service.listSiteFundingRequests(
          actorOf(request),
          companyIdOf(request),
          (request.params as { siteId: string }).siteId,
          request.query as { status?: string; cursor?: string; limit?: number },
        ),
    );

    app.get(
      '/sites/:siteId/wallet/funding-requests/:requestId',
      {
        ...siteView,
        schema: {
          ...WalletTag,
          params: RequestParams,
          summary: 'Request detail — status, attempts, transfers, linked evidence',
        },
      },
      async (request) => {
        const p = request.params as { siteId: string; requestId: string };
        return service.getFundingRequest(
          actorOf(request),
          companyIdOf(request),
          p.siteId,
          p.requestId,
        );
      },
    );

    app.get(
      '/sites/:siteId/wallet/funding-requests/:requestId/attempts',
      {
        ...siteView,
        schema: {
          ...WalletTag,
          params: RequestParams,
          summary: 'Complete immutable attempt history — every submit, decision, workflow instance',
        },
      },
      async (request) => {
        const p = request.params as { siteId: string; requestId: string };
        return service.listAttempts(actorOf(request), companyIdOf(request), p.siteId, p.requestId);
      },
    );

    // ------------------------------------------------- Finance funding queue

    const FinanceQueueQuery = Type.Object(
      {
        status: Type.Optional(FundingStatusQuery.properties.status),
        siteId: Type.Optional(Uuid),
        projectId: Type.Optional(Uuid),
        ...PageQuery,
      },
      { additionalProperties: false },
    );

    app.get(
      '/finance/wallet-funding-requests',
      {
        ...finRead,
        schema: {
          ...WalletTag,
          querystring: FinanceQueueQuery,
          summary: 'Finance funding queue — filterable by status/site/project',
        },
      },
      async (request) =>
        service.listFinanceFundingRequests(
          actorOf(request),
          companyIdOf(request),
          request.query as {
            status?: string;
            siteId?: string;
            projectId?: string;
            cursor?: string;
            limit?: number;
          },
        ),
    );

    app.get(
      '/finance/wallet-funding-requests/:requestId',
      {
        ...finRead,
        schema: {
          ...WalletTag,
          params: FinanceRequestParams,
          summary: 'Finance request detail — attempts, workflow task, transfers',
        },
      },
      async (request) =>
        service.getFinanceFundingRequest(
          actorOf(request),
          companyIdOf(request),
          (request.params as { requestId: string }).requestId,
        ),
    );

    // ---------------------------------------------------------------- transfers

    app.post(
      '/finance/wallet-funding-requests/:requestId/transfers',
      {
        ...finManage,
        schema: {
          ...WalletTag,
          params: FinanceRequestParams,
          body: TransferBody,
          summary: 'Finance records an actual transfer — NEVER credits the wallet',
          description:
            'Records the UTR/reference of money sent. The wallet is credited only when the PI ' +
            'confirms receipt. Σ transfers cannot exceed the approved amount. Reference is unique per request.',
        },
      },
      async (request, reply) => {
        const r = await service.recordTransfer(
          actorOf(request),
          companyIdOf(request),
          (request.params as { requestId: string }).requestId,
          request.body as never,
        );
        return reply.code(r.replayed ? 200 : 201).send(r);
      },
    );

    app.get(
      '/finance/wallet-funding-requests/:requestId/transfers',
      {
        ...finRead,
        schema: {
          ...WalletTag,
          params: FinanceRequestParams,
          summary: 'Finance transfer history for a request',
        },
      },
      async (request) =>
        service.listTransfers(
          actorOf(request),
          companyIdOf(request),
          (request.params as { requestId: string }).requestId,
        ),
    );

    app.post(
      '/sites/:siteId/wallet/transfers/:transferId/confirm',
      {
        ...siteManage,
        schema: {
          ...WalletTag,
          params: TransferParams,
          body: ConfirmBody,
          summary: 'PI confirms receipt — THE point where the wallet is credited',
          description:
            'Only the requesting PI may confirm. receivedAmount ≤ transfer amount. Exact receipt ' +
            '→ CONFIRMED + full credit. Partial/zero → DISPUTED; only the positive confirmed part ' +
            'is credited — the remainder stays disputed until Finance resolves it. Idempotent.',
        },
      },
      async (request, reply) => {
        const p = request.params as { siteId: string; transferId: string };
        const r = await service.confirmReceipt(
          actorOf(request),
          companyIdOf(request),
          p.siteId,
          p.transferId,
          request.body as never,
        );
        return reply.code(r.replayed ? 200 : 201).send(r);
      },
    );

    app.get(
      '/sites/:siteId/wallet/transfers/:transferId',
      {
        ...siteView,
        schema: {
          ...WalletTag,
          params: TransferParams,
          summary: 'PI view of a transfer and its receipt state',
        },
      },
      async (request) => {
        const p = request.params as { siteId: string; transferId: string };
        return service.getSiteTransfer(
          actorOf(request),
          companyIdOf(request),
          p.siteId,
          p.transferId,
        );
      },
    );

    app.post(
      '/finance/wallet-transfers/:transferId/resolve-dispute',
      {
        ...finManage,
        schema: {
          ...WalletTag,
          params: FinanceTransferParams,
          body: ResolveDisputeBody,
          summary: 'Finance resolves a receipt discrepancy — closes the transfer',
          description:
            'ACKNOWLEDGED accepts the shortfall; SUPPLEMENTARY_PENDING records intent to send a ' +
            'follow-up transfer (recorded separately and confirmed by PI again).',
        },
      },
      async (request, reply) => {
        const r = await service.resolveDispute(
          actorOf(request),
          companyIdOf(request),
          (request.params as { transferId: string }).transferId,
          request.body as never,
        );
        return reply.code(r.replayed ? 200 : 201).send(r);
      },
    );

    app.post(
      '/finance/wallet-funding-requests/:requestId/close-short',
      {
        ...finManage,
        schema: {
          ...WalletTag,
          params: FinanceRequestParams,
          body: CloseShortBody,
          summary: 'Finance closes an approved request short of the approved amount',
          description:
            'Allowed when confirmed < approved and no RECORDED/DISPUTED transfers remain open. ' +
            'Terminal — no further transfers or receipts.',
        },
      },
      async (request) =>
        service.closeShort(
          actorOf(request),
          companyIdOf(request),
          (request.params as { requestId: string }).requestId,
          request.body as { reason: string; idempotencyKey: string },
        ),
    );

    app.post(
      '/finance/wallet-funding-requests/:requestId/reduce-amount',
      {
        ...finManage,
        schema: {
          ...WalletTag,
          params: FinanceRequestParams,
          body: ReduceApprovedAmountBody,
          summary: 'Finance reduces approvedAmount on an APPROVED or PARTIALLY_FUNDED request',
          description:
            'Must be strictly less than current approvedAmount and >= max(confirmedAmount, recorded transfers).',
        },
      },
      async (request) =>
        service.reduceApprovedAmount(
          actorOf(request),
          companyIdOf(request),
          (request.params as { requestId: string }).requestId,
          request.body as { approvedAmount: string; reason: string; expectedVersion: number },
        ),
    );

    app.post(
      '/finance/wallet-transfers/:transferId/cancel',
      {
        ...finManage,
        schema: {
          ...WalletTag,
          params: FinanceTransferParams,
          body: CancelTransferBody,
          summary: 'Finance cancels an unconfirmed (RECORDED) transfer',
          description:
            'Only RECORDED transfers can be cancelled; frees the amount from in-flight transfers.',
        },
      },
      async (request) =>
        service.cancelTransfer(
          actorOf(request),
          companyIdOf(request),
          (request.params as { transferId: string }).transferId,
          request.body as { reason: string; expectedVersion: number },
        ),
    );

    // ------------------------------------------------------------ account heads

    app.get(
      '/sites/:siteId/wallet/account-heads',
      {
        ...siteView,
        schema: {
          ...WalletTag,
          params: SiteParams,
          querystring: Type.Object(
            {
              status: Type.Optional(Type.Union([Type.Literal('ACTIVE'), Type.Literal('INACTIVE')])),
              ...PageQuery,
            },
            { additionalProperties: false },
          ),
          summary: 'PI list of company account heads for voucher lines',
        },
      },
      async (request) =>
        service.listSiteAccountHeads(
          actorOf(request),
          companyIdOf(request),
          (request.params as { siteId: string }).siteId,
          request.query as { status?: string; cursor?: string; limit?: number },
        ),
    );

    app.post(
      '/finance/wallet/account-heads',
      {
        ...finManage,
        schema: {
          ...WalletTag,
          body: AccountHeadCreateBody,
          summary: 'Finance creates a company account head {code, name}',
        },
      },
      async (request, reply) =>
        reply
          .code(201)
          .send(
            await service.createAccountHead(
              actorOf(request),
              companyIdOf(request),
              request.body as never,
            ),
          ),
    );

    app.get(
      '/finance/wallet/account-heads',
      {
        ...finRead,
        schema: {
          ...WalletTag,
          querystring: Type.Object(
            {
              status: Type.Optional(Type.Union([Type.Literal('ACTIVE'), Type.Literal('INACTIVE')])),
              ...PageQuery,
            },
            { additionalProperties: false },
          ),
          summary: 'Finance account-head catalogue',
        },
      },
      async (request) =>
        service.listFinanceAccountHeads(
          actorOf(request),
          companyIdOf(request),
          request.query as { status?: string; cursor?: string; limit?: number },
        ),
    );

    app.patch(
      '/finance/wallet/account-heads/:accountHeadId',
      {
        ...finManage,
        schema: {
          ...WalletTag,
          params: AccountHeadParams,
          body: AccountHeadUpdateBody,
          summary: 'Update/deactivate an account head — historical voucher snapshots unaffected',
        },
      },
      async (request) =>
        service.updateAccountHead(
          actorOf(request),
          companyIdOf(request),
          (request.params as { accountHeadId: string }).accountHeadId,
          request.body as never,
        ),
    );

    // --------------------------------------------------------------- expenses

    const ExpenseQuery = Type.Object(
      {
        from: Type.Optional(IsoDate),
        to: Type.Optional(IsoDate),
        accountHeadId: Type.Optional(Uuid),
        ...PageQuery,
      },
      { additionalProperties: false },
    );

    app.post(
      '/sites/:siteId/wallet/expenses',
      {
        ...siteManage,
        schema: {
          ...WalletTag,
          params: SiteParams,
          body: ExpenseBody,
          summary: 'PI posts a wallet expense — immediate debit, optional voucher + documents',
          description:
            'accountLines must total exactly the debit amount and reference ACTIVE account ' +
            'heads. When voucher is supplied a numbered Sarjan cash voucher is generated from ' +
            'those lines (number, total, and amount-in-words are server-computed). Insufficient ' +
            'balance → 409. Idempotent by idempotencyKey.',
        },
      },
      async (request, reply) => {
        const r = await service.createExpense(
          actorOf(request),
          companyIdOf(request),
          (request.params as { siteId: string }).siteId,
          request.body as never,
        );
        return reply.code(r.replayed ? 200 : 201).send(r);
      },
    );

    app.get(
      '/sites/:siteId/wallet/expenses',
      {
        ...siteView,
        schema: {
          ...WalletTag,
          params: SiteParams,
          querystring: ExpenseQuery,
          summary: 'Site expense list — date/account-head filters, cursor pagination',
        },
      },
      async (request) =>
        service.listExpenses(
          actorOf(request),
          companyIdOf(request),
          (request.params as { siteId: string }).siteId,
          request.query as {
            from?: string;
            to?: string;
            accountHeadId?: string;
            cursor?: string;
            limit?: number;
          },
        ),
    );

    app.get(
      '/sites/:siteId/wallet/expenses/:expenseId',
      {
        ...siteView,
        schema: {
          ...WalletTag,
          params: ExpenseParams,
          summary: 'Expense detail with voucher lines and document links',
        },
      },
      async (request) => {
        const p = request.params as { siteId: string; expenseId: string };
        return service.getExpense(actorOf(request), companyIdOf(request), p.siteId, p.expenseId);
      },
    );

    // --------------------------------------------------------------- vouchers

    app.get(
      '/sites/:siteId/wallet/vouchers/:voucherId',
      {
        ...siteView,
        schema: {
          ...WalletTag,
          params: VoucherParams,
          summary: 'Voucher detail — lines, computed total, INR amount in words',
        },
      },
      async (request) => {
        const p = request.params as { siteId: string; voucherId: string };
        return service.getVoucher(actorOf(request), companyIdOf(request), p.siteId, p.voucherId);
      },
    );

    app.get(
      '/sites/:siteId/wallet/vouchers/:voucherId/print',
      {
        ...siteView,
        schema: {
          ...WalletTag,
          params: VoucherParams,
          summary: 'Print-friendly Sarjan cash voucher (text/html — print/Save-as-PDF in browser)',
          description:
            'Company letterhead, voucher number, site code/name, account lines, "Paid to", ' +
            'INR total, rupees-and-paise words, narration, Prepared By, blank Checked By and ' +
            'Receiver Sign boxes.',
        },
      },
      async (request, reply) => {
        const p = request.params as { siteId: string; voucherId: string };
        const html = await service.printVoucher(
          actorOf(request),
          companyIdOf(request),
          p.siteId,
          p.voucherId,
        );
        return reply.type('text/html; charset=utf-8').send(html);
      },
    );

    app.get(
      '/sites/:siteId/wallet/vouchers/:voucherId/pdf',
      {
        ...siteView,
        schema: {
          ...WalletTag,
          params: VoucherParams,
          summary: 'Download Sarjan cash voucher as PDF (application/pdf)',
        },
      },
      async (request, reply) => {
        const p = request.params as { siteId: string; voucherId: string };
        const { buffer, fileName } = await service.printVoucherPdf(
          actorOf(request),
          companyIdOf(request),
          p.siteId,
          p.voucherId,
        );
        return reply
          .header('Content-Disposition', `attachment; filename="${fileName}"`)
          .type('application/pdf')
          .send(buffer);
      },
    );

    app.get(
      '/finance/wallets/:walletId/vouchers/:voucherId/pdf',
      {
        ...finRead,
        schema: {
          ...WalletTag,
          params: FinanceVoucherParams,
          summary: 'Finance downloads a site cash voucher as PDF (application/pdf)',
        },
      },
      async (request, reply) => {
        const p = request.params as { walletId: string; voucherId: string };
        const { buffer, fileName } = await service.printFinanceVoucherPdf(
          actorOf(request),
          companyIdOf(request),
          p.walletId,
          p.voucherId,
        );
        return reply
          .header('Content-Disposition', `attachment; filename="${fileName}"`)
          .type('application/pdf')
          .send(buffer);
      },
    );

    app.get(
      '/sites/:siteId/wallet/transfers/:transferId/pdf',
      {
        ...siteView,
        schema: {
          ...WalletTag,
          params: TransferParams,
          summary: 'Download funding receipt voucher as PDF (application/pdf)',
        },
      },
      async (request, reply) => {
        const p = request.params as { siteId: string; transferId: string };
        const { buffer, fileName } = await service.printTransferReceiptPdf(
          actorOf(request),
          companyIdOf(request),
          p.siteId,
          p.transferId,
        );
        return reply
          .header('Content-Disposition', `attachment; filename="${fileName}"`)
          .type('application/pdf')
          .send(buffer);
      },
    );

    app.get(
      '/finance/wallet-transfers/:transferId/pdf',
      {
        ...finRead,
        schema: {
          ...WalletTag,
          params: FinanceTransferParams,
          summary: 'Finance downloads a funding receipt voucher as PDF (application/pdf)',
        },
      },
      async (request, reply) => {
        const p = request.params as { transferId: string };
        const { buffer, fileName } = await service.printFinanceTransferReceiptPdf(
          actorOf(request),
          companyIdOf(request),
          p.transferId,
        );
        return reply
          .header('Content-Disposition', `attachment; filename="${fileName}"`)
          .type('application/pdf')
          .send(buffer);
      },
    );

    app.post(
      '/sites/:siteId/wallet/vouchers/:voucherId/signed-document',
      {
        ...siteManage,
        schema: {
          ...WalletTag,
          params: VoucherParams,
          body: DocumentBody,
          summary: 'Attach the receiver-signed voucher scan (once)',
          description:
            'The document must be AVAILABLE, same company, and scoped to cover the site — ' +
            'upload first via POST /api/v1/org/sites/:id/documents/upload (multipart). ' +
            'Never changes the ledger; audited + notified after commit.',
        },
      },
      async (request) => {
        const p = request.params as { siteId: string; voucherId: string };
        return service.attachSignedVoucherDocument(
          actorOf(request),
          companyIdOf(request),
          p.siteId,
          p.voucherId,
          (request.body as { documentId: string }).documentId,
        );
      },
    );

    // ------------------------------------------------- evidence & reversals

    app.post(
      '/sites/:siteId/wallet/ledger/:entryId/documents',
      {
        ...siteManage,
        schema: {
          ...WalletTag,
          params: EntryParams,
          body: DocumentBody,
          summary: 'Attach optional supporting evidence to any ledger transaction',
        },
      },
      async (request) => {
        const p = request.params as { siteId: string; entryId: string };
        return service.attachLedgerDocument(
          actorOf(request),
          companyIdOf(request),
          p.siteId,
          p.entryId,
          (request.body as { documentId: string }).documentId,
        );
      },
    );

    app.post(
      '/sites/:siteId/wallet/ledger/:entryId/reversal-requests',
      {
        ...siteManage,
        schema: {
          ...WalletTag,
          params: EntryParams,
          body: ReversalRequestBody,
          summary: 'PI requests a full reversal of a posted ledger entry — Finance executes',
        },
      },
      async (request, reply) => {
        const p = request.params as { siteId: string; entryId: string };
        const r = await service.requestReversal(
          actorOf(request),
          companyIdOf(request),
          p.siteId,
          p.entryId,
          request.body as { reason: string; idempotencyKey: string },
        );
        return reply.code(r.replayed ? 200 : 201).send(r);
      },
    );

    app.get(
      '/finance/wallet-reversal-requests',
      {
        ...finRead,
        schema: {
          ...WalletTag,
          querystring: Type.Object(
            {
              status: Type.Optional(
                Type.Union(
                  (['REQUESTED', 'EXECUTED', 'REJECTED'] as const).map((s) => Type.Literal(s)),
                ),
              ),
              ...PageQuery,
            },
            { additionalProperties: false },
          ),
          summary: 'Finance reversal-request queue',
        },
      },
      async (request) =>
        service.listReversalRequests(
          actorOf(request),
          companyIdOf(request),
          request.query as { status?: string; cursor?: string; limit?: number },
        ),
    );

    app.post(
      '/finance/wallet/ledger/:entryId/reverse',
      {
        ...finManage,
        schema: {
          ...WalletTag,
          params: FinanceEntryParams,
          body: ReverseBody,
          summary: 'Finance executes a full reversal — posts the opposite REVERSAL_* entry',
          description:
            'Reversing a funding credit debits the wallet (needs balance); reversing an expense ' +
            'debit credits it back. Optionally closes a PI reversalRequestId as EXECUTED. ' +
            'Exactly one reversal per original entry. Idempotent.',
        },
      },
      async (request, reply) => {
        const r = await service.executeReversal(
          actorOf(request),
          companyIdOf(request),
          (request.params as { entryId: string }).entryId,
          request.body as never,
        );
        return reply.code(r.replayed ? 200 : 201).send(r);
      },
    );
  };
}
