import { formatDelta, type CompareMode } from '@/lib/drill';

/**
 * Δ vs the comparison window. Color is never the only signal: the arrow and
 * signed text carry the direction, and screen readers get a sentence. A null
 * base (no coverage in the comparison window) renders 'no prior data', not $0.
 * `prev === undefined` (the server didn't send a comparison) renders nothing.
 */
export function DeltaBadge({
  current,
  prev,
  cmp,
  size = 'sm',
}: {
  current: number;
  prev: number | null | undefined;
  cmp: CompareMode | null;
  size?: 'sm' | 'md';
}) {
  if (!cmp || prev === undefined) return null;
  const d = formatDelta(current, prev, cmp);
  const text = size === 'md' ? 'text-xs' : 'text-[11px]';
  if (!d) {
    return (
      <span className={`${text} text-text-secondary whitespace-nowrap`} title="No imported data in the comparison period">
        no prior data
      </span>
    );
  }
  const tone = d.tone === 'bad' ? 'text-red' : d.tone === 'good' ? 'text-green' : 'text-text-secondary';
  return (
    <span className={`${text} ${tone} tabular-nums whitespace-nowrap`}>
      <span aria-hidden="true">{d.text}</span>
      <span className="sr-only">{d.srText}</span>
    </span>
  );
}
