// Beat 5 "It proposes. You decide." - real footage + real transcript, annotations only.
import React from 'react';
import { AbsoluteFill, Sequence, OffthreadVideo, staticFile, useCurrentFrame, useVideoConfig, interpolate, spring } from 'remotion';
import { loadFont as loadMono } from '@remotion/google-fonts/JetBrainsMono';
import { loadFont as loadGrotesk } from '@remotion/google-fonts/SpaceGrotesk';
import data from './b5-data.json';

const mono = loadMono('normal', { weights: ['400', '700'], subsets: ['latin'] }).fontFamily;
const grotesk = loadGrotesk('normal', { weights: ['600', '700'], subsets: ['latin'] }).fontFamily;
const C = { money: '#22c55e', mint: '#86efac', ledger: '#e5e7eb', ink: '#9ca3af', carbon: '#374151', slate: '#1f2937', void: '#111827', deep: '#0a0f1a', caution: '#f59e0b', lead: '#06b6d4', dim: '#166534' };

export const FPS = 30;
const TITLE = 90;
// Data-driven cuts: [srcStart, srcEnd] seconds on the video timeline (events.json t_ms / 1000).
export const SEGS: [number, number][] = [[17, 30], [50.5, 61], [65.5, 68.5], [92, 110.5], [119.5, 124.5]];
const segFrames = SEGS.map(([a, b]) => Math.round((b - a) * FPS));
export const TOTAL = TITLE + segFrames.reduce((a, b) => a + b, 0);

// source time -> output frame (null if in a cut)
const segStarts = segFrames.reduce<number[]>((acc, f, i) => { acc.push(i ? acc[i - 1] + segFrames[i - 1] : 0); return acc; }, []);
const srcAtFrame = (frame: number): number => {
  for (let i = SEGS.length - 1; i >= 0; i--) if (frame >= segStarts[i]) return SEGS[i][0] + Math.min(frame - segStarts[i], segFrames[i]) / FPS;
  return SEGS[0][0];
};
const inSeg = (t: number) => SEGS.some(([a, b]) => t >= a && t <= b);

type Callout = { from: number; to: number; text: string; sub?: string; x: number; y: number; color?: string };
// all times in source seconds, pinned to event-log moments
const CALLOUTS: Callout[] = [
  { from: 24, to: 30, text: 'Agent sees only the 3 tools you granted', sub: 'grants-applied @ 28.9s', x: 700, y: 420 },
  { from: 102.4, to: 106.2, text: 'Exact row + before/after, computed by the server', sub: 'card-shown @ 102.4s', x: 560, y: 420, color: C.lead },
  { from: 106.2, to: 109.6, text: 'Nothing changes until you hold Approve', sub: 'approve-held @ 107.4s', x: 560, y: 420, color: C.money },
];
const CAPTIONS: [number, number, string][] = [
  [17, 24, 'Before: Sep 22, SQ *KILN & CO STUDIO, -$240.00, Uncategorized'],
  [24, 30, 'Access granted: categorize_transaction, transaction_search, spending_summary'],
  [50.5, 61, 'The agent calls the granted tools over WebMCP and finds the Kiln row (id 279)'],
  [65.5, 68.5, 'The agent also calls spending_summary'],
  [92, 100, 'The agent picks "Shopping" itself and proposes categorize_transaction {id:279}'],
  [100, 106.2, 'A confirmation card appears. The ledger is unchanged so far.'],
  [106.2, 109.6, 'Human holds Approve. Outcome: "Done. The change was applied."'],
  [109.6, 111, 'Outcome: Done. The change was applied.'],
  [119.5, 125, 'After: the same row now reads Shopping. The agent proposed; the human decided.'],
];

