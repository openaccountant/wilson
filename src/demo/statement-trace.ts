import type { Database } from '../db/compat-sqlite.js';
import { apiImport, type ImportRequestBody, type ImportTransactionInput, type ImportResult } from '../dashboard/api.js';
import { computeExternalId } from '../tools/import/external-id.js';
import {
  embedTexts,
  transactionEmbedText,
  DEFAULT_EMBEDDING_MODEL,
} from '../utils/embeddings.js';
import { KNOWN_MERCHANTS, type KnownMerchant } from './known-merchants.js';
import {
  detectDuplicates,
  detectSpikes,
  type DuplicateAnomaly,
  type SpikeAnomaly,
} from '../tools/query/anomaly-detect.js';

/**
 * The statement-to-dashboard agent trace (Demo tab): Wilson's offline chain —
 * import → embedding lookup → category prediction → reconciliation hint — as
 * four individually-timed steps. Every step reuses a real product path:
 *
 *  - import      → apiImport (the exact /api/import substrate: file-hash dedup,
 *                  external_id row dedup, insert, imports ledger)
 *  - embed       → embedTexts (the local MiniLM engine behind --index and search)
 *                  matched against the KNOWN_MERCHANTS reference vectors
 *  - predict     → the same local embedding lookup, one row, top match as the
 *                  predicted category with its cosine similarity as confidence —
 *                  strictly display-only, nothing is written anywhere
 *  - reconcile   → detectDuplicates/detectSpikes (the anomaly_detect tool's SQL),
 *                  filtered to the freshly imported rows
 *
 * Each step measures its own wall-clock (performance.now, rounded to whole ms)
 * and the orchestrator's totalMs is the exact sum of the step durations.
 */

export type TraceStepId = 'import' | 'embed' | 'predict' | 'reconcile';

export interface TraceImportDetail {
  bank: string;
  format: string;
  rowCount: number;
  imported: number;
  skippedRows: number;
  importedIds: number[];
  previouslyImported?: { importedAt: string; transactionCount: number | null };
  message: string;
}

export interface TraceEmbedMatch {
  description: string;
  label: string;
  category: string;
  score: number;
}

export interface TraceEmbedDetail {
  model: string;
  matches: TraceEmbedMatch[];
}

export interface TracePredictDetail {
  description: string;
  category: string;
  confidence: number;
  displayOnly: true;
}

export interface TraceReconcileDetail {
  duplicates: DuplicateAnomaly[];
  spikes: SpikeAnomaly[];
}

export type TraceStepDetail =
  | TraceImportDetail
  | TraceEmbedDetail
  | TracePredictDetail
  | TraceReconcileDetail;

export interface TraceStepResult {
  step: TraceStepId;
  status: 'ok' | 'skipped' | 'error';
  /** Math.round of real wall-clock measured around the step body. */
  durationMs: number;
  detail: TraceStepDetail;
  /** Set when status === 'error', or the skip reason for filler results. */
  error?: string;
}

export interface TraceRunResult {
  steps: TraceStepResult[];
  /** Exact sum of the step durations — the accumulation contract. */
  totalMs: number;
}

/** Injectable embed function — production default is the local embedTexts engine. */
export type EmbedFn = (texts: string[]) => Promise<Float32Array[]>;

export interface TraceDeps {
  db: Database;
  /** Defaults to (texts) => embedTexts(texts). Inject the fake embedder in tests. */
  embed?: EmbedFn;
  /** Defaults to apiImport. Injectable for tests. */
  importFn?: (db: Database, body: ImportRequestBody) => ImportResult | Promise<ImportResult>;
}

/** One parsed statement row as sent by the browser substrate (client-import). */
export interface TraceTransaction {
  date: string;
  description: string;
  amount: number;
  bank?: string;
  external_id?: string;
  merchant_name?: string;
  category_detailed?: string;
  payment_channel?: string;
  pending?: boolean;
  authorized_date?: string;
  account_last4?: string;
}

/** Full chain input: the parsed statement plus its client-computed file hash. */
export interface TraceChainInput {
  filename: string;
  bank?: string;
  format?: string;
  fileHash: string;
  transactions: TraceTransaction[];
}

