/**
 * User-facing summary of a categorize tool run — the text the terminal's
 * /categorize prints (src/cli.ts) and the dashboard chat's /categorize answers
 * with (src/dashboard/chat.ts). One formatter so the two never drift.
 */

interface CategorizeResultData {
  message?: string;
  error?: string;
  categorized?: number;
  totalUncategorized?: number;
  ruleMatched?: number;
  llmCategorized?: number;
  routedForReview?: number;
  categoriesApplied?: Record<string, number>;
  errors?: string[];
  notAttempted?: number;
  /** Transactions with no category after the run (held-for-review included). */
  stillUncategorized?: number;
}

/** Parse the tool's JSON result (formatToolResult wraps it in `data`). */
export function parseCategorizeResult(resultJson: string): CategorizeResultData {
  const result = JSON.parse(resultJson);
  return (result.data ?? result) as CategorizeResultData;
}

/**
 * Markdown summary of a run. `errorDetail` appends the first batch error's
 * reason — the terminal leaves it off (the count alone, as it always has).
 */
export function formatCategorizeSummary(data: CategorizeResultData, opts: { errorDetail?: boolean } = {}): string {
  const detail = opts.errorDetail && data.errors?.length ? `\n\n${data.errors[0]}` : '';
  if (data.categorized === 0 && !data.error) {
    return (data.message ?? 'All transactions are already categorized.') + detail;
  }
  if (data.error) {
    return `**Categorization failed:** ${data.error}`;
  }
  let msg = `Categorized **${data.categorized}** of ${data.totalUncategorized} transactions`;
  if ((data.ruleMatched ?? 0) > 0) {
    msg += ` (${data.ruleMatched} by rules, ${data.llmCategorized} by AI)`;
  }
  if ((data.routedForReview ?? 0) > 0) {
    msg += `\n${data.routedForReview} routed for human review (held in review queue).`;
  }
  if (data.categoriesApplied && Object.keys(data.categoriesApplied).length > 0) {
    msg += '\n\n**Categories:**\n';
    const sorted = Object.entries(data.categoriesApplied).sort(([, a], [, b]) => b - a);
    for (const [cat, count] of sorted) {
      msg += `  ${cat}: ${count}\n`;
    }
  }
  if (data.errors && data.errors.length > 0) {
    msg += `\n${data.errors.length} batch errors occurred.`;
  }
  if (data.notAttempted) {
    msg += `\nStopped after repeated batch failures; ${data.notAttempted} transactions were not attempted.`;
  }
  return msg + detail;
}
