import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/api';
import { useApi } from '@/hooks/useApi';
import { CONTRAST_CAPTION } from '@/demo/core';

/**
 * Privacy Validator (issue #95) — the Demo tab's proof panel.
 *
 * Left: a live provider ledger built from the trace store — every model/agent
 * request observed since the run armed, each labeled by where it actually
 * went (localhost / clearly-marked simulated / CLOUD / unrecognized). The
 * server owns classification and the verdict copy; this component renders
 * strings and never re-classifies. A run auto-arms on mount and polls the
 * ledger every second; a 400 (unknown run — e.g. the server restarted) triggers
 * one automatic re-arm instead of a broken panel. The verdict must be able to
 * fail: a real cloud call during the run renders red and the verdict says the
 * all-local claim does not hold.
 *
 * Right: the exhibit of the exact request a cloud-based agent would have sent
 * for the same decision step — re-fetched when the Speed Showdown picker's
 * selection changes, labeled as built from synthetic sample fixtures only.
 */

// ── Wire shapes (mirror src/demo/privacy.ts) ────────────────────────────────

type LedgerBucket = 'local' | 'simulated' | 'cloud' | 'unknown';

interface LedgerEntry {
  traceId: string;
  timestamp: string;
  provider: string;
  model: string;
  bucket: LedgerBucket;
  durationMs: number;
  status: 'ok' | 'error';
  error?: string;
}

interface PrivacyLedger {
  runId: string;
  startedAt: string;
  entries: LedgerEntry[];
  counts: { local: number; simulated: number; cloud: number; unknown: number; total: number };
  allLocal: boolean;
  verdict: string;
}

interface PrivacyExhibit {
  cloudModel: string;
  payload: { system: string; user: string };
  rowCount: number;
  rows: Array<{ id: number; slug: string; description: string; amount: number; date: string }>;
  note: string;
}

/** Chip copy per bucket — must mirror the server's BUCKET_LABELS. */
const BUCKET_LABELS: Record<LedgerBucket, string> = {
  local: 'localhost',
  simulated: 'simulated — no network',
  cloud: 'CLOUD',
  unknown: 'unrecognized',
};

const POLL_MS = 1000;

function bucketChipClass(bucket: LedgerBucket): string {
  switch (bucket) {
    case 'local':
      return 'bg-green-dim text-green border border-green/40';
    case 'simulated':
      return 'bg-yellow/10 text-yellow border border-yellow/40';
    case 'cloud':
      return 'bg-red/10 text-red border border-red/40';
    case 'unknown':
      return 'bg-yellow/10 text-yellow border border-yellow';
  }
}

function fmtMs(ms: number | null): string {
  if (ms === null) return '—';
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  return `${Math.round(ms)} ms`;
}

/** The normalized ISO timestamps parse directly; render HH:MM:SS. */
function hhmmss(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString([], { hour12: false });
}

function LedgerRow({ entry }: { entry: LedgerEntry }) {
  return (
    <div>
      <div
        className={`flex items-center gap-2 text-xs rounded px-2 py-1.5 ${
          entry.status === 'error' ? 'bg-red/5 border border-red/40' : 'bg-surface border border-border-muted'
        }`}
      >
        <span className="font-mono text-text-muted tabular-nums shrink-0">{hhmmss(entry.timestamp)}</span>
        <span className={`px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wide shrink-0 ${bucketChipClass(entry.bucket)}`}>
          {BUCKET_LABELS[entry.bucket]}
        </span>
        {/* the real marker string, verbatim — what the attendee can verify */}
        <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-surface-raised text-text-secondary border border-border shrink-0">
          {entry.provider}
        </span>
        <span className="font-mono text-text-secondary truncate min-w-0 flex-1" title={entry.model}>
          {entry.model}
        </span>
        <span className="font-mono text-text tabular-nums shrink-0">{fmtMs(entry.durationMs)}</span>
      </div>
      {entry.status === 'error' && entry.error && (
        <div className="text-[10px] text-red pl-2 pt-0.5 break-words">{entry.error}</div>
      )}
    </div>
  );
}

