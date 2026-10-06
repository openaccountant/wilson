import { useEffect, useMemo, useState } from 'react';
import { useApi } from '@/hooks/useApi';
import { useRovingList } from '@/hooks/useRovingList';
import { ChartCard } from '@/charts/ChartCard';
import { useCategoryColor } from '@/charts/usePalette';
import { chartTokens } from '@/charts/tokens';
import {
  buildSeriesBars,
  isNeutralDrillLabel,
  seriesTableData,
  seriesWindow,
  shortDate,
  transactionsHash,
  txnCountLabel,
  type CompareMode,
} from '@/lib/drill';
import {
  breakdownPath,
  merchantTransactionsPath,
  pageCount,
  seriesPath,
  TXN_PAGE_SIZE,
  type BreakdownResponse,
  type SeriesResponse,
} from '@/lib/spendingApi';
import { formatDate, money } from '@/format';
import type { Transaction } from '@/types';
import type { DrillCtx } from './drillContext';
import { DrillEmpty, DrillLink, DrillTotal } from './DrillStates';
import { MonthBars } from './MonthBars';

/**
 * L3 — one merchant (optionally within a category; 'all KFC' without one):
 * total, count and last date; the merchant's trailing-12-month bars; and a
 * paged transaction table (50/page, SQL offset) read with `merchantExact` —
 * the drill key is never sent as the fuzzy `merchant` param.
 */
