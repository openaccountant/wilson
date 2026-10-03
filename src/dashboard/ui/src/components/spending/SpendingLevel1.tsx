import { useEffect, useMemo, useRef, useState } from 'react';
import { PieChart, Pie, Cell, Tooltip } from 'recharts';
import { api } from '@/api';
import { useApi } from '@/hooks/useApi';
import { ChartCard } from '@/charts/ChartCard';
import { ChartTooltip } from '@/charts/ChartTooltip';
import { useCategoryColor } from '@/charts/usePalette';
import { chartTokens } from '@/charts/tokens';
import {
  breakdownTableData,
  categorizeLabel,
  donutReplacement,
  donutSlices,
  drillIntoPatch,
  expandCapped,
  expandedRemainder,
  foldTopN,
  isNeutralDrillLabel,
  L1_TOP_N,
  mergeRows,
  MORE_KEY,
  nextExpandPage,
  shareLabel,
  transactionsHash,
  txnCountLabel,
  type CompareMode,
} from '@/lib/drill';
import { createRequestGate } from '@/lib/requestGate';
import { breakdownPath, type BreakdownResponse, type BreakdownRow } from '@/lib/spendingApi';
import { money, pct } from '@/format';
import type { DrillCtx } from './drillContext';
import { DrillBarList, FoldedRow, type BarItem } from './DrillBarList';
import { DrillEmpty, DrillLink, DrillTotal, ExcludedFootnote } from './DrillStates';

const DONUT_SIZE = 132;

/**
 * L1 — spending by category: a ranked bar list (top 7) with the folded tail
 * as a 'N more categories' TEXT row under it (not a scaled bar), and a SMALL
 * donut beside it (decorative: aria-hidden; the list carries the data).
 * Hovering a row highlights its slice and vice versa. 'N more' expands in
 * place, fetching 100 groups at a time up to 200 rendered rows; a response
 * for a scope that has since changed is dropped.
 */
