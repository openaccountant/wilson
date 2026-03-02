import { z } from 'zod';
import { defineTool } from '../define-tool.js';
import { formatToolResult } from '../types.js';
import type { Database } from '../../db/compat-sqlite.js';
import { hasLicense } from '../../licensing/license.js';
import {
  insertLoan,
  updateLoan,
  getLoanByAccountId,
  getLoans,
  getAccountById,
} from '../../db/net-worth-queries.js';
import { calculateAmortization } from './amortization.js';

let db: Database;

export function initMortgageManageTool(database: Database) {
  db = database;
}

export const mortgageManageTool = defineTool({
  name: 'mortgage_manage',
  description: 'Manage loans and view amortization schedules, payoff simulations.',
  schema: z.object({
    action: z.enum(['add', 'update', 'schedule', 'summary', 'payoff']).describe(
      'add: create loan record. update: modify loan. schedule: show amortization. summary: all loans. payoff: simulate early payoff.'
    ),
    accountId: z.number().optional().describe('Liability account ID (required for add/update/schedule/payoff)'),
    originalPrincipal: z.number().optional().describe('Original loan amount (required for add)'),
    interestRate: z.number().optional().describe('Annual interest rate as percentage, e.g. 6.5 for 6.5% (required for add)'),
    termMonths: z.number().optional().describe('Loan term in months (required for add)'),
    startDate: z.string().optional().describe('Loan start date YYYY-MM-DD (required for add)'),
    linkedAssetId: z.number().optional().describe('ID of the financed asset account'),
    extraPayment: z.number().optional().describe('Extra monthly payment amount'),
    showMonths: z.number().optional().describe('Number of months to show in schedule (default: all)'),
    notes: z.string().optional().describe('Notes about this loan'),
  }),
  func: async (args) => {
    if (!hasLicense('pro')) {
      return formatToolResult({ error: 'Mortgage management requires a Pro license.' });
    }

    switch (args.action) {
      case 'add': {
        if (!args.accountId) return formatToolResult({ error: 'accountId is required' });
        if (!args.originalPrincipal) return formatToolResult({ error: 'originalPrincipal is required' });
        if (args.interestRate === undefined) return formatToolResult({ error: 'interestRate is required' });
        if (!args.termMonths) return formatToolResult({ error: 'termMonths is required' });
        if (!args.startDate) return formatToolResult({ error: 'startDate is required' });

        const account = getAccountById(db, args.accountId);
        if (!account) return formatToolResult({ error: `Account #${args.accountId} not found` });
        if (account.account_type !== 'liability') {
          return formatToolResult({ error: 'Loans can only be attached to liability accounts' });
        }

        // Convert user-friendly rate (6.5) to decimal (0.065)
        const rate = args.interestRate / 100;

        const id = insertLoan(db, {
          account_id: args.accountId,
          original_principal: args.originalPrincipal,
          interest_rate: rate,
          term_months: args.termMonths,
          start_date: args.startDate,
          extra_payment: args.extraPayment,
          linked_asset_id: args.linkedAssetId,
          notes: args.notes,
        });

        const schedule = calculateAmortization({
          principal: args.originalPrincipal,
          annualRate: rate,
          termMonths: args.termMonths,
          startDate: args.startDate,
        });

        return formatToolResult({
          message: `Loan #${id} created for ${account.name}`,
          monthlyPayment: schedule.monthlyPayment,
          totalInterest: schedule.totalInterest,
          totalPaid: schedule.totalPaid,
          payoffMonths: schedule.payoffMonths,
        });
      }

      case 'update': {
        if (!args.accountId) return formatToolResult({ error: 'accountId is required' });
        const loan = getLoanByAccountId(db, args.accountId);
        if (!loan) return formatToolResult({ error: `No loan found for account #${args.accountId}` });

        const updated = updateLoan(db, loan.id, {
          interest_rate: args.interestRate !== undefined ? args.interestRate / 100 : undefined,
          extra_payment: args.extraPayment,
          linked_asset_id: args.linkedAssetId,
          notes: args.notes,
        });
        if (!updated) return formatToolResult({ error: 'No changes made' });
        return formatToolResult({ message: `Loan for account #${args.accountId} updated` });
      }

      case 'schedule': {
        if (!args.accountId) return formatToolResult({ error: 'accountId is required' });
        const loan = getLoanByAccountId(db, args.accountId);
        if (!loan) return formatToolResult({ error: `No loan found for account #${args.accountId}` });

        const schedule = calculateAmortization({
          principal: loan.original_principal,
          annualRate: loan.interest_rate,
          termMonths: loan.term_months,
          extraPayment: loan.extra_payment,
          startDate: loan.start_date,
        });

        const payments = args.showMonths
          ? schedule.payments.slice(0, args.showMonths)
          : schedule.payments;

        return formatToolResult({
          monthlyPayment: schedule.monthlyPayment,
          totalInterest: schedule.totalInterest,
          totalPaid: schedule.totalPaid,
          payoffMonths: schedule.payoffMonths,
          payments: payments.map((p) => ({
            month: p.month,
            date: p.date,
            payment: p.payment,
            principal: p.principal,
            interest: p.interest,
            balance: p.balance,
          })),
        });
      }

      case 'summary': {
        const loans = getLoans(db);
        if (loans.length === 0) {
          return formatToolResult({ message: 'No loans configured.' });
        }
        return formatToolResult({
          count: loans.length,
          loans: loans.map((l) => ({
            accountId: l.account_id,
            name: l.account_name,
            principal: l.original_principal,
            rate: `${(l.interest_rate * 100).toFixed(2)}%`,
            termMonths: l.term_months,
            extraPayment: l.extra_payment,
            startDate: l.start_date,
          })),
        });
      }

      case 'payoff': {
        if (!args.accountId) return formatToolResult({ error: 'accountId is required' });
        const loan = getLoanByAccountId(db, args.accountId);
        if (!loan) return formatToolResult({ error: `No loan found for account #${args.accountId}` });

        const extra = args.extraPayment ?? 0;

        const baseSchedule = calculateAmortization({
          principal: loan.original_principal,
          annualRate: loan.interest_rate,
          termMonths: loan.term_months,
          startDate: loan.start_date,
        });

        const extraSchedule = calculateAmortization({
          principal: loan.original_principal,
          annualRate: loan.interest_rate,
          termMonths: loan.term_months,
          extraPayment: extra,
          startDate: loan.start_date,
        });

        return formatToolResult({
          withoutExtra: {
            monthlyPayment: baseSchedule.monthlyPayment,
            payoffMonths: baseSchedule.payoffMonths,
            totalInterest: baseSchedule.totalInterest,
            totalPaid: baseSchedule.totalPaid,
          },
          withExtra: {
            monthlyPayment: baseSchedule.monthlyPayment + extra,
            extraPerMonth: extra,
            payoffMonths: extraSchedule.payoffMonths,
            totalInterest: extraSchedule.totalInterest,
            totalPaid: extraSchedule.totalPaid,
          },
          savings: {
            monthsSaved: baseSchedule.payoffMonths - extraSchedule.payoffMonths,
            interestSaved: baseSchedule.totalInterest - extraSchedule.totalInterest,
          },
        });
      }

      default:
        return formatToolResult({ error: `Unknown action: ${args.action}` });
    }
  },
});
