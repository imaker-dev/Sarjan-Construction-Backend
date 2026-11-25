// Site Wallet Slice 1 — database invariants against real PostgreSQL.
// Runs only on the guarded disposable target — loopback :55432, db erp_test;
// skips silently when TEST_DATABASE_URL is unset or off-target.
//
// NOTE on cleanup: WalletLedgerEntry is append-only by design (UPDATE/DELETE
// are rejected by trigger), so any row it references — wallet, request,
// transfer, expense — is also undeletable (RESTRICT FKs). Rows touched by
// ledger tests are therefore permanent on the disposable database; all
// fixture codes carry a per-run random suffix so repeated runs never collide.
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { resolveTestDbUrl } from './test-db-url.js';

const url = resolveTestDbUrl(process.env.TEST_DATABASE_URL);
const run = url === null ? it.skip : it;
let prisma: PrismaClient | undefined;
let pool: pg.Pool | undefined;

// Fixture ids (company A unless suffixed B).
let companyA = '';
let companyB = '';
let siteA1 = '';
let siteA2 = '';
let principalA = '';
let employeeA = '';
let walletA1 = '';
let walletA2 = '';
let requestA1 = '';
let requestA2 = '';
let requestA3 = ''; // on walletA2 — walletA2 needs its own transfer for credits
let attemptA1 = '';
let attemptA3 = '';
let workflowInstanceA1 = '';
let transferA1 = '';
let transferA3 = ''; // on walletA2
let expenseA1 = '';
let creditEntryId = '';
let debitEntryId = '';

const sfx = randomUUID().slice(0, 8);
const q = <T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
) => {
  if (pool === undefined) throw new Error('unreachable');
  return pool.query<T>(text, params);
};

// pg throws error.code = SQLSTATE (23xxx = integrity violations,
// P0001 = RAISE EXCEPTION from our triggers).
const sqlstate = async (text: string, params: unknown[] = []) => {
  try {
    await q(text, params);
    return null;
  } catch (e) {
    return (e as { code?: string }).code ?? 'unknown';
  }
};

