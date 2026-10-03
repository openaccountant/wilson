import { describe, expect, test } from 'bun:test';
import {
  detectTrigger,
  detectArgTrigger,
  fuzzyScore,
  filterAndGroup,
  applySelection,
  formatMentionToken,
  accountMentionLabels,
  pruneMentions,
  extractMentionTokens,
  stripContextBlock,
  splitContextBlock,
  contextBlockLabels,
  parseCommand,
  tokenEndingAt,
  highlightSegments,
  mergeRecentMention,
  readRecentMentions,
  writeRecentMentions,
  RECENT_MENTIONS_KEY,
  type Candidate,
} from '../dashboard/ui/src/lib/typeahead.js';
import {
  CHAT_COMMANDS,
  HIDDEN_CLI_COMMANDS,
  COMMAND_GROUP_ORDER,
  COMMAND_EMPTY_LIMITS,
  commandCandidates,
  resolveCommand,
  skillCommands,
  helpMarkdown,
} from '../dashboard/ui/src/lib/chatCommands.js';
import { expandSlashCommand } from '../dashboard/chat-commands.js';
import { CONTEXT_BLOCK_HEADER } from '../dashboard/mentions.js';
import { HANDOFF_BLOCK_HEADER, MENTION_BLOCK_PREFIX } from '../dashboard/local-handoff-format.js';
import { renderHandoffBlock } from '../dashboard/local-handoff.js';

test('the shared mention-block prefix matches the server header', () => {
  expect(CONTEXT_BLOCK_HEADER.startsWith(MENTION_BLOCK_PREFIX)).toBe(true);
});

// ── detectTrigger ──────────────────────────────────────────────────────────

describe('detectTrigger', () => {
  const at = (text: string, caret = text.length, has?: (q: string) => boolean) => detectTrigger(text, caret, has);

  test('"/" at 0 opens the full list', () => {
    expect(at('/')).toEqual({ kind: '/', start: 0, end: 1, query: '', leading: true });
  });

  test('leading whitespace before "/" still counts as leading', () => {
    expect(at('  /bu')).toEqual({ kind: '/', start: 2, end: 5, query: 'bu', leading: true });
  });

  test('mid-text "/" after whitespace never triggers (commands are whole messages)', () => {
    expect(at('hey /sk')).toBeNull();
  });

  test('"a/b", "1/2/26", paths and URLs never trigger', () => {
    expect(at('a/b')).toBeNull();
    expect(at('1/2/26')).toBeNull();
    expect(at('see /usr/bin')).toBeNull();
    expect(at('https://example.com')).toBeNull();
  });

  test('email addresses never trigger "@"', () => {
    expect(at('me@x.com')).toBeNull();
    expect(at('mail me@x')).toBeNull();
  });

  test('"@" after "(" triggers', () => {
    expect(at('(@din')).toEqual({ kind: '@', start: 1, end: 5, query: 'din', leading: false });
  });

  test('bracket form keeps spaces in the query', () => {
    expect(at('@[Plaid Che')).toEqual({
      kind: '@', start: 0, end: 11, query: 'Plaid Che', leading: true, bracket: true,
    });
  });

  test('a closed bracket token no longer triggers', () => {
    expect(at('@[Plaid Checking] ')).toBeNull();
  });

  test('caret in the middle of the text', () => {
    const text = 'spent at @amaz last week';
    expect(at(text, 14)).toEqual({ kind: '@', start: 9, end: 14, query: 'amaz', leading: false });
    // Caret moved off the token → null.
    expect(at(text, 20)).toBeNull();
  });

  test('a space closes a bare "@" query when there are no matches', () => {
    expect(at('@chase ', 7, () => false)).toBeNull();
    expect(at('@chase che', 10, () => false)).toBeNull();
    // No predicate → a space always closes.
    expect(at('@chase che')).toBeNull();
  });

  test('a space continues a bare "@" query while it still matches', () => {
    expect(at('@chase ', 7, () => true)).toEqual({ kind: '@', start: 0, end: 7, query: 'chase ', leading: true });
    const seen: string[] = [];
    const t = at('@chase che', 10, (q) => (seen.push(q), true));
    expect(t?.query).toBe('chase che');
    expect(seen).toContain('chase che');
  });

  test('only one space may continue a query', () => {
    expect(at('@a b c', 6, () => true)).toBeNull();
    expect(at('@a  b', 5, () => true)).toBeNull();
  });

  test('bare "@" query closes past 48 chars', () => {
    expect(at('@' + 'x'.repeat(48))).not.toBeNull();
    expect(at('@' + 'x'.repeat(49))).toBeNull();
  });
});

