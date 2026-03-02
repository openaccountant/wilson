import { describe, expect, test } from 'bun:test';
import { calculateAmortization, getRemainingBalanceAtDate } from '../tools/net-worth/amortization.js';

describe('amortization', () => {
  test('standard 30yr mortgage', () => {
    const schedule = calculateAmortization({
      principal: 300000,
      annualRate: 0.065,
      termMonths: 360,
      startDate: '2024-01-01',
    });

    expect(schedule.monthlyPayment).toBeCloseTo(1896.20, 0);
    expect(schedule.payoffMonths).toBe(360);
    expect(schedule.totalPaid).toBeGreaterThan(300000);
    expect(schedule.totalInterest).toBeGreaterThan(0);
    expect(schedule.payments.length).toBe(360);

    // First payment should be mostly interest
    const first = schedule.payments[0];
    expect(first.interest).toBeGreaterThan(first.principal);

    // Last payment should be mostly principal
    const last = schedule.payments[schedule.payments.length - 1];
    expect(last.balance).toBe(0);
  });

  test('extra payments reduce payoff time', () => {
    const base = calculateAmortization({
      principal: 300000,
      annualRate: 0.065,
      termMonths: 360,
      startDate: '2024-01-01',
    });

    const withExtra = calculateAmortization({
      principal: 300000,
      annualRate: 0.065,
      termMonths: 360,
      extraPayment: 500,
      startDate: '2024-01-01',
    });

    expect(withExtra.payoffMonths).toBeLessThan(base.payoffMonths);
    expect(withExtra.totalInterest).toBeLessThan(base.totalInterest);
  });

  test('zero rate (0% financing)', () => {
    const schedule = calculateAmortization({
      principal: 24000,
      annualRate: 0,
      termMonths: 48,
      startDate: '2024-01-01',
    });

    expect(schedule.monthlyPayment).toBe(500);
    expect(schedule.totalInterest).toBe(0);
    expect(schedule.totalPaid).toBe(24000);
    expect(schedule.payoffMonths).toBe(48);
  });

  test('zero principal returns empty schedule', () => {
    const schedule = calculateAmortization({
      principal: 0,
      annualRate: 0.065,
      termMonths: 360,
      startDate: '2024-01-01',
    });

    expect(schedule.payments.length).toBe(0);
    expect(schedule.monthlyPayment).toBe(0);
  });

  test('getRemainingBalanceAtDate', () => {
    const input = {
      principal: 300000,
      annualRate: 0.065,
      termMonths: 360,
      startDate: '2024-01-01',
    };

    // Before first payment
    expect(getRemainingBalanceAtDate(input, '2024-01-15')).toBe(300000);

    // After 12 months — balance should be less
    const after12 = getRemainingBalanceAtDate(input, '2025-01-15');
    expect(after12).toBeLessThan(300000);
    expect(after12).toBeGreaterThan(290000);

    // Way past end
    const afterEnd = getRemainingBalanceAtDate(input, '2060-01-01');
    expect(afterEnd).toBe(0);
  });

  test('payment dates are sequential', () => {
    const schedule = calculateAmortization({
      principal: 10000,
      annualRate: 0.05,
      termMonths: 12,
      startDate: '2024-06-01',
    });

    expect(schedule.payments[0].date).toBe('2024-07-01');
    expect(schedule.payments[11].date).toBe('2025-06-01');
  });

  test('cumulative totals are correct', () => {
    const schedule = calculateAmortization({
      principal: 100000,
      annualRate: 0.04,
      termMonths: 60,
      startDate: '2024-01-01',
    });

    const last = schedule.payments[schedule.payments.length - 1];
    expect(last.cumulativeInterest).toBeCloseTo(schedule.totalInterest, 0);
    expect(last.cumulativePrincipal).toBeCloseTo(100000, 0);
  });
});
