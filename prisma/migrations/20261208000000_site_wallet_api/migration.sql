-- Site Wallet Slice 2 - runtime API models: account heads, cash vouchers,
-- reversal requests, ledger-entry document links, approval decision payload,
-- and the INR-only money contract.
--
-- Additive only - the already-applied 20261207000000_site_wallet migration is
-- untouched. New CHECK constraints validate existing rows; if any non-INR
-- wallet rows exist this migration FAILS rather than rewriting them.

-- ApprovalDecision: action-specific decision payload (e.g. approvedAmount),
-- part of decision history and the idempotency fingerprint.
ALTER TABLE "ApprovalDecision" ADD COLUMN "decisionPayload" JSONB;

-- Editable draft fields on the funding envelope - snapshotted into an
-- immutable attempt row at each submit.
ALTER TABLE "WalletFundingRequest" ADD COLUMN "draftAmount" DECIMAL(18,2);
ALTER TABLE "WalletFundingRequest" ADD COLUMN "draftPurpose" VARCHAR(500);
ALTER TABLE "WalletFundingRequest" ADD COLUMN "draftNeededByDate" DATE;
ALTER TABLE "WalletFundingRequest" ADD CONSTRAINT "WalletFundingRequest_draftAmount_positive"
  CHECK ("draftAmount" IS NULL OR "draftAmount" > 0);

-- New enums for the runtime tables below.
CREATE TYPE "WalletAccountHeadStatus" AS ENUM ('ACTIVE', 'INACTIVE');
CREATE TYPE "WalletReversalRequestStatus" AS ENUM ('REQUESTED', 'EXECUTED', 'REJECTED');

-- ---------------------------------------------------------------------------
-- WalletAccountHead - company-managed account catalogue for voucher lines.
-- ---------------------------------------------------------------------------
CREATE TABLE "WalletAccountHead" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "code" VARCHAR(20) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "status" "WalletAccountHeadStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "WalletAccountHead_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WalletAccountHead_companyId_code_key" ON "WalletAccountHead"("companyId", "code");
CREATE UNIQUE INDEX "WalletAccountHead_id_companyId_key" ON "WalletAccountHead"("id", "companyId");
CREATE INDEX "WalletAccountHead_companyId_status_id_idx" ON "WalletAccountHead"("companyId", "status", "id");

ALTER TABLE "WalletAccountHead" ADD CONSTRAINT "WalletAccountHead_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "WalletAccountHead" ADD CONSTRAINT "WalletAccountHead_code_nonempty"
  CHECK (btrim("code") <> '');
ALTER TABLE "WalletAccountHead" ADD CONSTRAINT "WalletAccountHead_name_nonempty"
  CHECK (btrim("name") <> '');

-- ---------------------------------------------------------------------------
-- WalletVoucherCounter - gapless company-scoped voucher numbering.
-- ---------------------------------------------------------------------------
CREATE TABLE "WalletVoucherCounter" (
    "companyId" UUID NOT NULL,
    "nextVoucherNo" BIGINT NOT NULL DEFAULT 1,

    CONSTRAINT "WalletVoucherCounter_pkey" PRIMARY KEY ("companyId")
);

ALTER TABLE "WalletVoucherCounter" ADD CONSTRAINT "WalletVoucherCounter_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- WalletCashVoucher - printable evidence of an outgoing wallet expense.
-- ---------------------------------------------------------------------------
CREATE TABLE "WalletCashVoucher" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "voucherNo" BIGINT NOT NULL,
    "expenseId" UUID NOT NULL,
    "walletId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "date" DATE NOT NULL,
    "paidTo" VARCHAR(200),
    "narration" VARCHAR(500),
    "currency" VARCHAR(3) NOT NULL,
    "preparedByPrincipalId" UUID NOT NULL,
    "preparedByEmployeeId" UUID NOT NULL,
    "checkedByPrincipalId" UUID,
    "checkedByEmployeeId" UUID,
    "signedDocumentId" UUID,
    "signedAt" TIMESTAMPTZ,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "WalletCashVoucher_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WalletCashVoucher_companyId_voucherNo_key" ON "WalletCashVoucher"("companyId", "voucherNo");
