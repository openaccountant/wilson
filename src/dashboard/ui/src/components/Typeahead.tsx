import { useEffect, useLayoutEffect, useState, type ReactNode, type RefObject } from 'react';
import { highlightSegments, menuPlacement, optionDomId, type Range } from '@/lib/typeahead';

export { optionDomId };

/**
 * Presentational listbox popover for typeahead menus (chat "/" and "@" today;
 * reusable for e.g. Transactions search). State lives in useTypeahead; this
 * renders WAI-ARIA 1.2 combobox popup markup:
 *   role=listbox → role=group (aria-labelledby header) → role=option.
 * It is position:fixed above `anchorRef` (the composer row), so it escapes the
 * chat column's overflow clipping and keeps a usable width on narrow screens.
 */

export type BadgeTone = 'green' | 'blue' | 'yellow' | 'dim' | 'entity';

export interface TypeaheadItem {
  id: string;
  group: string;
  label: string;
  /** Dim prefix before the label (e.g. "/" for commands). */
  prefix?: string;
  /** Argument hint after the label, e.g. "<category> <amount>". */
  args?: string;
  /** Right-aligned secondary text. */
  detail?: string;
  badge?: { text: string; tone: BadgeTone; color?: string };
  icon?: ReactNode;
  mono?: boolean;
  disabled?: boolean;
  ranges?: Range[];
}

export interface TypeaheadProps {
  listboxId: string;
  /** Element the popover sits above (it matches its left edge and width, min 280px). */
  anchorRef: RefObject<HTMLElement | null>;
  open: boolean;
  items: TypeaheadItem[];
  activeIndex: number;
  /** Title strip text + listbox aria-label ("Commands", "Mentions"). */
  title: string;
  onActiveChange: (index: number) => void;
  onSelect: (index: number) => void;
  /** e.g. "+12 more — keep typing" */
  footer?: string;
  emptyText?: string;
  /** Polite live-region text ("6 commands", "No matches"); debounced 250 ms. */
  status?: string;
}

const BADGE_TONES: Record<BadgeTone, string> = {
  green: 'border-green-700/50 bg-green-900/30 text-green',
  blue: 'border-blue/40 text-blue',
  yellow: 'border-yellow/40 text-yellow',
  dim: 'border-green-dim text-green/70',
  entity: '',
};

export function TypeaheadBadge({ badge }: { badge: NonNullable<TypeaheadItem['badge']> }) {
  const style =
    badge.tone === 'entity' && badge.color
      ? { color: badge.color, borderColor: `${badge.color}66` }
      : undefined;
  return (
    <span
      className={`shrink-0 text-[10px] leading-none font-mono px-1.5 py-[3px] rounded border ${BADGE_TONES[badge.tone]}`}
      style={style}
    >
      {badge.text}
    </span>
  );
}

