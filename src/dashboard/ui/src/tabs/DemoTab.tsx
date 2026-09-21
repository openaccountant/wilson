import { useCallback, useEffect, useState } from 'react';
import { useApi } from '@/hooks/useApi';
import { api } from '@/api';
import { useHybridChat } from '@/hooks/useHybridChat';
import {
  parseCategorizationDecision,
  buildVerdictLine,
  CONTRAST_CAPTION,
  LOCAL_BROWSER_LABEL,
  LOCAL_SERVER_LABEL,
  type CloudMode,
  type ParsedDecision,
} from '@/demo/core';
import { AgentTraceSection } from '@/demo/AgentTraceSection';
import { PrivacyValidatorSection } from '@/demo/PrivacyValidatorSection';

/**
 * Speed Showdown (issue #92) — pick a synthetic sample transaction and watch
 * side-by-side real timers race Wilson's local categorization decision
 * against a cloud round-trip for the SAME decision task.
 *
 * Honesty rules baked in:
 * - the picker lists ONLY in-repo ground-truth fixtures (SAMPLE chip on every
 *   row); imported rows are structurally absent from this tab;
 * - the final timer always snaps to a recorded per-call duration — the live
 *   value from the trace store (via callLlm / the browser-trace endpoint),
 *   never a fabricated or tick value;
 * - every arm label states what actually ran;
 * - simulated cloud runs carry their own marker (canned chip + simulated
 *   verdict wording) so nothing reads as a network measurement.
 *
 * The statement-agent-trace slice (issue #93) renders above this one in the
 * same tab: drop a bank statement and watch Wilson's offline chain — import →
 * embedding lookup → category prediction → reconciliation hint — run as a
 * live four-node flow diagram with real per-step timing.
 *
 * Below both sits the Privacy Validator (issue #95): a live provider ledger
 * proving every model/agent request during the run stayed on localhost (or is
 * clearly marked simulated), next to the would-be cloud payload for the
 * picked sample — built from the synthetic fixtures only.
 */

interface SampleRow {
  id: number;
  slug: string;
  date: string;
  description: string;
  amount: number;
  expectedCategory: string;
  note?: string;
  userPrompt: string;
}

interface ShowdownSamplesResponse {
  samples: SampleRow[];
  systemPrompt: string;
  config: { cloudModel: string; localModel: string; localRepo: string };
}

/** Mirror of src/demo/showdown.ts ShowdownArmResult. */
interface ShowdownArmResponse {
  ok: boolean;
  label: string;
  model: string;
  mode?: CloudMode;
  decisionMs: number | null;
  traceId: string | null;
  raw?: string;
  decision?: { id: number; category: string; confidence: number } | null;
  decisionSource?: 'canned';
  payload: { system: string; user: string };
  probeRan?: boolean;
  loadMs?: number;
  loadFresh?: boolean;
  error?: string;
}

interface ArmState {
  phase: 'idle' | 'running' | 'done';
  startedAt: number | null;
  label: string | null;
  model: string | null;
  mode?: CloudMode;
  decisionMs: number | null;
  loadMs: number | null;
  loadFresh: boolean | null;
  raw: string | null;
  decision: ParsedDecision | null;
  decisionSource: 'canned' | 'parsed' | null;
  error: string | null;
  progress: string | null;
}

const IDLE_ARM: ArmState = {
  phase: 'idle',
  startedAt: null,
  label: null,
  model: null,
  decisionMs: null,
  loadMs: null,
  loadFresh: null,
  raw: null,
  decision: null,
  decisionSource: null,
  error: null,
  progress: null,
};

function runningArm(startedAt: number): ArmState {
  return { ...IDLE_ARM, phase: 'running', startedAt };
}

function failedArm(startedAt: number, error: string): ArmState {
  return { ...IDLE_ARM, phase: 'done', startedAt, error };
}