describe('detectArgTrigger', () => {
  test('/profile <name>', () => {
    expect(detectArgTrigger('/profile bu', 11)).toEqual({
      kind: 'arg', source: 'profiles', command: 'profile', start: 9, end: 11, query: 'bu',
    });
    expect(detectArgTrigger('/profile a b', 12)).toBeNull();
  });

  test('/budget set <category> allows spaces until the amount starts', () => {
    expect(detectArgTrigger('/budget set Personal Ca', 23)?.query).toBe('Personal Ca');
    expect(detectArgTrigger('/budget set Dining 2', 20)).toBeNull();
    expect(detectArgTrigger('/budget', 7)).toBeNull();
  });
});

// ── fuzzyScore ─────────────────────────────────────────────────────────────

describe('fuzzyScore', () => {
  test('exact > prefix > word-boundary > substring > subsequence', () => {
    const exact = fuzzyScore('dining', 'dining')!.score;
    const prefix = fuzzyScore('din', 'dining')!.score;
    const boundary = fuzzyScore('che', 'plaid checking')!.score;
    const substring = fuzzyScore('ning', 'dining')!.score;
    const subseq = fuzzyScore('dng', 'dining')!.score;
    expect(exact).toBe(1000);
    expect(prefix).toBe(900 - 'dining'.length);
    expect(boundary).toBe(700);
    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(boundary);
    expect(boundary).toBeGreaterThan(substring);
    expect(substring).toBeGreaterThan(subseq);
  });

  test('shorter candidates win among prefixes', () => {
    expect(fuzzyScore('bu', 'budget')!.score).toBeGreaterThan(fuzzyScore('bu', 'budget set')!.score);
  });

  test('is case-insensitive', () => {
    expect(fuzzyScore('AMAZ', 'Amazon')!.score).toBe(fuzzyScore('amaz', 'amazon')!.score);
  });

  test('returns null when there is no in-order match', () => {
    expect(fuzzyScore('xyz', 'dining')).toBeNull();
    expect(fuzzyScore('gd', 'dg')).toBeNull();
  });

  test('ranges drive highlighting', () => {
    expect(fuzzyScore('che', 'Plaid Checking')!.ranges).toEqual([[6, 9]]);
    expect(fuzzyScore('dng', 'dining')!.ranges).toEqual([[0, 1], [2, 3], [5, 6]]);
    expect(highlightSegments('dining', [[0, 1], [4, 6]])).toEqual([
      { text: 'd', match: true },
      { text: 'ini', match: false },
      { text: 'ng', match: true },
    ]);
  });

  test('empty query matches everything with score 0', () => {
    expect(fuzzyScore('', 'anything')).toEqual({ score: 0, ranges: [] });
  });
});

// ── filterAndGroup ─────────────────────────────────────────────────────────