export function SpendingLevel1({ ctx }: { ctx: DrillCtx }) {
  const colorFor = useCategoryColor();
  const neutral = chartTokens().chartNeutral; // donut slices (separated by strokes)
  const neutralBar = chartTokens().chartNeutralBar; // bar marks: >= 3:1
  const cmp = (ctx.url.cmp ?? null) as CompareMode | null;
  const scope = {
    startDate: ctx.startDate,
    endDate: ctx.endDate,
    accountId: ctx.accountId,
    entityId: ctx.entityId,
    compareStart: ctx.compare?.compareStart,
    compareEnd: ctx.compare?.compareEnd,
  };
  const path = breakdownPath({ ...scope, by: 'category', limit: L1_TOP_N });
  const { data, loading: fetching, error, offline } = useApi<BreakdownResponse>(ctx.compareReady ? path : null);
  const loading = fetching || !ctx.compareReady;
  const [highlight, setHighlight] = useState<string | null>(null);
  const listWrapRef = useRef<HTMLDivElement>(null);

  // ── 'N more' expansion (reset whenever the query changes) ──────────────
  const [expanded, setExpanded] = useState(false);
  const [expandedRows, setExpandedRows] = useState<BreakdownRow[]>([]);
  const [expandLoading, setExpandLoading] = useState(false);
  const [expandError, setExpandError] = useState<string | null>(null);
  const gateRef = useRef(createRequestGate(path));
  const pathRef = useRef(path);
  pathRef.current = path;
  useEffect(() => {
    gateRef.current.reset(path);
    setExpanded(false);
    setExpandedRows([]);
    setExpandError(null);
    setExpandLoading(false);
  }, [path]);

  const { visible, more } = useMemo(
    () => (data ? foldTopN(data, L1_TOP_N) : { visible: [], more: null }),
    [data],
  );
  const totalGroups = visible.length + (more?.groups ?? 0);

  async function loadMore(loaded: BreakdownRow[]) {
    const page = nextExpandPage(loaded.length, totalGroups);
    if (!page) return;
    const forPath = pathRef.current;
    const token = gateRef.current.begin(forPath);
    setExpandLoading(true);
    setExpandError(null);
    try {
      const resp = await api<BreakdownResponse>(breakdownPath({ ...scope, by: 'category', ...page }));
      // The range / scope moved on while this page was in flight: drop it.
      if (!gateRef.current.isCurrent(token, pathRef.current) || forPath !== pathRef.current) return;
      setExpandedRows(mergeRows(loaded, resp.rows));
      setExpanded(true);
      // Keep keyboard users in place: focus the first row that was revealed
      // (the 'N more' button they activated is gone now).
      const revealIndex = loaded.length === 0 ? L1_TOP_N : loaded.length;
      requestAnimationFrame(() => {
        const rows = listWrapRef.current?.querySelectorAll<HTMLElement>('ul > li > *');
        rows?.[Math.min(revealIndex, rows.length - 1)]?.focus();
      });
    } catch (err) {
      if (!gateRef.current.isCurrent(token, pathRef.current)) return;
      setExpandError(err instanceof Error ? err.message : String(err));
    } finally {
      if (gateRef.current.isCurrent(token, pathRef.current)) setExpandLoading(false);
    }
  }

  // Bars: unslotted / neutral labels draw the brighter bar-mark neutral.
  const rowColor = (label: string) => {
    if (isNeutralDrillLabel(label)) return neutralBar;
    const c = colorFor(label);
    return c === neutral ? neutralBar : c;
  };
  const toItem = (r: BreakdownRow): BarItem => ({
    key: r.key,
    label: r.label,
    total: r.total,
    count: r.count,
    prevTotal: ctx.compare ? r.prevTotal : undefined,
    color: rowColor(r.label),
    action: 'drill',
  });

  const items: BarItem[] = expanded ? expandedRows.map(toItem) : visible.map(toItem);

  const slices = useMemo(
    () => donutSlices(visible, more, (l) => colorFor(l), neutral),
    [visible, more, colorFor, neutral],
  );
  const replacement = data ? donutReplacement(data) : null;
  const reportCount = ctx.reportCount;
  const reportedCount = data?.count ?? null;
  useEffect(() => reportCount(reportedCount), [reportCount, reportedCount]);
  // Rows for this data have rendered (refs attached before effects): settle a
  // pending 'focus the row I came from' that has no row to land on.
  const rowsSettled = ctx.rowsSettled;
  useEffect(() => {
    if (data) rowsSettled();
  }, [data, expanded, rowsSettled]);
  const total = data?.total ?? 0;
  const hasData = !!data && data.total > 0;
  const top = visible[0];
  const takeaway =
    hasData && top ? `${top.label} leads at ${shareLabel(top.total, total)} of ${money(total)} spent.` : undefined;

  if (offline && !data) {
    return (
      <ChartCard title="Spending by category" headingRef={ctx.headingRef} above={ctx.above} loading={false} hasData={false} height={240}
        empty={<p className="text-sm text-text-secondary">Unavailable offline — requires the server</p>} />
    );
  }

  const canShowMore = expanded && nextExpandPage(expandedRows.length, totalGroups) != null;
  const capped = expanded && expandCapped(expandedRows.length, totalGroups);

  return (
    <ChartCard
      title="Spending by category"
      headingRef={ctx.headingRef}
      above={ctx.above}
      takeaway={takeaway}
      loading={loading}
      hasData={hasData}
      height={260}
      empty={<DrillEmpty ctx={ctx} error={error} />}
      table={breakdownTableData({
        rows: expanded ? expandedRows : visible,
        // Expanded rows are every group (up to the cap); the remainder folds.
        more: expanded
          ? expandedRemainder(expandedRows, { total, count: data?.count ?? 0, groups: totalGroups })
          : more,
        total,
        cmp: ctx.compare ? cmp : null,
        firstColumn: 'Category',
        caption: `Spending by category, ${ctx.periodLabel}.`,
      })}
      footer={data ? <ExcludedFootnote excludedTotal={data.excludedTotal} /> : null}
    >
      <DrillTotal
        total={total}
        prevTotal={ctx.compare ? data?.prevTotal : undefined}
        cmp={cmp}
        compareCaption={ctx.compare?.caption}
        caption={`${txnCountLabel(data?.count ?? 0)} · ${ctx.periodLabel}`}
      />
      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-4 items-start">
        <div className="min-w-0" ref={listWrapRef}>
          <DrillBarList
            items={items}
            periodTotal={total}
            cmp={ctx.compare ? cmp : null}
            label="Spending categories, ranked by amount. Enter to drill in."
            registerRow={ctx.registerRow}
            highlightKey={highlight}
            onHighlight={setHighlight}
            onActivate={(it) => {
              const patch = drillIntoPatch(ctx.drill, it.key);
              if (patch) ctx.go(patch, 'drill');
            }}
          />
          {!expanded && more && (
            <FoldedRow
              label={more.label}
              total={more.total}
              count={more.count}
              periodTotal={total}
              onExpand={() => void loadMore([])}
              disabled={expandLoading}
              buttonRef={(el) => ctx.registerRow(MORE_KEY, el)}
              highlighted={highlight == null ? null : highlight === MORE_KEY}
              onHighlight={(on) => setHighlight(on ? MORE_KEY : null)}
            />
          )}
          {expanded && (
            <div className="flex items-center gap-3 mt-2 text-xs">
              {canShowMore && (
                <button
                  type="button"
                  disabled={expandLoading}
                  onClick={() => void loadMore(expandedRows)}
                  className="min-h-6 px-2 py-1 rounded border border-border bg-transparent text-text-secondary hover:text-green cursor-pointer disabled:opacity-50"
                >
                  {expandLoading ? 'Loading…' : 'Show more'}
                </button>
              )}
              <button
                type="button"
                onClick={() => setExpanded(false)}
                className="min-h-6 px-2 py-1 rounded border border-transparent bg-transparent text-text-secondary hover:text-text cursor-pointer"
              >
                Show top {L1_TOP_N}
              </button>
              {capped && <DrillLink href={transactionsHash(ctx.url, { cat: null })}>See all in Transactions →</DrillLink>}
            </div>
          )}
          {expandLoading && !expanded && <p className="text-[11px] text-text-secondary mt-2 mb-0">Loading categories…</p>}
          {expandError && <p className="text-[11px] text-red mt-2 mb-0">Couldn’t load more: {expandError}</p>}
        </div>

        {replacement ? (
          <div className="w-[140px] text-center pt-2">
            {replacement.kind === 'uncategorized' ? (
              <>
                <div className="text-2xl font-bold font-mono tabular-nums text-text">{pct(replacement.share)}</div>
                <div className="text-[11px] text-text-secondary mb-2">uncategorized</div>
                <DrillLink href={transactionsHash(ctx.url, { cat: 'Uncategorized' })}>
                  {categorizeLabel(replacement.count)} →
                </DrillLink>
              </>
            ) : (
              <>
                <div className="text-2xl font-bold font-mono tabular-nums text-text">100%</div>
                <div className="text-[11px] text-text-secondary truncate" title={replacement.label}>
                  {replacement.label}
                </div>
              </>
            )}
          </div>
        ) : (
          <div aria-hidden="true" className="chart-mark-svg shrink-0" style={{ width: DONUT_SIZE, height: DONUT_SIZE }}>
            <PieChart width={DONUT_SIZE} height={DONUT_SIZE}>
              <Pie
                data={slices}
                dataKey="value"
                nameKey="name"
                cx="50%"
                cy="50%"
                innerRadius={36}
                outerRadius={60}
                paddingAngle={1.5}
                stroke={chartTokens().surfaceRaised}
                strokeWidth={2}
                isAnimationActive={false}
                onMouseEnter={(_, index) => setHighlight(slices[index]?.key ?? null)}
                onMouseLeave={() => setHighlight(null)}
              >
                {slices.map((s) => (
                  <Cell
                    key={s.key}
                    fill={s.color}
                    fillOpacity={highlight == null || highlight === s.key ? 1 : 0.3}
                  />
                ))}
              </Pie>
              <Tooltip content={<ChartTooltip total={total} labelFormat={() => null} colorFor={(name) => slices.find((s) => s.name === name)?.color} />} />
            </PieChart>
          </div>
        )}
      </div>
    </ChartCard>
  );
}
