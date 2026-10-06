/**
 * Regression tests for verifier findings on the chat composer typeahead
 * (H1/H2/M1/M2 + the low-severity polish items). Pure-module tests only —
 * the React hook and ChatTab delegate every decision pinned here.
 */
import { describe, expect, test } from 'bun:test';
import {
  applySelection,
  detectArgTrigger,
  detectTrigger,
  formatMentionToken,
  initialActiveIndex,
  nextActiveIndex,
  contextBlockMentions,
  pruneMentions,
  isTypeaheadOpen,
  optionDomId,
  menuPlacement,
  MENU_MIN_WIDTH,
} from '../dashboard/ui/src/lib/typeahead.js';
import {
  planArgAccept,
  skillCommands,
  helpMarkdown,
  humanSkillDescription,
  commandCandidates,
} from '../dashboard/ui/src/lib/chatCommands.js';
import { resolveMentionContext } from '../dashboard/mentions.js';
import { createTestDb } from './helpers.js';
import { insertTransactions } from '../db/queries.js';

// ── H1: an accepted mention must not reopen the menu ───────────────────────

describe('H1 — accepted mentions stay closed', () => {
  const always = () => true;

  test('accepting "@din" → "@Dining " does not re-detect "@" (Enter then sends)', () => {
    const before = 'how much on @din';
    const t = detectTrigger(before, before.length, always)!;
    expect(t.kind).toBe('@');
    const token = formatMentionToken('Dining');
    const { text, caret } = applySelection(before, t, token);
    expect(text).toBe('how much on @Dining ');
    // The one-space continuation used to reopen '@' with query 'Dining '.
    expect(detectTrigger(text, caret, always, [token])).toBeNull();
  });

  test('caret right after an inserted single-word token does not reopen', () => {
    const text = 'spent at @Amazon last week';
    expect(detectTrigger(text, 16, always, ['@Amazon'])).toBeNull();
  });

  test('typing on after an accepted token stays closed', () => {
    expect(detectTrigger('how much on @Dining l', 21, always, ['@Dining'])).toBeNull();
  });

  test('a fresh trigger after the accepted token still opens', () => {
    const text = 'how much on @Dining vs @gro';
    expect(detectTrigger(text, text.length, always, ['@Dining'])?.query).toBe('gro');
  });

  test('editing the accepted token (no longer equal) reopens normally', () => {
    expect(detectTrigger('how much on @Dinin', 18, always, ['@Dining'])?.query).toBe('Dinin');
  });
});

// ── H2: caret must be past the trigger, at the end of the token ────────────

describe('H2 — no menu at or inside a token', () => {
  test('caret at index 0 before "/" does not open', () => {
    expect(detectTrigger('/budget', 0)).toBeNull();
    expect(detectTrigger('/', 0)).toBeNull();
  });

  test('caret before "@" does not open', () => {
    expect(detectTrigger('@amazon', 0)).toBeNull();
    expect(detectTrigger('hi @amazon', 3)).toBeNull();
  });

  test('caret mid-token does not open', () => {
    expect(detectTrigger('/budget', 3)).toBeNull();
    expect(detectTrigger('spent at @amazon last week', 12)).toBeNull();
    expect(detectTrigger('@[Plaid Checking] ', 8)).toBeNull();
  });

  test('caret at the end of the token still opens with the full token as query', () => {
    expect(detectTrigger('/budget', 7)).toMatchObject({ kind: '/', query: 'budget' });
    expect(detectTrigger('spent at @amaz last week', 14)).toMatchObject({ kind: '@', query: 'amaz' });
  });
});

// ── M2: "/" commands only at the start of the message ──────────────────────

describe('M2 — mid-text "/" never triggers', () => {
  test('a "/" after other text is not a command trigger', () => {
    expect(detectTrigger('hey /sk', 7)).toBeNull();
    expect(detectTrigger('run /skill tax', 10)).toBeNull();
    expect(detectTrigger('line one\n/bu', 12)).toBeNull();
  });

  test('a leading "/" (after optional whitespace) still triggers', () => {
    expect(detectTrigger('/sk', 3)).toMatchObject({ kind: '/', leading: true });
    expect(detectTrigger('  /bu', 5)).toMatchObject({ kind: '/', leading: true });
  });
});