beforeAll(async () => {
  if (url === null) return;
  pool = new pg.Pool({ connectionString: url });
  const client = new PrismaClient({ adapter: new PrismaPg(pool) });
  prisma = client;

  const mkCompany = async (code: string) => {
    const company = await client.company.create({ data: { code, name: `Wallet ${code}` } });
    const ho = await client.headOffice.create({
      data: { companyId: company.id, code: 'HQ', name: 'HQ', isPrimary: true },
    });
    const project = await client.project.create({
      data: {
        companyId: company.id,
        headOfficeId: ho.id,
        code: 'P1',
        name: 'Project One',
        timezone: 'UTC',
        contractCurrency: 'AED',
      },
    });
    return { company, project };
  };
  const a = await mkCompany(`WA-${sfx}`);
  const b = await mkCompany(`WB-${sfx}`);
  companyA = a.company.id;
  companyB = b.company.id;

  const mkSite = async (companyId: string, projectId: string, code: string) =>
    client.site.create({ data: { companyId, projectId, code, name: `Site ${code}` } });
  const s1 = await mkSite(companyA, a.project.id, `S1-${sfx}`);
  const s2 = await mkSite(companyA, a.project.id, `S2-${sfx}`);
  siteA1 = s1.id;
  siteA2 = s2.id;

  const p = await client.principal.create({
    data: {
      loginId: `wallet-${sfx}@t.dev`,
      loginIdType: 'EMAIL',
      passwordHash: 'test-only-not-a-real-hash',
    },
  });
  principalA = p.id;

  const emp = await client.employee.create({
    data: {
      companyId: companyA,
      principalId: principalA,
      employeeCode: `E-${sfx}`,
      displayName: 'Wallet Tester',
    },
  });
  employeeA = emp.id;

  const w1 = await client.siteWallet.create({
    data: { companyId: companyA, siteId: siteA1, currency: 'INR' },
  });
  const w2 = await client.siteWallet.create({
    data: { companyId: companyA, siteId: siteA2, currency: 'INR' },
  });
  walletA1 = w1.id;
  walletA2 = w2.id;

  const mkRequest = async (walletId: string, siteId: string, n: number) =>
    client.walletFundingRequest.create({
      data: {
        companyId: companyA,
        walletId,
        siteId,
        requestedByPrincipalId: principalA,
        requestedByEmployeeId: employeeA,
        idempotencyKey: `req-${sfx}-${n}`,
      },
    });
  requestA1 = (await mkRequest(walletA1, siteA1, 1)).id;
  requestA2 = (await mkRequest(walletA1, siteA1, 2)).id;
  requestA3 = (await mkRequest(walletA2, siteA2, 3)).id;

  // Minimal workflow chain for a real WorkflowInstance:
  // department → operation → version → workflow → version → instance.
  const dept = await client.department.create({
    data: {
      companyId: companyA,
      scopeType: 'SITE',
      siteId: siteA1,
      code: `D-${sfx}`,
      name: 'Site Dept',
    },
  });
  const op = await client.operation.create({
    data: { companyId: companyA, departmentId: dept.id, key: `op-${sfx}`, name: 'Funding Op' },
  });
  const opVer = await client.operationVersion.create({
    data: { companyId: companyA, operationId: op.id, revision: 1, definition: {} },
  });
  const wf = await client.workflow.create({
    data: {
      companyId: companyA,
      operationId: op.id,
      operationVersionId: opVer.id,
      key: `wf-${sfx}`,
      name: 'Funding WF',
    },
  });
  const wfVer = await client.workflowVersion.create({
    data: { companyId: companyA, workflowId: wf.id, revision: 1, definition: {} },
  });
  const inst = await client.workflowInstance.create({
    data: {
      companyId: companyA,
      operationId: op.id,
      workflowId: wf.id,
      workflowVersionId: wfVer.id,
      operationVersionId: opVer.id,
      state: 'SUBMITTED',
      startedByPrincipalId: principalA,
    },
  });
  workflowInstanceA1 = inst.id;

  const mkAttempt = async (requestId: string, attemptNo: number, instanceId: string, n: number) =>
    client.walletFundingAttempt.create({
      data: {
        companyId: companyA,
        requestId,
        attemptNo,
        amount: 1000,
        currency: 'INR',
        purpose: 'Site fuel and petty purchases',
        workflowInstanceId: instanceId,
        submittedByPrincipalId: principalA,
        idempotencyKey: `att-${sfx}-${n}`,
      },
    });
  attemptA1 = (await mkAttempt(requestA1, 1, workflowInstanceA1, 1)).id;
  const inst2 = await mkInstance();
  attemptA3 = (await mkAttempt(requestA3, 1, inst2, 3)).id;

  const mkTransfer = async (
    requestId: string,
    attemptId: string,
    walletId: string,
    siteId: string,
    n: number,
  ) =>
    client.walletTransfer.create({
      data: {
        companyId: companyA,
        requestId,
        attemptId,
        walletId,
        siteId,
        amount: 500,
        currency: 'INR',
        reference: `UTR-${sfx}-${n}`,
        transferredAt: new Date(),
        recordedByPrincipalId: principalA,
        idempotencyKey: `tr-${sfx}-${n}`,
      },
    });
  transferA1 = (await mkTransfer(requestA1, attemptA1, walletA1, siteA1, 1)).id;
  transferA3 = (await mkTransfer(requestA3, attemptA3, walletA2, siteA2, 3)).id;

  // Seed ledger on walletA1: CREDIT +500 then the expense+DEBIT pair. The
  // (expenseId, ledgerEntryId) cycle forces one transaction — the expense's
  // ledgerEntryId FK is DEFERRABLE INITIALLY DEFERRED so it validates at
  // commit, after the entry row exists.
  creditEntryId = randomUUID();
  debitEntryId = randomUUID();
  expenseA1 = randomUUID();
  const conn = await pool.connect();
  try {
    await conn.query('BEGIN');
    await conn.query(
      `INSERT INTO "WalletLedgerEntry"
         ("id","companyId","walletId","type","amount","currency","balanceAfter","fundingRequestId","transferId","postedByPrincipalId","idempotencyKey")
       VALUES ($1,$2,$3,'CREDIT_FUNDING',500,'INR',500,$4,$5,$6,$7)`,
      [creditEntryId, companyA, walletA1, requestA1, transferA1, principalA, `led-${sfx}-credit`],
    );
    await conn.query(
      `INSERT INTO "WalletExpense"
         ("id","companyId","walletId","amount","currency","expenseDate","category","description","ledgerEntryId","createdByPrincipalId","idempotencyKey")
       VALUES ($1,$2,$3,200,'INR','2026-12-01','FUEL','Diesel for mixer',$4,$5,$6)`,
      [expenseA1, companyA, walletA1, debitEntryId, principalA, `exp-${sfx}-1`],
    );
    await conn.query(
      `INSERT INTO "WalletLedgerEntry"
         ("id","companyId","walletId","type","amount","currency","balanceAfter","expenseId","postedByPrincipalId","idempotencyKey")
       VALUES ($1,$2,$3,'DEBIT_EXPENSE',200,'INR',300,$4,$5,$6)`,
      [debitEntryId, companyA, walletA1, expenseA1, principalA, `led-${sfx}-debit`],
    );
    await conn.query('COMMIT');
  } catch (e) {
    await conn.query('ROLLBACK');
    throw e;
  } finally {
    conn.release();
  }
});

afterAll(async () => {
  // Ledger-touched rows are intentionally permanent (append-only + RESTRICT).
  // Delete only rows that cannot be referenced by ledger entries.
  if (prisma !== undefined && pool !== undefined) {
    try {
      for (const t of [
        'WalletCashVoucherLine',
        'WalletCashVoucher',
        'WalletReversalRequest',
        'WalletAccountHead',
        'DocumentLink',
        'Document',
        'WalletTransfer',
        'WalletFundingAttempt',
        'WalletExpense',
        'WalletFundingRequest',
        'WorkflowInstance',
        'WorkflowVersion',
        'Workflow',
        'OperationVersion',
        'Operation',
        'Department',
        'SiteWallet',
        'Employee',
        'Site',
        'Project',
        'HeadOffice',
        'Company',
      ]) {
        await q(`DELETE FROM "${t}" WHERE "companyId" IN ($1, $2)`, [companyA, companyB]).catch(
          () => undefined,
        );
      }
      await q(`DELETE FROM "Principal" WHERE "id" = $1`, [principalA]).catch(() => undefined);
      await q(`DELETE FROM "WalletVoucherCounter" WHERE "companyId" = $1`, [companyA]).catch(
        () => undefined,
      );
    } finally {
      await prisma.$disconnect();
      await pool.end();
    }
  }
});

