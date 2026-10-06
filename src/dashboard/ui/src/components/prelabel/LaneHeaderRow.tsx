import type { Lane } from '@/prelabel/core';

const LABEL: Record<Lane, string> = { ATTENTION: 'NEEDS YOU', QUICK: 'QUICK CONFIRM' };

/** Separator row between lanes. Counts only: there is no bulk action (spec §9.2, OQ9). */
export function LaneHeaderRow({ lane, count, colSpan }: { lane: Lane; count: number; colSpan: number }) {
  return (
    <tr className="bg-surface border-b border-border" data-testid={`prelabel-lane-${lane.toLowerCase()}`}>
      <td
        colSpan={colSpan}
        className={`px-4 py-1.5 text-[10px] font-mono uppercase tracking-wide ${lane === 'ATTENTION' ? 'text-yellow' : 'text-green'}`}
      >
        {LABEL[lane]} · {count}
      </td>
    </tr>
  );
}
