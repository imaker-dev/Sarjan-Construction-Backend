import { describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { renderCashVoucherPdf, renderFundingReceiptPdf } from '../../../src/modules/wallet/voucher-pdf.js';
import { WalletService } from '../../../src/modules/wallet/service.js';
import { NotificationService } from '../../../src/modules/notification/service.js';
import { NotificationGateway, type NotificationSocket } from '../../../src/modules/notification/ws-gateway.js';

const Decimal = Prisma.Decimal;
const COMPANY = '00000000-0000-4000-8000-0000000000c1';
const SITE = '00000000-0000-4000-8000-0000000000s1';
const PROJECT = '00000000-0000-4000-8000-0000000000p1';
const WALLET = '00000000-0000-4000-8000-0000000000w1';
const REQUEST = '00000000-0000-4000-8000-0000000000r1';
const TRANSFER = '00000000-0000-4000-8000-0000000000t1';
const ACTOR = { actorId: '00000000-0000-4000-8000-0000000000u1', actorType: 'USER' as const };

describe('Wallet enhancements', () => {
  it('generates valid Sarjan Cash Voucher and Funding Receipt PDFs', async () => {
    const voucherBuf = await renderCashVoucherPdf({
      companyName: 'Sarjan Construction Pvt. Ltd.',
      companyAddress: '10, 2nd Floor, Yogeshwar Complex, Thaltej, Ahmedabad-380054.',
      voucherRef: 'CV-000001',
      date: '2026-11-28',
      siteName: 'Skyline Tower Site',
      siteCode: 'SITE-01',
      paidTo: 'Ramesh Patel',
      totalAmount: '1250.00',
      amountInWords: 'Rupees One Thousand Two Hundred Fifty Only',
      narration: 'Cement unloading labour charges',
      preparedBy: 'Site PI',
      checkedBy: '',
      lines: [{ accountCode: 'LAB-01', accountHeadName: 'Site Labour', amount: '1250.00' }],
    });
    expect(voucherBuf.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    expect(voucherBuf.length).toBeGreaterThan(500);

    const receiptBuf = await renderFundingReceiptPdf({
      companyName: 'Sarjan Construction Pvt. Ltd.',
      companyAddress: 'Ahmedabad',
      receiptRef: 'FR-3205070F',
      date: '2026-11-28',
      siteName: 'Skyline Tower Site',
      siteCode: 'SITE-01',
      transferReference: 'NEFT-998877',
      purpose: 'Weekly site petty cash',
      transferredAmount: '25000.00',
      confirmedAmount: '25000.00',
      amountInWords: 'Rupees Twenty Five Thousand Only',
      status: 'CONFIRMED',
      recordedBy: 'Finance Manager',
      confirmedBy: 'Site PI',
    });
    expect(receiptBuf.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    expect(receiptBuf.length).toBeGreaterThan(500);
  });

  it('reduces approvedAmount and emits WALLET_FUNDING_REDUCED outbox event', async () => {
    const outboxEvents: unknown[] = [];
    const tx = {
      employee: { findFirst: async () => ({ id: 'emp-1' }) },
      walletFundingRequest: {
        findFirst: async () => ({
          id: REQUEST,
          companyId: COMPANY,
          siteId: SITE,
          walletId: WALLET,
          status: 'APPROVED',
          requestedAmount: new Decimal('50000.00'),
          approvedAmount: new Decimal('50000.00'),
          confirmedAmount: new Decimal('10000.00'),
          requestedByPrincipalId: 'pi-1',
          version: 2,
        }),
        update: async ({ data }: { data: Record<string, unknown> }) => ({
          id: REQUEST,
          ...data,
          version: 3,
        }),
      },
      walletTransfer: {
        aggregate: async () => ({ _sum: { amount: new Decimal('10000.00') } }),
      },
      site: { findFirst: async () => ({ id: SITE, projectId: PROJECT }) },
      project: { findFirst: async () => ({ headOfficeId: null }) },
      roleAssignment: { findMany: async () => [] },
      $queryRaw: async () => [],
    };

    const service = new WalletService(
      {
        run: async <T>(fn: (r: never) => Promise<T>) =>
          fn({
            tx,
            audit: { record: async () => undefined },
            outbox: {
              record: async (evt: unknown) => {
                outboxEvents.push(evt);
              },
            },
          } as never),
      },
      { hasPermission: async () => true, assertPermission: async () => undefined },
      async () => ['PETTY_CASH_REQUEST_REVIEW'],
    );

    const updated = await service.reduceApprovedAmount(ACTOR, COMPANY, REQUEST, {
      approvedAmount: '30000.00',
      reason: 'Reduced budget for this week',
      expectedVersion: 2,
    });

    expect(new Decimal(updated.approvedAmount ?? 0).toFixed(2)).toBe('30000.00');
    expect(outboxEvents).toHaveLength(1);
    expect((outboxEvents[0] as { eventType: string }).eventType).toBe('WALLET_FUNDING_REDUCED');
  });

  it('cancels a RECORDED transfer and emits WALLET_TRANSFER_CANCELLED', async () => {
    const outboxEvents: unknown[] = [];
    const tx = {
      employee: { findFirst: async () => ({ id: 'emp-1' }) },
      walletTransfer: {
        findFirst: async () => ({
          id: TRANSFER,
          companyId: COMPANY,
          siteId: SITE,
          requestId: REQUEST,
          status: 'RECORDED',
          version: 1,
        }),
        update: async ({ data }: { data: Record<string, unknown> }) => ({
          id: TRANSFER,
          ...data,
          version: 2,
        }),
      },
      walletFundingRequest: {
        findFirstOrThrow: async () => ({
          id: REQUEST,
          requestedByPrincipalId: 'pi-1',
        }),
      },
      site: { findFirst: async () => ({ id: SITE, projectId: PROJECT }) },
      project: { findFirst: async () => ({ headOfficeId: null }) },
      roleAssignment: { findMany: async () => [] },
      $queryRaw: async () => [],
    };

    const service = new WalletService(
      {
        run: async <T>(fn: (r: never) => Promise<T>) =>
          fn({
            tx,
            audit: { record: async () => undefined },
            outbox: {
              record: async (evt: unknown) => {
                outboxEvents.push(evt);
              },
            },
          } as never),
      },
      { hasPermission: async () => true, assertPermission: async () => undefined },
      async () => ['PROJECT_WALLET_CREDIT_PROCESS'],
    );

    const cancelled = await service.cancelTransfer(ACTOR, COMPANY, TRANSFER, {
      reason: 'Wrong NEFT amount entered',
      expectedVersion: 1,
    });

    expect(cancelled.status).toBe('CLOSED');
    expect(outboxEvents).toHaveLength(1);
    expect((outboxEvents[0] as { eventType: string }).eventType).toBe('WALLET_TRANSFER_CANCELLED');
  });

  it('delivers WALLET_* outbox events through NotificationService to WebSocket gateway', async () => {
    const sentFrames: string[] = [];
    let onMessage: ((channel: string, message: string) => void) | undefined;
    const fakeSubscriber = {
      on: (_evt: string, cb: (channel: string, message: string) => void) => {
        onMessage = cb;
      },
      subscribe: async () => 1,
      unsubscribe: async () => 1,
    };
    const gateway = new NotificationGateway({
      subscriber: fakeSubscriber as never,
      revalidate: async () => true,
      pingMs: 60_000,
      revalidateMs: 60_000,
    });
    const fakeSocket: NotificationSocket = {
      send: (data) => sentFrames.push(data),
      close: () => undefined,
      terminate: () => undefined,
      on: () => undefined,
      ping: () => undefined,
    };
    const detach = gateway.attach(
      { companyId: COMPANY, principalId: 'pi-1', sessionId: 'sess-1' },
      fakeSocket,
    );

    const outboxRow = {
      id: 'out-1',
      companyId: COMPANY,
      eventType: 'WALLET_VOUCHER_CREATED',
      aggregateType: 'WALLET_CASH_VOUCHER',
      aggregateId: 'v-1',
      eventKey: 'ek-1',
      attempts: 0,
      payload: {
        recipientPrincipalIds: ['pi-1'],
        summary: { siteId: SITE, voucherNo: '1' },
      },
      createdAt: new Date(),
    };
    const notifRow = {
      id: 'notif-1',
      companyId: COMPANY,
      recipientPrincipalId: 'pi-1',
      eventType: 'WALLET_VOUCHER_CREATED',
      resourceType: 'WALLET_CASH_VOUCHER',
      resourceId: 'v-1',
      eventKey: 'ek-1',
      title: 'Cash voucher generated',
      readAt: null,
      publishedAt: null,
      createdAt: new Date(),
    };

    const notifService = new NotificationService({
      uow: {
        run: async <T>(fn: (r: never) => Promise<T>) =>
          fn({
            outbox: {
              claim: async () => [outboxRow],
              markDone: async () => undefined,
              recordFailure: async () => undefined,
              reclaimExpiredLeases: async () => 0,
            },
            notifications: {
              createManySkipping: async () => undefined,
              findUnpublished: async () => [notifRow],
              setPublished: async () => undefined,
              listUnpublishedAll: async () => [],
            },
            emailDeliveries: {
              createManySkipping: async () => undefined,
            },
            principals: {
              findVerifiedEmailAddresses: async () => new Map(),
            },
          } as never),
      },
      ticketStore: {} as never,
      signTicket: () => '',
      buildActorContext: async () => ({}) as never,
      publisher: {
        publish: async (channel, message) => {
          onMessage?.(channel, message);
        },
      },
      now: () => new Date(),
    });

    const result = await notifService.processBatch();
    detach();
    await gateway.closeAll();

    expect(result).toEqual({ claimed: 1, delivered: 1, published: 1 });
    expect(sentFrames).toHaveLength(1);
    const frame = JSON.parse(sentFrames[0] ?? '{}') as { eventType: string; title: string };
    expect(frame.eventType).toBe('WALLET_VOUCHER_CREATED');
    expect(frame.title).toBe('Cash voucher generated');
  });

  it('includes voucherId and expense metadata on listFinanceLedger DEBIT_EXPENSE rows', async () => {
    const tx = {
      employee: { findFirst: async () => ({ id: 'emp-1' }) },
      siteWallet: { findFirst: async () => ({ id: WALLET, companyId: COMPANY }) },
      walletLedgerEntry: {
        findMany: async () => [
          {
            id: 'entry-1',
            seq: 5n,
            companyId: COMPANY,
            walletId: WALLET,
            type: 'DEBIT_EXPENSE',
            amount: new Decimal('1250.00'),
            currency: 'INR',
            balanceAfter: new Decimal('8750.00'),
            fundingRequestId: null,
            transferId: null,
            expenseId: 'exp-1',
            reversalOfEntryId: null,
            reason: null,
            postedByPrincipalId: ACTOR.actorId,
            idempotencyKey: 'k-1',
            postedAt: new Date(),
            expense: {
              id: 'exp-1',
              payee: 'Ramesh Patel',
              description: 'Cement unloading',
              cashVoucher: { id: 'voucher-1', voucherNo: 1n },
            },
          },
        ],
        count: async () => 1,
      },
    };
    const service = new WalletService(
      { run: async <T>(fn: (r: never) => Promise<T>) => fn({ tx } as never) },
      { hasPermission: async () => true, assertPermission: async () => undefined },
      async () => ['PROJECT_WALLET_LEDGER_VIEW'],
    );
    const res = await service.listFinanceLedger(ACTOR, COMPANY, WALLET, {});
    expect(res.items).toHaveLength(1);
    expect(res.items[0]?.seq).toBe('5');
    expect(res.items[0]?.voucherId).toBe('voucher-1');
    expect(res.items[0]?.voucherNo).toBe('1');
    expect(res.pagination).toEqual({ total: 1, limit: 50, offset: 0 });
    expect(res.items[0]?.expense).toEqual({
      id: 'exp-1',
      voucherId: 'voucher-1',
      payee: 'Ramesh Patel',
      description: 'Cement unloading',
    });
  });
});