describe('filterAndGroup', () => {
  const mk = (group: string, label: string, extra: Partial<Candidate> = {}): Candidate => ({
    id: `${group}:${label}`, group, label, ...extra,
  });

  test('caps each group at 8 and the total at 40, reporting hidden matches', () => {
    const items: Candidate[] = [];
    for (const g of ['A', 'B', 'C', 'D', 'E', 'F']) for (let i = 0; i < 12; i++) items.push(mk(g, `item ${g}${i}`));
    const res = filterAndGroup(items, 'item', { groupOrder: ['A', 'B', 'C', 'D', 'E', 'F'] });
    expect(res.groups.every((g) => g.items.length <= 8)).toBe(true);
    expect(res.items.length).toBe(40);
    expect(res.hidden).toBe(72 - 40);
  });

  test('empty query keeps the configured group order and curation limits', () => {
    const items = [
      ...Array.from({ length: 10 }, (_, i) => mk('Skills', `skill s${i}`)),
      mk('Navigation', 'goals'),
      mk('Actions', 'new'),
      mk('Actions', 'help'),
    ];
    const res = filterAndGroup(items, '', { groupOrder: COMMAND_GROUP_ORDER, emptyLimits: COMMAND_EMPTY_LIMITS });
    expect(res.groups.map((g) => g.group)).toEqual(['Actions', 'Navigation', 'Skills']);
    expect(res.groups[2].items.length).toBe(6);
    expect(res.hidden).toBe(0);
  });

  test('pinned (recent) items lead an empty query and are not repeated', () => {
    const acct = mk('Accounts', 'Checking', { id: 'account:1' });
    const recent = { ...acct, group: 'Recent' };
    const res = filterAndGroup([acct, mk('Categories', 'Dining')], '', {
      groupOrder: ['Accounts', 'Categories'],
      pinned: [recent],
    });
    expect(res.groups.map((g) => g.group)).toEqual(['Recent', 'Categories']);
    expect(res.items.filter((i) => i.id === 'account:1')).toHaveLength(1);
  });

  test('with a query, groups are ordered by their best match; ties use group order', () => {
    const res = filterAndGroup(
      [mk('Accounts', 'Amex Platinum'), mk('Merchants', 'Amazon'), mk('Categories', 'Shopping', { keywords: ['shopping'] })],
      'amazon',
      { groupOrder: ['Accounts', 'Categories', 'Merchants'] },
    );
    expect(res.items[0].label).toBe('Amazon');
    expect(res.groups[0].group).toBe('Merchants');
  });

  test('keywords match at full weight, weak keywords at half', () => {
    const res = filterAndGroup(
      [mk('X', 'alpha', { keywords: ['zeta'] }), mk('X', 'beta', { weakKeywords: ['zeta'] })],
      'zeta',
      { groupOrder: ['X'] },
    );
    expect(res.items.map((i) => i.label)).toEqual(['alpha', 'beta']);
    expect(res.items[0].score).toBe(1000);
    expect(res.items[1].score).toBe(500);
  });

  test('multi-word queries require every term to hit label or keywords', () => {
    const items = [
      mk('Accounts', 'Plaid Checking', { id: 'a1', keywords: ['Chase', '1234'] }),
      mk('Accounts', 'Plaid Checking', { id: 'a2', keywords: ['Bank of America', '9999'] }),
    ];
    const res = filterAndGroup(items, 'chase che', { groupOrder: ['Accounts'] });
    expect(res.items.map((i) => i.id)).toEqual(['a1']);
  });

  test('empty groups are hidden', () => {
    const res = filterAndGroup([mk('A', 'apple'), mk('B', 'zzz')], 'app', { groupOrder: ['A', 'B'] });
    expect(res.groups.map((g) => g.group)).toEqual(['A']);
  });

  test('ties break on weight, then alphabetically', () => {
    const res = filterAndGroup(
      [mk('M', 'Bcoffee', { weight: 1 }), mk('M', 'Acoffee', { weight: 1 }), mk('M', 'Ccoffee', { weight: 50 })],
      'coffee',
      { groupOrder: ['M'] },
    );
    expect(res.items.map((i) => i.label)).toEqual(['Ccoffee', 'Acoffee', 'Bcoffee']);
  });

  test('empty "/" lists all Actions first, then a curated few Skills', () => {
    const skills = skillCommands([{ name: 'tax-prep', description: 'Prepare taxes', tier: 'paid', source: 'builtin' }]);
    const lead = commandCandidates([...CHAT_COMMANDS, ...skills]);
    const res = filterAndGroup(lead, '', { groupOrder: COMMAND_GROUP_ORDER, emptyLimits: COMMAND_EMPTY_LIMITS });
    expect(res.items[0].command.name).toBe('new');
    // Empty "/" shows ALL Actions (more than the per-group cap of 8).
    const actions = CHAT_COMMANDS.filter((c) => c.group === 'Actions').length;
    expect(actions).toBeGreaterThan(8);
    expect(res.groups[0].items).toHaveLength(actions);
    expect(res.groups.find((g) => g.group === 'Skills')?.items).toHaveLength(1);
  });

  test('aliases find their command', () => {
    const res = filterAndGroup(commandCandidates(CHAT_COMMANDS), 'clear', { groupOrder: COMMAND_GROUP_ORDER });
    expect(res.items[0].command.name).toBe('new');
    const model = filterAndGroup(commandCandidates(CHAT_COMMANDS), 'model', { groupOrder: COMMAND_GROUP_ORDER });
    expect(model.items[0].command.name).toBe('settings');
  });
});