function Highlighted({ text, ranges }: { text: string; ranges?: Range[] }) {
  return (
    <>
      {highlightSegments(text, ranges).map((seg, i) =>
        seg.match ? (
          <mark key={i} className="bg-transparent text-green font-semibold">
            {seg.text}
          </mark>
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      )}
    </>
  );
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

type Placement = ReturnType<typeof menuPlacement>;

/** Track the anchor's viewport rect while open (resize, scroll, composer growth). */
function usePlacement(open: boolean, anchorRef: RefObject<HTMLElement | null>): Placement | null {
  const [placement, setPlacement] = useState<Placement | null>(null);
  useLayoutEffect(() => {
    if (!open) {
      setPlacement(null);
      return;
    }
    const el = anchorRef.current;
    if (!el) return;
    const update = () => {
      const r = el.getBoundingClientRect();
      const next = menuPlacement(
        { left: r.left, top: r.top, width: r.width },
        { width: document.documentElement.clientWidth || window.innerWidth, height: window.innerHeight },
      );
      setPlacement((prev) =>
        prev &&
        prev.left === next.left &&
        prev.bottom === next.bottom &&
        prev.width === next.width &&
        prev.maxHeight === next.maxHeight
          ? prev
          : next,
      );
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
    ro?.observe(el);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
      ro?.disconnect();
    };
  }, [open, anchorRef]);
  return placement;
}

export function Typeahead({
  listboxId,
  anchorRef,
  open,
  items,
  activeIndex,
  title,
  onActiveChange,
  onSelect,
  footer,
  emptyText = 'No matches — Enter sends as text',
  status,
}: TypeaheadProps) {
  const announced = useDebounced(open ? status ?? '' : '', 250);
  const placement = usePlacement(open, anchorRef);

  // Keep the keyboard-active row visible.
  useEffect(() => {
    if (!open || activeIndex < 0 || !items[activeIndex]) return;
    const el = document.getElementById(optionDomId(listboxId, activeIndex));
    el?.scrollIntoView?.({ block: 'nearest' });
  }, [open, activeIndex, items, listboxId]);

  // Group consecutive items (items arrive display-ordered).
  const groups: Array<{ name: string; start: number; items: TypeaheadItem[] }> = [];
  items.forEach((item, i) => {
    const last = groups[groups.length - 1];
    if (last && last.name === item.group) last.items.push(item);
    else groups.push({ name: item.group, start: i, items: [item] });
  });

  return (
    <>
      <div role="status" aria-live="polite" className="sr-only">
        {announced}
      </div>
      {open && (
        <div
          className="fixed z-50 bg-surface border border-border rounded-lg shadow-xl shadow-black/40 overflow-hidden animate-[ta-fade_80ms_ease-out] motion-reduce:animate-none"
          style={
            placement
              ? { left: placement.left, bottom: placement.bottom, width: placement.width }
              : { visibility: 'hidden', left: 0, bottom: 0 }
          }
          // Clicking the panel chrome must not blur the textarea.
          onMouseDown={(e) => e.preventDefault()}
        >
          <div className="flex justify-between gap-3 px-3 py-1.5 border-b border-border-muted text-[11px] text-text-muted">
            <span className="shrink-0">{title}</span>
            <span aria-hidden="true" className="truncate">↑↓ navigate · ↵ select · tab insert · esc</span>
          </div>
          <div
            id={listboxId}
            role="listbox"
            aria-label={title}
            className="overflow-y-auto py-1"
            style={{ maxHeight: placement ? placement.maxHeight : 'min(320px, 45vh)' }}
          >
            {groups.map((g, gi) => {
              const headerId = `${listboxId}-g${gi}`;
              return (
                <div key={`${g.name}-${gi}`} role="group" aria-labelledby={headerId}>
                  <div
                    id={headerId}
                    className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wider font-medium text-text-muted"
                  >
                    {g.name}
                  </div>
                  {g.items.map((item, j) => {
                    const index = g.start + j;
                    const active = index === activeIndex;
                    return (
                      <div
                        key={item.id}
                        id={optionDomId(listboxId, index)}
                        role="option"
                        aria-selected={active}
                        aria-disabled={item.disabled || undefined}
                        onMouseDown={(e) => {
                          e.preventDefault();
                          if (!item.disabled) onSelect(index);
                        }}
                        onMouseMove={() => {
                          if (!active) onActiveChange(index);
                        }}
                        className={`flex items-center gap-2 px-3 py-1.5 text-sm border-l-2 cursor-pointer ${
                          active
                            ? 'bg-green-900/30 border-l-green text-text'
                            : 'border-l-transparent text-text-secondary'
                        } ${item.disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
                      >
                        {item.icon && (
                          <span aria-hidden="true" className={`shrink-0 ${active ? 'text-green' : 'text-text-muted'}`}>
                            {item.icon}
                          </span>
                        )}
                        {/* The label wins the space on narrow menus; args and detail truncate first. */}
                        <span
                          className={`shrink-0 max-w-[70%] truncate ${item.mono ? 'font-mono' : ''} ${active ? (item.mono ? 'text-green' : 'text-text') : 'text-text'}`}
                        >
                          {item.prefix && <span className="text-text-muted">{item.prefix}</span>}
                          <Highlighted text={item.label} ranges={item.ranges} />
                        </span>
                        {item.args && (
                          <span className="min-w-0 truncate font-mono text-xs text-text-muted">{item.args}</span>
                        )}
                        {item.badge && <TypeaheadBadge badge={item.badge} />}
                        {item.detail && (
                          <span className="ml-auto pl-3 min-w-0 truncate text-xs text-text-muted max-w-[55%]">
                            {item.detail}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
          {items.length === 0 && (
            <div className="px-3 py-1.5 border-t border-border-muted text-[11px] text-text-muted">{emptyText}</div>
          )}
          {items.length > 0 && footer && (
            <div className="px-3 py-1.5 border-t border-border-muted text-[11px] text-text-muted">{footer}</div>
          )}
        </div>
      )}
    </>
  );
}
