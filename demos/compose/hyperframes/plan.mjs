// Pure planning for the cut: join the host's card events per card, bind every card to the agent proposal it shows,
// expand per-card callouts/captions from that card's OWN data, and schedule overlays so none overlap. No I/O.
// Beat-agnostic: every event name, row pattern and copy string comes from the beat config (../beats/<beat>.json).
// Tested in src/__tests__/demo-cut-plan.test.ts.

/**
 * Group the host's events by card. Events carry the card `index`; the few that only carry the op id (card-behind-dialog)
 * are joined through it. Throws if any card was shown and never resolved (no pending card may reach the cut).
 * `opts.rowMatch` (regex source, default "^categor") picks the card-checked row whose [name, before, after] feeds {before}/{after};
 * with no match the first 3-element row is used.
 */
export function joinCards(events, opts = {}) {
  const rowRe = new RegExp(opts.rowMatch ?? '^categor', 'i');
  const by = new Map(); const byOp = new Map();
  const get = (i) => { if (!by.has(i)) by.set(i, { index: i }); return by.get(i); };
  for (const e of events) {
    if (e.t_ms == null) continue;
    let c;
    if (e.index !== undefined) c = get(e.index);
    else if (e.opId && byOp.has(e.opId)) c = byOp.get(e.opId);
    else continue;
    const t = e.t_ms / 1000;
    switch (e.name) {
      case 'card-shown': Object.assign(c, { opId: e.opId ?? null, txId: e.txId ?? null, tool: e.tool, kind: e.change ? 'change' : 'read', shown: t, text: e.text ?? '', box: e.box ?? null }); if (e.opId) byOp.set(e.opId, c); break;
      case 'card-checked': {
        c.target = !!e.target; c.problems = e.problems ?? [];
        const rows = e.rows ?? [];
        const row = rows.find((r) => rowRe.test(r?.[0] ?? '')) ?? rows.find((r) => Array.isArray(r) && r.length === 3);
        if (row) { c.field = row[0]; c.before = row[1]; c.after = row[2]; }
        break;
      }
      case 'card-behind-dialog': c.behindDialog = t; break;
      case 'reject-clicked': c.rejectClicked = t; c.reason = e.reason; break;
      case 'approve-pressed': c.pressed = t; break;
      case 'allow-clicked': c.allowClicked = t; break;
      case 'approve-held': c.held = t; break;
      case 'approve-released': c.released = t; break;
      case 'card-resolved': c.resolved = t; c.decision = e.decision; if (e.target !== undefined) c.target = !!e.target; c.outcome = e.outcome; break;
      default: break;
    }
  }
  const cards = [...by.values()].filter((c) => c.shown != null).sort((a, b) => a.shown - b.shown);
  for (const c of cards) if (c.resolved == null) throw new Error(`card ${c.opId ?? '#' + c.index} (${c.tool}) was shown but never resolved: a pending card would reach the cut`);
  return cards;
}

/**
 * Bind each CHANGE card to the audited `webmcp invoke <tool> --detach ...` that produced it. Each invoke is used at most once;
 * `entries` are transcriptFromAudit() entries with `src` seconds on the recording clock. Strategies (cfg.binding):
 *  - "categorize-by-id" (beat 5): same tool, same transaction id (the card's txId, matched against params.id), same category as
 *    the card's "after", started before the card was shown. An unbindable card throws: it is never annotated.
 *  - "tool-match": same tool, started before the card was shown, nearest first. Never reads params, so it makes no claim
 *    about what the proposal contained. An unbindable card throws only when `requireBinding` is true.
 *  - "none": no binding; cards carry no `proposal`.
 */
export function bindProposals(cards, entries, { strategy = 'categorize-by-id', requireBinding = true } = {}) {
  if (strategy === 'none') return cards;
  if (strategy !== 'categorize-by-id' && strategy !== 'tool-match') throw new Error(`unknown binding strategy "${strategy}"`);
  const used = new Set();
  for (const c of cards) {
    if (c.kind !== 'change') continue;
    const cands = entries.filter((e, i) => !used.has(i) && e.accepted && e.argv[0] === 'webmcp' && e.argv[1] === 'invoke' && e.argv[2] === c.tool && e.argv.includes('--detach') && e.src <= c.shown + 0.5)
      .map((e) => { let p = null; try { p = JSON.parse(e.argv[e.argv.indexOf('--params') + 1]); } catch { /* skip */ } return { e, p, i: entries.indexOf(e) }; })
      .filter((x) => strategy === 'tool-match' || (x.p && String(x.p.id) === String(c.txId)));
    const m = cands.at(-1);
    if (!m) {
      if (strategy === 'tool-match' && !requireBinding) continue;
      throw new Error(`cannot bind card ${c.opId ?? '#' + c.index} (${c.tool} #${c.txId}) to an agent proposal in ab-audit.jsonl; refusing to annotate it`);
    }
    if (strategy === 'categorize-by-id' && c.after && String(m.p.category).toLowerCase() !== String(c.after).toLowerCase()) throw new Error(`card ${c.opId ?? '#' + c.index} shows category ${c.after} but the bound proposal asked for ${m.p.category}`);
    used.add(m.i);
    c.proposal = { src: m.e.src, endSrc: m.e.endSrc, args: m.p ?? {}, argv: m.e.argv };
  }
  return cards;
}

