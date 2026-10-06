/**
 * Detecting the browser subagent's on-device handoff block inside a recorded prompt.
 *
 * When the browser subagent hands a turn to the server agent the server prepends an UNTRUSTED block to the user's
 * words, and the interaction store records that prompt verbatim in `llm_interactions.user_prompt`. The block is
 * computed in the browser from a local copy of the user's data, so it is not the user's question, not the model's
 * evidence, and must never be taken for either by a judge or copied into training data unnoticed.
 *
 * What is a block (spec: 2026-10 handoff-anchored design, option D): a header `[On-device assistant notes ... k=<tag>]`,
 * a body, and the end marker `[End of on-device assistant notes k=<tag>]`, where tag is HMAC-SHA256 of the exact body
 * under a per-profile secret (./handoff-tag.ts). Detection runs on the RAW text and needs no Unicode normalisation: a
 * typed, pasted or echoed marker has no valid tag, so it is not a block however it is spelled. Rows recorded before
 * the secret existed (`handoff_tag_since`) keep the old untagged detection, unchanged.
 *
 * Policy (specs/webmcp-security-judge.md, "Handoff blocks"):
 *  - judge tools show the user's words in full and replace each real block by a short, sanitized, clearly marked
 *    excerpt. Every other character of the prompt is neutralised (NFKC, brackets and bracket look-alikes to
 *    parentheses), so nothing typed can read as a marker and nothing typed is ever hidden;
 *  - SFT and DPO exports leave out every run/pair that contains a real block, and also every run with marker-like
 *    text that is NOT a real block ("suspect"), unless the export opts in explicitly.
 */
import { foldCompat, sanitizeUntrustedText, stripHiddenChars, stripMarks } from '../mcp/text-hygiene.js';
import {
  HANDOFF_BLOCK_END_MARKER,
  HANDOFF_BLOCK_HEADER_PREFIX,
  MENTION_BLOCK_PREFIX,
  NFKC_MAX_GROWTH,
  SCAN_MAX_PROMPT_CHARS,
  scanHandoffBlocksBudgeted,
  type HandoffDetector,
  type ScanShared,
  type VerifiedHandoffBlock,
} from '../dashboard/local-handoff-format.js';
import { CURRENT_MESSAGE_MARKER } from '../utils/history-context.js';

export { HANDOFF_BLOCK_END_MARKER, HANDOFF_BLOCK_HEADER_PREFIX, SCAN_MAX_PROMPT_CHARS };

/** How much of an unverified remainder the judge still sees once a scan was exhausted and nothing could be anchored. */
export const UNVERIFIED_TAIL_SHOWN_CHARS = 4_000;
/** Upper bound on anchor positions collected (cheap string finds; the verify work is bounded by one shared budget). */
const MAX_ANCHORS = 20_000;

// ── Neutralising everything that is not a real block ─────────────────────────

// Every Unicode opening / closing punctuation (Ps / Pe) character becomes ( or ), which covers shapes added later.
// The explicit lists add the bracket shapes that are Sm / So, not Ps / Pe (U+23A1-23A6 and U+23B4/23B5).
// Further shapes that are Pi / Pf, Sm or So (corners, hooks, box lines, substitution/transposition brackets, ...) or
// invisible tag characters are listed by code point below; src/__tests__/fixtures/bracket-lookalikes.json is every
// code point named BRACKET (Unicode 14) plus the look-alikes found by review, and a test requires all of them mapped.
// Pi / Pf are NOT mapped wholesale: that would also rewrite ordinary quotation marks.
const EXTRA_OPEN = '\\u{1AC5}\\u{231C}\\u{231E}\\u{23A7}\\u{23A8}\\u{23A9}\\u{23AA}\\u{23B0}\\u{23B6}\\u{23B8}\\u{23DE}\\u{23E0}\\u{2E02}\\u{2E04}\\u{2E09}\\u{2E0C}\\u{2E1C}\\u{2E20}\\u{1D115}\\u{1F668}\\u{E005B}\\u{E007B}';
const EXTRA_CLOSE = '\\u{231D}\\u{231F}\\u{23AB}\\u{23AC}\\u{23AD}\\u{23B1}\\u{23B9}\\u{23DF}\\u{23E1}\\u{2E03}\\u{2E05}\\u{2E0A}\\u{2E0D}\\u{2E1D}\\u{2E21}\\u{E005D}\\u{E007D}';
const OPEN_BRACKETS = new RegExp(`[\\p{Ps}⎡⎢⎣⎴⁅⟦【〔〚❲⦋⦍⦏⟬⸢⸤⹕⹗〖〘⦗⌈⌊⦃「『｢︹︻﹇［${EXTRA_OPEN}]`, 'gu');
const CLOSE_BRACKETS = new RegExp(`[\\p{Pe}⎤⎥⎦⎵⁆⟧】〕〛❳⦌⦎⦐⟭⸣⸥⹖⹘〗〙⦘⌉⌋⦄」』｣︺︼﹈］${EXTRA_CLOSE}]`, 'gu');

