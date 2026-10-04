/**
 * open-jev pre-labeler: main <-> worker message protocol
 * (specs/open-jev-labeler.md §5). Import-free and DOM-free.
 *
 * Messages are versioned (`v: 1`). Both sides validate every inbound message
 * with `parseToWorker` / `parseFromWorker`, which return null on anything
 * malformed, on a different version, and on ANY extra key. Validation is of
 * shape and format only: it deliberately lets non-finite numbers through, so
 * the main thread's `acceptResults` (session.ts) can count and drop them.
 */

export const PRELABEL_PROTOCOL_VERSION = 1 as const;

/** `run` accepts at most this many items (spec §7 caps). */
export const MAX_RUN_ITEMS = 2000;

/** `choose` (Round 4, R4-4): a single chat-time decision over 2..8 options. */
export const CHOOSE_MIN_OPTIONS = 2;
export const CHOOSE_MAX_OPTIONS = 8;
/** `choose` state is at most this many characters. */
export const CHOOSE_MAX_STATE_CHARS = 512;
const CHOOSE_MAX_QUESTION_CHARS = 512;
const CHOOSE_MAX_OPTION_CHARS = 64;
const CHOOSE_MAX_DESCRIPTION_CHARS = 400;

export type PrelabelPins = {
  repo: string;
  dtype: 'q4f16' | 'fp32';
  device: 'webgpu' | 'wasm';
  temperature: number;
  templateVersion: 'prelabel-tmpl-v1';
  modelId: string;
  /** 40-hex HF commit sha; every remote file is pinned to it. */
  revision: string;
  /** 64-hex sha256 of the expected config.json. */
  configSha: string;
};

export type PrelabelItem = { txnId: number; description: string; amount: number; date: string };

// main -> worker
export type ToWorker =
  // `labels` is optional (Round 4): a chat-only host never opened the Review tab and sends none.
  | { v: 1; type: 'init'; pins: PrelabelPins; labels?: string[]; labelSetVersion: string; assetBase: string }
  | { v: 1; type: 'probe' } // capability only, no download
  | { v: 1; type: 'info' } // OpenJev.info(): NETWORK, only after consent (§4.4)
  | { v: 1; type: 'load' } // consent already given by the UI
  | { v: 1; type: 'run'; runId: string; items: PrelabelItem[] } // <= MAX_RUN_ITEMS
  | { v: 1; type: 'cancel'; runId: string }
  // Round 4: one decision for a chat turn. `options` are names; `descriptions` (optional) render as `name: description`.
  | { v: 1; type: 'choose'; reqId: string; state: string; question: string; options: string[]; descriptions?: Record<string, string> }
  | { v: 1; type: 'dispose' };

export type PrelabelResult =
  | {
      txnId: number;
      ok: true;
      choice: string;
      p1: number;
      p2: number;
      margin: number;
      top2: [[string, number], [string, number]];
      ms: number;
      stateTokens: number;
      truncated: boolean;
    }
  | { txnId: number; ok: false; reason: 'decide_error' | 'empty_description' | 'bad_amount' };

// worker -> main
export type FromWorker =
  | {
      v: 1;
      type: 'capability';
      verdict: 'ready' | 'unavailable' | 'failed';
      reason: string | null;
      adapter: { vendor: string; architecture: string; shaderF16: boolean; isFallback: boolean } | null;
    }
  | { v: 1; type: 'info'; isCached: boolean; downloadSize: number }
  | { v: 1; type: 'progress'; phase: 'download' | 'session' | 'warmup'; loaded: number; total: number }
  | {
      v: 1;
      type: 'loaded';
      loadMs: number;
      fromCache: boolean;
      firstDecisionMs: number;
      runtime: { transformers: string; ort: string; openJev: '0.1.2'; device: string; dtype: string };
      configSha: string;
    }
  | { v: 1; type: 'results'; runId: string; rows: PrelabelResult[] } // chunks of 25
  | {
      v: 1;
      type: 'done';
      runId: string;
      n: number;
      skipped: number;
      cancelled: boolean;
      p50Ms: number;
      p95Ms: number;
      wallMs: number;
    }
  | {
      v: 1;
      type: 'chosen';
      reqId: string;
      ok: true;
      choice: string;
      p1: number;
      p2: number;
      margin: number;
      top2: [[string, number], [string, number]];
      ms: number;
    }
  | { v: 1; type: 'chosen'; reqId: string; ok: false; reason: 'not_loaded' | 'decide_error' | 'options_too_large' }
  | {
      v: 1;
      type: 'error';
      fatal: boolean;
      code: 'load' | 'decide' | 'label_set_too_large' | 'locked' | 'model_mismatch';
      detail: string;
    };

