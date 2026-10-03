import { breadcrumbs, type Drill, type DrillAction, type DrillKeys } from '@/lib/drill';

/**
 * <nav aria-label="Spending drill"><ol>…: every crumb but the last is a
 * button that pushes its level; the last is aria-current="page". Long labels
 * truncate with the full text in `title`. `count` renders as a chip.
 */
export function DrillBreadcrumb({
  drill,
  count,
  go,
}: {
  drill: Drill;
  count?: number | null;
  go: (patch: DrillKeys, action: DrillAction) => void;
}) {
  const crumbs = breadcrumbs(drill);
  return (
    <nav aria-label="Spending drill" className="min-w-0">
      <ol className="flex items-center flex-wrap gap-1 list-none m-0 p-0 text-xs">
        {crumbs.map((c, i) => (
          <li key={c.id} className="flex items-center gap-1 min-w-0">
            {i > 0 && (
              <span aria-hidden="true" className="text-text-muted">
                ›
              </span>
            )}
            {c.current ? (
              <span
                aria-current="page"
                title={c.truncated ? c.full : undefined}
                className="text-text font-medium truncate max-w-[220px]"
              >
                {c.label}
              </span>
            ) : (
              <button
                type="button"
                onClick={() => go(c.patch, 'crumb')}
                title={c.truncated ? c.full : undefined}
                className="bg-transparent border-none p-0 text-text-secondary hover:text-green cursor-pointer truncate max-w-[220px] focus:outline-none focus-visible:ring-1 focus-visible:ring-green/60 rounded-sm"
              >
                {c.label}
              </button>
            )}
            {c.current && count != null && (
              // text-secondary on border-muted: 4.95:1 (>= 4.5:1 for small text).
              <span className="text-[11px] px-1.5 py-0.5 rounded-full bg-border-muted text-text-secondary tabular-nums whitespace-nowrap">
                {count.toLocaleString('en-US')} {count === 1 ? 'txn' : 'txns'}
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