/**
 * The form a judge-visible, untrusted piece of prompt text is shown in: hidden characters removed (as the later
 * sanitising does), compat fold (an approximation of NFKC, one code point at a time), repeated until stable (so a bracket assembled by removal or folding cannot appear
 * afterwards), then `[` `]` and the bracket look-alikes that survive NFKC (the ones listed above) become `(` `)`.
 * The stored text is never changed.
 */
export function neutralizeBrackets(text: string): string {
  if (text.length > SCAN_MAX_PROMPT_CHARS) {
    return `${neutralizeBrackets(text.slice(0, SCAN_MAX_PROMPT_CHARS))} (... ${text.length - SCAN_MAX_PROMPT_CHARS} more characters not shown)`;
  }
  const { text: cur, overgrown } = normalizeStable(text);
  if (overgrown) return `(${text.length} characters not shown: they grow more than ${NFKC_MAX_GROWTH}x under Unicode normalisation)`;
  return cur.replace(OPEN_BRACKETS, '(').replace(CLOSE_BRACKETS, ')');
}

/**
 * Hidden characters removed and compat-folded (per code point, `foldCompat`), repeated until stable, with a bound on work: the text may not grow past
 * NFKC_MAX_GROWTH x its length (U+FDFA alone expands 18x, so an unbounded loop is a memory and time sink).
 * `overgrown` says the bound was hit; the returned text is then only the last in-bound form and must not be trusted.
 */
function normalizeStable(text: string): { text: string; overgrown: boolean } {
  const limit = text.length * NFKC_MAX_GROWTH + 64;
  let cur = text;
  for (let i = 0; i < 8; i++) {
    // Per-code-point fold (linear, see foldCompat), never the built-in normalisation method: no input can make it quadratic.
    const folded = foldCompat(cur);
    if (folded.length > limit) return { text: cur, overgrown: true };
    const next = stripHiddenChars(folded, { allowNewlines: true });
    if (next === cur) break;
    cur = next;
  }
  return { text: cur, overgrown: false };
}

/**
 * True when text OUTSIDE any real block still looks like part of a handoff marker. Letters and digits only, lower
 * case, after the same canonicalisation: spacing, hyphens, brackets, hidden characters, combining marks and width
 * variants make no difference. Deliberately broad: it only flags a run for exclusion from an export.
 */
export function looksLikeHandoffMarker(text: string): boolean {
  // Fail-safe on work bounds: text past the cap, or that balloons under NFKC, is never normalised and counts as marker-like.
  if (text.length > SCAN_MAX_PROMPT_CHARS) return true;
  const { text: cur, overgrown } = normalizeStable(text);
  if (overgrown) return true;
  const letters = stripMarks(cur).replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
  return letters.includes('ondeviceassistantnotes');
}

export type HandoffClass = 'none' | 'block' | 'suspect';