// ── Validation helpers ──────────────────────────────────────────────────────

type Obj = Record<string, unknown>;

function isObj(x: unknown): x is Obj {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/** True when `o` has exactly the given keys (no more, no fewer). */
function hasExactKeys(o: Obj, keys: readonly string[]): boolean {
  const own = Object.keys(o);
  return own.length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(o, k));
}

const isStr = (x: unknown): x is string => typeof x === 'string';
const isNonEmptyStr = (x: unknown): x is string => typeof x === 'string' && x.length > 0;
const isNum = (x: unknown): x is number => typeof x === 'number';
const isBool = (x: unknown): x is boolean => typeof x === 'boolean';
const isInt = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x);
const oneOf = <T extends string>(x: unknown, values: readonly T[]): x is T => typeof x === 'string' && (values as readonly string[]).includes(x);

// Mirrors MODEL_ID_PATTERN in src/prelabel/provenance.ts (this file is import-free).
const MODEL_ID_RE = /^[\w.:\/-]{1,64}$/;
const REVISION_RE = /^[0-9a-f]{40}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
// owner/name with no path tricks: the repo is spliced into an HF URL template.
const REPO_RE = /^[A-Za-z0-9][\w.-]{0,95}\/[A-Za-z0-9][\w.-]{0,95}$/;

const PIN_KEYS = ['repo', 'dtype', 'device', 'temperature', 'templateVersion', 'modelId', 'revision', 'configSha'] as const;

function isPins(x: unknown): x is PrelabelPins {
  return (
    isObj(x) &&
    hasExactKeys(x, PIN_KEYS) &&
    isStr(x.repo) && REPO_RE.test(x.repo) && !x.repo.includes('..') &&
    oneOf(x.dtype, ['q4f16', 'fp32'] as const) &&
    oneOf(x.device, ['webgpu', 'wasm'] as const) &&
    isNum(x.temperature) && Number.isFinite(x.temperature) &&
    x.templateVersion === 'prelabel-tmpl-v1' &&
    isStr(x.modelId) && MODEL_ID_RE.test(x.modelId) &&
    isStr(x.revision) && REVISION_RE.test(x.revision) &&
    isStr(x.configSha) && SHA256_RE.test(x.configSha)
  );
}

function isItem(x: unknown): x is PrelabelItem {
  return (
    isObj(x) &&
    hasExactKeys(x, ['txnId', 'description', 'amount', 'date']) &&
    isInt(x.txnId) && isStr(x.description) && isNum(x.amount) && isStr(x.date)
  );
}

function isScoredPair(x: unknown): x is [string, number] {
  return Array.isArray(x) && x.length === 2 && isStr(x[0]) && isNum(x[1]);
}

const RESULT_OK_KEYS = ['txnId', 'ok', 'choice', 'p1', 'p2', 'margin', 'top2', 'ms', 'stateTokens', 'truncated'] as const;

function isResult(x: unknown): x is PrelabelResult {
  if (!isObj(x) || !isInt(x.txnId)) return false;
  if (x.ok === true) {
    return (
      hasExactKeys(x, RESULT_OK_KEYS) &&
      isStr(x.choice) && isNum(x.p1) && isNum(x.p2) && isNum(x.margin) &&
      Array.isArray(x.top2) && x.top2.length === 2 && isScoredPair(x.top2[0]) && isScoredPair(x.top2[1]) &&
      isNum(x.ms) && isNum(x.stateTokens) && isBool(x.truncated)
    );
  }
  if (x.ok === false) {
    return hasExactKeys(x, ['txnId', 'ok', 'reason']) && oneOf(x.reason, ['decide_error', 'empty_description', 'bad_amount'] as const);
  }
  return false;
}

