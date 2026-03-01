/**
 * Rich description for the web_search tool.
 * Used in the system prompt to guide the LLM on when and how to use this tool.
 */
export const WEB_SEARCH_DESCRIPTION = `
Search the web for current information on any topic. Returns relevant search results with URLs and content snippets.

## When to Use

- When the user asks about current financial news or events
- When looking up information about a merchant or service
- When the user needs general knowledge to supplement their financial data
- When verifying claims about companies, services, or financial topics

## When NOT to Use

- When the user's question can be answered from their transaction data alone
- For pure conceptual/definitional questions ("What is a budget?")

## Usage Notes

- Provide specific, well-formed search queries for best results
- Returns up to 5 results with URLs and content snippets
- Use for supplementary research when local data doesn't cover the topic
`.trim();

export { tavilySearch } from './tavily.js';
export { exaSearch } from './exa.js';
export { perplexitySearch } from './perplexity.js';
export { braveSearch } from './brave.js';