describe('SiteWallet invariants', () => {
  run('one wallet per site', async () => {
    const code = await sqlstate(
      `INSERT INTO "SiteWallet" ("id","companyId","siteId","currency","updatedAt")
       VALUES (gen_random_uuid(), $1, $2, 'INR', now())`,
      [companyA, siteA1],
    );
    expect(code).toBe('23505');
  });

  run('negative wallet balance rejected', async () => {
    const code = await sqlstate(
      `INSERT INTO "SiteWallet" ("id","companyId","siteId","currency","balance","updatedAt")
       VALUES (gen_random_uuid(), $1, gen_random_uuid(), 'INR', -10, now())`,
      [companyA],
    );
    expect(code).toBe('23514');
  });

  run('wallet cannot pair another company with this site', async () => {
    const code = await sqlstate(
      `INSERT INTO "SiteWallet" ("id","companyId","siteId","currency","updatedAt")
       VALUES (gen_random_uuid(), $1, $2, 'INR', now())`,
      [companyB, siteA1],
    );
    expect(code).toBe('23503');
  });
});

describe('WalletFundingRequest invariants', () => {
  run('siteId must match the wallet site', async () => {
    // walletA1 belongs to siteA1; claiming siteA2 must fail the triple FK.
    const code = await sqlstate(
      `INSERT INTO "WalletFundingRequest"
         ("id","companyId","walletId","siteId","requestedByPrincipalId","requestedByEmployeeId","idempotencyKey","updatedAt")
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, now())`,
      [companyA, walletA1, siteA2, principalA, employeeA, `bad-${sfx}`],
    );
    expect(code).toBe('23503');
  });

  run('companyId cannot disagree with the wallet company', async () => {
    const code = await sqlstate(
      `INSERT INTO "WalletFundingRequest"
         ("id","companyId","walletId","siteId","requestedByPrincipalId","requestedByEmployeeId","idempotencyKey","updatedAt")
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, now())`,
      [companyB, walletA1, siteA1, principalA, employeeA, `bad-${sfx}`],
    );
    expect(code).toBe('23503');
  });

  run('idempotency key is unique per (company, requester)', async () => {
    const code = await sqlstate(
      `INSERT INTO "WalletFundingRequest"
         ("id","companyId","walletId","siteId","requestedByPrincipalId","requestedByEmployeeId","idempotencyKey","updatedAt")
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, now())`,
      [companyA, walletA1, siteA1, principalA, employeeA, `req-${sfx}-1`],
    );
    expect(code).toBe('23505');
  });
});

describe('WalletFundingAttempt invariants', () => {
  run('attempt number is unique per request', async () => {
    const inst2 = await mkInstance();
    const code = await sqlstate(
      `INSERT INTO "WalletFundingAttempt"
         ("id","companyId","requestId","attemptNo","amount","currency","purpose","workflowInstanceId","submittedByPrincipalId","idempotencyKey","updatedAt")
       VALUES (gen_random_uuid(), $1, $2, 1, 50, 'INR', 'dup attempt', $3, $4, $5, now())`,
      [companyA, requestA1, inst2, principalA, `att-${sfx}-dup`],
    );
    expect(code).toBe('23505');
  });

  run('workflow instance cannot be reused across attempts', async () => {
    const code = await sqlstate(
      `INSERT INTO "WalletFundingAttempt"
         ("id","companyId","requestId","attemptNo","amount","currency","purpose","workflowInstanceId","submittedByPrincipalId","idempotencyKey","updatedAt")
       VALUES (gen_random_uuid(), $1, $2, 9, 50, 'INR', 'reuse instance', $3, $4, $5, now())`,
      [companyA, requestA1, workflowInstanceA1, principalA, `att-${sfx}-reuse`],
    );
    expect(code).toBe('23505');
  });

  run('attempt cannot reference a request from another company', async () => {
    const inst = await mkInstance();
    const code = await sqlstate(
      `INSERT INTO "WalletFundingAttempt"
         ("id","companyId","requestId","attemptNo","amount","currency","purpose","workflowInstanceId","submittedByPrincipalId","idempotencyKey","updatedAt")
       VALUES (gen_random_uuid(), $1, $2, 7, 50, 'INR', 'cross-company', $3, $4, $5, now())`,
      [companyB, requestA1, inst, principalA, `att-${sfx}-x`],
    );
    expect(code).toBe('23503');
  });
});