CREATE UNIQUE INDEX "WalletCashVoucher_expenseId_companyId_key" ON "WalletCashVoucher"("expenseId", "companyId");
CREATE UNIQUE INDEX "WalletCashVoucher_id_companyId_key" ON "WalletCashVoucher"("id", "companyId");
CREATE INDEX "WalletCashVoucher_companyId_siteId_id_idx" ON "WalletCashVoucher"("companyId", "siteId", "id");

ALTER TABLE "WalletCashVoucher" ADD CONSTRAINT "WalletCashVoucher_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WalletCashVoucher" ADD CONSTRAINT "WalletCashVoucher_expenseId_companyId_fkey"
  FOREIGN KEY ("expenseId", "companyId") REFERENCES "WalletExpense"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WalletCashVoucher" ADD CONSTRAINT "WalletCashVoucher_walletId_companyId_fkey"
  FOREIGN KEY ("walletId", "companyId") REFERENCES "SiteWallet"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WalletCashVoucher" ADD CONSTRAINT "WalletCashVoucher_siteId_companyId_fkey"
  FOREIGN KEY ("siteId", "companyId") REFERENCES "Site"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WalletCashVoucher" ADD CONSTRAINT "WalletCashVoucher_preparedByPrincipalId_fkey"
  FOREIGN KEY ("preparedByPrincipalId") REFERENCES "Principal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WalletCashVoucher" ADD CONSTRAINT "WalletCashVoucher_preparedByEmployeeId_companyId_fkey"
  FOREIGN KEY ("preparedByEmployeeId", "companyId") REFERENCES "Employee"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WalletCashVoucher" ADD CONSTRAINT "WalletCashVoucher_checkedByPrincipalId_fkey"
  FOREIGN KEY ("checkedByPrincipalId") REFERENCES "Principal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WalletCashVoucher" ADD CONSTRAINT "WalletCashVoucher_checkedByEmployeeId_companyId_fkey"
  FOREIGN KEY ("checkedByEmployeeId", "companyId") REFERENCES "Employee"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WalletCashVoucher" ADD CONSTRAINT "WalletCashVoucher_signedDocumentId_companyId_fkey"
  FOREIGN KEY ("signedDocumentId", "companyId") REFERENCES "Document"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- WalletCashVoucherLine - detail rows with account code/head snapshots.
-- ---------------------------------------------------------------------------
CREATE TABLE "WalletCashVoucherLine" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "voucherId" UUID NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "accountHeadId" UUID NOT NULL,
    "accountCode" VARCHAR(20) NOT NULL,
    "accountHeadName" VARCHAR(120) NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,

    CONSTRAINT "WalletCashVoucherLine_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WalletCashVoucherLine_voucherId_lineNo_key" ON "WalletCashVoucherLine"("voucherId", "lineNo");
CREATE UNIQUE INDEX "WalletCashVoucherLine_id_companyId_key" ON "WalletCashVoucherLine"("id", "companyId");

ALTER TABLE "WalletCashVoucherLine" ADD CONSTRAINT "WalletCashVoucherLine_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WalletCashVoucherLine" ADD CONSTRAINT "WalletCashVoucherLine_voucherId_companyId_fkey"
  FOREIGN KEY ("voucherId", "companyId") REFERENCES "WalletCashVoucher"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WalletCashVoucherLine" ADD CONSTRAINT "WalletCashVoucherLine_accountHeadId_companyId_fkey"
  FOREIGN KEY ("accountHeadId", "companyId") REFERENCES "WalletAccountHead"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "WalletCashVoucherLine" ADD CONSTRAINT "WalletCashVoucherLine_amount_positive"
  CHECK ("amount" > 0);

