import React from 'react';
import {
  Composition, AbsoluteFill, Sequence, OffthreadVideo, staticFile,
  useCurrentFrame, useVideoConfig, interpolate, spring,
} from 'remotion';
import { getVideoMetadata } from '@remotion/media-utils';

const FPS = 30;
const TITLE_FRAMES = 78;   // 2.6s
const END_FRAMES = 84;     // 2.8s
const C = {
  void: '#0a0f1a', green: '#22c55e', ledger: '#e5e7eb', ink: '#9ca3af',
  mono: "'JetBrains Mono', Menlo, monospace",
  sans: "-apple-system, 'Helvetica Neue', Arial, sans-serif",
};

type ClipProps = { src: string; title: string; subtitle: string; speed: number; isEnd?: boolean };

const Card: React.FC<{ title: string; subtitle: string; durationInFrames: number }> = ({ title, subtitle, durationInFrames }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({ frame, fps, config: { damping: 200 }, durationInFrames: 20 });
  const out = interpolate(frame, [durationInFrames - 12, durationInFrames], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const y = interpolate(enter, [0, 1], [24, 0]);
  return (
    <AbsoluteFill style={{ backgroundColor: C.void, justifyContent: 'center', alignItems: 'center', fontFamily: C.sans, opacity: out }}>
      <div style={{ transform: `translateY(${y}px)`, opacity: enter, textAlign: 'center' }}>
        <div style={{ color: C.green, fontFamily: C.mono, fontSize: 30, fontWeight: 700, letterSpacing: 1, marginBottom: 30 }}>$ OPEN ACCOUNTANT</div>
        <div style={{ color: C.green, fontSize: 62, fontWeight: 700, padding: '0 80px', lineHeight: 1.1 }}>{title}</div>
        {subtitle ? <div style={{ color: C.ink, fontFamily: C.mono, fontSize: 25, marginTop: 24 }}>{subtitle}</div> : null}
        <div style={{ width: 120, height: 3, background: C.green, margin: '32px auto 0', borderRadius: 2, opacity: 0.85 }} />
      </div>
    </AbsoluteFill>
  );
};

const Clip: React.FC<ClipProps> = ({ src, title, subtitle, speed }) => {
  const { durationInFrames } = useVideoConfig();
  const bodyFrames = durationInFrames - TITLE_FRAMES - END_FRAMES;
  return (
    <AbsoluteFill style={{ backgroundColor: C.void }}>
      <Sequence durationInFrames={TITLE_FRAMES}>
        <Card title={title} subtitle={subtitle} durationInFrames={TITLE_FRAMES} />
      </Sequence>
      <Sequence from={TITLE_FRAMES} durationInFrames={bodyFrames}>
        <AbsoluteFill style={{ backgroundColor: C.void }}>
          <OffthreadVideo src={staticFile(src)} playbackRate={speed} />
        </AbsoluteFill>
      </Sequence>
      <Sequence from={TITLE_FRAMES + bodyFrames} durationInFrames={END_FRAMES}>
        <Card title="Follow the money." subtitle="Open Accountant — runs locally" durationInFrames={END_FRAMES} />
      </Sequence>
    </AbsoluteFill>
  );
};

const calc = async ({ props }: { props: ClipProps }) => {
  const meta = await getVideoMetadata(staticFile(props.src));
  const bodyFrames = Math.ceil((meta.durationInSeconds / (props.speed || 1)) * FPS);
  return { durationInFrames: TITLE_FRAMES + bodyFrames + END_FRAMES, fps: FPS, width: 1400, height: 860 };
};

export const RemotionRoot: React.FC = () => (
  <Composition
    id="Clip"
    component={Clip as React.FC}
    durationInFrames={300}
    fps={FPS}
    width={1400}
    height={860}
    defaultProps={{ src: 'input.mp4', title: 'CASE FILE: AUGUST 2026', subtitle: 'Follow the money.', speed: 3 } as ClipProps}
    calculateMetadata={calc as any}
  />
);
