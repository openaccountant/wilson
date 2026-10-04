// Config-parsing test for the beat-10 HyperFrames cut. The events come from a HAND-MADE fixture (demos/compose/fixtures), so this
// proves the config + template handle the b10 event contract, including missing optional events. It is never a rendered deliverable.
import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
// @ts-expect-error plain .mjs compose helper
import { fillTokens, MissingValue, zoomCrop, zoomTweens, cardZoomWindows, joinCards, firstAppearance, lastJump, normRect, findEvent } from '../../demos/compose/hyperframes/plan.mjs';

const DEMOS = path.join(import.meta.dir, '../../demos');
const FIXTURE = JSON.parse(fs.readFileSync(path.join(DEMOS, 'compose/fixtures/b10-judge.FIXTURE-NOT-A-RECORDING.events.json'), 'utf8'));
const CFG = path.join(DEMOS, 'compose/beats/b10-judge.json');
const REC0 = Date.parse(FIXTURE.recordingStartedAt);
const wall = (s: number) => new Date(REC0 + s * 1000).toISOString();
const W = '/rig/bin/ab-agent';
const rec = (s: number, end: number, argv: string[], stdout = '') => ({ ts: wall(s), endTs: wall(end), argv, accepted: true, exitCode: 0, stdout, stderr: '' });
const inv = (tool: string, ...extra: string[]) => ['webmcp', 'invoke', tool, '--params', '{}', ...extra];
const AUDIT = [
  rec(22, 22.4, ['webmcp', 'list', '--json'], '{}'), rec(24, 24.4, inv('get_judge_rubric')), rec(26, 26.4, inv('list_interactions')), rec(28, 28.4, inv('get_interaction')),
  rec(30, 30.4, inv('open_interaction')), rec(36, 36.4, inv('propose_judgements', '--detach'), 'AAA: pending'), rec(36.6, 46.2, ['webmcp', 'result', 'AAA'], 'AAA: completed\n{"outcome":"committed"}'),
];
const make = (mutate?: (events: Array<Record<string, unknown>>) => void) => {
  const take = fs.mkdtempSync(path.join(os.tmpdir(), 'cut-b10-take-'));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'cut-b10-out-'));
  const events = structuredClone(FIXTURE.events) as Array<Record<string, unknown>>;
  mutate?.(events);
  fs.writeFileSync(path.join(take, 'events.json'), JSON.stringify({ beat: 'b10-judge', recordingStartedAt: FIXTURE.recordingStartedAt, events }));
  fs.writeFileSync(path.join(take, 'video.mp4'), 'not a real video');
  fs.writeFileSync(path.join(take, 'actor-meta.json'), JSON.stringify({ wrapper: W, bin: '/b', cdpPort: 9333, session: 's', beat: 'b10-judge' }));
  fs.writeFileSync(path.join(take, 'ab-audit.jsonl'), AUDIT.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const cmd = (a: string[]) => `${W} ${a.map((x) => (/^[A-Za-z0-9_.-]+$/.test(x) ? x : `'${x}'`)).join(' ')}`;
  const stream: unknown[] = AUDIT.map((r, i) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `t${i}`, name: 'Bash', input: { command: cmd(r.argv) } }] } }));
  stream.push({ type: 'result', result: 'Proposed four grades.', _rx: wall(60) });
  fs.writeFileSync(path.join(take, 'actor.jsonl'), stream.map((x) => JSON.stringify(x)).join('\n') + '\n');
  return { take, out };
};
// the fixture take has no real video, so use the host's card events (cardStart 'event'); the footage detector is unit-tested below
const build = (take: string, out: string) => {
  const cfg = path.join(out, 'cfg.json');
  fs.writeFileSync(cfg, JSON.stringify({ ...JSON.parse(fs.readFileSync(CFG, 'utf8')), cardStart: 'event', footageAnchors: 'skip' }));
  return spawnSync('node', [path.join(DEMOS, 'compose/hyperframes/build.mjs'), '--take', take, '--config', cfg, '--out', out], { encoding: 'utf8' });
};
const caps = (html: string) => [...html.matchAll(/<div class="cap" id="cap\d+"[^>]*>([^<]*)<\/div>/g)].map((m) => m[1]);

