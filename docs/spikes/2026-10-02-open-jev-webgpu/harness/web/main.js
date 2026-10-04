import { OpenJev, choice, noul } from 'open-jev';
import * as tjs from '@huggingface/transformers';
import lists from './lists.json';

window.__adapterInfo = async () => {
  if (!navigator.gpu) return { webgpu: false, reason: 'navigator.gpu undefined' };
  let a;
  try { a = await navigator.gpu.requestAdapter(); } catch (e) { return { webgpu: false, reason: `requestAdapter threw: ${e.message}` }; }
  if (!a) return { webgpu: false, reason: 'requestAdapter() returned null' };
  const i = a.info ?? {};
  return { webgpu: true, vendor: i.vendor, architecture: i.architecture, device: i.device, description: i.description,
    is_fallback_adapter: a.isFallbackAdapter ?? null, shader_f16: a.features.has('shader-f16'), features: [...a.features].sort(),
    maxBufferSize: a.limits.maxBufferSize, maxStorageBufferBindingSize: a.limits.maxStorageBufferBindingSize };
};
window.__versions = () => ({ transformers: tjs.env.version ?? null, ort: tjs.env.backends?.onnx?.versions ?? null, crossOriginIsolated: self.crossOriginIsolated });

let jev = null;
window.__info = async (cfg) => {
  const i = await OpenJev.info(cfg);
  return { isCached: i.isCached, downloadSize: i.downloadSize, files: i.files, model: i.model, family: i.family, device: i.device, dtype: i.dtype };
};
window.__load = async (cfg) => {
  if (jev) { await jev.dispose(); jev = null; }
  const t0 = performance.now();
  let lastLoaded = 0, lastTotal = 0;
  try {
    jev = await OpenJev.load({ ...cfg, onProgress: ({ loaded, total }) => { lastLoaded = loaded; lastTotal = total; } });
  } catch (e) { return { ok: false, error: String(e?.stack ?? e).slice(0, 1500), load_ms: performance.now() - t0 }; }
  return { ok: true, load_ms: performance.now() - t0, runtime: jev.runtime, progress_loaded: lastLoaded, progress_total: lastTotal };
};

const fmtTx = (r) => `description: ${r.description} | amount: ${r.amount.toFixed(2)} | date: ${r.date}`;
const WL = {
  categorize: (r, descr, descOnly) => ({ state: descOnly ? r.description : fmtTx(r),
    q: choice('Which spending category does this transaction belong to?', lists.cats, descr ? lists.descs : undefined) }),
  route: (r) => ({ state: r.question,
    q: choice('Which tool should answer this user question? Pick "none" if no data tool applies.', [...Object.keys(lists.tools), 'none'],
      { ...lists.tools, none: 'No data tool applies: general chat, explanations, or requests to change data. Hand off to the full assistant.' }) }),
};

// rows: gold rows; workload: 'categorize' | 'categorize-bare' | 'route'
window.__run = async ({ workload, rows, warmup = 3 }) => {
  if (!jev) throw new Error('not loaded');
  if (workload === 'route-noul') {
    const out2 = []; let first = null;
    const stmt = 'The user is asking to look up, summarize or analyze their existing financial data (not to change data, import files, or just chat).';
    { const t = performance.now(); await jev.decide(rows[0].question, [noul(stmt)]); first = performance.now() - t; }
    for (let i = 0; i < warmup; i++) await jev.decide(rows[i % rows.length].question, [noul(stmt)]);
    for (const r of rows) {
      const t = performance.now(); const [a] = await jev.decide(r.question, [noul(stmt)]); const ms = performance.now() - t;
      const exp = r.expected === 'none' ? 'no' : 'yes';
      const pred = a.answer ? 'yes' : 'no';
      out2.push({ expected: exp, pred, conf: a.confidence, margin: Math.abs(2 * a.probability - 1), p_yes: a.probability, ms, label: r.question, top3: [], state_tokens: 0 });
    }
    return { first_ms: first, results: out2 };
  }
  const mk = (r) => workload === 'route' ? WL.route(r) : WL.categorize(r, workload === 'categorize', workload.endsWith('-desconly'));
  const out = [];
  let first_ms = null;
  // Very first call on this session = includes shader/pipeline compile.
  { const { state, q } = mk(rows[0]); const t = performance.now(); await jev.decide(state, [q]); first_ms = performance.now() - t; }
  for (let i = 0; i < warmup; i++) { const { state, q } = mk(rows[i % rows.length]); await jev.decide(state, [q]); }
  for (const r of rows) {
    const { state, q } = mk(r);
    const t = performance.now();
    const [a] = await jev.decide(state, [q]);
    const ms = performance.now() - t;
    const sorted = Object.entries(a.probabilities).sort((x, y) => y[1] - x[1]);
    out.push({ expected: r.expected, pred: a.choice, conf: a.confidence, margin: sorted[0][1] - (sorted[1]?.[1] ?? 0),
      top3: sorted.slice(0, 3).map(([k, v]) => [k, +v.toFixed(4)]), ms, state_tokens: jev.countTokens(state),
      label: r.description ?? r.question });
  }
  return { first_ms, results: out };
};
window.__ready = true;