// ── parseToWorker ───────────────────────────────────────────────────────────

/** Validate a message the worker received. Null on anything malformed. */
export function parseToWorker(raw: unknown): ToWorker | null {
  if (!isObj(raw) || raw.v !== PRELABEL_PROTOCOL_VERSION || !isStr(raw.type)) return null;
  switch (raw.type) {
    case 'init': {
      const hasLabels = Object.prototype.hasOwnProperty.call(raw, 'labels');
      return hasExactKeys(raw, hasLabels ? ['v', 'type', 'pins', 'labels', 'labelSetVersion', 'assetBase'] : ['v', 'type', 'pins', 'labelSetVersion', 'assetBase']) &&
        isPins(raw.pins) &&
        (!hasLabels || (Array.isArray(raw.labels) && raw.labels.length > 0 && raw.labels.every(isNonEmptyStr))) &&
        isStr(raw.labelSetVersion) && isStr(raw.assetBase)
        ? (raw as unknown as ToWorker)
        : null;
    }
    case 'choose': {
      const hasDesc = Object.prototype.hasOwnProperty.call(raw, 'descriptions');
      if (!hasExactKeys(raw, hasDesc ? ['v', 'type', 'reqId', 'state', 'question', 'options', 'descriptions'] : ['v', 'type', 'reqId', 'state', 'question', 'options'])) return null;
      if (!isNonEmptyStr(raw.reqId) || !isNonEmptyStr(raw.state) || raw.state.length > CHOOSE_MAX_STATE_CHARS) return null;
      if (!isNonEmptyStr(raw.question) || raw.question.length > CHOOSE_MAX_QUESTION_CHARS) return null;
      const opts = raw.options;
      if (!Array.isArray(opts) || opts.length < CHOOSE_MIN_OPTIONS || opts.length > CHOOSE_MAX_OPTIONS) return null;
      if (!opts.every((o) => isNonEmptyStr(o) && o.length <= CHOOSE_MAX_OPTION_CHARS) || new Set(opts).size !== opts.length) return null;
      if (hasDesc) {
        const d = raw.descriptions;
        if (!isObj(d)) return null;
        for (const [k, v] of Object.entries(d)) {
          if (!opts.includes(k) || !isNonEmptyStr(v) || v.length > CHOOSE_MAX_DESCRIPTION_CHARS) return null;
        }
      }
      return raw as unknown as ToWorker;
    }
    case 'probe':
    case 'info':
    case 'load':
    case 'dispose':
      return hasExactKeys(raw, ['v', 'type']) ? (raw as unknown as ToWorker) : null;
    case 'run':
      return hasExactKeys(raw, ['v', 'type', 'runId', 'items']) &&
        isNonEmptyStr(raw.runId) &&
        Array.isArray(raw.items) && raw.items.length <= MAX_RUN_ITEMS && raw.items.every(isItem)
        ? (raw as unknown as ToWorker)
        : null;
    case 'cancel':
      return hasExactKeys(raw, ['v', 'type', 'runId']) && isNonEmptyStr(raw.runId) ? (raw as unknown as ToWorker) : null;
    default:
      return null;
  }
}

// ── parseFromWorker ─────────────────────────────────────────────────────────

const ADAPTER_KEYS = ['vendor', 'architecture', 'shaderF16', 'isFallback'] as const;
const RUNTIME_KEYS = ['transformers', 'ort', 'openJev', 'device', 'dtype'] as const;