-- ---------------------------------------------------------------------------
-- WalletReversalRequest - PI requests, Finance executes/rejects.
-- ---------------------------------------------------------------------------
CREATE TABLE "WalletReversalRequest" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "walletId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "ledgerEntryId" UUID NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "status" "WalletReversalRequestStatus" NOT NULL DEFAULT 'REQUESTED',
    "requestedByPrincipalId" UUID NOT NULL,
    "requestedByEmployeeId" UUID NOT NULL,
    "decidedByPrincipalId" UUID,
    "decidedAt" TIMESTAMPTZ,
    "decisionReason" VARCHAR(500),
    "reversalEntryId" UUID,
    "idempotencyKey" VARCHAR(80) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "WalletReversalRequest_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WalletReversalRequest_id_companyId_key" ON "WalletReversalRequest"("id", "companyId");
CREATE UNIQUE INDEX "WalletReversalRequest_companyId_requestedByPrincipalId_idempotencyKey_key"
  ON "WalletReversalRequest"("companyId", "requestedByPrincipalId", "idempotencyKey");
-- At most one OPEN reversal request per ledger entry.
CREATE UNIQUE INDEX "WalletReversalRequest_one_open_per_entry"
  ON "WalletReversalRequest"("companyId", "ledgerEntryId")
  WHERE "status" = 'REQUESTED';
CREATE INDEX "WalletReversalRequest_companyId_status_id_idx" ON "WalletReversalRequest"("companyId", "status", "id");
CREATE INDEX "WalletReversalRequest_companyId_walletId_status_idx" ON "WalletReversalRequest"("companyId", "walletId", "status");

ALTER TABLE "WalletReversalRequest" ADD CONSTRAINT "WalletReversalRequest_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WalletReversalRequest" ADD CONSTRAINT "WalletReversalRequest_walletId_companyId_fkey"
  FOREIGN KEY ("walletId", "companyId") REFERENCES "SiteWallet"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WalletReversalRequest" ADD CONSTRAINT "WalletReversalRequest_siteId_companyId_fkey"
  FOREIGN KEY ("siteId", "companyId") REFERENCES "Site"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WalletReversalRequest" ADD CONSTRAINT "WalletReversalRequest_ledgerEntryId_companyId_fkey"
  FOREIGN KEY ("ledgerEntryId", "companyId") REFERENCES "WalletLedgerEntry"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WalletReversalRequest" ADD CONSTRAINT "WalletReversalRequest_reversalEntryId_companyId_fkey"
  FOREIGN KEY ("reversalEntryId", "companyId") REFERENCES "WalletLedgerEntry"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WalletReversalRequest" ADD CONSTRAINT "WalletReversalRequest_requestedByPrincipalId_fkey"
  FOREIGN KEY ("requestedByPrincipalId") REFERENCES "Principal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WalletReversalRequest" ADD CONSTRAINT "WalletReversalRequest_requestedByEmployeeId_companyId_fkey"
  FOREIGN KEY ("requestedByEmployeeId", "companyId") REFERENCES "Employee"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WalletReversalRequest" ADD CONSTRAINT "WalletReversalRequest_decidedByPrincipalId_fkey"
  FOREIGN KEY ("decidedByPrincipalId") REFERENCES "Principal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "WalletReversalRequest" ADD CONSTRAINT "WalletReversalRequest_reason_nonempty"
  CHECK (btrim("reason") <> '');

-- ---------------------------------------------------------------------------
-- DocumentLink - two new targets: WALLET_LEDGER_ENTRY and WALLET_VOUCHER.
-- The exactly-one-target CHECK is expanded, never weakened.
-- ---------------------------------------------------------------------------
ALTER TABLE "DocumentLink" ADD COLUMN "walletLedgerEntryId" UUID;
ALTER TABLE "DocumentLink" ADD COLUMN "walletVoucherId" UUID;