const fillWith = (vars) => (s) => String(s).replace(/\{(\w+)\}/g, (_, k) => (k in vars ? String(vars[k]) : `{${k}}`));

/** Template variables that come ONLY from this card (and the beat target). */
export function cardVars(c, base = {}) {
  const args = c.proposal?.args ?? {};
  const text = String(c.text ?? '').replace(/\s+/g, ' ').trim();
  return { ...base, txId: c.txId ?? '?', opId: c.opId ?? '', category: c.after ?? args.category ?? '?', after: c.after ?? '?', before: c.before ?? '?', field: c.field ?? '?', tool: c.tool,
    decision: c.decision ?? '?', outcome: c.outcome || 'no outcome recorded', cardText: text.length > 110 ? text.slice(0, 107) + '...' : text,
    proposalArgs: JSON.stringify(args).replace(/"(\w+)":/g, '$1:').replace(/"([^"]*)"/g, '“$1”') };
}

/**
 * Per-card overlays, each filled from that card's own data and timed on that card's own events (source seconds).
 * perCard config: { kinds?: ["change"], requireDecisionEvents?: true, resolvedHold?, behindDialog?, propose, shown, hold?,
 *   resolved:{approve,reject,rejectOther?,allow?}, coShown:{x,y,txt,sub,src?}, coDecide:{approve?:{...},reject?:{...},allow?:{...}} }
 * With requireDecisionEvents true (beat 5) a decided card with no approve-pressed / reject-clicked event refuses the cut; with
 * false the card's "shown" caption simply runs until it resolved and the hold / decide-callout beats are skipped.
 * Returns {caps:[{start,end,t,optional,card}], cos:[{id,start,end,x,y,txt,sub,src?,card}]}; `card` is the card's index, so a
 * test (and a reader of index.html) can see which card every overlay describes.
 */
export function perCardItems(cfg, cards, base = {}) {
  const caps = []; const cos = [];
  const kinds = cfg.kinds ?? ['change'];
  const strict = cfg.requireDecisionEvents !== false;
  for (const c of cards) {
    if (!kinds.includes(c.kind)) continue;
    const f = fillWith(cardVars(c, base));
    const d = c.decision;
    const decideAt = d === 'approve' ? c.pressed : d === 'reject' ? c.rejectClicked : (c.allowClicked ?? c.pressed);
    if (decideAt == null && strict) throw new Error(`card ${c.opId ?? '#' + c.index} has no ${d === 'approve' ? 'approve-pressed' : d === 'reject' ? 'reject-clicked' : d + ' decision'} event`);
    const tail = c.resolved + (cfg.resolvedHold ?? 1.5);
    const shownEnd = decideAt ?? c.resolved;
    if (c.proposal && c.proposal.src < c.shown && cfg.propose) caps.push({ start: c.proposal.src, end: c.shown, t: f(cfg.propose), optional: true, card: c.index });
    if (c.behindDialog != null && cfg.behindDialog) caps.push({ start: c.behindDialog, end: Math.max(c.shown, c.behindDialog + 3), t: f(cfg.behindDialog), optional: true, card: c.index });
    if (cfg.shown) caps.push({ start: c.shown, end: shownEnd, t: f(cfg.shown), card: c.index });
    if (d === 'approve') {
      if (decideAt != null && cfg.hold) caps.push({ start: c.pressed, end: c.released ?? c.resolved, t: f(cfg.hold), card: c.index });
      caps.push({ start: c.released ?? c.resolved, end: tail, t: f(cfg.resolved.approve), card: c.index });
    } else if (d === 'reject') {
      // "Not the target" copy only when this card is provably a different transaction; otherwise (a duplicate or
      // failed-check proposal for the target, or an unknown target id) use the neutral reject caption.
      const otherTx = base.targetTxId != null && c.txId != null && String(c.txId) !== String(base.targetTxId) && cfg.resolved.rejectOther;
      caps.push({ start: c.rejectClicked ?? c.resolved, end: tail, t: f(otherTx ? cfg.resolved.rejectOther : cfg.resolved.reject), card: c.index });
    } else if (cfg.resolved[d]) {
      caps.push({ start: c.resolved, end: tail, t: f(cfg.resolved[d]), card: c.index });
    }
    const co = cfg.coShown; const cd = cfg.coDecide?.[d];
    if (co) cos.push({ id: `co_c${c.index}_a`, start: c.shown + 0.2, end: shownEnd - 0.1, x: co.x, y: co.y, txt: f(co.txt), sub: f(co.sub), ...(co.src ? { src: f(co.src) } : {}), ...(co.w ? { w: co.w } : {}), card: c.index });
    if (cd && decideAt != null) cos.push({ id: `co_c${c.index}_b`, start: decideAt, end: tail, x: cd.x ?? co?.x ?? 40, y: cd.y ?? co?.y ?? 400, txt: f(cd.txt), sub: f(cd.sub), card: c.index });
  }
  return { caps, cos };
}