export interface HandoffAnalysis {
  /** Real, verified blocks (or, for a legacy row, header-prefix hits). */
  blocks: number;
  /** Marker-like text that is not a real block (never set for a legacy row, which has no such notion). */
  suspect: boolean;
  /** 'block' wins over 'suspect'. */
  kind: HandoffClass;
  /** The scan ran out of its work budget: the rest of the prompt is unverified, which counts as suspect. */
  exhausted: boolean;
}

/**
 * Real blocks at the places the product puts one: right after CURRENT_MESSAGE_MARKER (the current turn of a history
 * prompt) and right after `Query: ` (an iteration prompt), optionally behind a mention block. Each try is an
 * `onlyAt` scan with its own small budget, so typed pairs elsewhere in the prompt cannot starve it.
 */
function anchoredBlocks(text: string, detector: HandoffDetector, after: number): VerifiedHandoffBlock[] {
  const positions: number[] = [];
  const markerLine = `${CURRENT_MESSAGE_MARKER}\n`;
  for (let at = text.indexOf(markerLine, after), n = 0; at !== -1 && n < MAX_ANCHORS; at = text.indexOf(markerLine, at + 1), n++) {
    positions.push(at + markerLine.length);
  }
  for (let at = text.indexOf('Query: ', after), n = 0; at !== -1 && n < MAX_ANCHORS; at = text.indexOf('Query: ', at + 1)) {
    if (at === 0 || text[at - 1] === '\n') { positions.push(at + 'Query: '.length); n++; }
  }
  // Ascending, so the blank-line search below can move forward only (a monotone cursor): total work is linear in the
  // text however many anchors precede a mention block with no blank line after it.
  positions.sort((a, b) => a - b);
  let blankFrom = -1;
  let blankAt = -1;
  const nextBlankLine = (pos: number): number => {
    if (blankFrom !== -1 && blankFrom <= pos && (blankAt === -1 || blankAt >= pos)) return blankAt;
    blankFrom = pos;
    blankAt = text.indexOf('\n\n', pos);
    return blankAt;
  };
  const found = new Map<number, VerifiedHandoffBlock>();
  // One end-marker map and one verify budget for every anchor tried, however many typed anchors precede the real one.
  const shared: ScanShared = { spent: 0 };
  outer: for (const pos of positions) {
    let candidates = [pos];
    if (text.startsWith(MENTION_BLOCK_PREFIX, pos)) {
      const blank = nextBlankLine(pos);
      if (blank !== -1) candidates = [pos, blank + 2];
    }
    for (const from of candidates) {
      if (from < after) continue;
      // Only a header right here can be a block: skip the rest without any scan work.
      if (!text.startsWith(HANDOFF_BLOCK_HEADER_PREFIX, from)) continue;
      const scan = scanHandoffBlocksBudgeted(text, detector.verify, from, true, shared);
      if (scan.blocks[0]) { found.set(scan.blocks[0].start, scan.blocks[0]); break; }
      if (scan.exhausted) break outer;
    }
  }
  const out: VerifiedHandoffBlock[] = [];
  let end = after;
  for (const b of [...found.values()].sort((x, y) => x.start - y.start)) {
    if (b.start >= end) { out.push(b); end = b.end; }
  }
  return out;
}

/**
 * Split raw text into the real blocks and the text between them. With `recover`, a scan that ran out of budget gets
 * an anchored second look (see anchoredBlocks); `recovered` says that found something past the exhaustion point.
 */
function partition(text: string, detector: HandoffDetector, recover = false): { blocks: VerifiedHandoffBlock[]; between: string[]; exhausted: boolean; recovered: boolean; scanned: number } {
  const scan = scanHandoffBlocksBudgeted(text, detector.verify);
  let blocks = scan.blocks;
  let recovered = false;
  if (scan.exhausted && recover) {
    const extra = anchoredBlocks(text, detector, blocks.length > 0 ? blocks[blocks.length - 1].end : 0);
    if (extra.length > 0) { blocks = [...blocks, ...extra]; recovered = true; }
  }
  const between: string[] = [];
  let pos = 0;
  for (const b of blocks) {
    between.push(text.slice(pos, b.start));
    pos = b.end;
  }
  between.push(text.slice(pos));
  return { blocks, between, exhausted: scan.exhausted, recovered, scanned: scan.blocks.length };
}