function armFromResponse(res: ShowdownArmResponse, startedAt: number): ArmState {
  let decision = res.decision ?? null;
  let decisionSource: ArmState['decisionSource'] = res.decisionSource === 'canned' ? 'canned' : null;
  if (res.ok && res.raw && !decision) {
    const parsed = parseCategorizationDecision(res.raw);
    if (parsed.ok) {
      decision = parsed.decision;
      decisionSource = 'parsed';
    }
  }
  return {
    phase: 'done',
    startedAt,
    label: res.label,
    model: res.model,
    mode: res.mode,
    decisionMs: res.decisionMs,
    loadMs: res.loadMs ?? null,
    loadFresh: res.loadFresh ?? null,
    raw: res.raw ?? null,
    decision,
    decisionSource,
    error: res.ok ? null : (res.error ?? 'arm failed'),
    progress: null,
  };
}

function fmtMs(ms: number | null): string {
  if (ms === null) return '—';
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  return `${Math.round(ms)} ms`;
}

function money(n: number): string {
  return (n < 0 ? '-$' : '$') + Math.abs(n).toFixed(2);
}

function LoadLine({ loadMs, loadFresh }: { loadMs: number | null; loadFresh: boolean | null }) {
  if (loadMs === null) return null;
  return (
    <div className="text-xs text-text-muted mt-1">
      {loadFresh
        ? `model load: ${fmtMs(loadMs)} (fresh — shown separately from the decision)`
        : `model already loaded (${fmtMs(loadMs)})`}
    </div>
  );
}