describe('WalletTransfer invariants', () => {
  run('attempt must belong to the stated request', async () => {
    // attemptA1 belongs to requestA1; pairing it with requestA2 fails the
    // (attemptId, companyId, requestId) composite FK.
    const code = await sqlstate(
      `INSERT INTO "WalletTransfer"
         ("id","companyId","requestId","attemptId","walletId","siteId","amount","currency","reference","transferredAt","recordedByPrincipalId","idempotencyKey","updatedAt")
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 10, 'INR', $6, now(), $7, $8, now())`,
      [companyA, requestA2, attemptA1, walletA1, siteA1, `U2-${sfx}`, principalA, `tr-${sfx}-bad`],
    );
    expect(code).toBe('23503');
  });

  run('wallet must belong to the stated site', async () => {
    const code = await sqlstate(
      `INSERT INTO "WalletTransfer"
         ("id","companyId","requestId","attemptId","walletId","siteId","amount","currency","reference","transferredAt","recordedByPrincipalId","idempotencyKey","updatedAt")
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 10, 'INR', $6, now(), $7, $8, now())`,
      [companyA, requestA1, attemptA1, walletA2, siteA1, `U3-${sfx}`, principalA, `tr-${sfx}-bad2`],
    );
    expect(code).toBe('23503');
  });

  run('transfer reference is unique per request', async () => {
    const code = await sqlstate(
      `INSERT INTO "WalletTransfer"
         ("id","companyId","requestId","attemptId","walletId","siteId","amount","currency","reference","transferredAt","recordedByPrincipalId","idempotencyKey","updatedAt")
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 10, 'INR', $6, now(), $7, $8, now())`,
      [
        companyA,
        requestA1,
        attemptA1,
        walletA1,
        siteA1,
        `UTR-${sfx}-1`,
        principalA,
        `tr-${sfx}-dup`,
      ],
    );
    expect(code).toBe('23505');
  });

  run('confirmedAmount cannot exceed amount', async () => {
    const code = await sqlstate(
      `INSERT INTO "WalletTransfer"
         ("id","companyId","requestId","attemptId","walletId","siteId","amount","currency","reference","transferredAt","recordedByPrincipalId","confirmedAmount","idempotencyKey","updatedAt")
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 10, 'INR', $6, now(), $7, 11, $8, now())`,
      [companyA, requestA1, attemptA1, walletA1, siteA1, `U4-${sfx}`, principalA, `tr-${sfx}-over`],
    );
    expect(code).toBe('23514');
  });

  run('confirmer and confirmation time must appear together', async () => {
    const code = await sqlstate(
      `INSERT INTO "WalletTransfer"
         ("id","companyId","requestId","attemptId","walletId","siteId","amount","currency","reference","transferredAt","recordedByPrincipalId","confirmedByPrincipalId","confirmedAt","idempotencyKey","updatedAt")
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 10, 'INR', $6, now(), $7, $7, NULL, $8, now())`,
      [companyA, requestA1, attemptA1, walletA1, siteA1, `U5-${sfx}`, principalA, `tr-${sfx}-pair`],
    );
    expect(code).toBe('23514');
  });
});