// ── applySelection / tokens ────────────────────────────────────────────────

describe('applySelection', () => {
  test('replaces [start, caret) and adds one trailing space', () => {
    expect(applySelection('/bu', { start: 0, end: 3 }, '/budget')).toEqual({ text: '/budget ', caret: 8 });
    expect(applySelection('spent at @amaz last week', { start: 9, end: 14 }, '@Amazon')).toEqual({
      text: 'spent at @Amazon last week',
      caret: 17,
    });
  });

  test('bracket form for multi-word labels', () => {
    expect(formatMentionToken('Amazon')).toBe('@Amazon');
    expect(formatMentionToken("Trader_Joe's")).toBe("@Trader_Joe's");
    expect(formatMentionToken('Fees & Interest')).toBe('@[Fees & Interest]');
    expect(formatMentionToken('Evil] label')).toBe('@[Evil label]');
    const r = applySelection('(@[Plaid Che', { start: 1, end: 12 }, formatMentionToken('Plaid Checking'));
    expect(r.text).toBe('(@[Plaid Checking] ');
  });

  test('disambiguates duplicate account names', () => {
    const labels = accountMentionLabels([
      { id: 1, name: 'Plaid Checking', institution: 'Chase', account_number_last4: '1234' },
      { id: 2, name: 'Plaid Checking', institution: 'Bank of America', account_number_last4: '9999' },
      { id: 3, name: 'Savings', institution: 'Ally', account_number_last4: '0001' },
      { id: 4, name: 'Cash', institution: null, account_number_last4: null },
      { id: 5, name: 'Cash', institution: null, account_number_last4: null },
    ]);
    expect(labels.get(1)).toBe('Plaid Checking · Chase ••1234');
    expect(labels.get(2)).toBe('Plaid Checking · Bank of America ••9999');
    expect(labels.get(3)).toBe('Savings');
    expect(labels.get(4)).toBe('Cash #4');
    expect(labels.get(5)).toBe('Cash #5');
    expect(formatMentionToken(labels.get(1)!)).toBe('@[Plaid Checking · Chase ••1234]');
  });

  test('tokenEndingAt finds a token for atomic backspace', () => {
    const text = 'show @Amazon ';
    expect(tokenEndingAt(text, 12, ['@Amazon'])).toEqual({ start: 5, end: 12 });
    expect(tokenEndingAt(text, 13, ['@Amazon'])).toBeNull();
    expect(tokenEndingAt('x@Amazon', 8, ['@Amazon'])).toBeNull();
  });
});

describe('pruneMentions', () => {
  test('drops entries whose token left the text and dedupes', () => {
    const m = [
      { token: '@Amazon', label: 'Amazon' },
      { token: '@[Fees & Interest]', label: 'Fees & Interest' },
      { token: '@Amazon', label: 'Amazon' },
    ];
    expect(pruneMentions('spend at @Amazon', m)).toEqual([{ token: '@Amazon', label: 'Amazon' }]);
    expect(pruneMentions('nothing here', m)).toEqual([]);
  });

  test('a token that became a longer word no longer counts', () => {
    expect(pruneMentions('@Amazonian', [{ token: '@Amazon' }])).toEqual([]);
    expect(pruneMentions('@Amazon.', [{ token: '@Amazon' }])).toHaveLength(1);
  });
});