// ---- {@event[k=v].path} tokens: any copy string can quote a value straight from events.json ----

export class MissingValue extends Error {}

/** One `where` clause: a plain value (string compare) or {lt|lte|gt|gte: number} (numeric compare on the event field). */
const whereOk = (e, k, v) => {
  if (v && typeof v === 'object') {
    const x = Number(e[k]);
    if (e[k] == null || !Number.isFinite(x)) return false;
    return Object.entries(v).every(([op, n]) => (op === 'lt' ? x < n : op === 'lte' ? x <= n : op === 'gt' ? x > n : op === 'gte' ? x >= n : false));
  }
  return String(e[k]) === String(v);
};

/** First event named `name` (with t_ms), optionally filtered by `where` {k:v | k:{lt:n}} and picked by `nth` (0, 1, ... or "last"). */
export function findEvent(events, name, where = null, nth = 0) {
  const m = events.filter((e) => e.name === name && e.t_ms != null && (!where || Object.entries(where).every(([k, v]) => whereOk(e, k, v))));
  return nth === 'last' ? m.at(-1) : m[nth];
}

const TOKEN = /\{@([\w-]+)(?:\[(\w+)=([^\]]+)\])?((?:\.\w+)*)(?::(\w+))?(?:#([^|}]*))?(?:\|([^}]*))?\}/g;

/**
 * Fill {@event.field}, {@event[phase=after-agent].field}, {@catch-score.wrongIds.length}, {@this.rating} (the event an `each`
 * item iterates over, passed as ctx.this). Arrays of primitives join with " · ". `{@event.rows:row}` pluralises a number ("1 row", "3 rows"); `{@event.field#Prefix: }` prints the prefix only when the value exists; `{@event.field|fallback}` uses the fallback text
 * when the event or field is absent or null. Throws MissingValue otherwise (the caller decides: skip an optional item, fail a required one).
 */
export function fillTokens(s, events, extra = {}, ctx = {}) {
  return String(s).replace(TOKEN, (_, name, k, v, pathStr, unit, prefix, dflt) => {
    try {
      const e = name === 'this' ? ctx.this : findEvent(events, name, k ? { [k]: v } : null);
      if (!e) throw new MissingValue(`event ${name}${k ? `[${k}=${v}]` : ''} is not in events.json`);
      let val = e;
      for (const key of pathStr.split('.').filter(Boolean)) {
        if (val == null || !(typeof val === 'object' || Array.isArray(val)) || !(key in Object(val))) throw new MissingValue(`event ${name} has no field ${pathStr.slice(1)}`);
        val = val[key];
      }
      if (val == null) throw new MissingValue(`event ${name} field ${pathStr.slice(1)} is null`);
      if (Array.isArray(val)) return val.map(String).join(' · ');
      if (typeof val === 'object') throw new MissingValue(`event ${name} field ${pathStr.slice(1)} is an object; quote a field of it`);
      if (unit && Number.isFinite(Number(val))) return (prefix ?? '') + `${val} ${unit}${Number(val) === 1 ? '' : 's'}`;
      return (prefix ?? '') + String(val);
    } catch (err) {
      if (err instanceof MissingValue && dflt !== undefined) return dflt;
      throw err;
    }
  }).replace(/\{(\w+)\}/g, (_, key) => {
    if (key in extra) return String(extra[key]);
    throw new MissingValue(`variable {${key}} has no value in this take`); // never leave a template placeholder on screen
  });
}

// ---- zoom: an honest crop of the recording, eased in and out ----

/** Normalise a rect to fractions of the frame. Values all <= 1 are taken as fractions already; otherwise divided by the recorded viewport (CSS px). */
export function normRect(r, viewport) {
  if (!r) return null;
  const w0 = r.w ?? r.width; const h0 = r.h ?? r.height; // Playwright's boundingBox says width/height
  const vals = [r.x, r.y, w0, h0];
  if (vals.some((v) => typeof v !== 'number' || !Number.isFinite(v))) return null;
  const frac = vals.every((v) => v <= 1);
  if (frac) return { x: r.x, y: r.y, w: w0, h: h0 };
  if (!viewport?.width || !viewport?.height) return null;
  return { x: r.x / viewport.width, y: r.y / viewport.height, w: w0 / viewport.width, h: h0 / viewport.height };
}

/**
 * Uniform crop (same aspect as the frame, so nothing is stretched) around a fractional rect. Returns {s, ox, oy}: scale and the
 * crop origin as fractions of the frame. The card stays fully inside: s = 1 / max(w, h) after `pad`, capped at maxScale.
 */
export function zoomCrop(rect, { pad = 0.04, maxScale = 2.2 } = {}) {
  const w = Math.min(1, rect.w + 2 * pad); const h = Math.min(1, rect.h + 2 * pad);
  const s = Math.max(1, Math.min(maxScale, 1 / Math.max(w, h)));
  const cx = rect.x + rect.w / 2; const cy = rect.y + rect.h / 2;
  const ox = Math.min(Math.max(cx - 0.5 / s, 0), 1 - 1 / s);
  const oy = Math.min(Math.max(cy - 0.5 / s, 0), 1 - 1 / s);
  return { s, ox, oy };
}

/**
 * Stage crop: the footage (vw x vh, at vx,vy) sits inside a cw x ch frame of another aspect (16:10 recording in a 16:9 frame). Scale
 * so the padded rect fits the frame, centre it, then clamp the pan so the frame shows footage instead of the side bars wherever the
 * scaled footage is big enough. Returns {s, x, y}: the uniform scale and px translation of a top-left-origin wrapper (p -> s*p + (x,y)).
 */
export function stageCrop(rect, { pad = 0.04, maxScale = 2.2 } = {}, g) {
  const pw = Math.min(1, rect.w + 2 * pad) * g.vw; const ph = Math.min(1, rect.h + 2 * pad) * g.vh;
  const s = Math.max(1, Math.min(maxScale, g.cw / pw, g.ch / ph));
  const cx = g.vx + (rect.x + rect.w / 2) * g.vw; const cy = g.vy + (rect.y + rect.h / 2) * g.vh;
  const axis = (c, v0, v, frame) => {
    if (s * v < frame) return (frame - s * v) / 2 - s * v0; // footage narrower than the frame: centre it
    return Math.min(-s * v0, Math.max(frame - s * (v0 + v), frame / 2 - s * c));
  };
  return { s, x: axis(cx, g.vx, g.vw, g.cw), y: axis(cy, g.vy, g.vh, g.ch) };
}

/**
 * Zoom windows (source seconds) while a card is on screen: card.shown .. card.resolved + holdAfter. The rect is the card's own
 * `box` from card-shown when the host recorded one, else cfg.rect (fractions). cfg: {kinds?, rect, pad?, maxScale?, holdAfter?, ease?}.
 */
export function cardZoomWindows(cfg, cards, viewport) {
  if (!cfg) return [];
  const kinds = cfg.kinds ?? ['change', 'read'];
  const out = [];
  for (const c of cards) {
    if (!kinds.includes(c.kind)) continue;
    // A card the human could not reach until they closed a dialog was not (fully) on screen from `shown`; with no recorded box
    // we cannot say where or when it became visible, so we do not zoom on it.
    if (c.behindDialog != null && !c.box && cfg.skipWhenBehindDialog !== false) continue;
    const rect = normRect(c.box, viewport) ?? normRect(cfg.rect, viewport);
    if (!rect) throw new Error(`cardZoom: card ${c.opId ?? '#' + c.index} has no box and the config has no rect`);
    out.push({ start: c.shown, end: c.resolved + (cfg.holdAfter ?? 0.6), rect, card: c.index, source: normRect(c.box, viewport) ? 'event' : 'config' });
  }
  return out;
}

/**
 * Keyframes for the zoom wrapper on the composition clock. `wins` = [{start, end, rect}] (comp seconds). Ease in over `ease`
 * seconds from start, ease out ending at `end`. Windows closer than 2*ease stay zoomed and glide straight to the next rect.
 * Returns [{t, d, s, ox, oy}] tweens in time order (identity = s 1, ox 0, oy 0). `crop` / `identity` swap in another crop
 * (e.g. stageCrop, whose tweens carry {s, x, y} instead).
 */
export function zoomTweens(wins, { ease = 0.6, pad, maxScale, crop = zoomCrop, identity = { s: 1, ox: 0, oy: 0 } } = {}) {
  const w = [...wins].sort((a, b) => a.start - b.start);
  const tw = [];
  const lastEnd = () => (tw.length ? tw.at(-1).t + tw.at(-1).d : 0);
  for (let i = 0; i < w.length; i++) {
    const z = crop(w[i].rect, { pad: w[i].pad ?? pad, maxScale: w[i].maxScale ?? maxScale });
    const glide = i > 0 && w[i].start - w[i - 1].end < 2 * ease;
    tw.push({ t: Math.max(lastEnd(), glide ? w[i].start - ease : w[i].start), d: ease, ...z });
    const next = w[i + 1];
    if (!next || next.start - w[i].end >= 2 * ease) tw.push({ t: Math.max(lastEnd(), w[i].end - ease), d: ease, ...identity });
  }
  return tw;
}

/**
 * Make overlays non-overlapping on the composition clock: sort by start; each item ends before the next starts (minus
 * `gap`, room for the fades). Optional items squeezed below `minDur` are dropped; the rest are clipped, never delayed
 * (a delayed caption could describe a card that is no longer on screen).
 * Items: {start,end,optional?,...} in comp seconds. Returns the kept items, sorted.
 */
export function scheduleOverlays(items, { gap = 0.05, minDur = 0.6 } = {}) {
  let base = [...items].sort((x, y) => x.start - y.start || x.end - y.end);
  let list;
  for (;;) {
    list = base.map((x) => ({ ...x }));
    for (let i = 0; i < list.length - 1; i++) list[i].end = Math.min(list[i].end, list[i + 1].start - gap);
    const bad = list.findIndex((x) => x.optional && x.end - x.start < minDur);
    if (bad < 0) break;
    base.splice(bad, 1); // dropping it gives its predecessor back its original end on the next pass
  }
  for (const x of list) if (x.end <= x.start) throw new Error(`overlay at ${x.start.toFixed(2)}s has no room left after clipping: ${JSON.stringify(x.t ?? x.txt)}`);
  return list;
}

/** True when no two items overlap (used by build.mjs as a final assertion). */
export function nonOverlapping(list, eps = 1e-6) {
  const s = [...list].sort((a, b) => a.start - b.start);
  return s.every((x, i) => i === 0 || x.start >= s[i - 1].end - eps);
}

/**
 * When did a card first appear in the footage? `frames` are equal-size gray frames (Uint8Array) of the card's rectangle sampled at
 * `fps` from `t0` (source seconds). The first frame whose mean absolute difference from frame 0 reaches `fraction` of the largest
 * difference in the window is the pop-in (a half-way rule, so a fading toast from the previous card does not count). Returns null
 * when nothing in the window changes by at least `minMax` grey levels (no card detected: the caller keeps the host event).
 */
export function firstAppearance(frames, fps, t0, { fraction = 0.5, minMax = 5 } = {}) {
  if (frames.length < 2) return null;
  const d = frames.map((f) => { let s = 0; for (let i = 0; i < f.length; i++) s += Math.abs(f[i] - frames[0][i]); return s / f.length; });
  const max = Math.max(...d);
  if (max < minMax) return null;
  const i = d.findIndex((x) => x >= fraction * max);
  return +(t0 + i / fps).toFixed(3);
}

/**
 * When did something in a rectangle LAST change? Same frames as firstAppearance; the last frame whose difference from its predecessor reaches
 * `fraction` of the largest such jump in the window (e.g. a dialog closing: earlier jumps such as it opening do not count).
 * Returns null when no jump reaches `minMax` grey levels.
 */
export function lastJump(frames, fps, t0, { fraction = 0.5, minMax = 5 } = {}) {
  if (frames.length < 2) return null;
  const d = [0];
  for (let k = 1; k < frames.length; k++) { let s = 0; for (let i = 0; i < frames[k].length; i++) s += Math.abs(frames[k][i] - frames[k - 1][i]); d.push(s / frames[k].length); }
  const max = Math.max(...d);
  if (max < minMax) return null;
  let last = -1; d.forEach((x, k) => { if (x >= fraction * max) last = k; });
  return +(t0 + last / fps).toFixed(3);
}