describe('WalletLedgerEntry invariants', () => {
  // walletA1 seeded with: CREDIT 500 (balanceAfter 500) then DEBIT 200
  // (balanceAfter 300). Wallet balance is 300.

  run('seeded ledger chain keeps wallet balance in sync', async () => {
    const bal = await q<{ b: number; v: number }>(
      `SELECT "balance"::float AS b, "version" AS v FROM "SiteWallet" WHERE "id" = $1`,
      [walletA1],
    );
    expect(bal.rows[0]?.b).toBe(300);
    expect(bal.rows[0]?.v).toBe(2); // bumped once per ledger insert
    const exp = await q<{ ledgerEntryId: string }>(
      `SELECT "ledgerEntryId" FROM "WalletExpense" WHERE "id" = $1`,
      [expenseA1],
    );
    expect(exp.rows[0]?.ledgerEntryId).toBe(debitEntryId);
  });

  run('CREDIT_FUNDING without a transfer is rejected', async () => {
    const code = await sqlstate(
      `INSERT INTO "WalletLedgerEntry"
         ("id","companyId","walletId","type","amount","currency","balanceAfter","postedByPrincipalId","idempotencyKey")
       VALUES (gen_random_uuid(), $1, $2, 'CREDIT_FUNDING', 100, 'INR', 400, $3, $4)`,
      [companyA, walletA1, principalA, `led-${sfx}-src`],
    );
    // balanceAfter chains correctly (300+100) so the trigger passes; the
    // source CHECK must reject.
    expect(code).toBe('23514');
  });

  run('DEBIT_EXPENSE with a transferId is rejected', async () => {
    const code = await sqlstate(
      `INSERT INTO "WalletLedgerEntry"
         ("id","companyId","walletId","type","amount","currency","balanceAfter","transferId","expenseId","postedByPrincipalId","idempotencyKey")
       VALUES (gen_random_uuid(), $1, $2, 'DEBIT_EXPENSE', 100, 'INR', 200, $3, $4, $5, $6)`,
      [companyA, walletA1, transferA1, expenseA1, principalA, `led-${sfx}-src2`],
    );
    expect(code).toBe('23514');
  });

  run('balanceAfter must continue the running balance', async () => {
    const code = await sqlstate(
      `INSERT INTO "WalletLedgerEntry"
         ("id","companyId","walletId","type","amount","currency","balanceAfter","expenseId","postedByPrincipalId","idempotencyKey")
       VALUES (gen_random_uuid(), $1, $2, 'DEBIT_EXPENSE', 100, 'INR', 100, $3, $4, $5)`,
      [companyA, walletA1, expenseA1, principalA, `led-${sfx}-chain`],
    );
    // 300 - 100 = 200, not 100 → trigger rejects.
    expect(code).toBe('P0001');
  });

  run('debit that would overdraw is rejected', async () => {
    const code = await sqlstate(
      `INSERT INTO "WalletLedgerEntry"
         ("id","companyId","walletId","type","amount","currency","balanceAfter","expenseId","postedByPrincipalId","idempotencyKey")
       VALUES (gen_random_uuid(), $1, $2, 'DEBIT_EXPENSE', 999, 'INR', -699, $3, $4, $5)`,
      [companyA, walletA1, expenseA1, principalA, `led-${sfx}-over`],
    );
    expect(code).toBe('23514'); // balanceAfter >= 0 CHECK
  });

  run('ledger entry currency must match wallet currency', async () => {
    const code = await sqlstate(
      `INSERT INTO "WalletLedgerEntry"
         ("id","companyId","walletId","type","amount","currency","balanceAfter","fundingRequestId","transferId","postedByPrincipalId","idempotencyKey")
       VALUES (gen_random_uuid(), $1, $2, 'CREDIT_FUNDING', 10, 'USD', 310, $3, $4, $5, $6)`,
      [companyA, walletA1, requestA1, transferA1, principalA, `led-${sfx}-cur`],
    );
    expect(code).toBe('P0001'); // currency check inside the validate trigger
  });

  run('reversal must match the reversed entry type', async () => {
    // REVERSAL_DEBIT against the DEBIT_EXPENSE entry is the wrong direction.
    const code = await sqlstate(
      `INSERT INTO "WalletLedgerEntry"
         ("id","companyId","walletId","type","amount","currency","balanceAfter","reversalOfEntryId","postedByPrincipalId","idempotencyKey")
       VALUES (gen_random_uuid(), $1, $2, 'REVERSAL_DEBIT', 200, 'INR', 100, $3, $4, $5)`,
      [companyA, walletA1, debitEntryId, principalA, `led-${sfx}-revt`],
    );
    expect(code).toBe('P0001');
  });

  run('partial reversal is rejected (full reversals only)', async () => {
    const code = await sqlstate(
      `INSERT INTO "WalletLedgerEntry"
         ("id","companyId","walletId","type","amount","currency","balanceAfter","reversalOfEntryId","postedByPrincipalId","idempotencyKey")
       VALUES (gen_random_uuid(), $1, $2, 'REVERSAL_DEBIT', 100, 'INR', 200, $3, $4, $5)`,
      [companyA, walletA1, creditEntryId, principalA, `led-${sfx}-revp`],
    );
    expect(code).toBe('P0001'); // 100 != 500 → full-reversal rule
  });

  run('full reversal of a funded credit is overdraft-blocked when balance is short', async () => {
    // creditEntryId = 500 but the wallet now holds only 300 — a legitimate
    // full reversal correctly fails the non-negative balance rule.
    const code = await sqlstate(
      `INSERT INTO "WalletLedgerEntry"
         ("id","companyId","walletId","type","amount","currency","balanceAfter","reversalOfEntryId","fundingRequestId","postedByPrincipalId","idempotencyKey")
       VALUES (gen_random_uuid(), $1, $2, 'REVERSAL_DEBIT', 500, 'INR', -200, $3, $4, $5, $6)`,
      [companyA, walletA1, creditEntryId, requestA1, principalA, `led-${sfx}-rev1`],
    );
    expect(code).toBe('23514');
  });

  run('full reversal posts once; second reversal of the same entry is unique-blocked', async () => {
    // walletA2 (empty): CREDIT 100 via transferA3, then reverse it fully.
    const cred = randomUUID();
    const credCode = await sqlstate(
      `INSERT INTO "WalletLedgerEntry"
         ("id","companyId","walletId","type","amount","currency","balanceAfter","fundingRequestId","transferId","postedByPrincipalId","idempotencyKey")
       VALUES ($1, $2, $3, 'CREDIT_FUNDING', 100, 'INR', 100, $4, $5, $6, $7)`,
      [cred, companyA, walletA2, requestA3, transferA3, principalA, `led-${sfx}-w2c`],
    );
    expect(credCode).toBeNull();

    const rev1 = await sqlstate(
      `INSERT INTO "WalletLedgerEntry"
         ("id","companyId","walletId","type","amount","currency","balanceAfter","reversalOfEntryId","fundingRequestId","postedByPrincipalId","idempotencyKey")
       VALUES (gen_random_uuid(), $1, $2, 'REVERSAL_DEBIT', 100, 'INR', 0, $3, $4, $5, $6)`,
      [companyA, walletA2, cred, requestA3, principalA, `led-${sfx}-w2r1`],
    );
    expect(rev1).toBeNull();

    // Top walletA2 up so the duplicate reversal's arithmetic passes the
    // trigger — the reversalOfEntryId unique index is then what rejects it.
    const top = await sqlstate(
      `INSERT INTO "WalletLedgerEntry"
         ("id","companyId","walletId","type","amount","currency","balanceAfter","fundingRequestId","transferId","postedByPrincipalId","idempotencyKey")
       VALUES (gen_random_uuid(), $1, $2, 'CREDIT_FUNDING', 500, 'INR', 500, $3, $4, $5, $6)`,
      [companyA, walletA2, requestA3, transferA3, principalA, `led-${sfx}-w2top`],
    );
    expect(top).toBeNull();

    const rev2 = await sqlstate(
      `INSERT INTO "WalletLedgerEntry"
         ("id","companyId","walletId","type","amount","currency","balanceAfter","reversalOfEntryId","postedByPrincipalId","idempotencyKey")
       VALUES (gen_random_uuid(), $1, $2, 'REVERSAL_DEBIT', 100, 'INR', 400, $3, $4, $5)`,
      [companyA, walletA2, cred, principalA, `led-${sfx}-w2r2`],
    );
    // reversalOfEntryId unique — at most one full reversal per entry.
    expect(rev2).toBe('23505');
  });

  run('reversal cannot point at an entry on another wallet', async () => {
    // debitEntryId lives on walletA1; citing it from walletA2 fails the
    // (reversalOfEntryId, walletId, companyId) composite FK. REVERSAL_CREDIT
    // is used so the type check inside the trigger passes first.
    const code = await sqlstate(
      `INSERT INTO "WalletLedgerEntry"
         ("id","companyId","walletId","type","amount","currency","balanceAfter","reversalOfEntryId","postedByPrincipalId","idempotencyKey")
       VALUES (gen_random_uuid(), $1, $2, 'REVERSAL_CREDIT', 200, 'INR', 700, $3, $4, $5)`,
      [companyA, walletA2, debitEntryId, principalA, `led-${sfx}-xwal`],
    );
    expect(code).toBe('23503');
  });

  run('credit cannot cite a transfer recorded on another wallet', async () => {
    // transferA1 is bound to walletA1; a CREDIT_FUNDING on walletA2 citing it
    // fails the (transferId, walletId, companyId) composite FK.
    const code = await sqlstate(
      `INSERT INTO "WalletLedgerEntry"
         ("id","companyId","walletId","type","amount","currency","balanceAfter","fundingRequestId","transferId","postedByPrincipalId","idempotencyKey")
       VALUES (gen_random_uuid(), $1, $2, 'CREDIT_FUNDING', 50, 'INR', 550, $3, $4, $5, $6)`,
      [companyA, walletA2, requestA3, transferA1, principalA, `led-${sfx}-xtr`],
    );
    expect(code).toBe('23503');
  });

  run('entries are append-only: UPDATE and DELETE are rejected', async () => {
    const upd = await sqlstate(`UPDATE "WalletLedgerEntry" SET "amount" = 1 WHERE "id" = $1`, [
      creditEntryId,
    ]);
    expect(upd).toBe('P0001');
    const del = await sqlstate(`DELETE FROM "WalletLedgerEntry" WHERE "id" = $1`, [creditEntryId]);
    expect(del).toBe('P0001');
  });

  run('ledger idempotency key is unique per wallet', async () => {
    const code = await sqlstate(
      `INSERT INTO "WalletLedgerEntry"
         ("id","companyId","walletId","type","amount","currency","balanceAfter","fundingRequestId","transferId","postedByPrincipalId","idempotencyKey")
       VALUES (gen_random_uuid(), $1, $2, 'CREDIT_FUNDING', 500, 'INR', 800, $3, $4, $5, $6)`,
      [companyA, walletA1, requestA1, transferA1, principalA, `led-${sfx}-credit`],
    );
    // Chains correctly (300+500=800) so the trigger passes; the per-wallet
    // idempotency unique index must reject.
    expect(code).toBe('23505');
  });
});

