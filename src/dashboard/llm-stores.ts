import type { Database } from '../db/compat-sqlite.js';
import { interactionStore } from '../utils/interaction-store.js';
import { traceStore } from '../utils/trace-store.js';

/**
 * Point the LLM record stores at a profile's DB. Both, always: `llm_traces` feeds the LLM tab's stats, while
 * `llm_interactions` (full prompts, replies and tool results) feeds Traces, Training and the judge. The standalone
 * dashboard used to attach only the trace store, so Chat answered but the LLM tab stayed empty.
 */
export function attachLlmStores(db: Database): void {
  traceStore.setDatabase(db);
  interactionStore.setDatabase(db);
}
