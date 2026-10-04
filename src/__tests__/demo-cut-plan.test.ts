import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
// @ts-expect-error plain .mjs compose helper
import { joinCards, bindProposals, perCardItems, scheduleOverlays, nonOverlapping } from '../../demos/compose/hyperframes-b5/plan.mjs';
// @ts-expect-error plain .mjs rig helper
import { transcriptFromAudit } from '../../demos/rig/lib/ab-audit.mjs';

const CFG = JSON.parse(fs.readFileSync(path.join(import.meta.dir, '../../demos/compose/beats/b5-propose.json'), 'utf8'));
const REC0 = Date.parse('2026-10-04T17:36:16.626Z');
const wall = (s: number) => new Date(REC0 + s * 1000).toISOString();
const W = '/rig/bin/ab-agent';

// Two cards: #279 the target (approved, Shopping) then #298 another charge (rejected, Dining).
const e = (name: string, s: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ name, wall: wall(s), t_ms: Math.round(s * 1000), ...extra });
const EVENTS = [
  e('recording-started', 0), e('ledger-before', 12.8), e('grants-applied', 24, { tools: ['categorize_transaction', 'transaction_search', 'spending_summary'] }),
  e('card-shown', 41.3, { index: 0, opId: 'op-0001-aaaa', txId: '279', tool: 'categorize_transaction', change: true, text: 'Confirm: Categorize Transaction #279 (2026-09-22, -$240.00) as "Shopping"' }),
  e('card-checked', 45, { index: 0, opId: 'op-0001-aaaa', txId: '279', kind: 'change', rows: [['category', 'Uncategorized', 'Shopping']], problems: [], target: true }),
  e('approve-pressed', 45.7, { index: 0, opId: 'op-0001-aaaa', txId: '279' }), e('approve-held', 46.2, { index: 0 }), e('approve-released', 47.4, { index: 0 }),
  e('card-resolved', 47.7, { index: 0, opId: 'op-0001-aaaa', txId: '279', kind: 'change', decision: 'approve', target: true, outcome: 'Done. The change was applied.' }),
  e('card-shown', 52, { index: 1, opId: 'op-0002-bbbb', txId: '298', tool: 'categorize_transaction', change: true, text: 'Confirm: Categorize Transaction #298 (2026-09-15, -$88.10) as "Dining"' }),
  e('card-checked', 55.5, { index: 1, opId: 'op-0002-bbbb', txId: '298', kind: 'change', rows: [['category', 'Uncategorized', 'Dining']], problems: ['card text does not contain SQ *KILN & CO STUDIO'], target: false }),
  e('reject-clicked', 56, { index: 1, opId: 'op-0002-bbbb', txId: '298', reason: 'not the target' }),
  e('card-resolved', 56.6, { index: 1, opId: 'op-0002-bbbb', txId: '298', kind: 'change', decision: 'reject', target: false, outcome: 'Rejected. Nothing was changed.' }),
  e('ledger-after', 70, { decision: 'approve', category: 'Shopping' }), e('beat-end', 73.5),
];
const rec = (s: number, end: number, argv: string[], stdout = '') => ({ ts: wall(s), endTs: wall(end), argv, accepted: true, exitCode: 0, stdout, stderr: '' });
const inv = (id: number, cat: string) => ['webmcp', 'invoke', 'categorize_transaction', '--detach', '--params', JSON.stringify({ id, category: cat })];
const AUDIT = [
  rec(26, 26.5, ['webmcp', 'list', '--json'], '{"success":true}'),
  rec(28, 29, ['webmcp', 'invoke', 'transaction_search', '--params', '{"query":"September"}'], '{"rows":[]}'),
  rec(37, 37.4, inv(279, 'Shopping'), 'AAA111: pending'),
  rec(37.6, 47.8, ['webmcp', 'result', 'AAA111'], 'AAA111: completed\n{"outcome":"committed"}'),
  rec(49, 49.4, inv(298, 'Dining'), 'BBB222: pending'),
  rec(49.6, 56.7, ['webmcp', 'result', 'BBB222'], 'BBB222: completed\n{"outcome":"rejected"}'),
];
const entries = () => transcriptFromAudit(AUDIT).map((t: { date: Date; endDate: Date }) => ({ ...t, src: (t.date.getTime() - REC0) / 1000, endSrc: (t.endDate.getTime() - REC0) / 1000 }));

