import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useApi } from '@/hooks/useApi';
import { useUrlState, readUrlState } from '@/hooks/useUrlState';
import { useDateRange } from '@/hooks/useDateRange';
import { useAppState } from '@/state';
import { ymd } from '@/lib/dateRange';
import {
  applyDrill,
  deriveDrill,
  drillCompareWindow,
  drillNavMode,
  focusAfterTransition,
  isAppPushedTxnEntry,
  isUpKey,
  lastTwelveMonthsPatch,
  monthRangePatch,
  openTxnPatch,
  pushedHistoryState,
  settledFocusKey,
  upPatch,
  type Drill,
  type DrillAction,
  type DrillKeys,
  type FocusTarget,
} from '@/lib/drill';
import type { UrlCompare } from '@/lib/urlState';
import type { CoverageResponse, Transaction } from '@/types';
import type { DrillCtx } from './drillContext';
import { DrillBreadcrumb } from './DrillBreadcrumb';
import { SpendingLevel1 } from './SpendingLevel1';
import { SpendingLevel2 } from './SpendingLevel2';
import { SpendingLevel3 } from './SpendingLevel3';
import { TxnDrawer } from './TxnDrawer';

/**
 * Spending drill-down card (replaces the Overview donut). The level is derived
 * from the URL (cat / merchant / txn / by — see lib/drill.ts), so Back goes up
 * one level and a reload restores the exact depth.
 *
 * Keyboard: the active level's list is the primary control (roving tabindex,
 * Up/Down/Home/End, Enter/Space drills). Backspace or Alt+Up anywhere in the
 * card goes up one level; Esc only closes the transaction drawer. After
 * drilling down focus lands on the new level's heading; after going up, on
 * the row for the level just left.
 */
