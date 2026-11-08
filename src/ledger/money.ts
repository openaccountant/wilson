import { InvalidMoneyError } from './errors.js';

/** Integer cents. Always a JS number that satisfies Number.isSafeInteger. */
export type Cents = number;

/** Throws InvalidMoneyError unless value is a safe integer. */
export function assertCents(value: unknown, field: string): asserts value is Cents {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new InvalidMoneyError(field, value);
  }
}

/** Like assertCents but also requires value >= 0. */
export function assertNonNegativeCents(value: unknown, field: string): asserts value is Cents {
  assertCents(value, field);
  if (value < 0) throw new InvalidMoneyError(field, value);
}

/** Adds cents, refusing to leave the safe-integer range. */
export function addCents(a: Cents, b: Cents, field = 'sum'): Cents {
  const s = a + b;
  assertCents(s, field);
  return s;
}
