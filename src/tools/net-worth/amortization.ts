// ── Types ────────────────────────────────────────────────────────────────────

export interface AmortizationInput {
  principal: number;
  annualRate: number;       // decimal: 0.065 = 6.5%
  termMonths: number;
  extraPayment?: number;    // additional monthly payment
  startDate: string;        // YYYY-MM-DD
}

export interface AmortizationPayment {
  month: number;
  date: string;             // YYYY-MM-DD
  payment: number;
  principal: number;
  interest: number;
  extraPayment: number;
  balance: number;
  cumulativeInterest: number;
  cumulativePrincipal: number;
}

export interface AmortizationSchedule {
  monthlyPayment: number;
  totalInterest: number;
  totalPaid: number;
  payoffMonths: number;
  payments: AmortizationPayment[];
}

// ── Core Math ────────────────────────────────────────────────────────────────

/**
 * Calculate full amortization schedule.
 * Standard formula: M = P[r(1+r)^n] / [(1+r)^n - 1]
 */
export function calculateAmortization(input: AmortizationInput): AmortizationSchedule {
  const { principal, annualRate, termMonths, extraPayment = 0, startDate } = input;

  if (principal <= 0) return emptySchedule();
  if (termMonths <= 0) return emptySchedule();

  const monthlyRate = annualRate / 12;

  // Zero-rate edge case (0% financing)
  const basePayment = monthlyRate === 0
    ? principal / termMonths
    : (principal * monthlyRate * Math.pow(1 + monthlyRate, termMonths)) /
      (Math.pow(1 + monthlyRate, termMonths) - 1);

  const payments: AmortizationPayment[] = [];
  let balance = principal;
  let cumulativeInterest = 0;
  let cumulativePrincipal = 0;
  const [startYear, startMonth] = startDate.split('-').map(Number);

  for (let month = 1; balance > 0.005; month++) {
    const interest = balance * monthlyRate;
    let principalPart = basePayment - interest;
    let extra = extraPayment;

    // Don't overpay on the last payment
    if (principalPart + extra > balance) {
      if (principalPart > balance) {
        principalPart = balance;
        extra = 0;
      } else {
        extra = Math.min(extra, balance - principalPart);
      }
    }

    balance -= principalPart + extra;
    if (balance < 0.005) balance = 0;

    cumulativeInterest += interest;
    cumulativePrincipal += principalPart + extra;

    const paymentDate = new Date(startYear, startMonth - 1 + month, 1);
    const dateStr = `${paymentDate.getFullYear()}-${String(paymentDate.getMonth() + 1).padStart(2, '0')}-01`;

    payments.push({
      month,
      date: dateStr,
      payment: round(principalPart + interest + extra),
      principal: round(principalPart),
      interest: round(interest),
      extraPayment: round(extra),
      balance: round(balance),
      cumulativeInterest: round(cumulativeInterest),
      cumulativePrincipal: round(cumulativePrincipal),
    });
  }

  return {
    monthlyPayment: round(basePayment),
    totalInterest: round(cumulativeInterest),
    totalPaid: round(cumulativePrincipal + cumulativeInterest),
    payoffMonths: payments.length,
    payments,
  };
}

/**
 * Get remaining loan balance at a target date by walking the amortization schedule.
 */
export function getRemainingBalanceAtDate(input: AmortizationInput, targetDate: string): number {
  const schedule = calculateAmortization(input);

  if (schedule.payments.length === 0) return input.principal;

  // Find the last payment on or before targetDate
  for (let i = schedule.payments.length - 1; i >= 0; i--) {
    if (schedule.payments[i].date <= targetDate) {
      return schedule.payments[i].balance;
    }
  }

  // Target date is before first payment
  return input.principal;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function emptySchedule(): AmortizationSchedule {
  return { monthlyPayment: 0, totalInterest: 0, totalPaid: 0, payoffMonths: 0, payments: [] };
}
