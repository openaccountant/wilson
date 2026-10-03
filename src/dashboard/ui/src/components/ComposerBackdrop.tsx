import { forwardRef, type ReactNode } from 'react';
import type { MentionEntry, MentionType } from '@/lib/typeahead';

/**
 * Highlight layer rendered *behind* a transparent textarea. It mirrors the
 * text with identical metrics (font, padding, line-height, wrapping) but
 * transparent glyphs, so only the token backgrounds/rings show through —
 * the textarea still draws (and owns) every character. A dim argument hint
 * ("<category> <amount>") can be shown after the text.
 *
 * Keep the metric classes in sync with the textarea in ChatTab.
 */

const TONE: Record<MentionType, string> = {
  account: 'bg-blue/15 ring-1 ring-blue/40',
  category: 'bg-green-900/40 ring-1 ring-green-700/50',
  merchant: 'bg-yellow/10 ring-1 ring-yellow/40',
  goal: 'bg-green-900/40 ring-1 ring-green-700/50',
  entity: 'bg-green-900/40 ring-1 ring-green-700/50',
};

interface ComposerBackdropProps {
  text: string;
  mentions: MentionEntry[];
  /** Ghost argument hint appended after the text (caret at end only). */
  ghost?: string | null;
  /** Highlight a leading "/command" token. */
  command?: boolean;
}

export const ComposerBackdrop = forwardRef<HTMLDivElement, ComposerBackdropProps>(function ComposerBackdrop(
  { text, mentions, ghost, command },
  ref,
) {
  const parts: ReactNode[] = [];
  let pos = 0;

  const cmd = command ? /^\s*\/[a-z][\w-]*/i.exec(text) : null;
  if (cmd) {
    parts.push(
      <span key="cmd" className="rounded-sm bg-green-900/30">
        {cmd[0]}
      </span>,
    );
    pos = cmd[0].length;
  }

  // Longest tokens first so "@[A B]" wins over a shorter overlapping token.
  const tokens = [...mentions].sort((a, b) => b.token.length - a.token.length);
  while (pos < text.length) {
    let best: { at: number; m: MentionEntry } | null = null;
    for (const m of tokens) {
      const at = text.indexOf(m.token, pos);
      if (at !== -1 && (!best || at < best.at)) best = { at, m };
    }
    if (!best) break;
    if (best.at > pos) parts.push(text.slice(pos, best.at));
    parts.push(
      <span key={`${best.at}`} className={`rounded-sm ${TONE[best.m.type]}`}>
        {best.m.token}
      </span>,
    );
    pos = best.at + best.m.token.length;
  }
  if (pos < text.length) parts.push(text.slice(pos));

  return (
    <div
      ref={ref}
      aria-hidden="true"
      className="absolute inset-0 overflow-hidden pointer-events-none border border-transparent rounded-lg px-3 py-2 text-sm leading-5 whitespace-pre-wrap break-words text-transparent"
    >
      {parts}
      {ghost && <span className="font-mono text-text-muted">{ghost}</span>}
      {/* Trailing newline needs a glyph to keep the last line's height. */}
      {'​'}
    </div>
  );
});

/** 14px inline-SVG type icons for mention rows (no icon library). */
export function MentionIcon({ type }: { type: MentionType }) {
  const common = {
    width: 14,
    height: 14,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };
  switch (type) {
    case 'account': // bank
      return (
        <svg {...common}>
          <path d="M3 10h18L12 4z" />
          <path d="M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 20h18" />
        </svg>
      );
    case 'category': // tag
      return (
        <svg {...common}>
          <path d="M3 12V4h8l10 10-8 8z" />
          <circle cx="7.5" cy="7.5" r="1.5" />
        </svg>
      );
    case 'merchant': // storefront
      return (
        <svg {...common}>
          <path d="M4 9l1.5-5h13L20 9" />
          <path d="M4 9a2.7 2.7 0 0 0 5.3 0 2.7 2.7 0 0 0 5.4 0 2.7 2.7 0 0 0 5.3 0" />
          <path d="M5 11v9h14v-9M10 20v-5h4v5" />
        </svg>
      );
    case 'goal': // target
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <circle cx="12" cy="12" r="5" />
          <circle cx="12" cy="12" r="1" />
        </svg>
      );
    case 'entity': // building
      return (
        <svg {...common}>
          <path d="M5 21V4h10v17M15 9h4v12M3 21h18" />
          <path d="M8.5 8h3M8.5 12h3M8.5 16h3" />
        </svg>
      );
  }
}