/** Validate a message the main thread received. Null on anything malformed. */
export function parseFromWorker(raw: unknown): FromWorker | null {
  if (!isObj(raw) || raw.v !== PRELABEL_PROTOCOL_VERSION || !isStr(raw.type)) return null;
  switch (raw.type) {
    case 'capability': {
      if (!hasExactKeys(raw, ['v', 'type', 'verdict', 'reason', 'adapter'])) return null;
      if (!oneOf(raw.verdict, ['ready', 'unavailable', 'failed'] as const)) return null;
      if (raw.reason !== null && !isStr(raw.reason)) return null;
      const a = raw.adapter;
      if (a !== null) {
        if (!isObj(a) || !hasExactKeys(a, ADAPTER_KEYS)) return null;
        if (!isStr(a.vendor) || !isStr(a.architecture) || !isBool(a.shaderF16) || !isBool(a.isFallback)) return null;
      }
      return raw as unknown as FromWorker;
    }
    case 'info':
      return hasExactKeys(raw, ['v', 'type', 'isCached', 'downloadSize']) && isBool(raw.isCached) && isNum(raw.downloadSize)
        ? (raw as unknown as FromWorker)
        : null;
    case 'progress':
      return hasExactKeys(raw, ['v', 'type', 'phase', 'loaded', 'total']) &&
        oneOf(raw.phase, ['download', 'session', 'warmup'] as const) && isNum(raw.loaded) && isNum(raw.total)
        ? (raw as unknown as FromWorker)
        : null;
    case 'loaded': {
      if (!hasExactKeys(raw, ['v', 'type', 'loadMs', 'fromCache', 'firstDecisionMs', 'runtime', 'configSha'])) return null;
      if (!isNum(raw.loadMs) || !isBool(raw.fromCache) || !isNum(raw.firstDecisionMs) || !isStr(raw.configSha)) return null;
      const rt = raw.runtime;
      if (!isObj(rt) || !hasExactKeys(rt, RUNTIME_KEYS)) return null;
      if (!isStr(rt.transformers) || !isStr(rt.ort) || rt.openJev !== '0.1.2' || !isStr(rt.device) || !isStr(rt.dtype)) return null;
      return raw as unknown as FromWorker;
    }
    case 'results':
      return hasExactKeys(raw, ['v', 'type', 'runId', 'rows']) && isNonEmptyStr(raw.runId) &&
        Array.isArray(raw.rows) && raw.rows.every(isResult)
        ? (raw as unknown as FromWorker)
        : null;
    case 'done':
      return hasExactKeys(raw, ['v', 'type', 'runId', 'n', 'skipped', 'cancelled', 'p50Ms', 'p95Ms', 'wallMs']) &&
        isNonEmptyStr(raw.runId) && isNum(raw.n) && isNum(raw.skipped) && isBool(raw.cancelled) &&
        isNum(raw.p50Ms) && isNum(raw.p95Ms) && isNum(raw.wallMs)
        ? (raw as unknown as FromWorker)
        : null;
    case 'chosen': {
      if (!isNonEmptyStr(raw.reqId)) return null;
      if (raw.ok === false) {
        return hasExactKeys(raw, ['v', 'type', 'reqId', 'ok', 'reason']) &&
          oneOf(raw.reason, ['not_loaded', 'decide_error', 'options_too_large'] as const)
          ? (raw as unknown as FromWorker)
          : null;
      }
      return raw.ok === true &&
        hasExactKeys(raw, ['v', 'type', 'reqId', 'ok', 'choice', 'p1', 'p2', 'margin', 'top2', 'ms']) &&
        isStr(raw.choice) && isNum(raw.p1) && isNum(raw.p2) && isNum(raw.margin) && isNum(raw.ms) &&
        Array.isArray(raw.top2) && raw.top2.length === 2 && isScoredPair(raw.top2[0]) && isScoredPair(raw.top2[1])
        ? (raw as unknown as FromWorker)
        : null;
    }
    case 'error':
      return hasExactKeys(raw, ['v', 'type', 'fatal', 'code', 'detail']) && isBool(raw.fatal) &&
        oneOf(raw.code, ['load', 'decide', 'label_set_too_large', 'locked', 'model_mismatch'] as const) && isStr(raw.detail)
        ? (raw as unknown as FromWorker)
        : null;
    default:
      return null;
  }
}