describe('DocumentLink wallet targets', () => {
  run('exactly one target still enforced with wallet columns', async () => {
    const docId = await mkDoc();
    const code = await sqlstate(
      `INSERT INTO "DocumentLink" ("id","companyId","documentId","entityType","walletFundingRequestId","walletExpenseId","updatedAt")
       VALUES (gen_random_uuid(), $1, $2, 'WALLET_FUNDING_REQUEST', $3, $4, now())`,
      [companyA, docId, requestA1, expenseA1],
    );
    expect(code).toBe('23514');
  });

  run('same-company guarantee on wallet target and document', async () => {
    const docId = await mkDoc();
    // walletFundingRequestId of company A but companyId B → composite FK fails.
    const code = await sqlstate(
      `INSERT INTO "DocumentLink" ("id","companyId","documentId","entityType","walletFundingRequestId","updatedAt")
       VALUES (gen_random_uuid(), $1, $2, 'WALLET_FUNDING_REQUEST', $3, now())`,
      [companyB, docId, requestA1],
    );
    expect(code).toBe('23503');
  });

  run('one active link per (document, wallet target); relink allowed after unlink', async () => {
    const docId = await mkDoc();
    const docId2 = await mkDoc();
    const ok = await sqlstate(
      `INSERT INTO "DocumentLink" ("id","companyId","documentId","entityType","walletExpenseId","updatedAt")
       VALUES (gen_random_uuid(), $1, $2, 'WALLET_EXPENSE', $3, now())`,
      [companyA, docId, expenseA1],
    );
    expect(ok).toBeNull();
    // Same document + same target while active → partial unique index blocks.
    const dup = await sqlstate(
      `INSERT INTO "DocumentLink" ("id","companyId","documentId","entityType","walletExpenseId","updatedAt")
       VALUES (gen_random_uuid(), $1, $2, 'WALLET_EXPENSE', $3, now())`,
      [companyA, docId, expenseA1],
    );
    expect(dup).toBe('23505');
    const relink = await sqlstate(
      `INSERT INTO "DocumentLink" ("id","companyId","documentId","entityType","walletExpenseId","unlinkedAt","updatedAt")
       VALUES (gen_random_uuid(), $1, $2, 'WALLET_EXPENSE', $3, now(), now())`,
      [companyA, docId2, expenseA1],
    );
    expect(relink).toBeNull();
  });
});