CREATE INDEX "DocumentLink_companyId_walletLedgerEntryId_unlinkedAt_idx"
  ON "DocumentLink"("companyId", "walletLedgerEntryId", "unlinkedAt");
CREATE INDEX "DocumentLink_companyId_walletVoucherId_unlinkedAt_idx"
  ON "DocumentLink"("companyId", "walletVoucherId", "unlinkedAt");

ALTER TABLE "DocumentLink" ADD CONSTRAINT "DocumentLink_walletLedgerEntryId_companyId_fkey"
  FOREIGN KEY ("walletLedgerEntryId", "companyId") REFERENCES "WalletLedgerEntry"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DocumentLink" ADD CONSTRAINT "DocumentLink_walletVoucherId_companyId_fkey"
  FOREIGN KEY ("walletVoucherId", "companyId") REFERENCES "WalletCashVoucher"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "DocumentLink" DROP CONSTRAINT "DocumentLink_one_target";
ALTER TABLE "DocumentLink" ADD CONSTRAINT "DocumentLink_one_target"
  CHECK (num_nonnulls(
    "formSubmissionId", "workflowInstanceId",
    "walletFundingRequestId", "walletTransferId", "walletExpenseId",
    "walletLedgerEntryId", "walletVoucherId"
  ) = 1);

CREATE UNIQUE INDEX "DocumentLink_one_active_wallet_ledger_link"
  ON "DocumentLink"("companyId", "documentId", "walletLedgerEntryId", COALESCE("fieldKey", ''))
  WHERE "walletLedgerEntryId" IS NOT NULL AND "unlinkedAt" IS NULL;
CREATE UNIQUE INDEX "DocumentLink_one_active_wallet_voucher_link"
  ON "DocumentLink"("companyId", "documentId", "walletVoucherId", COALESCE("fieldKey", ''))
  WHERE "walletVoucherId" IS NOT NULL AND "unlinkedAt" IS NULL;

-- ---------------------------------------------------------------------------
-- INR-only money contract. These CHECKs validate existing rows - a non-INR
-- row anywhere fails the migration rather than being silently rewritten.
-- ---------------------------------------------------------------------------
ALTER TABLE "SiteWallet" ADD CONSTRAINT "SiteWallet_currency_inr"
  CHECK ("currency" = 'INR');
ALTER TABLE "WalletFundingAttempt" ADD CONSTRAINT "WalletFundingAttempt_currency_inr"
  CHECK ("currency" = 'INR');
ALTER TABLE "WalletTransfer" ADD CONSTRAINT "WalletTransfer_currency_inr"
  CHECK ("currency" = 'INR');
ALTER TABLE "WalletExpense" ADD CONSTRAINT "WalletExpense_currency_inr"
  CHECK ("currency" = 'INR');
ALTER TABLE "WalletLedgerEntry" ADD CONSTRAINT "WalletLedgerEntry_currency_inr"
  CHECK ("currency" = 'INR');
ALTER TABLE "WalletCashVoucher" ADD CONSTRAINT "WalletCashVoucher_currency_inr"
  CHECK ("currency" = 'INR');

-- A voucher belongs to the expense's own wallet and site - the triple must
-- agree, exactly like transfers' three-tuple binding.
CREATE OR REPLACE FUNCTION wallet_voucher_consistency() RETURNS trigger AS $$
DECLARE
  exp_record RECORD;
BEGIN
  SELECT "walletId" INTO exp_record FROM "WalletExpense"
    WHERE "id" = NEW."expenseId" AND "companyId" = NEW."companyId";
  IF exp_record."walletId" IS NULL THEN
    RAISE EXCEPTION 'WalletCashVoucher.expenseId does not resolve in company';
  END IF;
  IF exp_record."walletId" <> NEW."walletId" THEN
    RAISE EXCEPTION 'WalletCashVoucher.walletId does not match its expense wallet';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "WalletCashVoucher_consistency"
  BEFORE INSERT OR UPDATE ON "WalletCashVoucher"
  FOR EACH ROW EXECUTE FUNCTION wallet_voucher_consistency();

