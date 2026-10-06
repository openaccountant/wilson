import type { ReactNode, Ref } from 'react';
import type { DrillAction, Drill, DrillCompare, DrillKeys } from '@/lib/drill';
import type { UrlState } from '@/lib/urlState';
import type { CoverageResponse } from '@/types';

/** What every drill level receives from SpendingDrill. */
export interface DrillCtx {
  url: UrlState;
  drill: Drill;
  /** Global range + header scope (cat/merchant come from `drill`). */
  startDate: string;
  endDate: string;
  accountId: number | null;
  entityId: number | null;
  /** Header period label ('March 2026'). */
  periodLabel: string;
  today: string;
  compare: DrillCompare | null;
  /**
   * The comparison window is final (no cmp, or coverage settled so the
   * window can be measured to the data end). Breakdown requests wait for it.
   */
  compareReady: boolean;
  coverage: CoverageResponse | null;
  /** Coverage settled (loaded or failed): series requests may go out. */
  coverageReady: boolean;
  /** Apply drill keys with the action's history mode. */
  go: (patch: DrillKeys, action: DrillAction) => void;
  /** Open the txn drawer (push, remembered so close can go Back). */
  openTxn: (id: number) => void;
  /** Click a month bar: custom range over that month (push). */
  selectMonth: (period: string) => void;
  /** Empty state: jump to the 12 months ending at coverage end (replace). */
  jumpToLastYear: () => void;
  /** Level heading focus target. */
  headingRef: Ref<HTMLHeadingElement>;
  /** Register a row element by key, so focus can land on it after going up. */
  registerRow: (key: string, el: HTMLElement | null) => void;
  /**
   * The level's rows for the current data have rendered: a pending 'focus
   * the row I came from' with no such row falls back to 'N more' / heading.
   */
  rowsSettled: () => void;
  /** Report the level's transaction count (breadcrumb chip); null = unknown. */
  reportCount: (count: number | null) => void;
  /** Breadcrumb + compare control, rendered above each level's title. */
  above: ReactNode;
}
