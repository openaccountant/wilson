import { useState } from 'react';
import { api } from '@/api';
import { buildMeasureReport, formatMargin, type MeasureReport, type MeasuredRow } from '@/prelabel/core';
import type { PrelabelItem } from '@/prelabel/protocol';
import type { MeasureOutcome } from '@/prelabel/usePrelabel';
import type { PrelabelConfig } from '@/types';

interface GoldRow {
  txnId: number;
  description: string;
  amount: number;
  date: string;
  label: string;
}

const pct = (x: number | null) => (x === null ? '-' : `${(x * 100).toFixed(1)}%`);

/**
 * Measurement (spec §10.2, shown with ?prelabelMeasure=1): scores the human-
 * verified rows from /api/prelabel/gold through the worker, then reports
 * accuracy, the margin routing table and latency. Nothing is persisted or sent;
 * "Download JSON" is a local file with no descriptions, merchants or amounts.
 */
export function MeasurePanel({
  ready,
  config,
  measure,
}: {
  ready: boolean;
  config: PrelabelConfig | null;
  measure: (items: PrelabelItem[]) => Promise<MeasureOutcome | null>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [report, setReport] = useState<MeasureReport | null>(null);

  async function run() {
    setBusy(true);
    setError('');
    try {
      const { rows: gold } = await api<{ rows: GoldRow[] }>('/api/prelabel/gold?limit=500');
      if (gold.length === 0) {
        setError('No human-verified transactions to measure against.');
        return;
      }
      const items: PrelabelItem[] = gold.map((g) => ({ txnId: g.txnId, description: g.description, amount: g.amount, date: g.date }));
      const outcome = await measure(items);
      if (!outcome) {
        setError('The model is not ready, or another run is active.');
        return;
      }
      const labelOf = new Map(gold.map((g) => [g.txnId, g.label]));
      const scored: MeasuredRow[] = [];
      for (const r of outcome.rows) {
        if (!r.ok) continue;
        const label = labelOf.get(r.txnId);
        if (label !== undefined) scored.push({ txnId: r.txnId, label, pred: r.choice, p1: r.p1, p2: r.p2, margin: r.margin, ms: r.ms });
      }
      setReport(
        buildMeasureReport(scored, {
          p50Ms: outcome.p50Ms,
          p95Ms: outcome.p95Ms,
          context: config
            ? { modelId: config.pins.modelId, labelSetVersion: config.labelSetVersion, revision: config.pins.revision, templateVersion: config.pins.templateVersion }
            : undefined,
        }),
      );
      if (outcome.cancelled) setError('Cancelled; the numbers below cover the rows scored so far.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function download() {
    if (!report) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'prelabel-measure.json';
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div data-testid="prelabel-measure" className="border border-border rounded-md bg-surface-raised px-3 py-3 text-xs space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-mono uppercase text-[10px] text-text-secondary">Measure open-jev on verified rows</span>
        <button
          onClick={() => void run()}
          disabled={!ready || busy}
          data-testid="prelabel-measure-run"
          className="bg-surface hover:bg-border-muted disabled:opacity-50 text-text-secondary border border-border text-xs font-medium px-2.5 py-1 rounded-md cursor-pointer whitespace-nowrap"
        >
          {busy ? 'Measuring…' : 'Run measurement'}
        </button>
        {!ready && <span className="text-text-muted">Download and load the model first.</span>}
        {report && (
          <button
            onClick={download}
            className="bg-surface hover:bg-border-muted text-text-secondary border border-border text-xs font-medium px-2.5 py-1 rounded-md cursor-pointer whitespace-nowrap"
          >
            Download JSON
          </button>
        )}
      </div>

      {error && <p className="text-yellow">{error}</p>}

      {report && (
        <div className="space-y-2" data-testid="prelabel-measure-report">
          <p className="font-mono text-text" data-testid="prelabel-measure-accuracy">
            {report.table.correct}/{report.n} correct ({pct(report.table.accuracy)}) · p50 {Math.round(report.p50Ms)} ms · p95 {Math.round(report.p95Ms)} ms
          </p>
          {report.smallN && (
            <p className="text-yellow">Small n ({report.n}): fewer than 200 rows, so every percentage here is rough.</p>
          )}
          <table className="font-mono text-[11px]">
            <thead>
              <tr className="text-text-muted text-left">
                <th className="pr-4 font-normal">margin ≥</th>
                <th className="pr-4 font-normal">auto rows</th>
                <th className="pr-4 font-normal">auto accuracy</th>
                <th className="pr-4 font-normal">auto share</th>
                <th className="font-normal">review share</th>
              </tr>
            </thead>
            <tbody>
              {report.table.rows.map((r) => (
                <tr key={r.cut} data-cut={r.cut}>
                  <td className="pr-4">{formatMargin(r.cut)}</td>
                  <td className="pr-4">
                    {r.autoCorrect}/{r.auto}
                  </td>
                  <td className="pr-4">{pct(r.autoAccuracy)}</td>
                  <td className="pr-4">{pct(r.autoShare)}</td>
                  <td>{pct(r.reviewShare)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
