-- CreateEnum
CREATE TYPE "SiteWalletStatus" AS ENUM ('ACTIVE', 'FROZEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "WalletFundingRequestStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'RETURNED', 'PARTIALLY_FUNDED', 'FUNDED', 'CLOSED_SHORT', 'CANCELLED');

-- CreateEnum
CREATE TYPE "WalletFundingAttemptStatus" AS ENUM ('SUBMITTED', 'APPROVED', 'REJECTED', 'RETURNED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "WalletTransferStatus" AS ENUM ('RECORDED', 'CONFIRMED', 'DISPUTED', 'CLOSED', 'REVERSED');

-- CreateEnum
CREATE TYPE "WalletExpenseStatus" AS ENUM ('POSTED', 'REVERSED');

-- CreateEnum
CREATE TYPE "WalletEvidenceState" AS ENUM ('NONE', 'ATTACHED');

-- CreateEnum
CREATE TYPE "WalletLedgerType" AS ENUM ('CREDIT_FUNDING', 'DEBIT_EXPENSE', 'REVERSAL_DEBIT', 'REVERSAL_CREDIT');

-- AlterTable
ALTER TABLE "DocumentLink" ADD COLUMN     "walletExpenseId" UUID,
ADD COLUMN     "walletFundingRequestId" UUID,
ADD COLUMN     "walletTransferId" UUID;

-- CreateTable
CREATE TABLE "SiteWallet" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "balance" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "status" "SiteWalletStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "SiteWallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WalletFundingRequest" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "walletId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "requestedByPrincipalId" UUID NOT NULL,
    "requestedByEmployeeId" UUID NOT NULL,
    "status" "WalletFundingRequestStatus" NOT NULL DEFAULT 'DRAFT',
    "approvedAmount" DECIMAL(18,2),
    "confirmedAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "currentAttemptId" UUID,
    "closedShortReason" TEXT,
    "idempotencyKey" VARCHAR(80) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "WalletFundingRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WalletFundingAttempt" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "attemptNo" INTEGER NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "purpose" VARCHAR(500) NOT NULL,
    "neededByDate" DATE,
    "workflowInstanceId" UUID NOT NULL,
    "approvalTaskId" UUID,
    "status" "WalletFundingAttemptStatus" NOT NULL DEFAULT 'SUBMITTED',
    "approvedAmount" DECIMAL(18,2),
    "decidedByPrincipalId" UUID,
    "decidedAt" TIMESTAMPTZ,
    "decisionReason" TEXT,
    "submittedByPrincipalId" UUID NOT NULL,
    "idempotencyKey" VARCHAR(80) NOT NULL,
    "submittedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "WalletFundingAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WalletTransfer" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "attemptId" UUID NOT NULL,
    "walletId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "reference" VARCHAR(120) NOT NULL,
    "transferredAt" TIMESTAMPTZ NOT NULL,
    "recordedByPrincipalId" UUID NOT NULL,
    "confirmedAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "confirmedByPrincipalId" UUID,
    "confirmedAt" TIMESTAMPTZ,
    "discrepancyAmount" DECIMAL(18,2),
    "discrepancyNote" TEXT,
    "disputeResolution" TEXT,
    "status" "WalletTransferStatus" NOT NULL DEFAULT 'RECORDED',
    "idempotencyKey" VARCHAR(80) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "WalletTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WalletExpense" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "walletId" UUID NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "expenseDate" DATE NOT NULL,
    "category" VARCHAR(40) NOT NULL,
    "description" VARCHAR(500) NOT NULL,
    "payee" VARCHAR(200),
    "reference" VARCHAR(120),
    "status" "WalletExpenseStatus" NOT NULL DEFAULT 'POSTED',
    "evidenceState" "WalletEvidenceState" NOT NULL DEFAULT 'NONE',
    "ledgerEntryId" UUID NOT NULL,
    "createdByPrincipalId" UUID NOT NULL,
    "idempotencyKey" VARCHAR(80) NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WalletExpense_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WalletLedgerEntry" (
    "id" UUID NOT NULL,
    "seq" BIGSERIAL NOT NULL,
    "companyId" UUID NOT NULL,
    "walletId" UUID NOT NULL,
    "type" "WalletLedgerType" NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "balanceAfter" DECIMAL(18,2) NOT NULL,
    "fundingRequestId" UUID,
    "transferId" UUID,
    "expenseId" UUID,
    "reversalOfEntryId" UUID,
    "reason" TEXT,
    "postedByPrincipalId" UUID NOT NULL,
    "idempotencyKey" VARCHAR(80) NOT NULL,
    "postedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WalletLedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SiteWallet_companyId_status_idx" ON "SiteWallet"("companyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "SiteWallet_siteId_companyId_key" ON "SiteWallet"("siteId", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "SiteWallet_id_companyId_key" ON "SiteWallet"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "SiteWallet_id_companyId_siteId_key" ON "SiteWallet"("id", "companyId", "siteId");

-- CreateIndex
CREATE INDEX "WalletFundingRequest_companyId_siteId_status_id_idx" ON "WalletFundingRequest"("companyId", "siteId", "status", "id");

-- CreateIndex
CREATE INDEX "WalletFundingRequest_companyId_status_id_idx" ON "WalletFundingRequest"("companyId", "status", "id");

-- CreateIndex
CREATE UNIQUE INDEX "WalletFundingRequest_companyId_requestedByPrincipalId_idemp_key" ON "WalletFundingRequest"("companyId", "requestedByPrincipalId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "WalletFundingRequest_id_companyId_key" ON "WalletFundingRequest"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "WalletFundingRequest_id_companyId_siteId_key" ON "WalletFundingRequest"("id", "companyId", "siteId");

-- CreateIndex
CREATE UNIQUE INDEX "WalletFundingRequest_id_walletId_companyId_key" ON "WalletFundingRequest"("id", "walletId", "companyId");

-- CreateIndex
CREATE INDEX "WalletFundingAttempt_companyId_requestId_idx" ON "WalletFundingAttempt"("companyId", "requestId");

-- CreateIndex
CREATE INDEX "WalletFundingAttempt_companyId_status_id_idx" ON "WalletFundingAttempt"("companyId", "status", "id");

-- CreateIndex
CREATE UNIQUE INDEX "WalletFundingAttempt_requestId_attemptNo_key" ON "WalletFundingAttempt"("requestId", "attemptNo");

-- CreateIndex
CREATE UNIQUE INDEX "WalletFundingAttempt_workflowInstanceId_key" ON "WalletFundingAttempt"("workflowInstanceId");

-- CreateIndex
CREATE UNIQUE INDEX "WalletFundingAttempt_companyId_requestId_idempotencyKey_key" ON "WalletFundingAttempt"("companyId", "requestId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "WalletFundingAttempt_id_companyId_key" ON "WalletFundingAttempt"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "WalletFundingAttempt_id_companyId_requestId_key" ON "WalletFundingAttempt"("id", "companyId", "requestId");

-- CreateIndex
CREATE INDEX "WalletTransfer_companyId_walletId_status_id_idx" ON "WalletTransfer"("companyId", "walletId", "status", "id");

-- CreateIndex
CREATE INDEX "WalletTransfer_companyId_requestId_idx" ON "WalletTransfer"("companyId", "requestId");

-- CreateIndex
CREATE UNIQUE INDEX "WalletTransfer_companyId_requestId_reference_key" ON "WalletTransfer"("companyId", "requestId", "reference");

-- CreateIndex
CREATE UNIQUE INDEX "WalletTransfer_companyId_recordedByPrincipalId_idempotencyK_key" ON "WalletTransfer"("companyId", "recordedByPrincipalId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "WalletTransfer_id_companyId_key" ON "WalletTransfer"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "WalletTransfer_id_walletId_companyId_key" ON "WalletTransfer"("id", "walletId", "companyId");

-- CreateIndex
CREATE INDEX "WalletExpense_companyId_walletId_expenseDate_id_idx" ON "WalletExpense"("companyId", "walletId", "expenseDate", "id");

-- CreateIndex
CREATE UNIQUE INDEX "WalletExpense_companyId_createdByPrincipalId_idempotencyKey_key" ON "WalletExpense"("companyId", "createdByPrincipalId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "WalletExpense_id_companyId_key" ON "WalletExpense"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "WalletExpense_id_walletId_companyId_key" ON "WalletExpense"("id", "walletId", "companyId");

-- CreateIndex
CREATE INDEX "WalletLedgerEntry_companyId_walletId_postedAt_id_idx" ON "WalletLedgerEntry"("companyId", "walletId", "postedAt", "id");

-- CreateIndex
CREATE INDEX "WalletLedgerEntry_companyId_fundingRequestId_idx" ON "WalletLedgerEntry"("companyId", "fundingRequestId");

-- CreateIndex
CREATE INDEX "WalletLedgerEntry_walletId_seq_idx" ON "WalletLedgerEntry"("walletId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "WalletLedgerEntry_id_companyId_key" ON "WalletLedgerEntry"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "WalletLedgerEntry_id_walletId_companyId_key" ON "WalletLedgerEntry"("id", "walletId", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "WalletLedgerEntry_reversalOfEntryId_key" ON "WalletLedgerEntry"("reversalOfEntryId");

-- CreateIndex
CREATE UNIQUE INDEX "WalletLedgerEntry_companyId_walletId_idempotencyKey_key" ON "WalletLedgerEntry"("companyId", "walletId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "DocumentLink_companyId_walletFundingRequestId_unlinkedAt_idx" ON "DocumentLink"("companyId", "walletFundingRequestId", "unlinkedAt");

-- CreateIndex
CREATE INDEX "DocumentLink_companyId_walletTransferId_unlinkedAt_idx" ON "DocumentLink"("companyId", "walletTransferId", "unlinkedAt");

-- CreateIndex
CREATE INDEX "DocumentLink_companyId_walletExpenseId_unlinkedAt_idx" ON "DocumentLink"("companyId", "walletExpenseId", "unlinkedAt");

-- AddForeignKey
ALTER TABLE "DocumentLink" ADD CONSTRAINT "DocumentLink_walletFundingRequestId_companyId_fkey" FOREIGN KEY ("walletFundingRequestId", "companyId") REFERENCES "WalletFundingRequest"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentLink" ADD CONSTRAINT "DocumentLink_walletTransferId_companyId_fkey" FOREIGN KEY ("walletTransferId", "companyId") REFERENCES "WalletTransfer"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentLink" ADD CONSTRAINT "DocumentLink_walletExpenseId_companyId_fkey" FOREIGN KEY ("walletExpenseId", "companyId") REFERENCES "WalletExpense"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SiteWallet" ADD CONSTRAINT "SiteWallet_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SiteWallet" ADD CONSTRAINT "SiteWallet_siteId_companyId_fkey" FOREIGN KEY ("siteId", "companyId") REFERENCES "Site"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletFundingRequest" ADD CONSTRAINT "WalletFundingRequest_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletFundingRequest" ADD CONSTRAINT "WalletFundingRequest_walletId_companyId_siteId_fkey" FOREIGN KEY ("walletId", "companyId", "siteId") REFERENCES "SiteWallet"("id", "companyId", "siteId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletFundingRequest" ADD CONSTRAINT "WalletFundingRequest_siteId_companyId_fkey" FOREIGN KEY ("siteId", "companyId") REFERENCES "Site"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletFundingRequest" ADD CONSTRAINT "WalletFundingRequest_requestedByPrincipalId_fkey" FOREIGN KEY ("requestedByPrincipalId") REFERENCES "Principal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletFundingRequest" ADD CONSTRAINT "WalletFundingRequest_requestedByEmployeeId_companyId_fkey" FOREIGN KEY ("requestedByEmployeeId", "companyId") REFERENCES "Employee"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletFundingAttempt" ADD CONSTRAINT "WalletFundingAttempt_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletFundingAttempt" ADD CONSTRAINT "WalletFundingAttempt_requestId_companyId_fkey" FOREIGN KEY ("requestId", "companyId") REFERENCES "WalletFundingRequest"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletFundingAttempt" ADD CONSTRAINT "WalletFundingAttempt_workflowInstanceId_companyId_fkey" FOREIGN KEY ("workflowInstanceId", "companyId") REFERENCES "WorkflowInstance"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletFundingAttempt" ADD CONSTRAINT "WalletFundingAttempt_submittedByPrincipalId_fkey" FOREIGN KEY ("submittedByPrincipalId") REFERENCES "Principal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletFundingAttempt" ADD CONSTRAINT "WalletFundingAttempt_decidedByPrincipalId_fkey" FOREIGN KEY ("decidedByPrincipalId") REFERENCES "Principal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletTransfer" ADD CONSTRAINT "WalletTransfer_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletTransfer" ADD CONSTRAINT "WalletTransfer_siteId_companyId_fkey" FOREIGN KEY ("siteId", "companyId") REFERENCES "Site"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletTransfer" ADD CONSTRAINT "WalletTransfer_walletId_companyId_siteId_fkey" FOREIGN KEY ("walletId", "companyId", "siteId") REFERENCES "SiteWallet"("id", "companyId", "siteId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletTransfer" ADD CONSTRAINT "WalletTransfer_requestId_companyId_siteId_fkey" FOREIGN KEY ("requestId", "companyId", "siteId") REFERENCES "WalletFundingRequest"("id", "companyId", "siteId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletTransfer" ADD CONSTRAINT "WalletTransfer_attemptId_companyId_requestId_fkey" FOREIGN KEY ("attemptId", "companyId", "requestId") REFERENCES "WalletFundingAttempt"("id", "companyId", "requestId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletTransfer" ADD CONSTRAINT "WalletTransfer_recordedByPrincipalId_fkey" FOREIGN KEY ("recordedByPrincipalId") REFERENCES "Principal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletTransfer" ADD CONSTRAINT "WalletTransfer_confirmedByPrincipalId_fkey" FOREIGN KEY ("confirmedByPrincipalId") REFERENCES "Principal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletExpense" ADD CONSTRAINT "WalletExpense_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletExpense" ADD CONSTRAINT "WalletExpense_walletId_companyId_fkey" FOREIGN KEY ("walletId", "companyId") REFERENCES "SiteWallet"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletExpense" ADD CONSTRAINT "WalletExpense_createdByPrincipalId_fkey" FOREIGN KEY ("createdByPrincipalId") REFERENCES "Principal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletLedgerEntry" ADD CONSTRAINT "WalletLedgerEntry_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletLedgerEntry" ADD CONSTRAINT "WalletLedgerEntry_walletId_companyId_fkey" FOREIGN KEY ("walletId", "companyId") REFERENCES "SiteWallet"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletLedgerEntry" ADD CONSTRAINT "WalletLedgerEntry_fundingRequestId_walletId_companyId_fkey" FOREIGN KEY ("fundingRequestId", "walletId", "companyId") REFERENCES "WalletFundingRequest"("id", "walletId", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletLedgerEntry" ADD CONSTRAINT "WalletLedgerEntry_transferId_walletId_companyId_fkey" FOREIGN KEY ("transferId", "walletId", "companyId") REFERENCES "WalletTransfer"("id", "walletId", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletLedgerEntry" ADD CONSTRAINT "WalletLedgerEntry_expenseId_walletId_companyId_fkey" FOREIGN KEY ("expenseId", "walletId", "companyId") REFERENCES "WalletExpense"("id", "walletId", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletLedgerEntry" ADD CONSTRAINT "WalletLedgerEntry_reversalOfEntryId_walletId_companyId_fkey" FOREIGN KEY ("reversalOfEntryId", "walletId", "companyId") REFERENCES "WalletLedgerEntry"("id", "walletId", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletLedgerEntry" ADD CONSTRAINT "WalletLedgerEntry_postedByPrincipalId_fkey" FOREIGN KEY ("postedByPrincipalId") REFERENCES "Principal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================================
-- Hand-written invariants (intentional Prisma migration drift -- Prisma cannot
-- express CHECK constraints, triggers, or deferrable FKs; keep this section in
-- sync with the schema comments).
-- ============================================================================

-- Money and currency invariants ------------------------------------------------

ALTER TABLE "SiteWallet" ADD CONSTRAINT "SiteWallet_balance_nonnegative"
  CHECK ("balance" >= 0);
ALTER TABLE "SiteWallet" ADD CONSTRAINT "SiteWallet_currency_len"
  CHECK (char_length("currency") = 3);

ALTER TABLE "WalletFundingRequest" ADD CONSTRAINT "WalletFundingRequest_amounts_nonnegative"
  CHECK (("approvedAmount" IS NULL OR "approvedAmount" >= 0) AND "confirmedAmount" >= 0);
ALTER TABLE "WalletFundingRequest" ADD CONSTRAINT "WalletFundingRequest_confirmed_lte_approved"
  CHECK ("approvedAmount" IS NULL OR "confirmedAmount" <= "approvedAmount");

ALTER TABLE "WalletFundingAttempt" ADD CONSTRAINT "WalletFundingAttempt_amount_positive"
  CHECK ("amount" > 0);
ALTER TABLE "WalletFundingAttempt" ADD CONSTRAINT "WalletFundingAttempt_attemptNo_positive"
  CHECK ("attemptNo" > 0);
ALTER TABLE "WalletFundingAttempt" ADD CONSTRAINT "WalletFundingAttempt_approvedAmount_nonnegative"
  CHECK ("approvedAmount" IS NULL OR "approvedAmount" >= 0);
ALTER TABLE "WalletFundingAttempt" ADD CONSTRAINT "WalletFundingAttempt_currency_len"
  CHECK (char_length("currency") = 3);

ALTER TABLE "WalletTransfer" ADD CONSTRAINT "WalletTransfer_amount_positive"
  CHECK ("amount" > 0);
ALTER TABLE "WalletTransfer" ADD CONSTRAINT "WalletTransfer_confirmed_in_range"
  CHECK ("confirmedAmount" >= 0 AND "confirmedAmount" <= "amount");
ALTER TABLE "WalletTransfer" ADD CONSTRAINT "WalletTransfer_currency_len"
  CHECK (char_length("currency") = 3);
-- A confirmer and a confirmation time must always appear together.
ALTER TABLE "WalletTransfer" ADD CONSTRAINT "WalletTransfer_confirmer_pair"
  CHECK (("confirmedByPrincipalId" IS NULL) = ("confirmedAt" IS NULL));
ALTER TABLE "WalletTransfer" ADD CONSTRAINT "WalletTransfer_discrepancy_nonnegative"
  CHECK ("discrepancyAmount" IS NULL OR "discrepancyAmount" >= 0);

ALTER TABLE "WalletExpense" ADD CONSTRAINT "WalletExpense_amount_positive"
  CHECK ("amount" > 0);
ALTER TABLE "WalletExpense" ADD CONSTRAINT "WalletExpense_currency_len"
  CHECK (char_length("currency") = 3);

ALTER TABLE "WalletLedgerEntry" ADD CONSTRAINT "WalletLedgerEntry_amount_positive"
  CHECK ("amount" > 0);
ALTER TABLE "WalletLedgerEntry" ADD CONSTRAINT "WalletLedgerEntry_balanceAfter_nonnegative"
  CHECK ("balanceAfter" >= 0);
ALTER TABLE "WalletLedgerEntry" ADD CONSTRAINT "WalletLedgerEntry_currency_len"
  CHECK (char_length("currency") = 3);

-- Ledger source checks must match entry type ----------------------------------
-- CREDIT_FUNDING   -> a transfer (+ its request) exists, nothing else.
-- DEBIT_EXPENSE    -> an expense exists, nothing else.
-- REVERSAL_*       -> reversalOfEntryId set; source ids are never reused --
--                    fundingRequestId may be kept for provenance only.
ALTER TABLE "WalletLedgerEntry" ADD CONSTRAINT "WalletLedgerEntry_source_matches_type"
  CHECK (
    ("type" = 'CREDIT_FUNDING'
      AND "transferId" IS NOT NULL AND "fundingRequestId" IS NOT NULL
      AND "expenseId" IS NULL AND "reversalOfEntryId" IS NULL)
    OR ("type" = 'DEBIT_EXPENSE'
      AND "expenseId" IS NOT NULL
      AND "transferId" IS NULL AND "fundingRequestId" IS NULL AND "reversalOfEntryId" IS NULL)
    OR ("type" IN ('REVERSAL_DEBIT', 'REVERSAL_CREDIT')
      AND "reversalOfEntryId" IS NOT NULL
      AND "transferId" IS NULL AND "expenseId" IS NULL)
  );

-- WalletExpense -> its provenance DEBIT_EXPENSE entry. Deferrable because this
-- is one side of the (expenseId, ledgerEntryId) cycle; insert the expense and
-- the entry inside one transaction and the check runs at commit.
ALTER TABLE "WalletExpense" ADD CONSTRAINT "WalletExpense_ledgerEntryId_fkey"
  FOREIGN KEY ("ledgerEntryId") REFERENCES "WalletLedgerEntry"("id")
  DEFERRABLE INITIALLY DEFERRED;

-- Ledger semantics --------------------------------------------------------------
-- 1. Entries are append-only: UPDATE and DELETE are rejected outright.
CREATE OR REPLACE FUNCTION wallet_ledger_entry_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'WalletLedgerEntry is append-only: % is not allowed', TG_OP
    USING ERRCODE = 'raise_exception';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "WalletLedgerEntry_immutable"
  BEFORE UPDATE OR DELETE ON "WalletLedgerEntry"
  FOR EACH ROW EXECUTE FUNCTION wallet_ledger_entry_immutable();

-- 2. balanceAfter must continue the wallet's running balance exactly:
--    credits add, debits subtract, empty-ledger balance is zero.
--    Reversals must be full-amount and must match the reversed entry's type:
--    REVERSAL_DEBIT undoes CREDIT_FUNDING, REVERSAL_CREDIT undoes DEBIT_EXPENSE.
--    Entry currency must equal the wallet's fixed currency.
CREATE OR REPLACE FUNCTION wallet_ledger_entry_validate() RETURNS trigger AS $$
DECLARE
  prev_balance NUMERIC(18,2);
  rev_type "WalletLedgerType";
  rev_amount NUMERIC(18,2);
  signed_amount NUMERIC(18,2);
  wallet_currency VARCHAR(3);
BEGIN
  SELECT "currency" INTO wallet_currency
    FROM "SiteWallet" WHERE "id" = NEW."walletId" AND "companyId" = NEW."companyId";
  IF wallet_currency IS NULL OR wallet_currency <> NEW."currency" THEN
    RAISE EXCEPTION 'ledger currency % does not match wallet currency', NEW."currency";
  END IF;

  SELECT "balanceAfter" INTO prev_balance
    FROM "WalletLedgerEntry"
    WHERE "walletId" = NEW."walletId"
    ORDER BY "seq" DESC
    LIMIT 1;
  prev_balance := COALESCE(prev_balance, 0); -- empty-ledger balance is zero

  signed_amount := CASE
    WHEN NEW."type" IN ('CREDIT_FUNDING', 'REVERSAL_CREDIT') THEN NEW."amount"
    ELSE -NEW."amount"
  END;
  IF NEW."balanceAfter" <> prev_balance + signed_amount THEN
    RAISE EXCEPTION 'balanceAfter % must equal previous balance % plus signed amount %',
      NEW."balanceAfter", prev_balance, signed_amount;
  END IF;

  IF NEW."reversalOfEntryId" IS NOT NULL THEN
    SELECT "type", "amount" INTO rev_type, rev_amount
      FROM "WalletLedgerEntry" WHERE "id" = NEW."reversalOfEntryId";
    IF NEW."type" = 'REVERSAL_DEBIT' AND rev_type <> 'CREDIT_FUNDING' THEN
      RAISE EXCEPTION 'REVERSAL_DEBIT must reverse a CREDIT_FUNDING entry';
    END IF;
    IF NEW."type" = 'REVERSAL_CREDIT' AND rev_type <> 'DEBIT_EXPENSE' THEN
      RAISE EXCEPTION 'REVERSAL_CREDIT must reverse a DEBIT_EXPENSE entry';
    END IF;
    IF NEW."amount" <> rev_amount THEN
      RAISE EXCEPTION 'v1 allows full reversals only: reversal amount % != original amount %',
        NEW."amount", rev_amount;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "WalletLedgerEntry_validate"
  BEFORE INSERT ON "WalletLedgerEntry"
  FOR EACH ROW EXECUTE FUNCTION wallet_ledger_entry_validate();

-- 3. Wallet balance is the ledger-derived balance: every insert syncs
--    SiteWallet.balance to the new entry's balanceAfter (and bumps version so
--    optimistic-concurrency readers observe the movement).
CREATE OR REPLACE FUNCTION wallet_ledger_entry_sync_balance() RETURNS trigger AS $$
BEGIN
  UPDATE "SiteWallet"
     SET "balance" = NEW."balanceAfter",
         "version" = "version" + 1,
         "updatedAt" = now()
   WHERE "id" = NEW."walletId" AND "companyId" = NEW."companyId";
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "WalletLedgerEntry_sync_balance"
  AFTER INSERT ON "WalletLedgerEntry"
  FOR EACH ROW EXECUTE FUNCTION wallet_ledger_entry_sync_balance();

-- DocumentLink: extend the exactly-one-target check to the wallet targets.
-- The existing check is expanded, not weakened -- still exactly one target.
ALTER TABLE "DocumentLink" DROP CONSTRAINT "DocumentLink_one_target";
ALTER TABLE "DocumentLink" ADD CONSTRAINT "DocumentLink_one_target"
  CHECK (num_nonnulls(
    "formSubmissionId", "workflowInstanceId",
    "walletFundingRequestId", "walletTransferId", "walletExpenseId"
  ) = 1);

-- One active link per (document, wallet target) -- same semantics as the
-- existing form/instance partial unique indexes.
CREATE UNIQUE INDEX "DocumentLink_one_active_wallet_request_link"
  ON "DocumentLink"("companyId", "documentId", "walletFundingRequestId", COALESCE("fieldKey", ''))
  WHERE "walletFundingRequestId" IS NOT NULL AND "unlinkedAt" IS NULL;
CREATE UNIQUE INDEX "DocumentLink_one_active_wallet_transfer_link"
  ON "DocumentLink"("companyId", "documentId", "walletTransferId", COALESCE("fieldKey", ''))
  WHERE "walletTransferId" IS NOT NULL AND "unlinkedAt" IS NULL;
CREATE UNIQUE INDEX "DocumentLink_one_active_wallet_expense_link"
  ON "DocumentLink"("companyId", "documentId", "walletExpenseId", COALESCE("fieldKey", ''))
  WHERE "walletExpenseId" IS NOT NULL AND "unlinkedAt" IS NULL;

