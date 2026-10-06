import type { Ref } from 'react';
import { useRovingList } from '@/hooks/useRovingList';
import { barPercent, barScaleMax, shareLabel, type CompareMode } from '@/lib/drill';
import { money } from '@/format';
import { DeltaBadge } from './DeltaBadge';

export interface BarItem {
  key: string;
  label: string;
  total: number;
  count?: number;
  /** undefined = no comparison sent; null = comparison window had no coverage. */
  prevTotal?: number | null;
  color: string;
  /** What activating the row does. */
  action: 'drill' | 'none';
}

/**
 * Ranked horizontal bar list on ONE shared zero baseline (every bar scales
 * against the same max — real rows only; the folded 'N more' row is a
 * FoldedRow text row below the list, never a scaled bar). This list is the
 * drill's primary control: one tab stop with roving tabindex, Up/Down/Home/End
 * to move, Enter/Space to drill. Hovering or focusing a row reports its key
 * (to highlight a donut slice).
 */
export function DrillBarList({
  items,
  periodTotal,
  cmp,
  label,
  onActivate,
  registerRow,
  highlightKey,
  onHighlight,
}: {
  items: BarItem[];
  periodTotal: number;
  cmp: CompareMode | null;
  /** Accessible name of the list. */
  label: string;
  onActivate: (item: BarItem) => void;
  registerRow?: (key: string, el: HTMLElement | null) => void;
  highlightKey?: string | null;
  onHighlight?: (key: string | null) => void;
}) {
  const { itemProps } = useRovingList(items.length);
  const max = barScaleMax(items);

  return (
    // role="list": Safari drops list semantics from `list-style: none` lists.
    <ul role="list" aria-label={label} className="list-none m-0 p-0 space-y-0.5" onMouseLeave={() => onHighlight?.(null)}>
      {items.map((it, i) => {
        const props = itemProps(i, (el) => registerRow?.(it.key, el));
        const dimmed = highlightKey != null && highlightKey !== it.key;
        const body = (
          <>
            <span className="flex items-baseline justify-between gap-3 min-w-0">
              <span className="flex items-center gap-1.5 min-w-0">
                <span aria-hidden="true" className="chart-mark w-2 h-2 rounded-full shrink-0" style={{ background: it.color }} />
                <span className="truncate text-text" title={it.label}>
                  {it.label}
                </span>
              </span>
              <span className="text-text font-medium tabular-nums whitespace-nowrap">{money(it.total)}</span>
            </span>
            <span className="flex items-center gap-2 mt-1">
              <span aria-hidden="true" className="relative flex-1 h-1.5 rounded-full bg-border-muted overflow-hidden">
                <span
                  className="chart-mark absolute inset-y-0 left-0 rounded-full"
                  style={{ width: `${barPercent(it.total, max)}%`, background: it.color }}
                />
              </span>
              {/* Fixed-width meta columns keep every bar track the same length,
                  so all bars share one scale as well as one baseline. */}
              <span className="w-[5.5rem] shrink-0 text-right text-[11px] text-text-secondary tabular-nums whitespace-nowrap">
                {shareLabel(it.total, periodTotal)}
                <span className="sr-only"> of period</span>
                {it.count != null && (
                  <>
                    {' · '}
                    {it.count.toLocaleString('en-US')} {it.count === 1 ? 'txn' : 'txns'}
                  </>
                )}
              </span>
              {cmp && (
                <span className="w-[7rem] shrink-0 text-right">
                  <DeltaBadge current={it.total} prev={it.prevTotal} cmp={cmp} />
                </span>
              )}
            </span>
          </>
        );
        const cls = `block w-full text-left text-xs px-2 py-1.5 rounded border border-transparent transition-opacity bg-transparent ${
          dimmed ? 'opacity-50' : ''
        } focus:outline-none focus-visible:border-green/60 focus-visible:bg-surface`;
        return (
          <li role="listitem" key={it.key} onMouseEnter={() => onHighlight?.(it.key)}>
            {it.action === 'none' ? (
              <div {...props} onFocus={() => { props.onFocus(); onHighlight?.(it.key); }} className={cls}>
                {body}
              </div>
            ) : (
              <button
                type="button"
                {...props}
                onFocus={() => {
                  props.onFocus();
                  onHighlight?.(it.key);
                }}
                onClick={() => onActivate(it)}
                className={`${cls} cursor-pointer hover:bg-surface`}
              >
                {body}
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The folded tail as a TEXT row under the list — label, total, share and
 * transaction count — excluded from the bar scale so a big long tail can't
 * squash the real rows. With `onExpand` it is a button ('N more categories'),
 * otherwise plain text ('Other merchants (9)').
 */
export function FoldedRow({
  label,
  total,
  count,
  periodTotal,
  onExpand,
  buttonRef,
  highlighted,
  onHighlight,
  disabled,
}: {
  label: string;
  total: number;
  count?: number;
  periodTotal: number;
  onExpand?: () => void;
  buttonRef?: Ref<HTMLButtonElement>;
  highlighted?: boolean | null;
  onHighlight?: (on: boolean) => void;
  disabled?: boolean;
}) {
  const meta = (
    <span className="text-[11px] text-text-secondary tabular-nums whitespace-nowrap">
      {shareLabel(total, periodTotal)}
      <span className="sr-only"> of period</span>
      {count != null && count > 0 && ` · ${count.toLocaleString('en-US')} ${count === 1 ? 'txn' : 'txns'}`}
    </span>
  );
  const content = (
    <>
      <span className="truncate text-text-secondary" title={label}>
        {label}
        {onExpand && <span aria-hidden="true"> ▾</span>}
      </span>
      <span className="flex items-baseline gap-3 shrink-0">
        {meta}
        <span className="text-text-secondary font-medium tabular-nums">{money(total)}</span>
      </span>
    </>
  );
  const cls = `flex items-baseline justify-between gap-3 w-full text-xs px-2 mt-1 min-h-6 rounded border border-dashed ${
    highlighted === false ? 'opacity-50' : ''
  }`;
  if (!onExpand) {
    return <p className={`${cls} border-transparent mb-0 py-1`}>{content}</p>;
  }
  return (
    <button
      type="button"
      ref={buttonRef}
      aria-expanded={false}
      disabled={disabled}
      onClick={onExpand}
      onMouseEnter={() => onHighlight?.(true)}
      onMouseLeave={() => onHighlight?.(false)}
      onFocus={() => onHighlight?.(true)}
      onBlur={() => onHighlight?.(false)}
      className={`${cls} py-1.5 text-left border-border bg-transparent cursor-pointer hover:bg-surface hover:border-text-secondary focus:outline-none focus-visible:border-green/60 disabled:opacity-60`}
    >
      {content}
    </button>
  );
}
