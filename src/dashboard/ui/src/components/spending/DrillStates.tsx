import { emptyRangeMessage, excludedFootnote } from '@/lib/drill';
import { money } from '@/format';
import type { DrillCtx } from './drillContext';
import { DeltaBadge } from './DeltaBadge';
import type { CompareMode } from '@/lib/drill';
import type { ReactNode } from 'react';

/** Empty range: 'No spending in <period> — data through <coverage end>' + jump. */
export function DrillEmpty({ ctx, error }: { ctx: DrillCtx; error?: string | null }) {
  if (error) {
    return <p className="text-sm text-text-secondary m-0">Couldn’t load spending: {error}</p>;
  }
  const coverageEnd = ctx.coverage?.end ?? null;
  return (
    <div className="text-sm text-text-secondary space-y-2">
      <p className="m-0">{emptyRangeMessage(ctx.periodLabel, coverageEnd)}</p>
      {coverageEnd && (
        <button
          type="button"
          onClick={ctx.jumpToLastYear}
          className="text-xs min-h-6 px-2 py-1 rounded border border-border bg-transparent text-text-secondary hover:text-green hover:border-green/50 cursor-pointer"
        >
          Jump to last 12 months
        </button>
      )}
    </div>
  );
}

/**
 * Level header: period total, Δ vs comparison — with a visible caption naming
 * what Δ compares against ('vs Aug 1–15 (same 15 days)') — and an optional
 * right-side action.
 */
export function DrillTotal({
  total,
  prevTotal,
  cmp,
  compareCaption,
  caption,
  action,
}: {
  total: number;
  prevTotal: number | null | undefined;
  cmp: CompareMode | null;
  /** What the Δ compares against; shown only while a Δ is shown. */
  compareCaption?: string | null;
  caption?: ReactNode;
  action?: ReactNode;
}) {
  const showCompare = !!cmp && prevTotal !== undefined && !!compareCaption;
  return (
    <div className="flex items-end justify-between gap-3 mb-3">
      <div className="min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-2xl font-bold font-mono tabular-nums text-text">{money(total)}</span>
          <DeltaBadge current={total} prev={prevTotal} cmp={cmp} size="md" />
          {showCompare && <span className="text-[11px] text-text-secondary whitespace-nowrap">{compareCaption}</span>}
        </div>
        {caption && <div className="text-[11px] text-text-secondary mt-0.5">{caption}</div>}
      </div>
      {action}
    </div>
  );
}

export function ExcludedFootnote({ excludedTotal }: { excludedTotal: number }) {
  const text = excludedFootnote(excludedTotal);
  if (!text) return null;
  return <p className="text-[11px] text-text-secondary mt-3 mb-0">{text}</p>;
}

/** Inline arrow link ('See all 42 transactions →'). */
export function DrillLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} className="text-xs text-green hover:underline whitespace-nowrap">
      {children}
    </a>
  );
}