/** What a prompt holds, for the export and the dashboard flags. */
export function analyzeHandoff(text: string | null | undefined, detector: HandoffDetector): HandoffAnalysis {
  if (typeof text !== 'string' || text.length === 0) return { blocks: 0, suspect: false, kind: 'none', exhausted: false };
  if (detector.acceptLegacy) {
    const has = text.includes(HANDOFF_BLOCK_HEADER_PREFIX);
    return { blocks: has ? 1 : 0, suspect: false, kind: has ? 'block' : 'none', exhausted: false };
  }
  // Past the cap nothing is scanned or normalised: unverified, so suspect (fail-safe, availability-safe).
  if (text.length > SCAN_MAX_PROMPT_CHARS) return { blocks: 0, suspect: true, kind: 'suspect', exhausted: true };
  const { blocks, between, exhausted } = partition(text, detector);
  if (blocks.length > 0) return { blocks: blocks.length, suspect: exhausted, kind: 'block', exhausted };
  // An exhausted scan left the rest of the prompt unverified: suspect without needing a marker-like look (fail-safe).
  const suspect = exhausted || between.some(looksLikeHandoffMarker);
  return { blocks: 0, suspect, kind: suspect ? 'suspect' : 'none', exhausted };
}

/** True when the prompt holds a real handoff block (a legacy row: the header prefix anywhere, as before). */
export function hasHandoffBlock(text: string | null | undefined, detector: HandoffDetector): boolean {
  return analyzeHandoff(text, detector).blocks > 0;
}

/** True when an export must leave this prompt out: a real block, or marker-like text that is not one. */
export function isHandoffFlagged(text: string | null | undefined, detector: HandoffDetector): boolean {
  return analyzeHandoff(text, detector).kind !== 'none';
}

export interface ExcerptedPrompt {
  text: string;
  /** How many blocks were replaced. */
  blocks: number;
  /** The scan ran out of budget: everything after the last excerpt is unverified text, shown neutralised in full. */
  exhausted: boolean;
}

function sizeLabel(chars: number): string {
  // The size is rounded to whole thousands: a long exact number would be masked as an account number.
  return chars < 1000 ? `${Math.ceil(chars / 100) * 100} chars` : `${Math.ceil(chars / 1000)}k chars`;
}

function excerptMarker(blockChars: number, body: string, excerptChars: number): string {
  const excerpt = sanitizeUntrustedText(neutralizeBrackets(body), excerptChars);
  return `[UNTRUSTED on-device assistant notes, about ${sizeLabel(blockChars)}, excerpt: "${excerpt}"]`;
}

/**
 * The judge's view of a prompt. Each REAL block becomes `[UNTRUSTED on-device assistant notes, about N chars,
 * excerpt: "..."]` (sanitized, PII-masked, at most `excerptChars`). All other text is kept in full, neutralised
 * (`neutralizeBrackets`), so a typed marker is plain parenthesised text and can neither pass as a block nor hide
 * the words after it. A legacy row (no tag) is handled exactly as before tagging existed.
 */