describe('tokens, zoom and per-card helpers', () => {
  const ev = FIXTURE.events;
  test('{@event[k=v].path} quotes events.json; arrays join; missing values throw unless a fallback is given', () => {
    expect(fillTokens('{@tiles[phase=after-agent].proposed}/{@tiles[phase=after-review].accepted}', ev)).toBe('4/1');
    expect(fillTokens('{@catch-score.caught.length} of {@catch-score.wrongIds.length}', ev)).toBe('1 of 4');
    expect(fillTokens('{@grants-applied.tools}', ev)).toContain('get_judge_rubric · list_interactions');
    expect(() => fillTokens('{@nope.x}', ev)).toThrow(MissingValue);
    expect(() => fillTokens('{@catch-score.nope}', ev)).toThrow(MissingValue);
    expect(fillTokens('[{@nope.x|none}]', ev)).toBe('[none]');
    expect(fillTokens('{@this.rating}', ev, {}, { this: { rating: 3 } })).toBe('3');
    expect(fillTokens('{@export-done[variant=default].rows:row}|{@export-done[variant=with-judge].rows:row}|{@export-done[variant=default].provenance#From: |x}|{@nope.y#From: |none}', ev)).toBe('0 rows|3 rows|From: the downloaded file|none');
    expect(fillTokens('{@export-done[variant=default].includeJudge}/{@export-done[variant=with-judge].includeJudge}', ev)).toBe('false/true');
    expect(fillTokens('{@export-done[variant=with-judge].judgeRows|not recorded in the file}', ev)).toBe('not recorded in the file'); // null is never rendered as 0
    expect(findEvent(ev, 'human-annotation-saved', { rating: { lt: 4 } })).toBeTruthy(); expect(findEvent(ev, 'human-annotation-saved', { rating: { gte: 4 } })).toBeUndefined();
  });
  test('zoom crop is uniform, stays inside the frame and eases in and out; close windows glide instead of resetting', () => {
    const z = zoomCrop({ x: 0.75, y: 0.72, w: 0.245, h: 0.27 }, { pad: 0.03, maxScale: 2 });
    expect(z.s).toBe(2); expect(z.ox).toBeCloseTo(0.5, 5); expect(z.oy).toBeCloseTo(0.5, 5);
    const tw = zoomTweens([{ start: 10, end: 20, rect: { x: 0.75, y: 0.72, w: 0.245, h: 0.27 } }, { start: 30, end: 40, rect: { x: 0.75, y: 0.72, w: 0.245, h: 0.27 } }], { ease: 0.6, pad: 0.03, maxScale: 2 });
    expect(tw.map((t: { s: number }) => t.s)).toEqual([2, 1, 2, 1]);
    const glide = zoomTweens([{ start: 10, end: 20, rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } }, { start: 20.5, end: 30, rect: { x: 0.7, y: 0.7, w: 0.2, h: 0.2 } }], { ease: 0.6 });
    expect(glide.map((t: { s: number }) => t.s > 1)).toEqual([true, true, false]);
  });
  test('a card the human could not reach (behind a dialog) with no recorded box gets no zoom; a recorded box wins over the config rect', () => {
    const cards = joinCards(ev);
    const wins = cardZoomWindows({ kinds: ['change', 'read'], rect: { x: 0.75, y: 0.72, w: 0.245, h: 0.27 } }, cards, { width: 1440, height: 900 });
    expect(wins.map((w: { card: number }) => w.card)).toEqual([0]);
    const boxed = joinCards(ev.map((e: Record<string, unknown>) => (e.name === 'card-shown' && e.index === 0 ? { ...e, box: { x: 720, y: 450, w: 360, h: 225 } } : e)));
    const w2 = cardZoomWindows({ kinds: ['change'], rect: { x: 0, y: 0, w: 0.1, h: 0.1 } }, boxed, { width: 1440, height: 900 });
    expect(w2[0]).toMatchObject({ source: 'event' }); expect(w2[0].rect.x).toBeCloseTo(0.5);
  });
});

describe('card first appearance from footage', () => {
  const frame = (v: number) => new Uint8Array(64).fill(v);
  test('picks the pop-in frame, ignores a fading toast, and returns null when nothing changes', () => {
    const toast = [10, 10, 10, 13, 13, 40, 40, 40].map(frame); // 3 grey-level toast fade at 0.3 s, card at 0.5 s
    expect(firstAppearance(toast, 10, 50)).toBe(50.5);
    expect(firstAppearance([10, 10, 10, 12].map(frame), 10, 50)).toBeNull();
  });
  test('lastJump finds a dialog closing (the last big change), not it opening; normRect takes Playwright width/height', () => {
    const seq = [10, 10, 60, 60, 60, 12, 12, 12].map(frame); // opens at 0.2 s, closes at 0.5 s
    expect(lastJump(seq, 10, 50)).toBe(50.5);
    expect(lastJump([10, 10, 11].map(frame), 10, 50)).toBeNull();
    expect(normRect({ x: 720, y: 450, width: 360, height: 225 }, { width: 1440, height: 900 })).toEqual({ x: 0.5, y: 0.5, w: 0.25, h: 0.25 });
  });
});

