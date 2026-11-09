/** Typed errors raised by the ledger engine. All extend {@link LedgerError}. */

export type LedgerErrorCode =
  | 'INVALID_MONEY'
  | 'VALIDATION'
  | 'UNBALANCED'
  | 'NOT_FOUND'
  | 'INACTIVE_ACCOUNT'
  | 'CONFLICT'
  | 'ALREADY_VOIDED'
  | 'PERIOD_LOCKED';

export class LedgerError extends Error {
  readonly code: LedgerErrorCode;
  constructor(code: LedgerErrorCode, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

/** A money value was not a safe integer number of cents (floats, NaN, strings, bigints...). */
export class InvalidMoneyError extends LedgerError {
  constructor(field: string, value: unknown) {
    super('INVALID_MONEY', `${field} must be a safe integer number of cents, got ${describe(value)}`);
  }
}

export class LedgerValidationError extends LedgerError {
  constructor(message: string) {
    super('VALIDATION', message);
  }
}

export class UnbalancedEntryError extends LedgerError {
  readonly debit_cents: number;
  readonly credit_cents: number;
  constructor(debit: number, credit: number) {
    super('UNBALANCED', `journal entry is unbalanced: debits ${debit} != credits ${credit}`);
    this.debit_cents = debit;
    this.credit_cents = credit;
  }
}

export class NotFoundError extends LedgerError {
  constructor(what: string) {
    super('NOT_FOUND', `${what} not found`);
  }
}

export class InactiveAccountError extends LedgerError {
  constructor(code: string) {
    super('INACTIVE_ACCOUNT', `account ${code} is inactive`);
  }
}

/** Duplicate key, or an idempotent replay whose payload differs from the original. */
export class ConflictError extends LedgerError {
  constructor(message: string) {
    super('CONFLICT', message);
  }
}

export class AlreadyVoidedError extends LedgerError {
  constructor(entryId: number) {
    super('ALREADY_VOIDED', `journal entry ${entryId} has already been voided`);
  }
}

export class PeriodLockedError extends LedgerError {
  readonly locked_through: string;
  constructor(date: string, lockedThrough: string) {
    super('PERIOD_LOCKED', `date ${date} falls in a closed period (closed through ${lockedThrough})`);
    this.locked_through = lockedThrough;
  }
}

function describe(value: unknown): string {
  if (typeof value === 'number') return String(value);
  if (typeof value === 'bigint') return `${value}n (bigint)`;
  if (typeof value === 'string') return JSON.stringify(value) + ' (string)';
  return typeof value;
}