// ── M1: "/profile " never switches profiles on the first Enter ─────────────

describe('M1 — /profile argument list', () => {
  test('the arg list opens with no active option (Enter falls through)', () => {
    const t = detectArgTrigger('/profile ', 9)!;
    expect(t).toMatchObject({ kind: 'arg', source: 'profiles', query: '' });
    expect(initialActiveIndex(t)).toBe(-1);
    // Same for every second-stage list.
    expect(initialActiveIndex(detectArgTrigger('/budget set ', 12))).toBe(-1);
  });

  test('a typed query activates the top match; "/" and "@" menus always do', () => {
    expect(initialActiveIndex(detectArgTrigger('/profile bu', 11))).toBe(0);
    // Bare '/' opens with nothing active: Enter must not run '/new' (destructive).
    expect(initialActiveIndex(detectTrigger('/', 1))).toBe(-1);
    expect(initialActiveIndex(detectTrigger('/ what is my balance', 1))).toBe(-1);
    expect(initialActiveIndex(detectTrigger('/bu', 3))).toBe(0);
    expect(initialActiveIndex(detectTrigger('@', 1))).toBe(0);
  });

  test('Enter (execute) on a profile only inserts the name — a second Enter runs it', () => {
    const t = detectArgTrigger('/profile bu', 11)!;
    expect(planArgAccept('/profile bu', t, 'business', 'execute')).toEqual({
      action: 'insert',
      text: '/profile business ',
      caret: 18,
    });
    // Once inserted, the arg list is closed (a space ends a profile name), so
    // the next Enter is a plain send of "/profile business".
    expect(detectArgTrigger('/profile business ', 18)).toBeNull();
  });

  test('arrow keys from "no active option" land on the first / last option', () => {
    expect(nextActiveIndex(-1, 1, 4, true)).toBe(0);
    expect(nextActiveIndex(-1, -1, 4, true)).toBe(3);
    expect(nextActiveIndex(-1, 5, 4, false)).toBe(0);
    expect(nextActiveIndex(-1, -5, 4, false)).toBe(3);
    expect(nextActiveIndex(2, 1, 4, true)).toBe(3);
    expect(nextActiveIndex(3, 1, 4, true)).toBe(0);
  });
});

// ── Low-severity polish ────────────────────────────────────────────────────

describe('L1 — recalled history messages keep their mentions', () => {
  test('context block lines round-trip to mention entries', () => {
    const db = createTestDb();
    const dining = (db.prepare("SELECT id FROM categories WHERE slug = 'dining'").get() as { id: number }).id;
    const raw = 'SQ *BLUE BOTTLE [OAKLAND]';
    insertTransactions(db, [{ date: '2026-09-01', description: raw, amount: -6 }]);
    const block = resolveMentionContext(db, [
      { type: 'category', id: dining, label: 'x' },
      { type: 'merchant', key: raw, label: raw },
    ]).trimEnd();
    const entries = contextBlockMentions(block);
    expect(entries).toEqual([
      { type: 'category', id: dining, label: 'Dining', token: '@Dining' },
      { type: 'merchant', key: raw, label: raw, token: formatMentionToken(raw) },
    ]);
    // Recall keeps the ones whose token is in the message body.
    const body = `how much on @Dining at ${formatMentionToken(raw)} ?`;
    expect(pruneMentions(body, entries)).toHaveLength(2);
    expect(pruneMentions('how much on @Dining?', entries).map((e) => e.type)).toEqual(['category']);
  });
});

describe('L2 — mention limit closes the menu so Enter sends', () => {
  test('blocked closes an otherwise-open menu', () => {
    const base = { focused: true, trigger: { kind: '@' }, dismissed: false, blocked: false, itemCount: 3 };
    expect(isTypeaheadOpen(base)).toBe(true);
    expect(isTypeaheadOpen({ ...base, blocked: true })).toBe(false);
    expect(isTypeaheadOpen({ ...base, dismissed: true })).toBe(false);
    // "/" and "@" with no matches still show "No matches"; empty arg lists stay quiet.
    expect(isTypeaheadOpen({ ...base, itemCount: 0 })).toBe(true);
    expect(isTypeaheadOpen({ ...base, trigger: { kind: 'arg' }, itemCount: 0 })).toBe(false);
  });
});