describe('extractMentionTokens', () => {
  const known = new Set(['Amazon', 'Fees & Interest', 'Home']);

  test('known tokens become mentions; unknown "@home" stays plain', () => {
    const segs = extractMentionTokens('compare @Amazon and @[Fees & Interest] vs @home.', known);
    expect(segs).toEqual([
      { kind: 'text', text: 'compare ' },
      { kind: 'mention', text: '@Amazon', label: 'Amazon' },
      { kind: 'text', text: ' and ' },
      { kind: 'mention', text: '@[Fees & Interest]', label: 'Fees & Interest' },
      { kind: 'text', text: ' vs @home.' },
    ]);
  });

  test('trailing punctuation is not part of a bare token', () => {
    const segs = extractMentionTokens('@Amazon.', known);
    expect(segs).toEqual([
      { kind: 'mention', text: '@Amazon', label: 'Amazon' },
      { kind: 'text', text: '.' },
    ]);
  });

  test('a leading /command is its own segment', () => {
    expect(extractMentionTokens('/categorize 50', known)).toEqual([
      { kind: 'command', text: '/categorize' },
      { kind: 'text', text: ' 50' },
    ]);
  });

  test('emails are not mentions', () => {
    expect(extractMentionTokens('me@Amazon', known)).toEqual([{ kind: 'text', text: 'me@Amazon' }]);
  });
});

describe('stripContextBlock', () => {
  const block = `${CONTEXT_BLOCK_HEADER}\n- account id=55 "Visa" (BofA ••2962, liability/credit_card)\n- merchant "Amazon" (match merchant_name or description)\n\n`;

  test('removes a leading block up to the first blank line', () => {
    expect(stripContextBlock(`${block}how much at @Amazon?`)).toBe('how much at @Amazon?');
    expect(splitContextBlock(`${block}hi`).block).toContain('account id=55');
  });

  test('leaves ordinary text alone', () => {
    expect(stripContextBlock('hello\n\nworld')).toBe('hello\n\nworld');
  });

  test('labels can be read back from the block', () => {
    expect(contextBlockLabels(splitContextBlock(`${block}x`).block)).toEqual(['Visa', 'Amazon']);
  });

  // Slice 5: a reloaded history query that carried an on-device handoff block
  // renders the user's words only, and the handoff lines never leak into the
  // mention labels (they contain quoted JSON that would match the label regex).
  const handoff = renderHandoffBlock(
    {
      v: 1,
      reason: 'ungrounded',
      mirror: { syncedAt: null },
      steps: [{ tool: 'transaction_search', args: { query: 'Amazon in June' }, ok: true, summary: '' }],
      localNote: 'You spent "$12" at "Amazon".',
    },
    [{ tool: 'transaction_search', args: { query: 'Amazon in June' }, ok: true, summary: 'Found 1 transaction.\n#1 2026-06-02 -$12.00 Shopping "AMZN"' }],
  );

  test('a leading handoff block is peeled (handoff only)', () => {
    expect(handoff.startsWith(HANDOFF_BLOCK_HEADER)).toBe(true);
    expect(stripContextBlock(`${handoff}how much at Amazon?`)).toBe('how much at Amazon?');
    expect(splitContextBlock(`${handoff}how much at Amazon?`).block).toBe('');
  });

  test('mention block then handoff block: body is the words, block is the mention block only', () => {
    const split = splitContextBlock(`${block}${handoff}how much at @Amazon?`);
    expect(split.body).toBe('how much at @Amazon?');
    expect(split.block).not.toContain(HANDOFF_BLOCK_HEADER);
    expect(contextBlockLabels(split.block)).toEqual(['Visa', 'Amazon']);
  });

  test('handoff block then mention block also peels both', () => {
    const split = splitContextBlock(`${handoff}${block}how much at @Amazon?`);
    expect(split.body).toBe('how much at @Amazon?');
    expect(contextBlockLabels(split.block)).toEqual(['Visa', 'Amazon']);
  });
});

