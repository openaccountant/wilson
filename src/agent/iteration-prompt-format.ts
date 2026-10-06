/**
 * The fixed wording of an agent iteration prompt (`buildIterationPrompt` in prompts.ts), kept in a module with no
 * imports so the judge read tools can recognise the tool-results block without loading the prompt builder.
 *
 * From the second agent iteration on, `llm_interactions.user_prompt` holds `Query: ...`, then this block with EVERY
 * raw tool result, then the closing line. A reader that is allowed tool-result previews only must cut the block
 * (see `omitIterationToolResults`), or it could rebuild a full tool result by paging the prompt.
 */

/** Heading line that opens the full-tool-results block (preceded by a blank line, followed by a newline). */
export const ITERATION_TOOL_RESULTS_MARKER = 'Data retrieved from tool calls:';

/** The closing instruction, always the last paragraph of an iteration prompt. */
export const ITERATION_PROMPT_CLOSING = 'Continue working toward answering the query.';

/**
 * Local (Transformers.js) models get a different closing paragraph, which asks for a plain-language answer (granite
 * copied the "### tool(...)" blocks verbatim otherwise). On a retry it opens with the retry note instead.
 */
export const LOCAL_ITERATION_PROMPT_CLOSING = 'If you need more data, call a tool.';
export const LOCAL_ITERATION_RETRY_NOTE = 'Your previous reply repeated the raw tool results instead of answering.';

/**
 * The chain and team step prompts (src/orchestration/chain.ts, team.ts) embed every raw tool result too:
 * `<step prompt>\n\nTool results:\n<results>\n\nBased on these results, <closing>`. They are recorded as `chain` / `team`
 * interactions, so the judge's cut must know them as well.
 */
export const ORCHESTRATION_TOOL_RESULTS_HEADING = 'Tool results:';
/** The fixed start of both orchestration closing lines; the rest of the sentence differs per kind. */
export const ORCHESTRATION_CLOSING_PREFIX = 'Based on these results, continue';
export const CHAIN_ITERATION_CLOSING = `${ORCHESTRATION_CLOSING_PREFIX} your analysis or provide your final output.`;
export const TEAM_ITERATION_CLOSING = `${ORCHESTRATION_CLOSING_PREFIX} or provide your final findings.`;

/** The prompt of the next chain/team step iteration: the step prompt, every tool result, then the closing line. */
export function buildOrchestrationIterationPrompt(stepPrompt: string, toolResults: string[], closing: string): string {
  return `${stepPrompt}\n\n${ORCHESTRATION_TOOL_RESULTS_HEADING}\n${toolResults.join('\n\n')}\n\n${closing}`;
}

/** Call types whose recorded prompts follow a format `omitIterationToolResults` knows. Anything else is not paged. */
export const KNOWN_PROMPT_CALL_TYPES: readonly string[] = ['agent', 'chain', 'team', 'categorization', 'entity-classification', 'summarize', 'relevance', 'demo-showdown'];

/**
 * Build user prompt for agent iteration with full tool results.
 * Anthropic-style: full results in context for accurate decision-making.
 * Context clearing happens at threshold, not inline summarization.
 *
 * @param originalQuery - The user's original query
 * @param fullToolResults - Formatted full tool results (or placeholder for cleared)
 * @param toolUsageStatus - Optional tool usage status for graceful exit mechanism
 * @param options.local - Local (Transformers.js) models: a closing that asks
 *   for a plain-language answer — granite copied the "### tool(...)" blocks
 *   verbatim otherwise. Cloud models keep the original closing.
 * @param options.retry - Local only: the last reply was such a copy.
 */
export function buildIterationPrompt(
  originalQuery: string,
  fullToolResults: string,
  toolUsageStatus?: string | null,
  options: { local?: boolean; retry?: boolean } = {},
): string {
  let prompt = `Query: ${originalQuery}`;

  if (fullToolResults.trim()) {
    prompt += `

${ITERATION_TOOL_RESULTS_MARKER}
${fullToolResults}`;
  }

  // Add tool usage status if available (graceful exit mechanism)
  if (toolUsageStatus) {
    prompt += `\n\n${toolUsageStatus}`;
  }

  if (options.local) {
    const retry = options.retry ? `${LOCAL_ITERATION_RETRY_NOTE} ` : '';
    prompt += `

${retry}${LOCAL_ITERATION_PROMPT_CLOSING} Otherwise, using the data above, answer the query in plain language: lead with the key numbers. Do not copy the tool results, their ### headings or JSON into your answer.`;
    return prompt;
  }

  prompt += `

${ITERATION_PROMPT_CLOSING} When you have gathered sufficient data to answer, write your complete answer directly and do not call more tools.`;

  return prompt;
}

/**
 * Replace the tool-results block of an iteration prompt (the heading through the closing line, tool-usage status
 * included) with a one-line note. Three formats are known: the agent's ("Data retrieved from tool calls:" ...
 * "Continue working toward answering the query.", or a local model's "If you need more data, call a tool." closing,
 * which a retry opens with its note), and the chain and team step prompts ("Tool results:" ...
 * "Based on these results, continue ..."). The cut starts at the EARLIEST heading and ends at the LAST closing line,
 * since a tool result is data and may quote either; a block with no closing line (cut off, forged) is taken to run
 * to the end of the text. Text with no heading is returned unchanged.
 */
export function omitIterationToolResults(text: string): { text: string; omittedChars: number } {
  const headings = [ITERATION_TOOL_RESULTS_MARKER, ORCHESTRATION_TOOL_RESULTS_HEADING].map((h) => `\n\n${h}\n`);
  const starts = headings.map((h) => text.indexOf(h)).filter((i) => i !== -1);
  if (starts.length === 0) return { text, omittedChars: 0 };
  const start = Math.min(...starts);
  const closing = Math.max(...[ITERATION_PROMPT_CLOSING, LOCAL_ITERATION_PROMPT_CLOSING, LOCAL_ITERATION_RETRY_NOTE, ORCHESTRATION_CLOSING_PREFIX].map((c) => text.lastIndexOf(`\n\n${c}`)));
  const end = closing > start ? closing : text.length;
  const omitted = end - start;
  // Rounded up to whole hundreds: a long exact number would be masked as an account number downstream.
  const approx = `${Math.ceil(omitted / 100) * 100}`;
  return {
    text: `${text.slice(0, start)}\n\n[tool results omitted: about ${approx} chars; see tool_results previews]${text.slice(end)}`,
    omittedChars: omitted,
  };
}
