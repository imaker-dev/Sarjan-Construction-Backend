import { ConflictError } from '../../common/errors/app-error.js';

/** Wallet/request/transfer/expense in a state that forbids the operation. */
export class WalletStateError extends ConflictError {
  constructor(message: string) {
    super('WALLET_STATE', message);
  }
}

/** Expense/reversal would drive the wallet balance negative. */
export class InsufficientWalletBalanceError extends ConflictError {
  constructor() {
    super('INSUFFICIENT_WALLET_BALANCE', 'wallet balance cannot cover this debit');
  }
}

/** Repeated mutation would exceed the approved or transferred amounts. */
export class WalletLimitError extends ConflictError {
  constructor(message: string) {
    super('WALLET_LIMIT', message);
  }
}