-- Voucher fields are auditable but the money columns are append-only in
-- spirit: expenseId/walletId/siteId/voucherNo/currency may never change.
CREATE OR REPLACE FUNCTION wallet_voucher_immutable_cols() RETURNS trigger AS $$
BEGIN
  IF NEW."expenseId" <> OLD."expenseId"
     OR NEW."walletId" <> OLD."walletId"
     OR NEW."siteId" <> OLD."siteId"
     OR NEW."voucherNo" <> OLD."voucherNo"
     OR NEW."currency" <> OLD."currency"
     OR NEW."preparedByPrincipalId" <> OLD."preparedByPrincipalId" THEN
    RAISE EXCEPTION 'WalletCashVoucher immutable column changed';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "WalletCashVoucher_immutable_cols"
  BEFORE UPDATE ON "WalletCashVoucher"
  FOR EACH ROW EXECUTE FUNCTION wallet_voucher_immutable_cols();

-- Voucher lines are immutable - the printed form is a snapshot.
CREATE OR REPLACE FUNCTION wallet_voucher_line_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'WalletCashVoucherLine is append-only: % is not allowed', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "WalletCashVoucherLine_immutable_update"
  BEFORE UPDATE ON "WalletCashVoucherLine"
  FOR EACH ROW EXECUTE FUNCTION wallet_voucher_line_immutable();
CREATE TRIGGER "WalletCashVoucherLine_immutable_delete"
  BEFORE DELETE ON "WalletCashVoucherLine"
  FOR EACH ROW EXECUTE FUNCTION wallet_voucher_line_immutable();

-- Voucher line rows must total exactly the expense amount. Deferred to
-- COMMIT so the service's createMany batch inside one transaction validates
-- as a set, and so any partial insert still fails the commit.
CREATE OR REPLACE FUNCTION wallet_voucher_total_check() RETURNS trigger AS $$
DECLARE
  line_total NUMERIC(18,2);
  expense_amount NUMERIC(18,2);
BEGIN
  SELECT COALESCE(SUM(l."amount"), 0) INTO line_total
    FROM "WalletCashVoucherLine" l
    WHERE l."voucherId" = NEW."voucherId" AND l."companyId" = NEW."companyId";
  SELECT e."amount" INTO expense_amount
    FROM "WalletCashVoucher" v
    JOIN "WalletExpense" e
      ON e."id" = v."expenseId" AND e."companyId" = v."companyId"
    WHERE v."id" = NEW."voucherId" AND v."companyId" = NEW."companyId";
  IF expense_amount IS NULL OR line_total <> expense_amount THEN
    RAISE EXCEPTION 'voucher line total % must equal expense amount %',
      line_total, expense_amount;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "WalletCashVoucher_total_equals_expense"
  AFTER INSERT ON "WalletCashVoucherLine"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION wallet_voucher_total_check();

-- Wallet balance/currency are ledger-derived: only the ledger sync trigger
-- (running inside another trigger, i.e. pg_trigger_depth() > 1) may change
-- them. Direct UPDATEs from application or admin connections at depth 1 are
-- rejected, closing the balance-bypass path. status/version/updatedAt stay
-- freely updatable.
CREATE OR REPLACE FUNCTION site_wallet_balance_guard() RETURNS trigger AS $$
BEGIN
  IF (NEW."balance" IS DISTINCT FROM OLD."balance"
      OR NEW."currency" IS DISTINCT FROM OLD."currency")
     AND pg_trigger_depth() <= 1 THEN
    RAISE EXCEPTION 'SiteWallet.balance and .currency are ledger-derived - post a WalletLedgerEntry instead';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "SiteWallet_balance_guard"
  BEFORE UPDATE ON "SiteWallet"
  FOR EACH ROW EXECUTE FUNCTION site_wallet_balance_guard();