// Fresh workflow instance clone (attempt uniqueness tests need new ones).
async function mkInstance() {
  const res = await q<{ id: string }>(
    `INSERT INTO "WorkflowInstance"
       ("id","companyId","operationId","workflowId","workflowVersionId","operationVersionId","state","updatedAt")
     SELECT gen_random_uuid(), "companyId","operationId","workflowId","workflowVersionId","operationVersionId","state", now()
       FROM "WorkflowInstance" WHERE "id" = $1
     RETURNING "id"`,
    [workflowInstanceA1],
  );
  if (res.rows[0] === undefined) throw new Error('workflow instance insert returned no id');
  return res.rows[0].id;
}

async function mkDoc() {
  const res = await q<{ id: string }>(
    `INSERT INTO "Document" ("id","companyId","storageKey","originalFileName","scopeType","siteId","updatedAt")
     VALUES (gen_random_uuid(), $1, $2, 'evidence.pdf', 'SITE', $3, now()) RETURNING "id"`,
    [companyA, `doc-${randomUUID()}`, siteA1],
  );
  if (res.rows[0] === undefined) throw new Error('document insert returned no id');
  return res.rows[0].id;
}

// ---------------------------------------------------------------------------
// Slice 2 invariants — INR contract, balance-update guard, vouchers, reversals
// ---------------------------------------------------------------------------

describe('INR-only money contract', () => {
  run('non-INR wallet currency is rejected by CHECK', async () => {
    const code = await sqlstate(
      `INSERT INTO "SiteWallet" ("id","companyId","siteId","currency","updatedAt")
       VALUES (gen_random_uuid(), $1, gen_random_uuid(), 'USD', now())`,
      [companyA],
    );
    expect(code).toBe('23514');
  });

  run('non-INR attempt currency is rejected by CHECK', async () => {
    const inst = await mkInstance();
    const code = await sqlstate(
      `INSERT INTO "WalletFundingAttempt"
         ("id","companyId","requestId","attemptNo","amount","currency","purpose","workflowInstanceId","submittedByPrincipalId","idempotencyKey","updatedAt")
       VALUES (gen_random_uuid(), $1, $2, 8, 50, 'USD', 'non-inr', $3, $4, $5, now())`,
      [companyA, requestA1, inst, principalA, `att-${sfx}-usd`],
    );
    expect(code).toBe('23514');
  });

  run('project contractCurrency does not flow into wallet rows', async () => {
    // Fixture project uses contractCurrency 'AED'; the wallet and every money
    // row carries 'INR' — derived currency would have broken every fixture.
    const rows = await q<{ c: string }>(
      `SELECT DISTINCT "currency" AS c FROM "SiteWallet" WHERE "companyId" = $1`,
      [companyA],
    );
    expect(rows.rows.every((r) => r.c === 'INR')).toBe(true);
  });
});

describe('SiteWallet direct-update guard', () => {
  run('direct balance UPDATE outside the ledger path is rejected', async () => {
    const code = await sqlstate(
      `UPDATE "SiteWallet" SET "balance" = 99999 WHERE "id" = $1 AND "companyId" = $2`,
      [walletA1, companyA],
    );
    expect(code).toBe('P0001');
  });

  run('direct currency UPDATE is rejected', async () => {
    const code = await sqlstate(
      `UPDATE "SiteWallet" SET "currency" = 'USD' WHERE "id" = $1 AND "companyId" = $2`,
      [walletA1, companyA],
    );
    expect(code).toBe('P0001');
  });

  run('ledger-synced balance change still lands', async () => {
    // The sync trigger runs inside the ledger INSERT trigger (depth > 1) —
    // its balance write must pass the guard.
    const code = await sqlstate(
      `INSERT INTO "WalletLedgerEntry"
         ("id","companyId","walletId","type","amount","currency","balanceAfter","fundingRequestId","transferId","postedByPrincipalId","idempotencyKey")
       VALUES (gen_random_uuid(), $1, $2, 'CREDIT_FUNDING', 50, 'INR', 350, $3, $4, $5, $6)`,
      [companyA, walletA1, requestA1, transferA1, principalA, `led-${sfx}-guard`],
    );
    expect(code).toBeNull();
    const bal = await q<{ b: number }>(
      `SELECT "balance"::float AS b FROM "SiteWallet" WHERE "id" = $1`,
      [walletA1],
    );
    expect(bal.rows[0]?.b).toBe(350);
  });

  run('status and other fields remain updatable', async () => {
    const res = await q<{ status: string }>(
      `UPDATE "SiteWallet" SET "status" = 'FROZEN' WHERE "id" = $1 AND "companyId" = $2 RETURNING "status"`,
      [walletA2, companyA],
    );
    expect(res.rows[0]?.status).toBe('FROZEN');
    await q(`UPDATE "SiteWallet" SET "status" = 'ACTIVE' WHERE "id" = $1 AND "companyId" = $2`, [
      walletA2,
      companyA,
    ]);
  });
});

