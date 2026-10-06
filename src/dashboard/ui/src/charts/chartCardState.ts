/**
 * ChartCard loading phases (pure, unit-tested):
 *  - 'skeleton': first load, nothing to show yet → fixed-height placeholder
 *  - 'stale':    refetching with previous data on screen → keep the old chart
 *                at reduced opacity with a thin progress bar (aria-busy)
 *  - 'ready':    data settled and renderable
 *  - 'empty':    settled with nothing to plot
 */
export type ChartCardPhase = 'skeleton' | 'stale' | 'ready' | 'empty';

export function chartCardPhase(loading: boolean, hasData: boolean): ChartCardPhase {
  if (loading) return hasData ? 'stale' : 'skeleton';
  return hasData ? 'ready' : 'empty';
}

export interface ChartTableColumn {
  label: string;
  /** Right-align + tabular figures. */
  numeric?: boolean;
}

/** Data behind a chart, rendered as a real <table> by the card's Table toggle. */
export interface ChartTableData {
  caption?: string;
  columns: ChartTableColumn[];
  rows: (string | number)[][];
}

/** Accessible name of the card's Table toggle (names the chart it switches). */
export function tableToggleLabel(title: string): string {
  return `Show ${title} as table`;
}

/**
 * Table-view state after `canTable` changes: when the table can no longer be
 * shown (data emptied, card back to skeleton) the toggle resets, so the next
 * time data arrives the chart — not a stale table choice — is what renders.
 */
export function nextShowTable(showTable: boolean, canTable: boolean): boolean {
  return canTable ? showTable : false;
}
