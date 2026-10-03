import type { LaneRoute } from '@/prelabel/core';

const TOOLTIP =
  "open-jev's margin between its top two choices, not the LLM's confidence. It is a second opinion only; nothing is applied until you click.";

/**
 * The open-jev second-opinion chip. Visually distinct from ConfidenceBadge
 * (uppercase mono, JEV prefix) so the two numbers are never conflated. A
 * DISAGREES chip never names open-jev's category (B1-a is blind, spec §2).
 */
export function PrelabelChip({ route }: { route: LaneRoute }) {
  const tone =
    route.kind === 'agrees'
      ? 'border-green/40 text-green'
      : route.kind === 'disagrees'
        ? 'border-yellow/40 text-yellow'
        : 'border-border text-text-muted';
  return (
    <span
      title={TOOLTIP}
      data-testid="prelabel-chip"
      data-kind={route.kind}
      className={`inline-block text-[10px] px-1.5 py-0.5 border font-mono uppercase tracking-wide whitespace-nowrap ${tone}`}
    >
      {route.chip}
    </span>
  );
}