const fade = (frame: number, a: number, b: number, k = 6) => interpolate(frame, [a, a + k, b - k, b], [0, 1, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

const Title: React.FC = () => {
  const f = useCurrentFrame(); const { fps } = useVideoConfig();
  const s = spring({ frame: f, fps, config: { damping: 200 }, durationInFrames: 20 });
  return (
    <AbsoluteFill style={{ background: C.deep, justifyContent: 'center', padding: '0 160px', opacity: interpolate(f, [TITLE - 10, TITLE], [1, 0]) }}>
      <div style={{ opacity: s, transform: `translateY(${(1 - s) * 24}px)` }}>
        <div style={{ color: C.money, fontFamily: mono, fontSize: 30, fontWeight: 700, marginBottom: 28 }}>$ OPEN ACCOUNTANT / BEAT 5</div>
        <div style={{ color: C.ledger, fontFamily: grotesk, fontWeight: 700, fontSize: 120, lineHeight: 1.05 }}>It proposes.<br /><span style={{ color: C.money }}>You decide.</span></div>
        <div style={{ color: C.ink, fontFamily: mono, fontSize: 26, marginTop: 36 }}>Real session. Real agent. Real approval.</div>
        <div style={{ width: 140, height: 3, background: C.money, marginTop: 36 }} />
      </div>
    </AbsoluteFill>
  );
};

const Terminal: React.FC<{ src: number; frame: number }> = ({ src, frame }) => {
  type Row = { k: 'cmd' | 'body' | 'cut' | 'sum'; t: string };
  const rows: Row[] = [];
  for (const e of data.entries as any[]) {
    if (e.summary) { if (src >= 119.5) rows.push({ k: 'sum', t: e.summary }); continue; }
    if (src < e.t) continue;
    if (!inSeg(e.t)) rows.push({ k: 'cut', t: '... cut to the next moment ...' });
    rows.push({ k: 'cmd', t: `$ ${e.cmd.replace('agent-browser ', '')}` });
    if (src >= e.t + 0.7) {
      const body = e.body.filter((l: string) => l.trim() !== '');
      const cap = e.cmd.includes('list --json') ? 1 : 12;
      body.slice(0, cap).forEach((l: string) => rows.push({ k: 'body', t: l }));
      if (body.length > cap) rows.push({ k: 'cut', t: `... ${body.length - cap} more lines not shown ...` });
    }
  }
  const last = rows.slice(-34);
  const color = { cmd: C.mint, body: C.ledger, cut: C.ink, sum: C.ledger } as const;
  return (
    <div style={{ position: 'absolute', left: 1380, top: 20, width: 520, height: 837, background: C.deep, border: `1px solid ${C.carbon}`, display: 'flex', flexDirection: 'column' }}>
      <div style={{ background: C.slate, borderBottom: `1px solid ${C.carbon}`, padding: '10px 14px', color: C.ink, fontFamily: mono, fontSize: 15, display: 'flex', gap: 8, alignItems: 'center' }}>
        <span style={{ color: C.money }}>$</span><span>Agent (Claude, cloud) — via WebMCP</span>
      </div>
      <div style={{ flex: 1, padding: '10px 14px', overflow: 'hidden', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', fontFamily: mono, fontSize: 13.5, lineHeight: '19px' }}>
        {last.map((r, i) => (
          <div key={i} style={{ color: color[r.k], fontStyle: r.k === 'cut' ? 'italic' : 'normal', whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: r.k === 'cmd' ? 60 : 38, overflow: 'hidden', opacity: r.k === 'cut' ? 0.7 : 1, fontWeight: r.k === 'cmd' ? 700 : 400 }}>{r.t}</div>
        ))}
        <span style={{ color: C.money, opacity: Math.floor(frame / 15) % 2 ? 0 : 1 }}>█</span>
      </div>
    </div>
  );
};

const Body: React.FC = () => {
  const frame = useCurrentFrame();
  const src = srcAtFrame(frame);
  const cap = CAPTIONS.find(([a, b]) => src >= a && src < b);
  return (
    <AbsoluteFill style={{ background: C.void }}>
      <div style={{ position: 'absolute', left: 20, top: 20, width: 1340, height: 837, border: `1px solid ${C.carbon}`, overflow: 'hidden', background: '#000' }}>
        {SEGS.map(([a], i) => (
          <Sequence key={i} from={segStarts[i]} durationInFrames={segFrames[i]} layout="none">
            <div style={{ position: 'absolute', inset: 0 }}>
              <OffthreadVideo src={staticFile('b5/video.mp4')} startFrom={Math.round(a * FPS)} muted style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            </div>
          </Sequence>
        ))}
        {CALLOUTS.map((c, i) => {
          const o = interpolate(src, [c.from, c.from + 0.3, c.to - 0.3, c.to], [0, 1, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
          if (o <= 0) return null;
          const col = c.color || C.caution;
          return (
            <div key={i} style={{ position: 'absolute', left: c.x, top: c.y - (1 - o) * -10, opacity: o, maxWidth: 560, background: C.deep, border: `2px solid ${col}`, boxShadow: '0 8px 30px rgba(0,0,0,.6)', padding: '14px 18px' }}>
              <div style={{ color: col, fontFamily: grotesk, fontWeight: 700, fontSize: 30, lineHeight: 1.15 }}>{c.text}</div>
              {c.sub ? <div style={{ color: C.ink, fontFamily: mono, fontSize: 14, marginTop: 6 }}>{c.sub}</div> : null}
            </div>
          );
        })}
      </div>
      <Terminal src={src} frame={frame} />
      <div style={{ position: 'absolute', left: 20, right: 20, top: 880, height: 180, display: 'flex', alignItems: 'center', borderTop: `3px solid ${C.money}`, background: C.deep, padding: '0 36px' }}>
        <div style={{ color: C.ledger, fontFamily: grotesk, fontWeight: 600, fontSize: 44, lineHeight: 1.2 }}>{cap ? cap[2] : ''}</div>
      </div>
    </AbsoluteFill>
  );
};

export const B5: React.FC = () => (
  <AbsoluteFill style={{ background: C.deep }}>
    <Sequence durationInFrames={TITLE}><Title /></Sequence>
    <Sequence from={TITLE}><Body /></Sequence>
  </AbsoluteFill>
);
