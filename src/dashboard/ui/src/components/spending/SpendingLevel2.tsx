import { useEffect, useMemo } from 'react';
import { useApi } from '@/hooks/useApi';
import { ChartCard } from '@/charts/ChartCard';
import { useCategoryColor } from '@/charts/usePalette';
import { chartTokens } from '@/charts/tokens';
import {
  breakdownTableData,
  buildSeriesBars,
  byPatch,
  categorizeLabel,
  drillIntoPatch,
  foldTopN,
  isDrillable,
  isNeutralDrillLabel,
  L2_TOP_N,
  seeAllLabel,
  seriesTableData,
  seriesWindow,
  shareLabel,
  transactionsHash,
  type CompareMode,
  type DrillBy,
} from '@/lib/drill';
import { isUncategorized } from '../../../../../db/spend-rules.js';
import { breakdownPath, seriesPath, type BreakdownResponse, type SeriesResponse } from '@/lib/spendingApi';
import { money } from '@/format';
import type { DrillCtx } from './drillContext';
import { DrillBarList, FoldedRow, type BarItem } from './DrillBarList';
import { DrillEmpty, DrillLink, DrillTotal, ExcludedFootnote } from './DrillStates';
import { MonthBars } from './MonthBars';

/**
 * L2 — one category: top 12 merchants (or category_detailed values with
 * by=detailed) as bars, 'Other merchants (N) $Y' as a TEXT row (not scaled),
 * and beside it the trailing-12-month bars for the category.
 */
export function SpendingLevel2({ ctx }: { ctx: DrillCtx }) {
  const cat = ctx.drill.cat as string;
  const by: DrillBy = ctx.drill.by;
  const colorFor = useCategoryColor();
  const { chartNeutral, chartNeutralBar } = chartTokens();
  // Bar marks: a neutral / unslotted category draws the brighter bar neutral (>= 3:1).
  const slotted = isNeutralDrillLabel(cat) ? chartNeutral : colorFor(cat);
  const color = slotted === chartNeutral ? chartNeutralBar : slotted;
  const cmp = (ctx.url.cmp ?? null) as CompareMode | null;
  const scope = { startDate: ctx.startDate, endDate: ctx.endDate, accountId: ctx.accountId, entityId: ctx.entityId, cat };

  const { data, loading: fetching, error, offline } = useApi<BreakdownResponse>(
    ctx.compareReady
      ? breakdownPath({
          ...scope,
          by,
          limit: L2_TOP_N,
          compareStart: ctx.compare?.compareStart,
          compareEnd: ctx.compare?.compareEnd,
        })
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

  const { visible, more } = useMemo(
    () => (data ? foldTopN(data, L2_TOP_N, 'merchant') : { visible: [], more: null }),
    [data],
  );
  const drillable = isDrillable(ctx.drill);
  const items: BarItem[] = visible.map((r) => ({
    key: r.key,
    label: r.label,
    total: r.total,
    count: r.count,
    prevTotal: ctx.compare ? r.prevTotal : undefined,
    color,
    action: drillable ? 'drill' : 'none',
  }));
  const reportCount = ctx.reportCount;
  const reportedCount = data?.count ?? null;
  useEffect(() => reportCount(reportedCount), [reportCount, reportedCount]);
  const rowsSettled = ctx.rowsSettled;
  useEffect(() => {
    if (data) rowsSettled();
  }, [data, rowsSettled]);
  const total = data?.total ?? 0;
  const count = data?.count ?? 0;
  const hasData = !!data && total > 0;
  const uncategorized = isUncategorized(cat);
  const seeAll = transactionsHash(ctx.url, { cat });
  const top = visible[0];
  const noun = by === 'detailed' ? 'subcategory' : 'merchant';
  const takeaway =
    hasData && top ? `${top.label} is the top ${noun} at ${shareLabel(top.total, total)} of ${money(total)}.` : undefined;

  if (offline && !data) {
    return (
      <ChartCard title={cat} headingRef={ctx.headingRef} above={ctx.above} loading={false} hasData={false} height={240}
        empty={<p className="text-sm text-text-secondary">Unavailable offline — requires the server</p>} />
    );
  }

  const showByToggle = (data?.hasDetailed ?? false) || by === 'detailed';
  const otherText = more
    ? `Other ${by === 'detailed' ? 'subcategories' : 'merchants'} (${more.groups.toLocaleString('en-US')})`
    : '';

  return (
    <ChartCard
      title={cat}
      headingRef={ctx.headingRef}
      above={ctx.above}
      takeaway={takeaway}
      loading={loading}
      hasData={hasData}
      height={260}
      empty={<DrillEmpty ctx={ctx} error={error} />}
      headerRight={
        showByToggle ? (
          <div role="group" aria-label="Group by" className="flex rounded border border-border overflow-hidden">
            {(['merchant', 'detailed'] as const).map((b) => (
              <button
                key={b}
                type="button"
                aria-pressed={by === b}
                onClick={() => by !== b && ctx.go(byPatch(ctx.drill, b), 'by')}
                className={`text-[10px] uppercase tracking-wide min-h-6 px-2 py-0.5 border-none cursor-pointer ${
                  by === b ? 'bg-green/10 text-green' : 'bg-transparent text-text-secondary hover:text-text'
                }`}
              >
                {b === 'merchant' ? 'Merchant' : 'Detailed'}
              </button>
            ))}
          </div>
        ) : undefined
      }
      table={[
        breakdownTableData({
          rows: visible,
          more,
          moreText: otherText,
          total,
          cmp: ctx.compare ? cmp : null,
          firstColumn: by === 'detailed' ? 'Subcategory' : 'Merchant',
          caption: `${cat} by ${by === 'detailed' ? 'subcategory' : 'merchant'}, ${ctx.periodLabel}.`,
        }),
        seriesTableData(seriesModel.bars, seriesModel.average, `${cat}: monthly spend, last 12 months.`),
      ]}
      footer={data ? <ExcludedFootnote excludedTotal={data.excludedTotal} /> : null}
    >
      <DrillTotal
        total={total}
        prevTotal={ctx.compare ? data?.prevTotal : undefined}
        cmp={cmp}
        compareCaption={ctx.compare?.caption}
        caption={ctx.periodLabel}
        action={
          uncategorized ? (
            <DrillLink href={seeAll}>{categorizeLabel(count)} →</DrillLink>
          ) : (
            <DrillLink href={seeAll}>{seeAllLabel(count)} →</DrillLink>
          )
        }
      />
      <div className="@container">
        <div className="grid grid-cols-1 @2xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-5 items-start">
          <div className="min-w-0">
            <DrillBarList
              items={items}
              periodTotal={total}
              cmp={ctx.compare ? cmp : null}
              label={
                drillable
                  ? `Merchants in ${cat}, ranked by amount. Enter to drill in.`
                  : `Subcategories in ${cat}, ranked by amount.`
              }
              registerRow={ctx.registerRow}
              onActivate={(it) => {
                const patch = drillIntoPatch(ctx.drill, it.key);
                if (patch) ctx.go(patch, 'drill');
              }}
            />
            {more && <FoldedRow label={otherText} total={more.total} count={more.count} periodTotal={total} />}
          </div>
          <MonthBars
            model={seriesModel}
            color={color}
            coverageEnd={coverageEnd}
            label={`${cat}: monthly spend, last 12 months. Choose a month to show it.`}
            onSelect={ctx.selectMonth}
          />
        </div>
      </div>
    </ChartCard>
  );
}