describe('parseCommand', () => {
  test('parses name and rest', () => {
    expect(parseCommand('/categorize 50')).toEqual({ name: 'categorize', rest: '50' });
    expect(parseCommand('/skill tax-prep extra words')).toEqual({ name: 'skill', rest: 'tax-prep extra words' });
    expect(parseCommand('  /Budget  ')).toEqual({ name: 'budget', rest: '' });
  });

  test('"/" alone has an empty name', () => {
    expect(parseCommand('/')).toEqual({ name: '', rest: '' });
  });

  test('non-slash input is null', () => {
    expect(parseCommand('how much did I spend?')).toBeNull();
    expect(parseCommand('')).toBeNull();
  });
});

describe('recent mentions storage', () => {
  test('merge keeps 5, newest first, deduped', () => {
    let list: ReturnType<typeof mergeRecentMention> = [];
    for (let i = 1; i <= 7; i++) list = mergeRecentMention(list, { type: 'account', id: i, label: `A${i}` });
    list = mergeRecentMention(list, { type: 'account', id: 5, label: 'A5' });
    expect(list.map((m) => m.id)).toEqual([5, 7, 6, 4, 3]);
  });

  test('read/write survive throwing or corrupt storage', () => {
    const throwing = {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
    };
    expect(readRecentMentions(throwing)).toEqual([]);
    expect(() => writeRecentMentions(throwing, [])).not.toThrow();
    expect(readRecentMentions({ getItem: () => '{not json' })).toEqual([]);
    expect(readRecentMentions(undefined)).toEqual([]);

    const mem = new Map<string, string>();
    const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    writeRecentMentions(store, [{ type: 'category', id: 1, label: 'Dining' }]);
    expect(mem.has(RECENT_MENTIONS_KEY)).toBe(true);
    expect(readRecentMentions(store)).toEqual([{ type: 'category', id: 1, label: 'Dining' }]);
  });
});

// ── Registry invariants ────────────────────────────────────────────────────

describe('chat command registry', () => {
  test('names and ids are unique, aliases never shadow a name', () => {
    const names = CHAT_COMMANDS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    const ids = CHAT_COMMANDS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of CHAT_COMMANDS) for (const a of c.aliases ?? []) expect(names).not.toContain(a);
  });

  test('no CLI-only commands are registered', () => {
    for (const hidden of HIDDEN_CLI_COMMANDS) {
      expect(CHAT_COMMANDS.some((c) => c.name === hidden || c.aliases?.includes(hidden))).toBe(false);
    }
  });

  test('every agent command has a server expansion (never "unknown")', () => {
    const sample: Record<string, string> = { 'budget set': '/budget set Dining 200', skill: '/skill tax-prep' };
    const skills = skillCommands([{ name: 'tax-prep', description: 'x', tier: 'free', source: 'builtin' }]);
    for (const c of [...CHAT_COMMANDS, ...skills].filter((c) => c.kind === 'agent')) {
      const text = sample[c.name] ?? `/${c.name}`;
      const out = expandSlashCommand(text);
      // Runs server-side: through the agent (query) or a tool directly (action).
      expect('query' in out || 'action' in out).toBe(true);
    }
  });

  test('client commands carry a client run descriptor', () => {
    for (const c of CHAT_COMMANDS) {
      if (c.kind === 'client') expect(c.run.type).not.toBe('agent');
      else expect(c.run.type).toBe('agent');
    }
  });

  test('resolveCommand prefers two-word names and resolves aliases', () => {
    expect(resolveCommand({ name: 'budget', rest: '' })?.id).toBe('budget');
    expect(resolveCommand({ name: 'budget', rest: 'set Dining 200' })?.id).toBe('budget-set');
    expect(resolveCommand({ name: 'clear', rest: '' })?.id).toBe('new');
    expect(resolveCommand({ name: 'model', rest: '' })?.id).toBe('nav-settings');
    expect(resolveCommand({ name: 'nope', rest: '' })).toBeNull();
  });

  test('help markdown lists commands and marks paid skills', () => {
    const md = helpMarkdown([
      ...CHAT_COMMANDS,
      ...skillCommands([{ name: 'tax-prep', description: 'Prepare taxes', tier: 'paid', source: 'builtin' }]),
    ]);
    expect(md).toContain('`/budget set <category> <amount>`');
    expect(md).toContain('`/skill tax-prep` — Prepare taxes (PRO)');
  });
});