export function excerptHandoffBlocks(text: string, detector: HandoffDetector, excerptChars = 100): ExcerptedPrompt {
  if (detector.acceptLegacy) return excerptLegacy(text, excerptChars);
  // Past the cap only the prefix is looked at; the rest is cut and said so.
  const tooLong = text.length > SCAN_MAX_PROMPT_CHARS;
  const head = tooLong ? text.slice(0, SCAN_MAX_PROMPT_CHARS) : text;
  const { blocks, between, exhausted, recovered, scanned } = partition(head, detector, true);
  // between[scanned] is the first stretch past the last block the full scan verified: from there on nothing is verified.
  const firstUnverified = scanned;
  let out = '';
  for (let i = 0; i < between.length; i++) {
    const piece = between[i];
    // Exhausted: every stretch from the exhaustion point on is unverified and may hold a real block's body, which must
    // never be shown. Each such stretch is cut at the first raw block header in it (a real block can only start at
    // one), so a second real block past the point is never shown in full either. The last one is also cut at the
    // character cap when nothing at all could be anchored. Trade-off, deliberate: a header typed by the user before a
    // real block that was recovered by anchoring cuts the view there too, so typed text can shrink what the judge
    // sees. That fails safe and the judge is told (the "more unverified characters not shown" notice).
    if (exhausted && i >= firstUnverified) {
      const isLast = i === between.length - 1;
      const header = piece.indexOf(HANDOFF_BLOCK_HEADER_PREFIX);
      const cap = isLast && !recovered ? UNVERIFIED_TAIL_SHOWN_CHARS : piece.length;
      const cut = Math.min(header === -1 ? piece.length : header, cap);
      if (cut < piece.length) {
        out += `${neutralizeBrackets(piece.slice(0, cut))} (... ${piece.length - cut} more unverified characters not shown)`;
        if (i < blocks.length) { const b = blocks[i]; out += excerptMarker(b.end - b.start, b.body, excerptChars); }
        continue;
      }
    }
    out += neutralizeBrackets(piece);
    if (i < blocks.length) {
      const b = blocks[i];
      out += excerptMarker(b.end - b.start, b.body, excerptChars);
    }
  }
  if (tooLong) out += ` (... ${text.length - SCAN_MAX_PROMPT_CHARS} more characters not shown)`;
  return { text: out, blocks: blocks.length, exhausted: exhausted || tooLong };
}

/**
 * The pre-tag excerpt, for rows recorded before `handoff_tag_since`: a block starts at the header prefix and ends at
 * the LAST end marker before the next header; one with no end marker is taken to run to the end of the text.
 */
/** The legacy excerpt reads this many times the excerpt length of the body (room for end markers and spaces to drop). */
const LEGACY_EXCERPT_SLACK = 12;

function excerptLegacy(text: string, excerptChars: number): ExcerptedPrompt {
  let out = '';
  let pos = 0;
  let blocks = 0;
  for (;;) {
    const start = text.indexOf(HANDOFF_BLOCK_HEADER_PREFIX, pos);
    if (start === -1) break;
    const nextHeader = text.indexOf(HANDOFF_BLOCK_HEADER_PREFIX, start + HANDOFF_BLOCK_HEADER_PREFIX.length);
    const windowEnd = nextHeader === -1 ? text.length : nextHeader;
    // Search only this header's own window [start, windowEnd): the windows are disjoint, so the total work is
    // linear (an unbounded lastIndexOf walks back to the start of the text when nothing matches).
    const rel = text.slice(start, windowEnd).lastIndexOf(HANDOFF_BLOCK_END_MARKER);
    const endAt = rel > 0 ? start + rel : -1;
    const end = endAt === -1 ? text.length : endAt + HANDOFF_BLOCK_END_MARKER.length;
    const block = text.slice(start, end);
    // The excerpt is the block's first body line after the header sentence, not the header itself.
    const headerEnd = block.indexOf(']');
    const body = headerEnd === -1 ? block : block.slice(headerEnd + 1);
    // Only the start of the body can reach the excerpt; cut before sanitising so a block that runs to the end of a
    // huge text does not cost a pass over all of it per header.
    const excerpt = sanitizeUntrustedText(body.slice(0, excerptChars * LEGACY_EXCERPT_SLACK).split(HANDOFF_BLOCK_END_MARKER).join(' '), excerptChars);
    out += `${text.slice(pos, start)}[UNTRUSTED on-device assistant notes, about ${sizeLabel(block.length)}, excerpt: "${excerpt}"]`;
    pos = end;
    blocks += 1;
  }
  return { text: out + text.slice(pos), blocks, exhausted: false };
}