describe('cut plan: cards bound to their own operation', () => {
  test('events join per card with the op id, and every card is resolved', () => {
    const cards = joinCards(EVENTS);
    expect(cards.map((c: { opId: string; txId: string; decision: string; target: boolean }) => [c.opId, c.txId, c.decision, c.target])).toEqual([['op-0001-aaaa', '279', 'approve', true], ['op-0002-bbbb', '298', 'reject', false]]);
    expect(cards[0].pressed).toBeCloseTo(45.7); expect(cards[1].rejectClicked).toBeCloseTo(56);
  });

  test('a card shown but never resolved refuses the cut (no pending card at the end frame)', () => {
    expect(() => joinCards(EVENTS.filter((x) => !(x.name === 'card-resolved' && x.index === 1)))).toThrow(/never resolved/);
  });

  test('each card is bound to the audited proposal with the same transaction id and category', () => {
    const cards = bindProposals(joinCards(EVENTS), entries());
    expect(cards[0].proposal.args).toEqual({ id: 279, category: 'Shopping' });
    expect(cards[1].proposal.args).toEqual({ id: 298, category: 'Dining' });
    expect(cards[0].proposal.src).toBeLessThan(cards[0].shown);
    expect(cards[1].proposal.src).toBeGreaterThan(cards[0].resolved);
  });

  test('a card with no matching proposal, or a different category, cannot be annotated', () => {
    const noMatch = entries().filter((x: { argv: string[] }) => !x.argv.join(' ').includes('"id":298'));
    expect(() => bindProposals(joinCards(EVENTS), noMatch)).toThrow(/cannot bind card op-0002-bbbb/);
    const wrongCat = transcriptFromAudit([...AUDIT.slice(0, 4), rec(49, 49.4, inv(298, 'Travel'), 'x: pending')]).map((t: { date: Date; endDate: Date }) => ({ ...t, src: (t.date.getTime() - REC0) / 1000, endSrc: 0 }));
    expect(() => bindProposals(joinCards(EVENTS), wrongCat)).toThrow(/shows category Dining but the bound proposal asked for Travel/);
  });

  const items = () => perCardItems(CFG.perCard, bindProposals(joinCards(EVENTS), entries()), { target: CFG.target, targetTxId: '279' });

  test('"not the target" copy only for a provably different transaction; a rejected target card gets the neutral caption', () => {
    const mk = (txId: string) => ({ index: 0, kind: 'change', tool: 'categorize_transaction', txId, opId: 'op-x', shown: 10, rejectClicked: 12, resolved: 13, decision: 'reject', target: false, after: 'Shopping', before: 'Uncategorized' });
    const cap = (txId: string, targetTxId: string | null) => perCardItems(CFG.perCard, [mk(txId)], { target: CFG.target, targetTxId }).caps.at(-1).t;
    expect(cap('298', '279')).toBe(CFG.perCard.resolved.rejectOther.replace('{target}', CFG.target).replace('{txId}', '298'));
    expect(cap('279', '279')).toBe(CFG.perCard.resolved.reject.replace('{txId}', '279'));
    expect(cap('298', null)).toBe(CFG.perCard.resolved.reject.replace('{txId}', '298'));
  });

  test('every caption and callout names only its own card (tx id + category), and carries the card index', () => {
    const { caps, cos } = items();
    const own = { 0: { id: '279', cat: 'Shopping', other: '298', otherCat: 'Dining' }, 1: { id: '298', cat: 'Dining', other: '279', otherCat: 'Shopping' } } as const;
    for (const x of [...caps, ...cos]) {
      const o = own[x.card as 0 | 1];
      const text = 'txt' in x ? `${x.txt} ${x.sub}` : x.t;
      expect(text).not.toMatch(new RegExp(`#${o.other}\\b`));
      expect(text).not.toContain(o.otherCat);
      expect(text).not.toMatch(/\{\w+\}/); // no unfilled template
    }
    const shown0 = cos.find((c: { id: string }) => c.id === 'co_c0_a'); const shown1 = cos.find((c: { id: string }) => c.id === 'co_c1_a');
    expect(shown0.sub).toBe('#279 · Uncategorized → Shopping');
    expect(shown1.sub).toBe('#298 · Uncategorized → Dining');
  });

  test('each decided card gets its beats on its own events: approve (shown, hold, done) and reject (shown, rejected)', () => {
    const { caps, cos } = items();
    const c0 = caps.filter((c: { card: number }) => c.card === 0); const c1 = caps.filter((c: { card: number }) => c.card === 1);
    expect(c0.map((c: { t: string }) => c.t.split(' ')[0])).toEqual(['The', 'Card', 'The', '“Done.']);
    expect(c0[1]).toMatchObject({ start: 41.3, end: 45.7 }); expect(c0[2]).toMatchObject({ start: 45.7, end: 47.4 });
    expect(c1.find((c: { t: string }) => /rejects #298/.test(c.t))).toBeTruthy();
    expect(c1.find((c: { t: string }) => /Not the SQ \*KILN & CO STUDIO charge/.test(c.t))).toBeTruthy(); // non-target rejection names why
    expect(c1.find((c: { start: number }) => c.start === 56)).toBeTruthy();
    expect(cos.filter((c: { card: number }) => c.card === 1).map((c: { txt: string }) => c.txt)).toEqual(['Exact row + before/after, shown on the card', 'Reject leaves the books untouched']);
    for (const c of cos.filter((x: { card: number }) => x.card === 0)) { expect(c.start).toBeGreaterThanOrEqual(41.3); expect(c.end).toBeLessThanOrEqual(47.7 + CFG.perCard.resolvedHold + 1e-9); }
  });

  test('scheduled lower-thirds never overlap: later items clip the earlier, squeezed optional ones are dropped', () => {
    const { caps } = items();
    const raw = [{ start: 0, end: 5, t: 'global' }, ...caps].sort((a: { start: number }, b: { start: number }) => a.start - b.start);
    // the optional "proposes" caption of card 1 starts 49 and ends 52; card 0's resolved caption runs to 49.2 and is clipped, not delayed
    const out = scheduleOverlays(raw);
    expect(nonOverlapping(out)).toBe(true);
    for (let i = 1; i < out.length; i++) expect(out[i].start).toBeGreaterThanOrEqual(out[i - 1].end);
    expect(out.every((x: { end: number; start: number }) => x.end > x.start)).toBe(true);
  });

  test('forced overlap: a long caption is clipped to the next start; a squeezed optional one is dropped', () => {
    const out = scheduleOverlays([
      { start: 0, end: 10, t: 'A' },
      { start: 4, end: 6, t: 'B', optional: true },
      { start: 5.8, end: 9, t: 'C' },
    ]);
    expect(out.map((x: { t: string }) => x.t)).toEqual(['A', 'B', 'C']);
    expect(out[0].end).toBeCloseTo(3.95); expect(out[1].end).toBeCloseTo(5.75);
    const dropped = scheduleOverlays([{ start: 0, end: 10, t: 'A' }, { start: 4, end: 6, t: 'B', optional: true }, { start: 4.3, end: 9, t: 'C' }]);
    expect(dropped.map((x: { t: string }) => x.t)).toEqual(['A', 'C']);
    expect(dropped[0].end).toBeCloseTo(4.25);
  });
});

describe('build.mjs end to end on a synthetic two-card take (no browser, no video decode)', () => {
  const make = () => {
    const take = fs.mkdtempSync(path.join(os.tmpdir(), 'cut-take-'));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cut-cwd-'));
    fs.writeFileSync(path.join(take, 'events.json'), JSON.stringify({ beat: 'b5-propose', recordingStartedAt: wall(0), events: EVENTS }));
    fs.writeFileSync(path.join(take, 'video.mp4'), 'not a real video');
    fs.writeFileSync(path.join(take, 'actor-meta.json'), JSON.stringify({ wrapper: W, bin: '/b', cdpPort: 9333, session: 's', beat: 'b5-propose' }));
    fs.writeFileSync(path.join(take, 'ab-audit.jsonl'), AUDIT.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const cmd = (a: string[]) => `${W} ${a.map((x) => (/^[A-Za-z0-9_.-]+$/.test(x) ? x : `'${x}'`)).join(' ')}`;
    const stream = AUDIT.map((r, i) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `t${i}`, name: 'Bash', input: { command: cmd(r.argv) } }] } }));
    stream.push({ type: 'result', result: 'Proposed #279 (approved) and #298 (rejected).', _rx: wall(60) } as never);
    fs.writeFileSync(path.join(take, 'actor.jsonl'), stream.map((x) => JSON.stringify(x)).join('\n') + '\n');
    return { take, cwd };
  };
  const build = (take: string, cwd: string) => spawnSync('node', [path.join(import.meta.dir, '../../demos/compose/hyperframes-b5/build.mjs'), '--take', take, '--config', path.join(import.meta.dir, '../../demos/compose/beats/b5-propose.json')], { cwd, encoding: 'utf8' });

  test('builds; captions and callouts are bound to their cards, ledger hold >= 2.5 s, no overlapping lower-thirds', () => {
    const { take, cwd } = make();
    const r = build(take, cwd);
    expect(r.status).toBe(0);
    const html = fs.readFileSync(path.join(cwd, 'index.html'), 'utf8');
    expect(html).toContain('data-card="0"'); expect(html).toContain('data-card="1"');
    expect(html).toContain('Ledger afterwards, search cleared: 1 approved, 1 rejected.');
    const caps = JSON.parse(/const caps = (\[.*?\]);/s.exec(html)![1]) as Array<{ a: number; b: number }>;
    for (let i = 1; i < caps.length; i++) expect(caps[i].a).toBeGreaterThanOrEqual(caps[i - 1].b);
    const seg = /id="seg2"[^>]*data-duration="([\d.]+)"/.exec(html)![1];
    expect(Number(seg) - 1.2).toBeGreaterThanOrEqual(2.5); // segment 2 starts 1.2 s before ledger-after
    expect(html).toContain('\u201cShopping\u201d');
  });

  test('refuses a take whose stream has a command that is not in the audit', () => {
    const { take, cwd } = make();
    fs.appendFileSync(path.join(take, 'actor.jsonl'), JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'z', name: 'Bash', input: { command: `${W} snapshot` } }] } }) + '\n');
    const r = build(take, cwd);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/no ab-audit.jsonl record/);
  });

  test('refuses a take with a pending card, and one with a ledger hold under 2.5 s', () => {
    const a = make();
    const ev = JSON.parse(fs.readFileSync(path.join(a.take, 'events.json'), 'utf8'));
    ev.events = ev.events.filter((x: { name: string; index?: number }) => !(x.name === 'card-resolved' && x.index === 1));
    fs.writeFileSync(path.join(a.take, 'events.json'), JSON.stringify(ev));
    expect(build(a.take, a.cwd).stderr).toMatch(/never resolved/);
    const b = make();
    const ev2 = JSON.parse(fs.readFileSync(path.join(b.take, 'events.json'), 'utf8'));
    ev2.events.find((x: { name: string }) => x.name === 'beat-end').t_ms = 71500;
    fs.writeFileSync(path.join(b.take, 'events.json'), JSON.stringify(ev2));
    expect(build(b.take, b.cwd).stderr).toMatch(/ledger-after hold is/);
  });
});
