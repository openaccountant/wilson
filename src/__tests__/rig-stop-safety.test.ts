import { describe, expect, test } from 'bun:test';
// @ts-expect-error plain .mjs rig helper
import { judgeOrphanGroup, reapOrphanGroup, workspace, assertScratch } from '../../demos/rig/lib/common.mjs';

const MARK = '/repo/src/index.tsx --dashboard --port 3141';
const rec = (ageSec: number, pid = 4242) => ({ pid, expect: `${MARK}`, startedAt: new Date(Date.now() - ageSec * 1000).toISOString() });
const member = (over: Record<string, unknown> = {}) => ({ pid: 4300, pgid: 4242, command: `bun run ${MARK}`, ageSec: 50, ...over });

describe('rig reapOrphanGroup safety', () => {
  test('a verified group (record fresh, every member matches) is signalled', async () => {
    const sent: string[] = [];
    const r = await reapOrphanGroup(rec(100), [MARK], { members: () => [member(), member({ pid: 4301 })], kill: (s: string, g: number) => sent.push(`${s}:${g}`), log: () => {}, wait: async () => {} });
    expect(r.killed).toBe(true);
    expect(sent).toEqual(['SIGTERM:4242', 'SIGKILL:4242']);
  });

  test('a fake stale record whose pgid now holds someone else\'s process kills nothing', async () => {
    const sent: string[] = [];
    const logs: string[] = [];
    const r = await reapOrphanGroup(rec(100), [MARK], {
      members: () => [member({ command: '/usr/bin/some-editor --file notes.txt' })],
      kill: (s: string, g: number) => sent.push(`${s}:${g}`), log: (l: string) => logs.push(l), wait: async () => {},
    });
    expect(r.killed).toBe(false);
    expect(sent).toEqual([]);
    expect(logs.join('\n')).toContain('some-editor'); // members are logged
  });

  test('one non-matching member among matching ones still blocks the kill', async () => {
    const sent: string[] = [];
    const r = await reapOrphanGroup(rec(100), [MARK], { members: () => [member(), member({ pid: 9, command: 'vim' })], kill: (s: string) => sent.push(s), log: () => {}, wait: async () => {} });
    expect(r.killed).toBe(false);
    expect(sent).toEqual([]);
  });

  test('a member older than the pid record (reused group) is rejected even if its command matches', () => {
    expect(judgeOrphanGroup(rec(100), [member({ ageSec: 99999 })], [MARK]).ok).toBe(false);
  });

  test('a member in a different group, a malformed record, or no markers is rejected', () => {
    expect(judgeOrphanGroup(rec(100), [member({ pgid: 1 })], [MARK]).ok).toBe(false);
    expect(judgeOrphanGroup({ pid: 1, expect: MARK, startedAt: new Date().toISOString() }, [member({ pgid: 1 })], [MARK]).ok).toBe(false);
    expect(judgeOrphanGroup({ pid: 4242 } as never, [member()], [MARK]).ok).toBe(false);
    expect(judgeOrphanGroup(rec(100), [member()], []).ok).toBe(false);
  });
});

describe('rig path guards', () => {
  test('workspace rejects names and beats containing / or ..', () => {
    expect(() => workspace('../x')).toThrow();
    expect(() => workspace('a/b')).toThrow();
    expect(() => workspace('ok').beatDir('../../etc')).toThrow();
    expect(() => workspace('ok').beatDir('a/b')).toThrow();
    expect(workspace('ok').beatDir('w9-tour')).toContain('/wilson-demos/ok/w9-tour');
  });
  test('assertScratch refuses paths outside the scratch root', () => {
    expect(() => assertScratch('/Users/someone/.openaccountant')).toThrow();
    expect(() => assertScratch('/private/tmp/claude-501/../x')).toThrow();
  });
});