describe('WalletCashVoucher invariants', () => {
  let accountHeadId = '';

  beforeAll(async () => {
    if (url === null) return;
    const res = await q<{ id: string }>(
      `INSERT INTO "WalletAccountHead" ("id","companyId","code","name","updatedAt")
       VALUES (gen_random_uuid(), $1, $2, 'Materials', now()) RETURNING "id"`,
      [companyA, `AH-${sfx}`],
    );
    if (res.rows[0] === undefined) throw new Error('account head insert returned no id');
    accountHeadId = res.rows[0].id;
  });

  const mkVoucher = async (conn: pg.PoolClient, voucherNo: number) =>
    conn.query<{ id: string }>(
      `INSERT INTO "WalletCashVoucher"
         ("id","companyId","voucherNo","expenseId","walletId","siteId","date","currency","preparedByPrincipalId","preparedByEmployeeId","updatedAt")
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, '2026-12-01', 'INR', $6, $7, now()) RETURNING "id"`,
      [companyA, voucherNo, expenseA1, walletA1, siteA1, principalA, employeeA],
    );

  run('line total must equal the expense amount at commit', async () => {
    if (pool === undefined) return;
    const conn = await pool.connect();
    let code: string | null = null;
    try {
      await conn.query('BEGIN');
      const v = await mkVoucher(conn, 900001);
      await conn.query(
        `INSERT INTO "WalletCashVoucherLine"
           ("id","companyId","voucherId","lineNo","accountHeadId","accountCode","accountHeadName","amount")
         VALUES (gen_random_uuid(), $1, $2, 1, $3, '5010', 'Materials', 999)`,
        [companyA, v.rows[0]?.id, accountHeadId],
      );
      await conn.query('COMMIT').catch((e: unknown) => {
        code = (e as { code?: string }).code ?? 'unknown';
        throw e;
      });
    } catch {
      await conn.query('ROLLBACK').catch(() => undefined);
    } finally {
      conn.release();
    }
    expect(code).toBe('P0001'); // expenseA1 amount is 200, not 999
  });

  run('matching line total commits cleanly', async () => {
    if (pool === undefined) return;
    const conn = await pool.connect();
    try {
      await conn.query('BEGIN');
      const v = await mkVoucher(conn, 900002);
      await conn.query(
        `INSERT INTO "WalletCashVoucherLine"
           ("id","companyId","voucherId","lineNo","accountHeadId","accountCode","accountHeadName","amount")
         VALUES (gen_random_uuid(), $1, $2, 1, $3, '5010', 'Materials', 150),
                (gen_random_uuid(), $1, $2, 2, $3, '5010', 'Materials', 50)`,
        [companyA, v.rows[0]?.id, accountHeadId],
      );
      await conn.query('COMMIT');
    } finally {
      conn.release();
    }
    const n = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM "WalletCashVoucherLine" WHERE "voucherId" IN
         (SELECT "id" FROM "WalletCashVoucher" WHERE "companyId" = $1 AND "voucherNo" = 900002)`,
      [companyA],
    );
    expect(n.rows[0]?.n).toBe(2);
  });

  run('voucher lines are append-only', async () => {
    const code = await sqlstate(
      `UPDATE "WalletCashVoucherLine" SET "amount" = 1 WHERE "companyId" = $1`,
      [companyA],
    );
    expect(code).toBe('P0001');
    const del = await sqlstate(`DELETE FROM "WalletCashVoucherLine" WHERE "companyId" = $1`, [
      companyA,
    ]);
    expect(del).toBe('P0001');
  });

  run('voucher number counter is atomic and gapless', async () => {
    if (pool === undefined) return;
    const alloc = `INSERT INTO "WalletVoucherCounter" ("companyId","nextVoucherNo")
      VALUES ($1::uuid, 2) ON CONFLICT ("companyId")
      DO UPDATE SET "nextVoucherNo" = "WalletVoucherCounter"."nextVoucherNo" + 1
      RETURNING "nextVoucherNo" - 1 AS n`;
    const [a, b] = await Promise.all([
      pool.connect().then(async (c) => {
        try {
          return (await c.query<{ n: number }>(alloc, [companyA])).rows[0]?.n;
        } finally {
          c.release();
        }
      }),
      pool.connect().then(async (c) => {
        try {
          return (await c.query<{ n: number }>(alloc, [companyA])).rows[0]?.n;
        } finally {
          c.release();
        }
      }),
    ]);
    expect(new Set([a, b]).size).toBe(2); // distinct — no duplicate numbers
  });

  run('voucher money columns are immutable after insert', async () => {
    const code = await sqlstate(
      `UPDATE "WalletCashVoucher" SET "expenseId" = gen_random_uuid()
       WHERE "companyId" = $1 AND "voucherNo" = 900002`,
      [companyA],
    );
    expect(code).toBe('P0001');
  });
});

describe('WalletReversalRequest invariants', () => {
  const mkRr = (key: string) =>
    `INSERT INTO "WalletReversalRequest"
       ("id","companyId","walletId","siteId","ledgerEntryId","reason","requestedByPrincipalId","requestedByEmployeeId","idempotencyKey","updatedAt")
     VALUES (gen_random_uuid(), $1, $2, $3, $4, 'duplicate expense', $5, $6, '${key}', now())`;

  run('at most one open reversal request per ledger entry', async () => {
    const first = await sqlstate(mkRr(`rr-${sfx}-1`), [
      companyA,
      walletA1,
      siteA1,
      debitEntryId,
      principalA,
      employeeA,
    ]);
    expect(first).toBeNull();
    const second = await sqlstate(mkRr(`rr-${sfx}-2`), [
      companyA,
      walletA1,
      siteA1,
      debitEntryId,
      principalA,
      employeeA,
    ]);
    expect(second).toBe('23505');
  });
});