describe('build.mjs with the b10 config on the hand-made fixture', () => {
  test('builds every segment and caption from the events; values, not adjectives', () => {
    const { take, out } = make();
    const r = build(take, out);
    expect(r.stderr).not.toMatch(/Error/);
    expect(r.status).toBe(0);
    const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
    expect(html).toContain('OPEN ACCOUNTANT / BEAT 10');
    const c = caps(html).join('\n');
    expect(c).toContain('Judge: proposed 0 / accepted 0'); expect(c).toContain('Judge: proposed 4 / accepted 0'); expect(c).toContain('Judge: proposed 0 / accepted 1');
    expect(c).toContain('caught 1 of 4 deliberately wrong answers');
    expect(c).toContain('with agentPresent: true. The default export leaves it out for two reasons');
    expect(c).toContain('Default export (sft), includeJudge false, includeAgentPresent false: 0 rows.');
    expect(c).toContain('includeAgentPresent true): 3 rows. Judge rows: not recorded in the file. Human rows: 1. Interactions in the file: 3.');
    expect(c).toContain('for two reasons: it is flagged agent-present, and an SFT export keeps only runs rated 4 or higher (src/training/annotations.ts:405)');
    expect(c).toContain('“Include ratings made while an agent had access”');
    expect(c).toContain('Seed ground truth: a deliberately wrong answer, and the agent rated it 1.'); expect(c).toContain('Seed ground truth: #7 is a deliberately wrong answer, so a 5 is too generous.');
    expect(c).toContain('0 rows. Counted from: the downloaded file'); expect(c).toContain('3 rows. Judge rows');
    expect(c).toContain('get_interaction calls in all');
    expect((html.match(/id="seg\d+"/g) ?? []).length).toBe(8);
    expect(html).toContain('src/dashboard/judgement-routes.ts:42');
    expect(html).not.toMatch(/\{@|\{\w+\}/); // no unfilled template
    expect(fs.existsSync(path.join(DEMOS, 'compose/hyperframes/index.html'))).toBe(false); // never written into the template dir
  });

  test('catch-score of 0 is captioned literally', () => {
    const { take, out } = make((evs) => { const cs = evs.find((e) => e.name === 'catch-score') as Record<string, unknown>; cs.caught = []; cs.missed = [7, 8, 9, 10]; });
    expect(build(take, out).status).toBe(0);
    expect(caps(fs.readFileSync(path.join(out, 'index.html'), 'utf8')).join('\n')).toContain('caught 0 of 4 deliberately wrong answers');
  });

  test('missing optional events degrade gracefully: that segment and caption are skipped, the cut still builds', () => {
    const { take, out } = make((evs) => { for (let i = evs.length - 1; i >= 0; i--) if (['panel-opened-by-agent', 'human-annotation-saved', 'card-behind-dialog', 'verdict-accepted', 'verdict-rejected'].includes(evs[i].name as string)) evs.splice(i, 1); });
    const r = build(take, out);
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/skipped optional items/);
    const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
    expect((html.match(/id="seg\d+"/g) ?? []).length).toBe(7); // the annotation segment is gone, and so are the verdict ones
    expect(caps(html).join('\n')).not.toContain('themselves');
  });

  test('a missing required event fails loudly, naming it', () => {
    for (const name of ['catch-score', 'queue-shown', 'training-before']) {
      const { take, out } = make((evs) => { const i = evs.findIndex((e) => e.name === name); evs.splice(i, 1); });
      const r = build(take, out);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain(name);
    }
    const second = make((evs) => { const i = evs.findIndex((e) => e.name === 'export-done' && e.variant === 'with-judge'); evs.splice(i, 1); });
    expect(build(second.take, second.out).stderr).toMatch(/required event .*with-judge/);
    const { take, out } = make((evs) => { const i = evs.findIndex((e) => e.name === 'tiles' && e.phase === 'after-agent'); evs.splice(i, 1); });
    expect(build(take, out).stderr).toMatch(/required event .*after-agent/);
  });

  test('refuses a config for another beat, and refuses to build into the template dir', () => {
    const { take } = make();
    const r = spawnSync('node', [path.join(DEMOS, 'compose/hyperframes/build.mjs'), '--take', take, '--config', path.join(DEMOS, 'compose/beats/b5-propose.json'), '--out', os.tmpdir() + '/x'], { encoding: 'utf8' });
    expect(r.stderr).toMatch(/is for b5-propose/);
    const r2 = spawnSync('node', [path.join(DEMOS, 'compose/hyperframes/build.mjs'), '--take', take, '--config', CFG, '--out', path.join(DEMOS, 'compose/hyperframes')], { encoding: 'utf8' });
    expect(r2.stderr).toMatch(/template dir/);
  });
});
