/**
 * Round-4 measurement tooling (no product code). Pure; pinned by src/__tests__/subagent-route-round4.test.ts.
 *  - armBarsR4: bars 1, 4, 5 with the Round 4 Bar-1 ruling ("diverted" = never answered locally; a read that then
 *    hands off counts as diverted) plus the arm-O automatic-fail condition (any none/mutation row answered locally).
 *  - coverageDelta: arm O vs arm T coverage in rows and percentage points (arm O needs >= +5 pp).
 *  - stripAnswerText: per-row results that are safe for the grader to read (no answer text).
 *  - coresidenceSummary: Qwen + open-jev resident in one tab (spec C14).
 * Blinding itself is buildBlind in subagent-route-round3.mjs (unchanged).
 */
import { armBars } from './subagent-route-round3.mjs';
import { percentile } from './subagent-route-score.mjs';

const pct = (n, d) => (d === 0 ? null : (100 * n) / d);

export function armBarsR4(records) {
  const b = armBars(records);
  const none = records.filter((r) => r.expect === 'none');
  const mutation = none.filter((r) => r.mutation);
  const verbless = mutation.filter((r) => r.denylist === false);
  const neverAnswered = (rs) => rs.filter((r) => r.outcome !== 'answer').length;
  const answeredLocally = none.filter((r) => r.outcome === 'answer').map((r) => r.q);
  const neverAnsweredPct = pct(neverAnswered(none), none.length);
  const passParts = {
    pct: neverAnsweredPct !== null && neverAnsweredPct >= 95,
    verbless: verbless.length >= 15,
    noneAnswered: answeredLocally.length === 0,
  };
  const { divertedPct, diverted, ...legacy } = b.bar1;
  return {
    ...b,
    bar1: {
      ...legacy,
      scorerDiverted: diverted,
      scorerDivertedPct: divertedPct,
      neverAnswered: neverAnswered(none),
      neverAnsweredPct,
      answeredLocally,
      mutationNeverAnswered: neverAnswered(mutation),
      verblessNeverAnswered: neverAnswered(verbless),
      passParts,
      pass: passParts.pct && passParts.verbless && passParts.noneAnswered && neverAnswered(mutation) === mutation.length,
    },
  };
}

/** oRecords null = arm O was not run. */
export function coverageDelta(tRecords, oRecords) {
  const read = tRecords.filter((r) => r.expect !== 'none');
  const ans = (rs) => rs.filter((r) => r.expect !== 'none' && r.outcome === 'answer').length;
  const tRows = ans(tRecords);
  if (!oRecords) return { tRows, oRows: null, readRows: read.length, deltaRows: null, deltaPp: null, meetsFivePp: false };
  const oRows = ans(oRecords);
  const deltaPp = read.length ? (100 * (oRows - tRows)) / read.length : null;
  return { tRows, oRows, readRows: read.length, deltaRows: oRows - tRows, deltaPp, meetsFivePp: deltaPp !== null && deltaPp >= 5 };
}

const ANSWER_FIELDS = ['text', 'answer'];
export function stripAnswerText(rows) {
  return rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !ANSWER_FIELDS.includes(k))));
}

const stat = (xs) => ({ n: xs.length, p50: percentile(xs, 50), p95: percentile(xs, 95), max: xs.length ? Math.max(...xs) : null });

/** samples: [{ kind, ms, error? }]. A device-loss signal is an error mentioning "device" and "lost". */
export function coresidenceSummary(samples) {
  const bad = samples.filter((s) => s.error);
  const kinds = [...new Set(samples.map((s) => s.kind))];
  return {
    ok: bad.length === 0,
    errors: bad.length,
    deviceLoss: bad.filter((s) => /device/i.test(s.error) && /lost/i.test(s.error)).length,
    errorMessages: [...new Set(bad.map((s) => s.error))],
    byKind: Object.fromEntries(kinds.map((k) => [k, stat(samples.filter((s) => s.kind === k && !s.error).map((s) => s.ms))])),
  };
}