// ── Reference embeddings ─────────────────────────────────────────────────────

/**
 * Reference vectors for KNOWN_MERCHANTS, computed once per process per model
 * key. Constraint: one embedder per process per model key — true in production
 * (a single local model) and under bun test (per-file process isolation; the
 * fake embedder is deterministic anyway).
 */
const referenceCache = new Map<string, Float32Array[]>();

async function getReferenceVectors(embed: EmbedFn, modelId: string): Promise<Float32Array[]> {
  let vectors = referenceCache.get(modelId);
  if (!vectors) {
    // Same embed-text rule as rows: label doubles as the embed text, so query
    // and reference vectors are directly comparable.
    vectors = await embed(KNOWN_MERCHANTS.map((m) => m.label));
    referenceCache.set(modelId, vectors);
  }
  return vectors;
}

/** Dot product of two unit vectors = cosine similarity. */
function dotVec(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) sum += a[i] * b[i];
  return sum;
}

/** Argmax over the reference set — every row gets a nearest neighbor. */
function topMatch(vec: Float32Array, refVectors: Float32Array[]): { merchant: KnownMerchant; score: number } {
  let best = 0;
  let bestScore = -Infinity;
  for (let i = 0; i < refVectors.length; i++) {
    const score = dotVec(vec, refVectors[i]);
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return { merchant: KNOWN_MERCHANTS[best], score: bestScore };
}

function roundScore(score: number): number {
  return Math.round(score * 1000) / 1000;
}

function clamp01(score: number): number {
  return Math.max(0, Math.min(1, score));
}

// ── Step details ─────────────────────────────────────────────────────────────

/** Minimal detail for filler (skipped) / error results — never rendered as data. */
function emptyDetail(step: TraceStepId): TraceStepDetail {
  switch (step) {
    case 'import':
      return { bank: '', format: '', rowCount: 0, imported: 0, skippedRows: 0, importedIds: [], message: '' };
    case 'embed':
      return { model: DEFAULT_EMBEDDING_MODEL, matches: [] };
    case 'predict':
      return { description: '', category: '', confidence: 0, displayOnly: true };
    case 'reconcile':
      return { duplicates: [], spikes: [] };
  }
}

/** Map a client-parsed row onto the /api/import substrate's row shape. */
function toImportRow(t: TraceTransaction): ImportTransactionInput {
  const row: ImportTransactionInput = {
    date: t.date,
    description: t.description,
    amount: t.amount,
  };
  if (t.bank !== undefined) row.bank = t.bank;
  if (t.external_id !== undefined) row.external_id = t.external_id;
  if (t.merchant_name !== undefined) row.merchant_name = t.merchant_name;
  if (t.category_detailed !== undefined) row.category_detailed = t.category_detailed;
  if (t.payment_channel !== undefined) row.payment_channel = t.payment_channel;
  if (t.pending !== undefined) row.pending = t.pending;
  if (t.authorized_date !== undefined) row.authorized_date = t.authorized_date;
  if (t.account_last4 !== undefined) row.account_last4 = t.account_last4;
  return row;
}

// ── Step 1: import ───────────────────────────────────────────────────────────

/**
 * Commit the parsed statement through the real import substrate. A re-drop of
 * the same file short-circuits with status 'skipped' (file-hash dedup is
 * inherited from apiImport) and the orchestrator stops the chain there.
 */
export async function importStep(
  input: { filename: string; bank?: string; format?: string; fileHash: string; transactions: TraceTransaction[] },
  deps: TraceDeps,
): Promise<TraceStepResult> {
  const t0 = performance.now();
  const finish = (result: Omit<TraceStepResult, 'durationMs'>): TraceStepResult => ({
    ...result,
    durationMs: Math.round(performance.now() - t0),
  });

  try {
    const body: ImportRequestBody = {
      filename: input.filename,
      bank: input.bank,
      fileHash: input.fileHash,
      transactions: input.transactions.map(toImportRow),
    };
    const result = await (deps.importFn ?? apiImport)(deps.db, body);

    if (result.status === 'failed') {
      return finish({
        step: 'import',
        status: 'error',
        detail: emptyDetail('import'),
        error: result.error ?? result.message,
      });
    }

    if (result.status === 'skipped') {
      return finish({
        step: 'import',
        status: 'skipped',
        detail: {
          bank: input.bank ?? '',
          format: input.format ?? '',
          rowCount: input.transactions.length,
          imported: 0,
          skippedRows: result.transactionsSkipped,
          importedIds: [],
          previouslyImported: result.previouslyImported
            ? {
                importedAt: result.previouslyImported.importedAt,
                transactionCount: result.previouslyImported.transactionCount,
              }
            : undefined,
          message: result.message,
        },
      });
    }

    // status === 'imported' — resolve the committed row ids so reconciliation
    // can scope to the freshly imported statement. The external ids are exactly
    // what apiImport derived: the row's own external_id when present, else
    // computeExternalId(date|description|amount) — identical to the CLI.
    const extIds = input.transactions.map((t) => t.external_id ?? computeExternalId(t));
    const importedIds = new Set<number>();
    const CHUNK = 500; // SQLite parameter limit headroom
    for (let i = 0; i < extIds.length; i += CHUNK) {
      const chunk = extIds.slice(i, i + CHUNK);
      const params: Record<string, unknown> = {};
      const placeholders = chunk
        .map((id, j) => {
          params[`id${j}`] = id;
          return `@id${j}`;
        })
        .join(',');
      const rows = deps.db
        .prepare(`SELECT id FROM transactions WHERE external_id IN (${placeholders})`)
        .all(params) as { id: number }[];
      for (const r of rows) importedIds.add(r.id);
    }

    return finish({
      step: 'import',
      status: 'ok',
      detail: {
        bank: input.bank ?? '',
        format: input.format ?? '',
        rowCount: input.transactions.length,
        imported: result.transactionsImported,
        skippedRows: result.transactionsSkipped,
        importedIds: [...importedIds].sort((a, b) => a - b),
        message: result.message,
      },
    });
  } catch (err) {
    return finish({
      step: 'import',
      status: 'error',
      detail: emptyDetail('import'),
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ── Step 2: embedding lookup ─────────────────────────────────────────────────

/**
 * Match every row description against the known merchants/categories reference
 * using the local embedding engine. One batched embed call for the rows; the
 * reference vectors are computed once per process and reused.
 */
export async function embeddingStep(
  rows: { description: string }[],
  deps: TraceDeps,
): Promise<TraceStepResult> {
  const t0 = performance.now();
  const embed = deps.embed ?? ((texts: string[]) => embedTexts(texts));
  try {
    const texts = rows.map((r) => transactionEmbedText({ description: r.description }));
    const [rowVecs, refVectors] = await Promise.all([
      embed(texts),
      getReferenceVectors(embed, DEFAULT_EMBEDDING_MODEL),
    ]);
    const matches: TraceEmbedMatch[] = rows.map((r, i) => {
      const { merchant, score } = topMatch(rowVecs[i], refVectors);
      return {
        description: r.description,
        label: merchant.label,
        category: merchant.category,
        score: roundScore(score),
      };
    });
    return {
      step: 'embed',
      status: 'ok',
      durationMs: Math.round(performance.now() - t0),
      detail: { model: DEFAULT_EMBEDDING_MODEL, matches },
    };
  } catch (err) {
    return {
      step: 'embed',
      status: 'error',
      durationMs: Math.round(performance.now() - t0),
      detail: emptyDetail('embed'),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── Step 3: category prediction (display-only) ───────────────────────────────

/**
 * The single-row categorization decision: top known-category match from the
 * local embedding lookup, cosine similarity as confidence. Strictly
 * display-only — this function performs no database access whatsoever, so
 * nothing can be written.
 */
export async function predictStep(description: string, deps: TraceDeps): Promise<TraceStepResult> {
  const t0 = performance.now();
  const embed = deps.embed ?? ((texts: string[]) => embedTexts(texts));
  try {
    const [vec] = await embed([transactionEmbedText({ description })]);
    const refVectors = await getReferenceVectors(embed, DEFAULT_EMBEDDING_MODEL);
    const { merchant, score } = topMatch(vec, refVectors);
    return {
      step: 'predict',
      status: 'ok',
      durationMs: Math.round(performance.now() - t0),
      detail: {
        description,
        category: merchant.category,
        confidence: roundScore(clamp01(score)),
        displayOnly: true,
      },
    };
  } catch (err) {
    return {
      step: 'predict',
      status: 'error',
      durationMs: Math.round(performance.now() - t0),
      detail: emptyDetail('predict'),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── Step 4: reconciliation hint ──────────────────────────────────────────────

/**
 * Duplicate/spike detection over the freshly imported rows: the anomaly
 * detectors run DB-wide (their real semantics), then hints are kept only when
 * every contributing transaction belongs to the just-imported set.
 */
export async function reconcileStep(importedIds: number[], deps: TraceDeps): Promise<TraceStepResult> {
  const t0 = performance.now();
  try {
    const idSet = new Set(importedIds);
    const duplicates = detectDuplicates(deps.db).filter((a) => a.transactions.every((t) => idSet.has(t.id)));
    const spikes = detectSpikes(deps.db).filter((a) => idSet.has(a.transaction.id));
    return {
      step: 'reconcile',
      status: 'ok',
      durationMs: Math.round(performance.now() - t0),
      detail: { duplicates, spikes },
    };
  } catch (err) {
    return {
      step: 'reconcile',
      status: 'error',
      durationMs: Math.round(performance.now() - t0),
      detail: emptyDetail('reconcile'),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── Orchestrator ─────────────────────────────────────────────────────────────

/** Skipped filler for steps that never ran (chain stopped earlier). */
function skippedFiller(step: TraceStepId, reason: string): TraceStepResult {
  return { step, status: 'skipped', durationMs: 0, detail: emptyDetail(step), error: reason };
}

/**
 * Run the full offline chain in order. A step that reports an error — or a
 * re-drop skip — stops the chain; remaining steps become skipped fillers and
 * nothing is fabricated. totalMs is always the exact sum of step durations.
 */
export async function runStatementChain(input: TraceChainInput, deps: TraceDeps): Promise<TraceRunResult> {
  const steps: TraceStepResult[] = [];

  // 1. Import
  const importResult = await importStep(input, deps);
  steps.push(importResult);
  if (importResult.status !== 'ok') {
    const reason = importResult.status === 'skipped'
      ? 'statement already imported'
      : (importResult.error ?? 'import failed');
    steps.push(skippedFiller('embed', reason));
    steps.push(skippedFiller('predict', reason));
    steps.push(skippedFiller('reconcile', reason));
    return { steps, totalMs: sumDurations(steps) };
  }

  // 2. Embedding lookup
  const embedResult = await embeddingStep(input.transactions, deps);
  steps.push(embedResult);
  if (embedResult.status !== 'ok') {
    const reason = embedResult.error ?? 'embedding lookup failed';
    steps.push(skippedFiller('predict', reason));
    steps.push(skippedFiller('reconcile', reason));
    return { steps, totalMs: sumDurations(steps) };
  }

  // 3. Category prediction — deterministic default: the first imported row.
  const predictResult = await predictStep(input.transactions[0]?.description ?? '', deps);
  steps.push(predictResult);
  if (predictResult.status !== 'ok') {
    const reason = predictResult.error ?? 'prediction failed';
    steps.push(skippedFiller('reconcile', reason));
    return { steps, totalMs: sumDurations(steps) };
  }

  // 4. Reconciliation hint
  const importDetail = importResult.detail as TraceImportDetail;
  const reconcileResult = await reconcileStep(importDetail.importedIds, deps);
  steps.push(reconcileResult);

  return { steps, totalMs: sumDurations(steps) };
}

function sumDurations(steps: TraceStepResult[]): number {
  return steps.reduce((sum, r) => sum + r.durationMs, 0);
}