describe('L4 — option DOM ids are index-based', () => {
  test('labels differing only in punctuation get distinct ids', () => {
    const ids = ['AT&T', 'AT-T', 'AT T'].map((_, i) => optionDomId('lb', i));
    expect(new Set(ids).size).toBe(3);
    expect(optionDomId('chat-composer-listbox', 2)).toBe('chat-composer-listbox-opt-2');
  });
});

describe('L5 — skill descriptions read as human one-liners', () => {
  const agentText =
    'Pre-flight check for 1099 filing requirements. Identifies contractors paid over $600. Trigger when user asks about 1099s, contractor payments, or year-end filing prep.';

  test('first sentence, cut before the agent routing hint', () => {
    expect(humanSkillDescription(agentText)).toBe('Pre-flight check for 1099 filing requirements.');
    expect(humanSkillDescription('Syncs transactions from linked bank accounts,\n  shows balances. Trigger when user says "sync"')).toBe(
      'Syncs transactions from linked bank accounts, shows balances.',
    );
    expect(humanSkillDescription('Export for your accountant: P\\&L and notes Use when asked')).toBe(
      'Export for your accountant: P&L and notes',
    );
    expect(humanSkillDescription('Prepare taxes')).toBe('Prepare taxes');
  });

  test('menu and /help show the short text; search still uses the full text', () => {
    const [cmd] = skillCommands([{ name: '1099-preflight', description: agentText, tier: 'paid', source: 'builtin' }]);
    expect(cmd.description).toBe('Pre-flight check for 1099 filing requirements.');
    expect(cmd.fullDescription).toBe(agentText);
    expect(helpMarkdown([cmd])).not.toContain('Trigger when');
    const [cand] = commandCandidates([cmd]);
    expect(cand.weakKeywords).toContain('contractor');
  });
});

describe('L6 — popover placement on narrow screens', () => {
  test('390px viewport with the 240px sidebar: min width, overlaps the sidebar, stays on screen', () => {
    // Composer row inside the chat column: x 252 → 378 (126px wide).
    const p = menuPlacement({ left: 252, top: 700, width: 126 }, { width: 390, height: 844 });
    expect(p.width).toBe(MENU_MIN_WIDTH);
    expect(p.left).toBeGreaterThanOrEqual(8);
    expect(p.left + p.width).toBeLessThanOrEqual(390 - 8);
    expect(p.left).toBeLessThan(240); // extends over the sidebar
    expect(p.bottom).toBe(844 - 700 + 8);
  });

  test('wide screens follow the composer, capped at 576px; tiny viewports clamp', () => {
    expect(menuPlacement({ left: 300, top: 900, width: 400 }, { width: 1440, height: 1000 })).toMatchObject({ left: 300, width: 400 });
    expect(menuPlacement({ left: 300, top: 900, width: 1100 }, { width: 1440, height: 1000 }).width).toBe(576);
    const tiny = menuPlacement({ left: 100, top: 500, width: 50 }, { width: 240, height: 600 });
    expect(tiny).toMatchObject({ left: 8, width: 224 });
  });
});

describe('L8 — "/skill " lists skill names', () => {
  test('second-stage trigger for /skill', () => {
    expect(detectArgTrigger('/skill ', 7)).toEqual({ kind: 'arg', source: 'skills', command: 'skill', start: 7, end: 7, query: '' });
    expect(detectArgTrigger('/skill tax', 10)?.query).toBe('tax');
    // Once the name is complete (space), the list closes so args can follow.
    expect(detectArgTrigger('/skill tax-prep ', 16)).toBeNull();
    // Opens with nothing active, like every argument list.
    expect(initialActiveIndex(detectArgTrigger('/skill ', 7))).toBe(-1);
  });

  test('arg triggers also require the caret at the end of the token', () => {
    expect(detectArgTrigger('/profile business', 9)).toBeNull();
  });
});