function GroundTruthChip({ decision, expected }: { decision: ParsedDecision | null; expected: string }) {
  if (!decision) return null;
  const correct = decision.category === expected;
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${
        correct ? 'bg-green-dim text-green' : 'bg-red/10 text-red'
      }`}
      title={`Expected: ${expected}`}
    >
      {correct ? '✓' : '✗'} ground truth: {expected}
    </span>
  );
}

function ArmCard({
  title,
  arm,
  elapsed,
  expected,
}: {
  title: string;
  arm: ArmState;
  elapsed: number;
  expected: string;
}) {
  const live = arm.phase === 'running' ? elapsed : arm.decisionMs;
  return (
    <div className="bg-surface-raised border border-border rounded-lg p-5 flex-1 min-w-0">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs uppercase tracking-wide text-text-secondary font-medium">{title}</div>
        {arm.label && (
          <span
            className={`px-2 py-0.5 rounded text-xs font-medium border ${
              arm.label === LOCAL_BROWSER_LABEL || arm.label === LOCAL_SERVER_LABEL
                ? 'border-green text-green'
                : 'border-blue text-blue'
            }`}
          >
            {arm.label}
          </span>
        )}
      </div>
      {arm.model !== null && <div className="text-xs text-text-muted mt-1 font-mono">{arm.model}</div>}

      <div className="text-4xl font-bold font-mono text-text mt-3 tabular-nums">{fmtMs(live)}</div>
      {arm.phase === 'running' && arm.progress && (
        <div className="text-xs text-text-muted mt-1">{arm.progress}</div>
      )}
      <LoadLine loadMs={arm.loadMs} loadFresh={arm.loadFresh} />

      {arm.phase === 'done' && arm.decision && (
        <div className="mt-3 space-y-1">
          <div className="text-sm">
            <span className="text-text-secondary">decision: </span>
            <span className="text-text font-medium">{arm.decision.category}</span>
            <span className="text-text-muted"> ({(arm.decision.confidence * 100).toFixed(0)}% confidence)</span>
          </div>
          {arm.decisionSource === 'canned' && (
            <span className="inline-block px-2 py-0.5 rounded text-xs bg-yellow/10 text-yellow border border-yellow/40">
              canned response — simulated arm
            </span>
          )}
          <div>
            <GroundTruthChip decision={arm.decision} expected={expected} />
          </div>
        </div>
      )}

      {arm.phase === 'done' && !arm.decision && arm.raw && !arm.error && (
        <div className="mt-3">
          <div className="text-xs text-yellow">local decision unparseable — raw output:</div>
          <pre className="bg-surface border border-border rounded p-2 mt-1 text-xs text-text-secondary font-mono whitespace-pre-wrap overflow-x-auto max-h-32 overflow-y-auto">
            {arm.raw}
          </pre>
        </div>
      )}

      {arm.phase === 'done' && arm.error && (
        <div className="mt-3 text-xs text-red break-words">
          <span className="font-medium">arm failed:</span> {arm.error}
        </div>
      )}

      {arm.phase === 'idle' && <div className="text-xs text-text-muted mt-3">waiting to run…</div>}
    </div>
  );
}

export function DemoTab() {
  const { data: samplesData, loading: samplesLoading } = useApi<ShowdownSamplesResponse>(
    '/api/demo/showdown/samples',
  );
  const hybrid = useHybridChat();

  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [localArm, setLocalArm] = useState<ArmState>(IDLE_ARM);
  const [cloudArm, setCloudArm] = useState<ArmState>(IDLE_ARM);
  const [payload, setPayload] = useState<{ system: string; user: string } | null>(null);
  const [showPayload, setShowPayload] = useState(false);
  const [nowTick, setNowTick] = useState(0);

  const samples = samplesData?.samples ?? [];
  const selected = samples.find((s) => s.slug === selectedSlug) ?? null;

  // Ticking wall-clock while a race is in flight. The big timers tick real
  // elapsed time, then snap to the recorded per-call duration on settle.
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => setNowTick((t) => t + 1), 100);
    return () => window.clearInterval(id);
  }, [running]);

  const elapsedOf = useCallback(
    (arm: ArmState): number => {
      if (arm.phase !== 'running' || arm.startedAt === null) return 0;
      return performance.now() - arm.startedAt;
    },
    // nowTick drives re-renders while running; the lint-exempt deps keep the
    // interval-driven recompute honest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [nowTick],
  );

  async function run(slug: string) {
    if (running || !samplesData) return;
    const sample = samplesData.samples.find((s) => s.slug === slug);
    if (!sample) return;

    setSelectedSlug(slug);
    setRunning(true);
    setShowPayload(false);
    const startedAt = performance.now();
    setLocalArm(runningArm(startedAt));
    setCloudArm(runningArm(startedAt));

    const onLocalProgress = (label: string) => {
      setLocalArm((prev) => (prev.phase === 'running' ? { ...prev, progress: label } : prev));
    };

    // ── Cloud arm ────────────────────────────────────────────────────────
    const cloudPromise = (async () => {
      try {
        const res = await api<ShowdownArmResponse>('/api/demo/showdown/cloud', {
          method: 'POST',
          body: JSON.stringify({ slug }),
        });
        const arm = armFromResponse(res, startedAt);
        setCloudArm(arm);
        if (res.payload) setPayload(res.payload);
      } catch (err) {
        setCloudArm(failedArm(startedAt, err instanceof Error ? err.message : String(err)));
      }
    })();

    // ── Local arm: browser WebGPU first, server-side transformers fallback ──
    const localPromise = (async () => {
      try {
        const r = await hybrid.categorizeSample({
          systemPrompt: samplesData.systemPrompt,
          userPrompt: sample.userPrompt,
          onProgress: onLocalProgress,
        });
        if (r.ok) {
          // Record the measured time so the rendered timer is a trace row.
          let recorded: number | null = null;
          try {
            const rec = await api<{ traceId: string; durationMs: number }>(
              '/api/demo/showdown/browser-trace',
              {
                method: 'POST',
                body: JSON.stringify({ model: r.model, decisionMs: r.decisionMs, ok: true, slug }),
              },
            );
            recorded = rec.durationMs;
          } catch {
            // best-effort: the measured value still renders if recording fails
          }
          const arm: ArmState = {
            phase: 'done',
            startedAt,
            label: LOCAL_BROWSER_LABEL,
            model: r.model,
            decisionMs: recorded ?? r.decisionMs,
            loadMs: r.loadMs,
            loadFresh: r.loadFresh,
            raw: r.raw,
            decision: r.decision,
            decisionSource: r.decision ? 'parsed' : null,
            error: null,
            progress: null,
          };
          setLocalArm(arm);
          return;
        }
        onLocalProgress('browser GPU unavailable — using this machine…');
        try {
          const res = await api<ShowdownArmResponse>('/api/demo/showdown/local', {
            method: 'POST',
            body: JSON.stringify({ slug }),
          });
          const arm = armFromResponse(res, startedAt);
          if (!arm.label || arm.label === LOCAL_BROWSER_LABEL) arm.label = LOCAL_SERVER_LABEL;
          setLocalArm(arm);
          if (res.payload) setPayload(res.payload);
        } catch (err) {
          setLocalArm(failedArm(startedAt, err instanceof Error ? err.message : String(err)));
        }
      } catch (err) {
        setLocalArm(failedArm(startedAt, err instanceof Error ? err.message : String(err)));
      }
    })();

    await Promise.allSettled([cloudPromise, localPromise]);
    setRunning(false);
  }

  const bothDone = localArm.phase === 'done' && cloudArm.phase === 'done';
  const verdict =
    bothDone && selected
      ? buildVerdictLine(
          { decisionMs: localArm.decisionMs },
          { mode: cloudArm.mode ?? 'simulated', decisionMs: cloudArm.decisionMs },
        )
      : null;

  return (
    <div className="flex-1 overflow-y-auto min-h-0">
      <div className="max-w-5xl mx-auto p-6 space-y-6">
        {/* ── Statement-to-dashboard agent trace (#93) ────────────────── */}
        <div>
          <h2 className="text-lg font-semibold text-text">Your agent. Your data. Your machine.</h2>
          <p className="text-sm text-text-secondary mt-1">
            Drop a bank statement and watch Wilson's offline agent chain run, step by step — every
            node timed on this machine, nothing sent to a cloud.
          </p>
        </div>
        <AgentTraceSection />

        {/* ── Headline ─────────────────────────────────────────────── */}
        <div>
          <h1 className="text-2xl font-bold text-text">Your agent. Your data. Your speed.</h1>
          <p className="text-sm text-text-secondary mt-1">
            Speed Showdown — pick a sample transaction and race Wilson's local decision against a
            cloud round-trip for the same categorization task. Every timer is a real, recorded
            duration; nothing here is fabricated.
          </p>
        </div>

        {/* ── Picker (synthetic fixtures only) ─────────────────────── */}
        <div className="bg-surface-raised border border-border rounded-lg p-5">
          <div className="flex items-center gap-2 flex-wrap">
            <div className="text-xs uppercase tracking-wide text-text-secondary font-medium">
              Pick a transaction
            </div>
            <span className="px-2 py-0.5 rounded text-xs bg-green-dim text-green border border-green/40">
              synthetic fixtures only — safe to send
            </span>
          </div>
          {samplesLoading && <div className="text-sm text-text-muted mt-3">loading samples…</div>}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2 mt-3">
            {samples.map((s) => (
              <button
                key={s.slug}
                onClick={() => setSelectedSlug(s.slug)}
                disabled={running}
                className={`text-left border rounded p-3 transition-colors cursor-pointer disabled:opacity-60 ${
                  selectedSlug === s.slug
                    ? 'border-green bg-surface'
                    : 'border-border bg-surface hover:border-text-muted'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-sm text-text">{s.description}</span>
                  <span className={`font-mono text-sm ${s.amount < 0 ? 'text-text' : 'text-green'}`}>
                    {money(s.amount)}
                  </span>
                </div>
                <div className="flex items-center gap-2 mt-1 flex-wrap">
                  <span className="text-xs text-text-muted">{s.date}</span>
                  <span className="px-1.5 py-0.5 rounded text-[10px] bg-surface-raised text-green border border-green/40 uppercase tracking-wide">
                    sample
                  </span>
                  {s.note && <span className="text-xs text-text-muted italic">{s.note}</span>}
                </div>
              </button>
            ))}
          </div>
          <div className="mt-4">
            <button
              onClick={() => selectedSlug && run(selectedSlug)}
              disabled={running || !selectedSlug}
              className="px-4 py-2 rounded bg-green text-bg font-medium text-sm cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed hover:opacity-90 transition-opacity"
            >
              {running ? 'Racing…' : 'Run the race'}
            </button>
            {selected && !running && (
              <span className="text-xs text-text-muted ml-3">
                local arm tries your browser's GPU first, then this machine · cloud arm{' '}
                {samplesData?.config.cloudModel ?? ''}
              </span>
            )}
          </div>
        </div>

        {/* ── Arms ─────────────────────────────────────────────────── */}
        <div className="flex flex-col md:flex-row gap-4">
          <ArmCard
            title="Local arm — Wilson"
            arm={localArm}
            elapsed={elapsedOf(localArm)}
            expected={selected?.expectedCategory ?? ''}
          />
          <ArmCard
            title="Cloud arm"
            arm={cloudArm}
            elapsed={elapsedOf(cloudArm)}
            expected={selected?.expectedCategory ?? ''}
          />
        </div>

        {/* ── Verdict + contrast caption ───────────────────────────── */}
        <div className="bg-surface-raised border border-border rounded-lg p-5 space-y-2">
          <div className="text-xs uppercase tracking-wide text-text-secondary font-medium">Verdict</div>
          {verdict ? (
            <div className="text-xl font-bold font-mono text-text">{verdict}</div>
          ) : (
            <div className="text-sm text-text-muted">Run the race to get a verdict.</div>
          )}
          <p className="text-xs text-text-muted leading-relaxed pt-1 border-t border-border-muted mt-2">
            {CONTRAST_CAPTION}
          </p>
        </div>

        {/* ── Payload exhibit ──────────────────────────────────────── */}
        <div className="bg-surface-raised border border-border rounded-lg p-5">
          <button
            onClick={() => setShowPayload((v) => !v)}
            className="flex items-center gap-2 cursor-pointer bg-transparent border-none p-0 text-left"
          >
            <span className="text-xs uppercase tracking-wide text-text-secondary font-medium">
              {showPayload ? '▾' : '▸'} What leaves your machine
            </span>
            <span className="px-2 py-0.5 rounded text-xs bg-green-dim text-green border border-green/40">
              synthetic sample rows only
            </span>
          </button>
          {showPayload && (
            <div className="mt-3 space-y-3">
              <div>
                <div className="text-xs text-text-muted mb-1">system prompt</div>
                <pre className="bg-surface border border-border rounded p-3 text-xs text-text-secondary font-mono whitespace-pre-wrap overflow-x-auto">
                  {payload?.system ?? '(run the race to capture the exact payload)'}
                </pre>
              </div>
              <div>
                <div className="text-xs text-text-muted mb-1">user prompt (category list + rules + confidence rubric + rows)</div>
                <pre className="bg-surface border border-border rounded p-3 text-xs text-text-secondary font-mono whitespace-pre-wrap overflow-x-auto max-h-96 overflow-y-auto">
                  {payload?.user ?? '(run the race to capture the exact payload)'}
                </pre>
              </div>
            </div>
          )}
        </div>

        {/* ── Privacy Validator (#95): live ledger + would-be cloud payload ── */}
        <PrivacyValidatorSection selectedSlug={selectedSlug} />
      </div>
    </div>
  );
}