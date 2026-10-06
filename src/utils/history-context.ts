export const HISTORY_CONTEXT_MARKER = '[Chat history for context]';
export const CURRENT_MESSAGE_MARKER = '[Current message - respond to this]';
export const DEFAULT_HISTORY_LIMIT = 10;
export const FULL_ANSWER_TURNS = 3;

export interface HistoryEntry {
  role: 'user' | 'assistant';
  content: string;
}

export function buildHistoryContext(params: {
  entries: HistoryEntry[];
  currentMessage: string;
  lineBreak?: string;
}): string {
  const lineBreak = params.lineBreak ?? '\n';
  if (params.entries.length === 0) {
    return params.currentMessage;
  }

  const historyText = params.entries
    .map(entry => `${entry.role === 'user' ? 'User' : 'Assistant'}: ${entry.content}`)
    .join(`${lineBreak}${lineBreak}`);

  return [
    HISTORY_CONTEXT_MARKER,
    historyText,
    '',
    CURRENT_MESSAGE_MARKER,
    params.currentMessage,
  ].join(lineBreak);
}

/**
 * buildHistoryContext under a token budget (local models): keeps the newest
 * turns that fit in `maxTokens` and drops whole turns from the oldest. With no
 * room for any turn, the result is the current message alone.
 */
export function buildBudgetedHistoryContext(params: {
  entries: HistoryEntry[];
  currentMessage: string;
  countTokens: (text: string) => number;
  maxTokens: number;
  lineBreak?: string;
}): { text: string; droppedEntries: number } {
  const { entries, currentMessage, countTokens, maxTokens, lineBreak } = params;
  const render = (kept: HistoryEntry[]) => buildHistoryContext({ entries: kept, currentMessage, lineBreak });

  // Turn boundaries: each turn starts at a user entry (getRecentTurns emits
  // user/assistant pairs, but a lone entry still counts as its own turn).
  const starts = entries.map((e, i) => (e.role === 'user' || i === 0 ? i : -1)).filter((i) => i >= 0);
  for (const start of starts) {
    const kept = entries.slice(start);
    const text = render(kept);
    if (countTokens(text) <= maxTokens) return { text, droppedEntries: start };
  }
  return { text: currentMessage, droppedEntries: entries.length };
}
