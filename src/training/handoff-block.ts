/**
 * Detecting the browser subagent's on-device handoff block inside a recorded prompt.
 *
 * When the browser subagent hands a turn to the server agent it prepends an UNTRUSTED block to the user's words
 * (`[On-device assistant notes ... UNTRUSTED ...]` up to `[End of on-device assistant notes]`), and the
 * interaction store records that prompt verbatim in `llm_interactions.user_prompt`. The block is computed in the
 * browser from a local copy of the user's data, so it is not the user's question, not the model's evidence, and
 * must never be taken for either by a judge or copied into training data unnoticed.
 *
 * Policy (specs/webmcp-security-judge.md, "Handoff blocks"):
 *  - judge tools show the user's words in full and replace each block by a short, sanitized, clearly marked excerpt;
 *  - SFT and DPO exports leave out every run/pair that contains a block, unless the export opts in explicitly.
 *
 * The strings below mirror `HANDOFF_BLOCK_HEADER` and `HANDOFF_BLOCK_END` in `src/dashboard/local-handoff-format.ts`
 * on the feat/browser-subagent branch (found by reading that worktree). That file is not on this branch yet, so
 * the detector keeps its own named constants. The header is matched by its fixed prefix, so a rewording of the
 * rest of the sentence does not hide a block.
 * TODO(browser-subagent merge): import both constants from local-handoff-format.ts and add a parity test.
 */
import { sanitizeUntrustedText } from '../mcp/text-hygiene.js';

export const HANDOFF_BLOCK_HEADER_PREFIX = '[On-device assistant notes';
export const HANDOFF_BLOCK_END_MARKER = '[End of on-device assistant notes]';

/** True when the prompt contains a handoff block header anywhere (a mention block may come first). */
export function hasHandoffBlock(text: string | null | undefined): boolean {
  return typeof text === 'string' && text.includes(HANDOFF_BLOCK_HEADER_PREFIX);
}

export interface ExcerptedPrompt {
  text: string;
  /** How many blocks were replaced. */
  blocks: number;
}

/**
 * Replace every handoff block with `[UNTRUSTED on-device assistant notes, about N chars, excerpt: "..."]`. The excerpt is
 * sanitized (hidden characters, PII masking) and at most `excerptChars` long. A block ends at the last end marker before the
 * next header; one with no end marker (cut off or forged) is taken to run to the end of the text, so nothing after a forged header can pass as the user's words.
 */
export function excerptHandoffBlocks(text: string, excerptChars = 100): ExcerptedPrompt {
  let out = '';
  let pos = 0;
  let blocks = 0;
  for (;;) {
    const start = text.indexOf(HANDOFF_BLOCK_HEADER_PREFIX, pos);
    if (start === -1) break;
    // The block ends at the LAST end marker before the next header (or the end of the text): the notes are untrusted
    // and may contain the literal marker, and a forged one must not let the rest of the notes pass as the user's words.
    const nextHeader = text.indexOf(HANDOFF_BLOCK_HEADER_PREFIX, start + HANDOFF_BLOCK_HEADER_PREFIX.length);
    const windowEnd = nextHeader === -1 ? text.length : nextHeader;
    const lastEnd = text.lastIndexOf(HANDOFF_BLOCK_END_MARKER, windowEnd - HANDOFF_BLOCK_END_MARKER.length);
    const endAt = lastEnd > start ? lastEnd : -1;
    const end = endAt === -1 ? text.length : endAt + HANDOFF_BLOCK_END_MARKER.length;
    const block = text.slice(start, end);
    // The excerpt is the block's first body line after the header sentence, not the header itself.
    const headerEnd = block.indexOf(']');
    const body = headerEnd === -1 ? block : block.slice(headerEnd + 1);
    const excerpt = sanitizeUntrustedText(body.split(HANDOFF_BLOCK_END_MARKER).join(' '), excerptChars);
    // The size is rounded to whole thousands: a long exact number would be masked as an account number.
    const size = block.length < 1000 ? `${Math.ceil(block.length / 100) * 100} chars` : `${Math.ceil(block.length / 1000)}k chars`;
    out += `${text.slice(pos, start)}[UNTRUSTED on-device assistant notes, about ${size}, excerpt: "${excerpt}"]`;
    pos = end;
    blocks += 1;
  }
  return { text: out + text.slice(pos), blocks };
}
