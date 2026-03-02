import { Scratchpad } from './scratchpad.js';
import { TokenCounter } from './token-counter.js';

/**
 * Mutable state for a single agent run.
 */
export interface RunContext {
  readonly query: string;
  readonly runId: string;
  readonly scratchpad: Scratchpad;
  readonly tokenCounter: TokenCounter;
  readonly startTime: number;
  iteration: number;
  sequenceNum: number;
}

export function createRunContext(query: string): RunContext {
  return {
    query,
    runId: crypto.randomUUID(),
    scratchpad: new Scratchpad(query),
    tokenCounter: new TokenCounter(),
    startTime: Date.now(),
    iteration: 0,
    sequenceNum: 0,
  };
}