export function PrivacyValidatorSection({ selectedSlug }: { selectedSlug: string | null }) {
  const [ledger, setLedger] = useState<PrivacyLedger | null>(null);
  const [monitoring, setMonitoring] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [session, setSession] = useState(0);
  const [showPayload, setShowPayload] = useState(false);

  const runIdRef = useRef<string | null>(null);
  const monitoringRef = useRef(false);
  const rearmedRef = useRef(false);

  // The exhibit follows the Speed Showdown picker's selection ("the same
  // step"); no slug means the full 8-row fixture set.
  const exhibitPath =
    '/api/demo/privacy/exhibit' + (selectedSlug ? `?slug=${encodeURIComponent(selectedSlug)}` : '');
  const { data: exhibit } = useApi<PrivacyExhibit>(exhibitPath, [selectedSlug]);

  const arm = useCallback(async (): Promise<boolean> => {
    try {
      const run = await api<{ id: string; startedAt: string }>('/api/demo/privacy/start', {
        method: 'POST',
      });
      runIdRef.current = run.id;
      rearmedRef.current = false;
      monitoringRef.current = true;
      setMonitoring(true);
      setLedger(null);
      setReconnecting(false);
      return true;
    } catch {
      return false;
    }
  }, []);

  const poll = useCallback(async (): Promise<void> => {
    const runId = runIdRef.current;
    if (!runId) return;
    try {
      const data = await api<PrivacyLedger>(`/api/demo/privacy/ledger?run=${encodeURIComponent(runId)}`);
      // Healthy again — a LATER server restart may re-arm once more.
      rearmedRef.current = false;
      setLedger(data);
      setReconnecting(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith('API 400')) {
        // Unknown privacy run (server restarted, run state wiped). One
        // automatic re-arm, then polling resumes on the next tick.
        if (!rearmedRef.current) {
          rearmedRef.current = true;
          await arm();
        }
      } else {
        // Network-level failure — say so, retry on the next tick.
        setReconnecting(true);
      }
    }
  }, [arm]);

  // Poll loop: one chained timeout per tick (never overlapping requests).
  // Re-runs when `session` bumps — that is "Start fresh".
  useEffect(() => {
    let alive = true;
    let timer: number | undefined;

    const tick = async (): Promise<void> => {
      if (!alive || !monitoringRef.current) return;
      if (!runIdRef.current) {
        const ok = await arm();
        if (!alive) return;
        if (!ok) {
          setReconnecting(true);
          timer = window.setTimeout(tick, POLL_MS);
          return;
        }
      }
      await poll();
      if (alive && monitoringRef.current) timer = window.setTimeout(tick, POLL_MS);
    };

    monitoringRef.current = true;
    setMonitoring(true);
    void tick();

    return () => {
      alive = false;
      monitoringRef.current = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [session, arm, poll]);

  function stop() {
    monitoringRef.current = false;
    setMonitoring(false);
  }

  function startFresh() {
    runIdRef.current = null;
    setLedger(null);
    setSession((s) => s + 1);
  }

  const counts = ledger?.counts ?? null;
  const verdictClass = !ledger
    ? 'text-text-muted'
    : counts!.total === 0
      ? 'text-text-muted'
      : counts!.cloud > 0
        ? 'text-red'
        : counts!.unknown > 0
          ? 'text-yellow'
          : 'text-green';

  return (
    <div className="space-y-3">
      {/* ── Headline ────────────────────────────────────────────────── */}
      <div>
        <h2 className="text-lg font-semibold text-text">
          Privacy Validator — local means private. Watch it be true.
        </h2>
        <p className="text-sm text-text-secondary mt-1">
          A live ledger of every model/agent request observed during this run, labeled by where it
          actually went — beside the exact request a cloud-based agent would have sent for the same
          step.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* ── Live provider ledger ──────────────────────────────────── */}
        <div className="bg-surface-raised border border-border rounded-lg p-5 space-y-3 min-w-0">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="text-xs uppercase tracking-wide text-text-secondary font-medium">
              Live provider ledger
            </div>
            <div className="flex items-center gap-2">
              {reconnecting && <span className="text-xs text-yellow">reconnecting…</span>}
              {monitoring && !reconnecting && (
                <span className="flex items-center gap-1.5 text-xs text-green">
                  <span className="inline-block w-2 h-2 rounded-full bg-green animate-pulse" />
                  watching since {ledger ? hhmmss(ledger.startedAt) : '…'}
                </span>
              )}
              {!monitoring && <span className="text-xs text-text-muted">stopped</span>}
              <button
                onClick={startFresh}
                className="px-2 py-0.5 rounded border border-border text-xs text-text-secondary hover:text-text hover:border-text-muted cursor-pointer bg-surface"
              >
                Start fresh
              </button>
              {monitoring && (
                <button
                  onClick={stop}
                  className="px-2 py-0.5 rounded border border-border text-xs text-text-secondary hover:text-text hover:border-text-muted cursor-pointer bg-surface"
                >
                  Stop
                </button>
              )}
            </div>
          </div>

          {counts && (
            <div className="flex items-center gap-2 flex-wrap">
              <span className="px-2 py-0.5 rounded text-xs bg-green-dim text-green border border-green/40">
                {counts.local} localhost
              </span>
              <span className="px-2 py-0.5 rounded text-xs bg-yellow/10 text-yellow border border-yellow/40">
                {counts.simulated} {BUCKET_LABELS.simulated}
              </span>
              <span
                className={`px-2 py-0.5 rounded text-xs ${
                  counts.cloud === 0
                    ? 'bg-green-dim text-green border border-green/40'
                    : 'bg-red/10 text-red border border-red/40'
                }`}
              >
                {counts.cloud} {BUCKET_LABELS.cloud}
              </span>
              {counts.unknown > 0 && (
                <span className="px-2 py-0.5 rounded text-xs bg-yellow/10 text-yellow border border-yellow">
                  {counts.unknown} {BUCKET_LABELS.unknown}
                </span>
              )}
            </div>
          )}

          {ledger && (
            <div className={`text-sm font-mono leading-relaxed ${verdictClass}`}>{ledger.verdict}</div>
          )}

          {ledger && ledger.entries.length > 0 && (
            <div className="space-y-1 max-h-72 overflow-y-auto">
              {ledger.entries.map((e) => (
                <LedgerRow key={e.traceId} entry={e} />
              ))}
            </div>
          )}

          {monitoring && ledger !== null && ledger.entries.length === 0 && (
            <div className="text-xs text-text-muted">
              The statement-trace chain runs pure local compute (no LLM calls), so it writes no rows
              here — run the Speed Showdown or send a chat message to see the ledger move.
            </div>
          )}

          {!monitoring && !ledger && (
            <div className="text-xs text-text-muted">Press Start fresh to begin watching.</div>
          )}
        </div>

        {/* ── Would-be cloud payload exhibit ────────────────────────── */}
        <div className="bg-surface-raised border border-border rounded-lg p-5 space-y-3 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <div className="text-xs uppercase tracking-wide text-text-secondary font-medium">
              What a cloud agent would have sent for this step
            </div>
            <span className="px-2 py-0.5 rounded text-xs bg-green-dim text-green border border-green/40">
              synthetic sample rows only
            </span>
            {selectedSlug && (
              <span className="px-2 py-0.5 rounded text-xs bg-blue/10 text-blue border border-blue/40">
                matching your picked sample
              </span>
            )}
          </div>

          <div className="text-xs text-text-secondary">
            a cloud-based agent would call{' '}
            <span className="font-mono text-text">{exhibit?.cloudModel ?? '…'}</span> with this exact
            request
          </div>

          <button
            onClick={() => setShowPayload((v) => !v)}
            className="flex items-center gap-2 cursor-pointer bg-transparent border-none p-0 text-left"
          >
            <span className="text-xs uppercase tracking-wide text-text-secondary font-medium">
              {showPayload ? '▾' : '▸'} the would-be cloud request
            </span>
            <span className="px-2 py-0.5 rounded text-xs bg-green-dim text-green border border-green/40">
              {exhibit ? `${exhibit.rowCount} sample row${exhibit.rowCount === 1 ? '' : 's'}` : '…'}
            </span>
          </button>

          {showPayload && (
            <div className="space-y-3">
              <div>
                <div className="text-xs text-text-muted mb-1">system prompt</div>
                <pre className="bg-surface border border-border rounded p-3 text-xs text-text-secondary font-mono whitespace-pre-wrap overflow-x-auto">
                  {exhibit?.payload.system ?? '(loading the fixture-built payload)'}
                </pre>
              </div>
              <div>
                <div className="text-xs text-text-muted mb-1">
                  user prompt (category list + rules + confidence rubric + rows)
                </div>
                <pre className="bg-surface border border-border rounded p-3 text-xs text-text-secondary font-mono whitespace-pre-wrap overflow-x-auto max-h-96 overflow-y-auto">
                  {exhibit?.payload.user ?? '(loading the fixture-built payload)'}
                </pre>
              </div>
            </div>
          )}

          <div className="text-xs text-text-muted leading-relaxed pt-2 border-t border-border-muted space-y-2">
            <p>{exhibit?.note ?? ''}</p>
            <p>{CONTRAST_CAPTION}</p>
          </div>
        </div>
      </div>
    </div>
  );
}