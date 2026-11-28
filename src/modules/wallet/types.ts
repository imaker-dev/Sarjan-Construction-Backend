/** API permission keys — FINANCE_* already exist in the permission catalogue. */
export const SITE_WALLET_VIEW = 'SITE_WALLET_VIEW';
export const SITE_WALLET_MANAGE = 'SITE_WALLET_MANAGE';
export const FINANCE_WALLET_READ = 'FINANCE_WALLET_READ';
export const FINANCE_WALLET_MANAGE = 'FINANCE_WALLET_MANAGE';
export const DOCUMENT_LINK_KEY = 'DOCUMENT_LINK';

/** Employee operation keys — reused verbatim from the existing catalogue. */
export const OPS = {
  FUNDING_SUBMIT: 'PETTY_CASH_REQUEST_SUBMIT',
  FUNDING_REVIEW: 'PETTY_CASH_REQUEST_REVIEW',
  EXPENSE_SUBMIT: 'PETTY_CASH_EXPENSE_SUBMIT',
  EXPENSE_REVIEW: 'PETTY_CASH_EXPENSE_REVIEW',
  SITE_REPORT_VIEW: 'PROJECT_WALLET_REPORT_VIEW',
  FINANCE_REPORT_VIEW: 'FINANCE_WALLET_REPORT_VIEW',
  LEDGER_VIEW: 'PROJECT_WALLET_LEDGER_VIEW',
  RECEIPT_CONFIRM: 'PROJECT_WALLET_RECEIPT_CONFIRM',
  CREDIT_PROCESS: 'PROJECT_WALLET_CREDIT_PROCESS',
  RECONCILE: 'PROJECT_WALLET_RECONCILE',
  RETURN_FUNDS: 'PROJECT_WALLET_RETURN_FUNDS',
} as const;

export const INR = 'INR';
export const WALLET_FUNDING_OPERATION_KEY = 'WALLET-FUNDING-REQUEST';

export interface Page {
  cursor?: string;
  limit?: number;
  offset?: number;
  page?: number;
  q?: string;
}

export interface FundingRequestCreateInput {
  amount: string;
  purpose: string;
  neededByDate?: string;
  idempotencyKey: string;
}

export interface FundingRequestUpdateInput {
  amount?: string;
  purpose?: string;
  neededByDate?: string | null;
  expectedVersion: number;
}

export interface SubmitInput {
  idempotencyKey: string;
}

export interface TransferRecordInput {
  amount: string;
  reference: string;
  transferredAt?: string;
  idempotencyKey: string;
}

export interface ConfirmReceiptInput {
  receivedAmount: string;
  discrepancyNote?: string;
  idempotencyKey: string;
}

export interface ResolveDisputeInput {
  resolution: 'ACKNOWLEDGED' | 'SUPPLEMENTARY_PENDING';
  note: string;
  idempotencyKey: string;
}

export interface CloseShortInput {
  reason: string;
  idempotencyKey: string;
}

export interface ReduceApprovedAmountInput {
  approvedAmount: string;
  reason: string;
  expectedVersion: number;
}

export interface CancelTransferInput {
  reason: string;
  expectedVersion: number;
}

export interface ExpenseLineInput {
  accountHeadId: string;
  amount: string;
}

export interface ExpenseCreateInput {
  amount: string;
  expenseDate: string;
  description: string;
  payee?: string;
  reference?: string;
  accountLines: ExpenseLineInput[];
  documentIds?: string[];
  voucher?: { paidTo?: string; narration?: string };
  idempotencyKey: string;
}

export interface ReversalRequestInput {
  reason: string;
  idempotencyKey: string;
}

export interface ReverseExecuteInput {
  reason?: string;
  reversalRequestId?: string;
  idempotencyKey: string;
}

export interface AccountHeadCreateInput {
  code: string;
  name: string;
  idempotencyKey?: string;
}

export interface AccountHeadUpdateInput {
  name?: string;
  status?: 'ACTIVE' | 'INACTIVE';
  expectedVersion: number;
}