export function SpendingLevel3({ ctx, onRows }: { ctx: DrillCtx; onRows: (rows: Transaction[]) => void }) {
  const merchant = ctx.drill.merchant as string;
  const cat = ctx.drill.cat;
  const colorFor = useCategoryColor();
  const { chartNeutral, chartNeutralBar } = chartTokens();
  const slotted = cat && !isNeutralDrillLabel(cat) ? colorFor(cat) : chartNeutral;
  const color = slotted === chartNeutral ? chartNeutralBar : slotted;
  const cmp = (ctx.url.cmp ?? null) as CompareMode | null;
  const scope = { startDate: ctx.startDate, endDate: ctx.endDate, accountId: ctx.accountId, entityId: ctx.entityId, cat, merchant };

  const { data: summary, loading: fetching, error, offline } = useApi<BreakdownResponse>(
    ctx.compareReady
      ? breakdownPath({ ...scope, by: 'merchant', limit: 1, compareStart: ctx.compare?.compareStart, compareEnd: ctx.compare?.compareEnd })
      : null,
  );
  const loading = fetching || !ctx.compareReady;
  const win = seriesWindow(ctx.coverage?.end, ctx.today);
  const { data: series } = useApi<SeriesResponse>(
    ctx.coverageReady ? seriesPath({ ...scope, startDate: win.startDate, endDate: win.endDate }) : null,
  );
  const range = useMemo(() => ({ startDate: ctx.startDate, endDate: ctx.endDate }), [ctx.startDate, ctx.endDate]);
  const coverageEnd = ctx.coverage?.end ?? null;
  const seriesModel = useMemo(() => buildSeriesBars(series, range, { coverageEnd }), [series, range, coverageEnd]);

  const [page, setPage] = useState(0);
  const scopeKey = `${merchant}|${cat}|${ctx.startDate}|${ctx.endDate}|${ctx.accountId}|${ctx.entityId}`;
  useEffect(() => setPage(0), [scopeKey]);
  const txPath = merchantTransactionsPath({
    startDate: ctx.startDate,
    endDate: ctx.endDate,
    merchant,
    cat,
    accountId: ctx.accountId,
    entityId: ctx.entityId,
    page,
  });
  const { data: txns, loading: txLoading } = useApi<Transaction[]>(txPath);
  useEffect(() => {
    if (txns) onRows(txns);
  }, [txns, onRows]);

  const rows = txns ?? [];
  const { itemProps } = useRovingList(rows.length);
  const reportCount = ctx.reportCount;
  const reportedCount = summary?.count ?? null;
  useEffect(() => reportCount(reportedCount), [reportCount, reportedCount]);
  const total = summary?.total ?? 0;
  const count = summary?.count ?? 0;
  const last = summary?.rows.reduce<string | null>((m, r) => (r.last && (!m || r.last > m) ? r.last : m), null) ?? null;
  const pages = pageCount(count, TXN_PAGE_SIZE);
  const hasData = !!summary && (total > 0 || count > 0);

  if (offline && !summary) {
    return (
      <ChartCard title={merchant} headingRef={ctx.headingRef} above={ctx.above} loading={false} hasData={false} height={240}
        empty={<p className="text-sm text-text-secondary">Unavailable offline — requires the server</p>} />
    );
  }

  return (
    <ChartCard
      title={merchant}
      headingRef={ctx.headingRef}
      above={ctx.above}
      takeaway={hasData ? `${txnCountLabel(count)} at ${merchant}, ${money(total)} in ${ctx.periodLabel}.` : undefined}
      loading={loading}
      hasData={hasData}
      height={260}
      empty={<DrillEmpty ctx={ctx} error={error} />}
      // The transactions below are already a table; the toggle adds the
      // 12-month series as one.
      table={seriesTableData(seriesModel.bars, seriesModel.average, `${merchant}: monthly spend, last 12 months.`)}
    >
      <DrillTotal
        total={total}
        prevTotal={ctx.compare ? summary?.prevTotal : undefined}
        cmp={cmp}
        compareCaption={ctx.compare?.caption}
        caption={`${txnCountLabel(count)} · last ${shortDate(last)}${cat ? ` · in ${cat}` : ' · all categories'}`}
        action={<DrillLink href={transactionsHash(ctx.url, { cat, merchant })}>Open in Transactions →</DrillLink>}
      />
      <div className="mb-4">
        <MonthBars
          model={seriesModel}
          color={color}
          coverageEnd={coverageEnd}
          label={`${merchant}: monthly spend, last 12 months. Choose a month to show it.`}
          onSelect={ctx.selectMonth}
        />
      </div>

      <div className={`transition-opacity ${txLoading && txns ? 'opacity-60' : ''}`} aria-busy={txLoading || undefined}>
        <table className="w-full text-xs border-collapse">
          <caption className="sr-only">
            Transactions at {merchant}, page {page + 1} of {pages}. Enter opens details.
          </caption>
          <thead>
            <tr className="text-text-secondary">
              <th scope="col" className="text-left font-medium py-1 px-1.5 border-b border-border">Date</th>
              <th scope="col" className="text-left font-medium py-1 px-1.5 border-b border-border">Description</th>
              <th scope="col" className="text-left font-medium py-1 px-1.5 border-b border-border">Account</th>
              <th scope="col" className="text-right font-medium py-1 px-1.5 border-b border-border">Amount</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((tx, i) => {
              const props = itemProps(i, (el) => ctx.registerRow(`txn:${tx.id}`, el));
              return (
                <tr key={tx.id} className="border-b border-border-muted last:border-0 hover:bg-surface">
                  <td className="py-1 px-1.5 whitespace-nowrap font-mono text-text-secondary">{formatDate(tx.date)}</td>
                  <td className="py-1 px-1.5 max-w-0 w-full">
                    <button
                      type="button"
                      {...props}
                      onClick={() => ctx.openTxn(tx.id)}
                      className="block w-full text-left truncate bg-transparent border-none p-0 text-text cursor-pointer hover:text-green focus:outline-none focus-visible:ring-1 focus-visible:ring-green/60 rounded-sm"
                      title={tx.description}
                    >
                      {tx.description}
                    </button>
                  </td>
                  <td className="py-1 px-1.5 whitespace-nowrap text-text-secondary">{tx.account_name ?? '—'}</td>
                  <td className="py-1 px-1.5 text-right tabular-nums text-text whitespace-nowrap">{money(Math.abs(tx.amount))}</td>
                </tr>
              );
            })}
            {rows.length === 0 && !txLoading && (
              <tr>
                <td colSpan={4} className="py-3 text-center text-text-secondary">
                  No transactions on this page.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {pages > 1 && (
          <nav aria-label="Transaction pages" className="flex items-center justify-end gap-2 mt-2 text-xs">
            <button
              type="button"
              disabled={page === 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              className="min-h-6 px-2 py-0.5 rounded border border-border bg-transparent text-text-secondary cursor-pointer disabled:opacity-40 disabled:cursor-default"
            >
              ← Prev
            </button>
            <span className="text-text-secondary tabular-nums" aria-live="polite">
              Page {page + 1} of {pages}
            </span>
            <button
              type="button"
              disabled={page >= pages - 1}
              onClick={() => setPage((p) => Math.min(pages - 1, p + 1))}
              className="min-h-6 px-2 py-0.5 rounded border border-border bg-transparent text-text-secondary cursor-pointer disabled:opacity-40 disabled:cursor-default"
            >
              Next →
            </button>
          </nav>
        )}
      </div>
    </ChartCard>
  );
}