export function SpendingDrill() {
  const { state: url, navigate } = useUrlState();
  const { dateRange, accountId, entityId } = useAppState();
  const { monthLabel } = useDateRange();
  const today = ymd(new Date());
  const drill = useMemo(
    () => deriveDrill({ cat: url.cat, merchant: url.merchant, txn: url.txn, by: url.by }),
    [url.cat, url.merchant, url.txn, url.by],
  );
  const { data: coverage, loading: coverageLoading } = useApi<CoverageResponse>('/api/coverage');
  // Δ is measured to min(today, coverage end), so a period whose imports end
  // early compares the same elapsed days; requests wait for coverage when a
  // comparison is on (never a flash of the wrong window).
  const coverageEnd = coverage?.end ?? null;
  const compare = useMemo(
    () => drillCompareWindow({ preset: url.preset, start: url.start, end: url.end, today, cmp: url.cmp, coverageEnd }),
    [url.preset, url.start, url.end, url.cmp, today, coverageEnd],
  );
  const compareReady = !url.cmp || !coverageLoading;

  // ── Navigation ─────────────────────────────────────────────────────────
  const go = useCallback(
    (patch: DrillKeys, action: DrillAction) => navigate((s) => applyDrill(s, patch), { mode: drillNavMode(action) }),
    [navigate],
  );
  // Drawer entries this app pushes are marked in history.state (so closing
  // can go Back instead of adding another entry). The mark lives on the entry
  // itself, so it survives Back → Forward; a drawer restored by reload/deep
  // link carries no mark and closes with a replace.
  const openTxn = useCallback(
    (id: number) => {
      navigate((s) => applyDrill(s, openTxnPatch(deriveDrill(s), id)), {
        mode: 'push',
        pushState: (prev) => pushedHistoryState(prev, id),
      });
    },
    [navigate],
  );
  const closeTxn = useCallback(() => {
    const live = deriveDrill(readUrlState());
    // The native <dialog> also fires close after the URL already dropped txn.
    if (live.txn == null) return;
    if (isAppPushedTxnEntry(window.history.state, live.txn)) {
      window.history.back();
      return;
    }
    const patch = upPatch(live);
    if (patch) navigate((s) => applyDrill(s, patch), { mode: 'replace' });
  }, [navigate]);

  const selectMonth = useCallback(
    (period: string) => navigate((s) => ({ ...s, ...monthRangePatch(period) }), { mode: drillNavMode('month') }),
    [navigate],
  );
  const jumpToLastYear = useCallback(
    () => navigate((s) => ({ ...s, ...lastTwelveMonthsPatch(coverage?.end, ymd(new Date())) }), { mode: 'replace' }),
    [navigate, coverage?.end],
  );
  const setCompare = (cmp: UrlCompare | null) => navigate((s) => ({ ...s, cmp }), { mode: 'replace' });

  // ── Focus management ───────────────────────────────────────────────────
  const cardRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const rowsRef = useRef(new Map<string, HTMLElement>());
  const pendingRowRef = useRef<string | null>(null);
  const prevDrillRef = useRef<Drill | null>(null);

  const registerRow = useCallback((key: string, el: HTMLElement | null) => {
    if (el) {
      rowsRef.current.set(key, el);
      if (pendingRowRef.current === key) {
        pendingRowRef.current = null;
        el.focus();
      }
    } else {
      rowsRef.current.delete(key);
    }
  }, []);

  const rowsSettled = useCallback(() => {
    const next = settledFocusKey(pendingRowRef.current, (k) => rowsRef.current.has(k));
    if (next == null) return;
    pendingRowRef.current = null;
    // Only redirect focus that is still parked on the heading.
    if (document.activeElement !== headingRef.current) return;
    if (next === 'heading') return;
    rowsRef.current.get(next)?.focus();
  }, []);

  useEffect(() => {
    const target: FocusTarget = focusAfterTransition(prevDrillRef.current, drill);
    prevDrillRef.current = drill;
    if (!target) return;
    // Only move focus when the user is working in this card (or focus was
    // dropped to <body>, e.g. by Back unmounting the focused row) — never
    // steal it from the header's category select.
    const active = document.activeElement;
    const inCard = !!active && !!cardRef.current?.contains(active);
    if (!inCard && active && active !== document.body) return;
    if (target.kind === 'heading') {
      pendingRowRef.current = null;
      headingRef.current?.focus();
      return;
    }
    const row = rowsRef.current.get(target.key);
    if (row) {
      row.focus();
      return;
    }
    // Rows are still loading: hold focus on the heading, then hand it to the
    // row when it registers.
    pendingRowRef.current = target.key;
    headingRef.current?.focus();
  }, [drill]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!isUpKey(e)) return;
    const el = e.target as HTMLElement;
    // Text entry keeps Backspace; inside the drawer only Esc applies.
    if (el.closest('input, textarea, select, [contenteditable="true"], dialog')) return;
    const patch = upPatch(drill);
    if (!patch || drill.level === 4) return;
    e.preventDefault();
    go(patch, 'up');
  };

  // L3's current page, so the drawer can show a row without refetching.
  const [l3Rows, setL3Rows] = useState<Transaction[]>([]);
  const onRows = useCallback((rows: Transaction[]) => setL3Rows(rows), []);
  const [crumbCount, setCrumbCount] = useState<number | null>(null);

  const ctx: DrillCtx = {
    url,
    drill,
    startDate: dateRange.startDate,
    endDate: dateRange.endDate,
    accountId,
    entityId,
    periodLabel: monthLabel,
    today,
    compare,
    compareReady,
    coverage: coverage ?? null,
    coverageReady: !coverageLoading,
    go,
    openTxn,
    selectMonth,
    jumpToLastYear,
    headingRef,
    registerRow,
    rowsSettled,
    reportCount: setCrumbCount,
    above: (
      <div className="flex items-center justify-between gap-2 mb-2">
        <DrillBreadcrumb drill={drill} go={go} count={crumbCount} />
        <label className="flex items-center gap-1 text-[11px] text-text-secondary uppercase tracking-wide shrink-0">
          Compare
          <select
            value={url.cmp ?? ''}
            onChange={(e) => setCompare((e.target.value || null) as UrlCompare | null)}
            className="bg-surface border border-border rounded min-h-6 px-1 py-0.5 text-[11px] normal-case tracking-normal text-text-secondary focus:outline-none focus:border-green"
          >
            <option value="">Off</option>
            <option value="prev">Previous period</option>
            <option value="yoy">Last year</option>
          </select>
        </label>
      </div>
    ),
  };

  return (
    <div ref={cardRef} onKeyDown={onKeyDown} data-testid="spending-drill" className="min-w-0">
      {drill.baseLevel === 1 && <SpendingLevel1 ctx={ctx} />}
      {drill.baseLevel === 2 && <SpendingLevel2 ctx={ctx} />}
      {drill.baseLevel === 3 && <SpendingLevel3 ctx={ctx} onRows={onRows} />}
      <TxnDrawer ctx={ctx} known={drill.baseLevel === 3 ? l3Rows : []} onClose={closeTxn} />
    </div>
  );
}
