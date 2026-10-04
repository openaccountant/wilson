// Generates a HyperFrames composition (index.html + assets) from a take's REAL event log + audited agent commands + video,
// driven entirely by a per-beat config. One shared template for every beat; see NOTES.md for the config fields.
//   node build.mjs --take /private/tmp/claude-501/wilson-demos/<beat>/take<N> --config ../beats/<beat>.json [--out <dir>] [--profile stage]
// --profile stage: the config's profiles.stage keys replace the top-level ones; footage only (no title, transcript, captions,
// callouts or badges), 16:9 crops, speed ramps and a corner source tag. Default output <take>/hf-stage. See stage.sh.
// Output goes to <take>/hf by default (never into this template dir), so beats and takes cannot collide.
// Timing is derived from events.json (host clock) and ab-audit.jsonl (the wrapper's record of every command and output,
// the source of truth for the terminal pane); copy and callouts come from the config.
//  - The terminal is rendered from ab-audit.jsonl, never parsed from actor.log, so model- or page-controlled text cannot
//    forge a command or SUMMARY row. The stream (actor.jsonl) is re-checked 1:1 against the audit: any other command, a
//    refused attempt, or a mismatch refuses the take.
//  - Every card annotation is generated from THAT card's own events (op id, card-checked rows, outcome) and, per the beat's
//    binding strategy, bound to the agent proposal that produced it (plan.mjs); a card that was never resolved refuses the take.
//  - Any copy can quote events.json with {@event.field} / {@event[k=v].field}. A missing value drops an optional item and
//    fails a required one, loudly. Captions and callouts are clipped so none overlaps another. Zoom is a uniform crop only.
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { parseJsonl, summaryFromStream } from "../../rig/lib/actor-log.mjs";
import { parseAudit, checkStreamAgainstAudit, auditProblems, transcriptFromAudit } from "../../rig/lib/ab-audit.mjs";
import { joinCards, bindProposals, perCardItems, scheduleOverlays, nonOverlapping, findEvent, fillTokens, MissingValue, cardZoomWindows, zoomTweens, normRect, firstAppearance, lastJump, stageCrop } from "./plan.mjs";
const arg = (k) => { const i = process.argv.indexOf("--" + k); return i > 0 ? process.argv[i + 1] : undefined; };
const HERE = path.dirname(new URL(import.meta.url).pathname);
const takeDir = arg("take");
if (!takeDir) { console.error("usage: node build.mjs --take <take dir> --config <beat json> [--out <dir>]"); process.exit(2); }
const ev = JSON.parse(fs.readFileSync(path.join(takeDir, "events.json"), "utf8"));
const cfgPath = arg("config") ?? path.join(HERE, "..", "beats", ev.beat + ".json");
const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
if (ev.beat && cfg.id && ev.beat !== cfg.id) throw new Error(`config ${cfgPath} is for ${cfg.id} but ${takeDir}/events.json is from ${ev.beat}`);
const PROFILE = arg("profile") ?? "web";
if (PROFILE !== "web") { const p = cfg.profiles?.[PROFILE]; if (!p) throw new Error(`config ${cfgPath} has no profiles.${PROFILE}`); Object.assign(cfg, p); }
if (PROFILE !== "web" && PROFILE !== "stage") throw new Error(`unknown profile "${PROFILE}" (web | stage)`);
const STAGE = PROFILE === "stage";
const OUT = path.resolve(arg("out") ?? path.join(takeDir, STAGE ? "hf-stage" : "hf"));
if (OUT === HERE) throw new Error("refusing to build into the template dir; pass --out elsewhere");
class MissingAnchor extends Error {}
const evHas = (spec) => { const s = typeof spec === "string" ? { event: spec } : spec; return !!findEvent(ev.events, s.event, s.where ?? null, s.nth ?? 0); };
for (const r of cfg.requiredEvents ?? []) if (!evHas(r)) throw new Error(`required event ${JSON.stringify(r)} missing from ${takeDir}/events.json (beat ${cfg.id})`);
const meta = JSON.parse(fs.readFileSync(path.join(takeDir, "actor-meta.json"), "utf8"));
const stream = parseJsonl(fs.readFileSync(path.join(takeDir, "actor.jsonl"), "utf8"));
const audit = parseAudit(fs.readFileSync(path.join(takeDir, "ab-audit.jsonl"), "utf8"));
const violations = [...checkStreamAgainstAudit(stream, audit, meta.wrapper), ...auditProblems(audit)];
if (violations.length) throw new Error("take refused: actor commands are not clean: " + violations.map((v) => JSON.stringify(String(v.command).slice(0, 160)) + " (" + v.reason + ")").join("; "));
const rec0 = Date.parse(ev.recordingStartedAt);
const entries = transcriptFromAudit(audit).map((e) => ({ ...e, src: (e.date.getTime() - rec0) / 1000, endSrc: (e.endDate.getTime() - rec0) / 1000 }));
const { summary: SUMMARY, at: summaryAt } = summaryFromStream(stream);
const viewport = findEvent(ev.events, "recording-started")?.viewport ?? { width: 1440, height: 900 };
fs.mkdirSync(path.join(OUT, "assets"), { recursive: true });
const VIDEO = "assets/take.mp4";
fs.rmSync(path.join(OUT, VIDEO), { force: true });
try { fs.linkSync(path.join(takeDir, "video.mp4"), path.join(OUT, VIDEO)); } catch { fs.copyFileSync(path.join(takeDir, "video.mp4"), path.join(OUT, VIDEO)); }
for (const f of ["hyperframes.json", "package.json"]) fs.copyFileSync(path.join(HERE, f), path.join(OUT, f));
fs.writeFileSync(path.join(OUT, "meta.json"), JSON.stringify({ id: "hyperframes-" + cfg.id, name: "hyperframes-" + cfg.id, createdAt: new Date().toISOString() }, null, 2));
const skipped = [];

// ---- cards: join per card, bind to proposals ----
const cards = bindProposals(joinCards(ev.events, cfg.cards), entries, cfg.binding ?? { strategy: "none" });
/** Gray frames of a fractional rect of the recording, sampled at fps from lo to hi (source seconds), via ffmpeg. */
const grabFrames = (lo, hi, rect, fps) => {
  const W = 96, H = 64, size = W * H;
  const r = spawnSync("ffmpeg", ["-v", "error", "-ss", String(Math.max(0, lo)), "-t", String(hi - Math.max(0, lo)), "-i", path.join(takeDir, "video.mp4"), "-vf",
    `fps=${fps},crop=iw*${rect.w}:ih*${rect.h}:iw*${rect.x}:ih*${rect.y},scale=${W}:${H},format=gray`, "-f", "rawvideo", "-"], { maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error("footage detection needs ffmpeg on PATH: " + String(r.stderr ?? r.error));
  const frames = []; for (let o = 0; o + size <= r.stdout.length; o += size) frames.push(r.stdout.subarray(o, o + size));
  return frames;
};
// ---- when did each card really appear? The host's card-shown event is polled and can lag the footage ----
//  cardStart "event" (default): the host event. "audit": the audit end time of the invoke that raised the card (an early bound; on take21 the
//  card appeared ~1.2 s after it). "footage": the first frame in which the card's rectangle changes (ffmpeg, 10 fps), searched between
//  the audit end of that invoke (or cardDetect.lead s before the event) and the event; falls back to the event, noted, if nothing changes.
const cardStart = cfg.cardStart ?? "event";
if (!["event", "audit", "footage"].includes(cardStart)) throw new Error(`unknown cardStart "${cardStart}"`);
const detect = { fps: 10, lead: 4, fraction: 0.5, minMax: 5, ...(cfg.cardDetect ?? {}) };
const cardStartNotes = []; const footageNotes = [];
if (cardStart !== "event") {
  for (const c of cards) {
    const ev0 = c.shown; const floor = c.proposal?.endSrc ?? c.proposal?.src;
    if (cardStart === "audit") {
      if (floor != null && floor < ev0) { c.shown = Math.max(floor, ev0 - detect.lead); cardStartNotes.push(`card ${c.index}: audit ${c.shown.toFixed(2)}s (event ${ev0.toFixed(2)}s)`); }
      else cardStartNotes.push(`card ${c.index}: no audit invoke, kept event ${ev0.toFixed(2)}s`);
      continue;
    }
    const rect = normRect(c.box, viewport) ?? normRect((cfg.cardDetect ?? {}).rect ?? cfg.zoom?.card?.rect, viewport);
    if (!rect) throw new Error(`cardStart footage: card ${c.opId ?? c.index} has no box and the config has no cardDetect.rect / zoom.card.rect`);
    const lo = Math.max(0, (floor != null && floor < ev0 ? Math.max(floor, ev0 - detect.lead) : ev0 - detect.lead) - 0.3); const dur = ev0 + 0.5 - lo;
    const frames = grabFrames(lo, lo + dur, rect, detect.fps);
    const t = firstAppearance(frames, detect.fps, lo, { fraction: detect.fraction, minMax: detect.minMax });
    if (t == null || t > ev0 + 0.5) cardStartNotes.push(`card ${c.index}: no change detected in ${lo.toFixed(1)}-${(lo + dur).toFixed(1)}s, kept event ${ev0.toFixed(2)}s`);
    else { c.shown = Math.min(t, ev0); cardStartNotes.push(`card ${c.index}: footage ${c.shown.toFixed(2)}s (event ${ev0.toFixed(2)}s, audit ${floor?.toFixed(2) ?? "n/a"}s)`); }
  }
}
const changeCards = cards.filter((c) => c.kind === "change");
const target = changeCards.find((c) => c.target);
if (cfg.requireTargetCard && !target) throw new Error("no decided target card in events.json");
const proposalCards = cards.filter((c) => c.proposal);
const proposalTimes = proposalCards.map((c) => c.proposal.src).sort((a, b) => a - b);
const special = {
  "last-card-resolved": () => (cards.length ? Math.max(...cards.map((c) => c.resolved)) : null),
  "first-proposal": () => (proposalTimes.length ? proposalTimes[0] : null),
  "first-card-shown": () => (cards.length ? Math.min(...cards.map((c) => c.shown)) : null),
};
// An event the host recorded wins; the derived name only stands in when the host did not record it (beat 5 derives both).
const E = (n, where, nth) => {
  const e = findEvent(ev.events, n, where ?? null, nth ?? 0);
  if (e) return e.t_ms / 1000;
  const v = !where && special[n] ? special[n]() : null;
  if (v == null) throw new MissingAnchor(`event ${n}${where ? JSON.stringify(where) : ""} is not in events.json`);
  return v;
};
if (cfg.noCardAfter) { const lim = E(cfg.noCardAfter); if (cards.some((c) => c.shown > lim)) throw new Error(`a card appears after ${cfg.noCardAfter}: the end frame would not be clean`); }
const verbs = cfg.transcript?.verbs ?? ["list", "invoke", "result"];
const kept = entries.filter((e) => e.accepted && e.argv[0] === "webmcp" && verbs.includes(e.argv[1]));
const beforeFirst = kept.filter((c) => c.src < (proposalTimes[0] ?? Infinity));
const cmdAnchor = { firstAgentCommand: kept[0]?.src, firstProposal: proposalTimes[0], lastBeforeFirstProposal: proposalTimes.length ? (beforeFirst.at(-1) ?? { src: proposalTimes[0] }).src : undefined };

const decisions = cards.map((c) => c.decision);
const cnt = (d) => decisions.filter((x) => x === d).length;
const agentTools = [...new Set(entries.filter((e) => e.accepted && e.argv[0] === "webmcp" && e.argv[1] === "invoke").map((e) => e.argv[2]))].join(" \u00b7 ");
const vars = { target: cfg.target ?? "", agentTools, nCards: cards.length, nApproved: cnt("approve"), nRejected: cnt("reject"), nAllowed: cnt("allow"), targetId: target?.txId ?? "", targetAfter: target?.after ?? "",
  targetIs: target ? (target.decision === "approve" ? `is now ${target.after}.` : "is unchanged.") : "" };
for (const e of entries) if (e.accepted && e.argv[0] === "webmcp" && e.argv[1] === "invoke") { const k = "calls_" + e.argv[2]; vars[k] = (vars[k] ?? 0) + 1; } // audited invoke counts, e.g. {calls_get_interaction}
const fill = (s) => fillTokens(s, ev.events, vars);
const namedMemo = {};

// ---- anchors -> source seconds ----
const at = (a, segs) => {
  const off = a.offset ?? 0;
  if (a.anchor) { // a named anchor from cfg.anchors; the footage kind looks for the last change in a rect, with an event fallback
    if (namedMemo[a.anchor] === undefined) {
      const d = cfg.anchors?.[a.anchor]; if (!d) throw new Error(`unknown anchor "${a.anchor}"`);
      let t = null;
      if (d.footage && cfg.footageAnchors !== "skip") {
        const f = d.footage; const rect = normRect(f.rect, viewport); const lo = at(f.from, segs); const hi = at(f.to, segs); const fps = f.fps ?? 10;
        t = lastJump(grabFrames(lo, hi, rect, fps), fps, Math.max(0, lo), { fraction: f.fraction ?? 0.5, minMax: f.minMax ?? 5 });
        footageNotes.push(`anchor ${a.anchor}: ${t == null ? "no change in " + lo.toFixed(1) + "-" + hi.toFixed(1) + "s" : "footage " + t.toFixed(2) + "s"}`);
      }
      if (t == null && d.fallback) t = at(d.fallback, segs);
      namedMemo[a.anchor] = t;
    }
    if (namedMemo[a.anchor] == null) throw new MissingAnchor(`anchor ${a.anchor} could not be placed`);
    return namedMemo[a.anchor] + off;
  }
  if (a.max || a.min) { // latest / earliest of the alternatives that exist in this take (at least one must)
    const vs = (a.max ?? a.min).map((x) => { try { return at(x, segs); } catch (e) { if (e instanceof MissingAnchor) return null; throw e; } }).filter((v) => v != null);
    if (!vs.length) throw new MissingAnchor("none of the alternatives of " + JSON.stringify(a.max ?? a.min) + " exist in this take");
    return (a.max ? Math.max(...vs) : Math.min(...vs)) + off;
  }
  if (a.event) return E(a.event, a.where, a.nth) + off;
  if (a.cmd) { const v = cmdAnchor[a.cmd]; if (v == null) throw new MissingAnchor(`no ${a.cmd} anchor in this take`); return v + off; }
  if (a.tool) {
    const m = entries.filter((e) => e.accepted && e.argv[0] === "webmcp" && e.argv[1] === "invoke" && e.argv[2] === a.tool);
    const e = a.which === "last" ? m.at(-1) : m[a.nth ?? 0];
    if (!e) throw new MissingAnchor(`agent never invoked ${a.tool}`);
    return (a.edge === "end" ? e.endSrc : e.src) + off;
  }
  if (a.seg !== undefined) { const g = segs?.[a.seg]; if (!g) throw new MissingAnchor(`segment ${a.seg} is not in this cut`); return g[a.edge] + off; }
  throw new Error("bad anchor " + JSON.stringify(a));
};
/** Run fn; a missing event / value drops an optional or conditional item (noted), and fails a required one loudly. */
const attempt = (item, what, fn) => {
  if (item.if !== undefined && ![].concat(item.if).every(evHas)) { skipped.push(`${what} (condition ${JSON.stringify(item.if)} not met)`); return null; }
  if (item.ifNot !== undefined && [].concat(item.ifNot).some(evHas)) { skipped.push(`${what} (excluded by ${JSON.stringify(item.ifNot)})`); return null; }
  try { return fn(); } catch (e) {
    if (e instanceof MissingAnchor || e instanceof MissingValue) {
      if (item.optional) { skipped.push(`${what} (${e.message})`); return null; }
      throw new Error(`required ${what} cannot be built: ${e.message}`);
    }
    throw e;
  }
};
// `each: <event>` (+ where) on a segment/caption/zoom makes one per matching event; atOffset/endOffset are seconds from that event.
const eachHits = (c) => ev.events.filter((e) => e.name === c.each && e.t_ms != null && (!c.where || Object.entries(c.where).every(([k, v]) => findEvent([e], e.name, { [k]: v }))));
const segCfg = (cfg.segments ?? []).flatMap((g, i) => {
  if (!g.each) return [{ g, label: g.id ?? i }];
  const hits = eachHits(g);
  if (!hits.length) skipped.push(`segment ${g.id ?? i} (no ${g.each} events)`);
  return hits.map((h, n) => ({ g: { ...g, optional: true, from: { event: g.each, where: g.where, nth: n, offset: g.atOffset ?? -2 }, to: { event: g.each, where: g.where, nth: n, offset: g.endOffset ?? 3 } }, label: `${g.id ?? i}[${n}]` }));
});
const segRaw = [];
segCfg.forEach(({ g, label }, i) => { segRaw[i] = attempt(g, `segment ${label}`, () => ({ s: at(g.from, segRaw), e: at(g.to, segRaw), cfgIndex: i })); });
const segs = [];
for (const g of segRaw.filter(Boolean).sort((a, b) => a.s - b.s)) { // never overlap or reorder footage; a segment wholly inside the previous one adds nothing
  const prevEnd = segs.at(-1)?.e ?? -Infinity;
  if (g.e <= prevEnd + 0.1) { skipped.push(`segment ${g.cfgIndex} (already inside the previous segment)`); continue; }
  if (g.s < prevEnd) g.s = prevEnd;
  segs.push(g);
}
if (!segs.length) throw new Error("no segments survive: nothing to cut");
for (let i = 1; i < segs.length; i++) if (segs[i].s < segs[i - 1].e) segs[i].s = segs[i - 1].e; // never overlap or reorder footage
for (const g of segs) if (g.e - g.s < 0.1) throw new Error(`segment ${g.cfgIndex} is empty after ordering (${g.s.toFixed(2)}..${g.e.toFixed(2)})`);
// holds: [{event, where?, minSeconds}] -- the footage must keep running at least this long after the event (a readable result frame).
for (const h of [...(cfg.endHold ? [cfg.endHold] : []), ...(cfg.holds ?? [])]) {
  const t = E(h.event, h.where);
  const g = segs.find((x) => t >= x.s - 1e-6 && t <= x.e + 1e-6);
  if (!g) throw new Error(`${h.event} is not inside any kept segment: its result would be cut`);
  const need = h.minSeconds ?? 2.5;
  if (g.e - t < need) throw new Error(`${h.event} hold is ${(g.e - t).toFixed(2)}s, need >= ${need}s`);
}
const TITLE = STAGE ? 0 : cfg.titleSeconds ?? 4;
// ramps: [{id?, from, to, rate}] -- dead time (e.g. waiting for the model) plays faster. Each kept segment is split into pieces at the
// ramp edges; a piece plays at the rate of the ramp covering it (1 elsewhere). Footage is never reordered or dropped by a ramp.
const ramps = (cfg.ramps ?? []).map((r, i) => attempt(r, `ramp ${r.id ?? i}`, () => {
  if (!(r.rate > 1 && r.rate <= 10)) throw new Error(`ramp ${r.id ?? i}: rate must be in (1, 10], got ${r.rate}`);
  return { s: at(r.from, segRaw), e: at(r.to, segRaw), rate: r.rate, id: r.id ?? i };
})).filter(Boolean).sort((a, b) => a.s - b.s);
for (let i = 1; i < ramps.length; i++) if (ramps[i].s < ramps[i - 1].e) throw new Error(`ramps ${ramps[i - 1].id} and ${ramps[i].id} overlap`);
const pieces = segs.flatMap((g) => {
  const cutsAt = [...new Set([g.s, g.e, ...ramps.flatMap((r) => [r.s, r.e]).filter((t) => t > g.s && t < g.e)])].sort((a, b) => a - b);
  return cutsAt.slice(1).map((e, k) => { const s = cutsAt[k]; const r = ramps.find((x) => (s + e) / 2 >= x.s && (s + e) / 2 <= x.e); return { s, e, rate: r?.rate ?? 1 }; }).filter((p) => p.e - p.s > 0.05);
});
let acc = TITLE; for (const p of pieces) { p.c = acc; p.d = (p.e - p.s) / p.rate; acc += p.d; }
for (const g of segs) { g.c = pieces.find((p) => p.s >= g.s - 1e-6).c; g.d = g.e - g.s; }
const TOTAL = +acc.toFixed(2);
const toComp = (src) => { for (const p of pieces) if (src >= p.s - 1e-6 && src <= p.e + 1e-6) return p.c + (src - p.s) / p.rate; return null; };
const toCompOrCut = (src) => { for (const p of pieces) if (src <= p.e) return Math.max(p.c, toComp(src) ?? p.c); return TOTAL; };

// ---- transcript rows (from the audit, verbatim) ----
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const rows = [];
for (const c of kept) {
  rows.push({ src: c.src, ts: c.ts, cmd: c.cmd });
  const out = c.out; // real return time: a blocking `webmcp result` returns when its card is resolved
  if (/--detach/.test(c.cmd) && /: pending$/.test(out[0] ?? "")) rows.push({ src: c.endSrc, out: out[0], kind: "pending" });
  if (c.argv[1] === "result") {
    if (/: completed$/.test(out[0] ?? "")) {
      rows.push({ src: c.endSrc, out: out[0], kind: "done" });
      if (out.length > 1) rows.push({ src: c.endSrc + 0.1, out: out.slice(1).join("\n"), kind: "json" });
    } else if (out[0]) rows.push({ src: c.endSrc, out: out[0], kind: "pending" });
  }
}
const lastResolved = cards.length ? Math.max(...cards.map((c) => c.resolved)) : rows.at(-1)?.src ?? 0;
if (SUMMARY) rows.push({ src: summaryAt ? (Date.parse(summaryAt) - rec0) / 1000 : lastResolved + 1.2, out: "[SUMMARY] " + SUMMARY, kind: "summary" });
rows.sort((a, b) => a.src - b.src);

const rowHtml = rows.map((r, i) => {
  let inner;
  if (r.cmd) inner = `<span class="ts">[${r.ts}]</span> <span class="pr">$</span> <span class="cm">${esc(r.cmd)}</span>`;
  else if (r.kind === "pending") inner = `<span class="pend">${esc(r.out)}</span>`;
  else if (r.kind === "done") inner = `<span class="ok">${esc(r.out)}</span>`;
  else if (r.kind === "json") inner = `<span class="js">${esc(r.out)}</span>`;
  else inner = `<span class="sm">${esc(r.out)}</span>`;
  return `<div class="row" id="row${i}">${inner}</div>`;
}).join("\n");
const rowTimes = rows.map((r) => {
  let c = toComp(r.src);
  const cut = c === null;
  if (cut) c = toCompOrCut(r.src);
  return { c: +c.toFixed(3), cut };
});

// ---- annotations: global config copy + per-card items, then clipped so none overlap ----
// A card whose whole life (shown..resolved) is in cut footage is not annotated: its overlays would describe frames that are not in the cut.
const keptCards = cards.filter((c) => toComp(c.shown) !== null || toComp(c.resolved) !== null);
for (const c of cards) if (!keptCards.includes(c)) skipped.push(`card ${c.index} overlays (card is in cut footage)`);
const pc = cfg.perCard ? perCardItems(cfg.perCard, keptCards, { target: cfg.target, targetTxId: target?.txId ?? null }) : { caps: [], cos: [] };
const mapT = (src) => toCompOrCut(src);
// `each: <event name>` (+ optional `where`) makes one item per matching event; {@this.field} quotes that event, atOffset/endOffset are seconds from it.
const expandEach = (list, what) => list.flatMap((c, i) => {
  if (!c.each) return [{ c, i, what: `${what} ${i}` }];
  const hits = ev.events.filter((e) => e.name === c.each && e.t_ms != null && (!c.where || Object.entries(c.where).every(([k, v]) => String(e[k]) === String(v))));
  if (!hits.length) skipped.push(`${what} ${i} (no ${c.each} events)`);
  return hits.map((h, n) => ({ c: { ...c, at: { event: c.each, where: c.where, nth: n, offset: c.atOffset ?? 0 }, end: { event: c.each, where: c.where, nth: n, offset: c.endOffset ?? 3 }, optional: true }, i, ctx: { this: h }, what: `${what} ${i}[${n}]` }));
});
const capItems = STAGE ? [] : [
  ...expandEach(cfg.captions ?? [], "caption").map(({ c, what, ctx }) => attempt(c, what, () => { if (ctx && toComp(ctx.this.t_ms / 1000) === null) throw new MissingAnchor("its event is in cut footage"); return { start: mapT(at(c.at, segRaw)), end: mapT(at(c.end, segRaw)), t: fillTokens(c.t, ev.events, vars, ctx), optional: !!c.optional }; })).filter(Boolean),
  ...pc.caps.map((c) => ({ start: mapT(c.start), end: mapT(c.end), t: c.t, optional: !!c.optional, card: c.card })),
].filter((c) => c.end > c.start);
const DASH_W = 1304, DASH_H = 815, K = DASH_W / 1200; // config callout x/y are in a 1200x750 design space
const coItems = STAGE ? [] : [
  ...(cfg.callouts ?? []).map((c, i) => attempt(c, `callout ${c.id ?? i}`, () => ({ id: c.id ?? `co${i}`, start: mapT(at(c.at, segRaw)), end: mapT(at(c.end, segRaw)), x: c.x, y: c.y, w: c.w, txt: fill(c.txt), sub: fill(c.sub ?? ""), src: c.src ? fill(c.src) : "" }))).filter(Boolean),
  ...pc.cos.map((c) => ({ ...c, start: mapT(c.start), end: mapT(c.end) })),
].filter((c) => c.end > c.start);
const caps = scheduleOverlays(capItems);
const callouts = scheduleOverlays(coItems, { minDur: 0.4 });
if (!nonOverlapping(caps) || !nonOverlapping(callouts)) throw new Error("overlay scheduling left overlapping lower-thirds");
const cuts = pieces.slice(1).map((g, i) => ({ c: g.c, gap: g.s - pieces[i].e })).filter((c) => c.gap >= 1); // contiguous footage is not a cut

// ---- zoom: honest crop (uniform scale + pan of the same recording), eased ----
const zoomCfg = cfg.zoom ?? {};
// A window lives inside one kept segment: clip its end to that segment's end, drop it if its start is in cut footage.
const clipToSeg = (s, e) => { const g = segs.find((x) => s >= x.s - 1e-6 && s <= x.e + 1e-6); return g ? [s, Math.min(e, g.e)] : null; };
const zoomSpecs = (zoomCfg.windows ?? []).flatMap((z, i) => {
  if (!z.each) return [{ z, what: `zoom ${z.id ?? i}`, wins: [{ from: z.from, to: z.to, rect: z.rect, pad: z.pad, maxScale: z.maxScale }] }];
  const hits = eachHits(z);
  if (!hits.length) skipped.push(`zoom ${z.id ?? i} (no ${z.each} events)`);
  return hits.map((h, n) => ({ z: { ...z, optional: true }, what: `zoom ${z.id ?? i}[${n}]`, ev: h,
    wins: (z.phases ?? [{ from: z.atOffset ?? -2, to: z.endOffset ?? 3, rect: z.rect }]).map((ph) => ({ from: { event: z.each, where: z.where, nth: n, offset: ph.from }, to: { event: z.each, where: z.where, nth: n, offset: ph.to }, rect: ph.rect ?? z.rect, pad: ph.pad ?? z.pad, maxScale: ph.maxScale ?? z.maxScale })) }));
});
const zwins = [
  ...cardZoomWindows(zoomCfg.card, keptCards, viewport).map((w) => ({ ...w, start: mapT(w.start), end: mapT(w.end) })),
  ...zoomSpecs.flatMap(({ z, what, ev: hit, wins }) => attempt(z, what, () => {
    if (hit && toComp(hit.t_ms / 1000) === null) throw new MissingAnchor("its event is in cut footage");
    return wins.map((w) => {
      const rect = normRect(w.rect, viewport); if (!rect) throw new Error(`${what} has no valid rect`);
      const c = clipToSeg(at(w.from, segRaw), at(w.to, segRaw)); if (!c) throw new MissingAnchor("its start is in cut footage");
      return { start: mapT(c[0]), end: mapT(c[1]), rect, pad: w.pad, maxScale: w.maxScale, source: "config" };
    });
  }) ?? []),
].filter((w) => w.end - w.start > 0.8);
// stage: a zoom that runs to the end of the cut stays in (the deck holds the last frame); no ease-out in the final half second.
if (STAGE) for (const w of zwins) if (w.end >= TOTAL - 0.05) w.end = TOTAL + 60;
// stage: the 16:10 recording fills the 1080 px height of a 1920x1080 frame; crops may use the full 16:9 frame.
const SG = { cw: 1920, ch: 1080, vh: 1080, vw: Math.round(1080 * viewport.width / viewport.height), vy: 0 }; SG.vx = (SG.cw - SG.vw) / 2;
const ztw = zoomTweens(zwins, { ease: zoomCfg.ease ?? 0.6, pad: zoomCfg.card?.pad, maxScale: zoomCfg.card?.maxScale,
  ...(STAGE ? { crop: (r, o) => stageCrop(r, o, SG), identity: { s: 1, x: 0, y: 0 } } : {}) });
const zbadges = []; { let on = null; for (const z of ztw) { if (z.s > 1 && on === null) on = z.t; if (z.s === 1 && on !== null) { zbadges.push({ a: on, b: z.t + z.d }); on = null; } } }

const segVideo = pieces.map((g, i) => `      <video id="seg${i}" class="vid" src="${VIDEO}" data-start="${g.c.toFixed(3)}" data-duration="${g.d.toFixed(3)}" data-media-start="${g.s.toFixed(3)}"${g.rate !== 1 ? ` data-playback-rate="${g.rate}"` : ""} data-track-index="1" muted playsinline></video>`).join("\n");
const capHtml = caps.map((c, i) => `<div class="cap" id="cap${i}"${c.card !== undefined ? ` data-card="${c.card}"` : ""}${c.t.length > 190 ? ' style="font-size:30px"' : c.t.length > 150 ? ' style="font-size:34px"' : ""}>${esc(c.t)}</div>`).join("\n");
const coHtml = callouts.map((c) => `<div class="co" id="${c.id}"${c.card !== undefined ? ` data-card="${c.card}"` : ""} style="left:${Math.round(c.x * K)}px;top:${Math.round(c.y * K)}px${c.w ? `;max-width:${c.w}px` : ""}"><div class="cot">${esc(c.txt)}</div>${c.sub ? `<div class="cos">${esc(c.sub)}</div>` : ""}${c.src ? `<div class="cos src">${esc(c.src)}</div>` : ""}</div>`).join("\n");
const cutHtml = cuts.map((c, i) => `<div class="cutbadge" id="cut${i}">CUT – ${Math.round(c.gap)} s of dead time removed</div>`).join("\n");
const zoomHtml = zbadges.map((z, i) => `<div class="cutbadge zoombadge" id="zb${i}">ZOOM – crop of the same recording</div>`).join("\n");

// ---- stage profile: footage only, filling the frame; one small corner tag (take + recording date from the take, never typed in) ----
const takeNo = path.basename(path.resolve(takeDir)).match(/take(\d+)/)?.[1];
if (STAGE && !takeNo) throw new Error(`stage tag: cannot read a take number from ${takeDir}`);
const recordedOn = new Date(rec0).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }).replace(",", "");
const stageTag = fillTokens(cfg.sourceTag ?? "real agent \u00b7 take {take} \u00b7 recorded {recordedOn}", ev.events, { ...vars, take: takeNo ?? "?", recordedOn });
const stageHtml = () => `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=1920, height=1080" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet" />
<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
<style>
:root{--ledger:#e5e7eb;--ink:#9ca3af;--deep:#0a0f1a;--caution:#f59e0b}
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:1920px;height:1080px;overflow:hidden;background:var(--deep)}
#root{position:relative;width:1920px;height:1080px;overflow:hidden;background:var(--deep)}
#zw{position:absolute;left:0;top:0;width:1920px;height:1080px;transform-origin:0 0}
#zw .vid{position:absolute;left:${SG.vx}px;top:${SG.vy}px;width:${SG.vw}px;height:${SG.vh}px;object-fit:fill}
#tag{position:absolute;right:18px;top:16px;z-index:5;font-family:'JetBrains Mono',ui-monospace,Menlo,monospace;font-size:17px;color:var(--ink);background:rgba(10,15,26,.82);border:1px solid rgba(156,163,175,.35);border-radius:6px;padding:5px 11px}
#tag .sp{display:none;color:var(--caution)}
</style>
</head>
<body>
<div id="root" data-composition-id="main" data-start="0" data-duration="${TOTAL}" data-width="1920" data-height="1080">
  <div id="zw" data-track-index="1">
${segVideo}
  </div>
  <div id="tag" class="clip" data-start="0" data-duration="${TOTAL}" data-track-index="2">${esc(stageTag)}${pieces.some((p) => p.rate !== 1) ? [...new Set(pieces.map((p) => p.rate).filter((r) => r !== 1))].map((r) => `<span class="sp" data-rate="${r}"> \u00b7 ${r}\u00d7 speed</span>`).join("") : ""}</div>
</div>
<script>
window.__timelines = window.__timelines || {};
const tl = gsap.timeline({ paused: true });
// speed ramps are labelled while they play
const sp = ${JSON.stringify(pieces.filter((p) => p.rate !== 1).map((p) => ({ r: p.rate, a: +p.c.toFixed(3), b: +(p.c + p.d).toFixed(3) })))};
sp.forEach(p=>{ const el = document.querySelector('#tag .sp[data-rate="'+p.r+'"]'); tl.set(el,{display:"inline"},p.a).set(el,{display:"none"},p.b); });
// zoom: uniform scale + pan of the footage wrapper only (an honest crop); origin top-left, so point p maps to s*p + (x,y)
tl.set("#zw",{transformOrigin:"0 0",scale:1,x:0,y:0},0);
const zt = ${JSON.stringify(ztw.map((z) => ({ t: +z.t.toFixed(3), d: z.d, s: +z.s.toFixed(4), x: +z.x.toFixed(2), y: +z.y.toFixed(2) })))};
let zc = {s:1,x:0,y:0};
zt.forEach(z=>{ tl.fromTo("#zw",{scale:zc.s,x:zc.x,y:zc.y},{scale:z.s,x:z.x,y:z.y,duration:z.d,ease:"power2.inOut",immediateRender:false},z.t); zc = {s:z.s,x:z.x,y:z.y}; });
window.__timelines["main"] = tl;
tl.seek(0);
</script>
</body>
</html>`;
let html = `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=1920, height=1080" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600&family=JetBrains+Mono:wght@400;700&family=Space+Grotesk:wght@600;700&display=swap" rel="stylesheet" />
<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
<style>
:root{--money:#22c55e;--mint:#86efac;--ledger:#e5e7eb;--ink:#9ca3af;--carbon:#374151;--slate:#1f2937;--void:#111827;--deep:#0a0f1a;--dim:#166534;--glow:rgba(34,197,94,.15);--alert:#ef4444;--caution:#f59e0b;--lead:#06b6d4}
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:1920px;height:1080px;overflow:hidden;background:var(--deep)}
#root{position:relative;width:1920px;height:1080px;overflow:hidden;background:var(--deep);font-family:Inter,system-ui,sans-serif;color:var(--ledger)}
.mono{font-family:'JetBrains Mono',ui-monospace,Menlo,monospace}
#hdr{position:absolute;left:32px;top:0;width:1856px;height:56px;display:flex;align-items:center;justify-content:space-between}
#hdr .brand{font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:28px;color:var(--ledger)}
#hdr .brand b{color:var(--money)}
#hdr .tag{font-family:'JetBrains Mono',monospace;font-size:17px;color:var(--ink)}
#hdr .tag em{font-style:normal;color:var(--money)}
#dash{position:absolute;left:32px;top:64px;box-sizing:content-box;width:${DASH_W}px;height:${DASH_H}px;border:2px solid var(--carbon);border-radius:10px;overflow:hidden;background:var(--void)}
#zw{position:absolute;left:0;top:0;width:${DASH_W}px;height:${DASH_H}px;transform-origin:0 0}
#dash .vid{position:absolute;left:0;top:0;width:${DASH_W}px;height:${DASH_H}px;object-fit:fill}
#dlabel,#tlabel{position:absolute;top:890px;font-family:'JetBrains Mono',monospace;font-size:15px;color:var(--ink)}
#dlabel{left:36px}#tlabel{left:1360px}
#term{position:absolute;left:1356px;top:64px;width:532px;height:${DASH_H + 4}px;border:2px solid var(--carbon);border-radius:10px;background:var(--void);overflow:hidden}
#tbar{height:44px;background:var(--slate);border-bottom:2px solid var(--carbon);display:flex;align-items:center;padding:0 16px;gap:8px;font-family:'JetBrains Mono',monospace;font-size:14px;color:var(--mint)}
#tbar i{width:11px;height:11px;border-radius:50%;background:var(--carbon);display:inline-block}
#tbar span{margin-left:8px}
#tbody{position:absolute;left:0;right:0;top:44px;bottom:0;padding:12px 16px;display:flex;flex-direction:column;justify-content:flex-end;overflow:hidden;font-family:'JetBrains Mono',monospace;font-size:14px;line-height:20px}
.row{display:none;word-break:break-all;white-space:pre-wrap;margin-top:7px}
.ts{color:var(--ink)}.pr{color:var(--money);font-weight:700}.cm{color:var(--ledger)}.pend{color:var(--caution)}.ok{color:var(--money)}.js{color:var(--lead)}.sm{color:var(--mint)}
.editnote{display:none;margin-top:7px;font-size:13px;color:var(--caution);border-top:1px dashed var(--carbon);border-bottom:1px dashed var(--carbon);padding:4px 0}
#caps{position:absolute;left:32px;top:916px;width:1856px;height:132px;background:var(--slate);border:2px solid var(--carbon);border-left:6px solid var(--money);border-radius:10px}
.cap{position:absolute;left:32px;right:32px;top:0;bottom:0;display:flex;align-items:center;font-family:'Space Grotesk',sans-serif;font-weight:600;font-size:38px;line-height:1.22;color:var(--ledger);opacity:0}
.co{position:absolute;z-index:5;opacity:0;max-width:600px;background:rgba(10,15,26,.94);border:2px solid var(--money);border-radius:8px;padding:14px 18px;box-shadow:0 0 0 6px var(--glow)}
.co .cot{font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:27px;color:var(--money);line-height:1.2}
.co .cos{font-family:'JetBrains Mono',monospace;font-size:14px;color:var(--ink);margin-top:6px}
.co .src{color:var(--lead);font-size:13px;margin-top:8px;padding-top:6px;border-top:1px dashed var(--carbon)}
#calayer{position:absolute;left:34px;top:66px;width:${DASH_W}px;height:${DASH_H}px;overflow:hidden;pointer-events:none}
.cutbadge{position:absolute;left:36px;top:36px;z-index:6;opacity:0;font-family:'JetBrains Mono',monospace;font-size:16px;color:var(--caution);background:rgba(10,15,26,.92);border:1px solid var(--caution);border-radius:4px;padding:6px 10px}
.zoombadge{top:12px;left:auto;right:12px;color:var(--lead);border-color:var(--lead)}
#title{position:absolute;inset:0;z-index:20;background:var(--deep);display:flex;flex-direction:column;justify-content:center;padding-left:160px}
#title .k{font-family:'JetBrains Mono',monospace;font-size:24px;color:var(--ink);margin-bottom:26px}
#title .k b{color:var(--money)}
#title h1{font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:112px;letter-spacing:-.02em;color:var(--ledger)}
#title h1 span{color:var(--money)}
#title .s{font-family:Inter,sans-serif;font-size:30px;color:var(--ink);margin-top:28px;max-width:1500px}
#title .rule{width:120px;height:4px;background:var(--money);margin-top:34px}
</style>
</head>
<body>
<div id="root" data-composition-id="main" data-start="0" data-duration="${TOTAL}" data-width="1920" data-height="1080">
  <div id="title" class="clip" data-start="0" data-duration="${TITLE}" data-track-index="9">
    <div class="k"><b>$</b> ${esc(cfg.kicker)}</div>
    <h1 id="h1">${esc(cfg.titleLead)} <span>${esc(cfg.titleAccent)}</span></h1>
    <div class="rule" id="rule"></div>
    <div class="s" id="sub">${esc(cfg.subtitle)}</div>
  </div>
  <div id="hdr" class="clip" data-start="${TITLE - 0.4}" data-duration="${(TOTAL - TITLE + 0.4).toFixed(3)}" data-track-index="2">
    <div class="brand"><b>$</b> Open Accountant &nbsp;<span style="color:var(--ink);font-weight:600">${esc(cfg.headerTitle)}</span></div>
    <div class="tag">real footage &middot; <em>annotations only</em> &middot; cuts and zooms marked</div>
  </div>
  <div id="dash" data-track-index="1">
    <div id="zw">
${segVideo}
    </div>
  </div>
  <div id="calayer" class="clip" data-start="${TITLE}" data-duration="${(TOTAL - TITLE).toFixed(3)}" data-track-index="3">
${coHtml}
${cutHtml}
${zoomHtml}
  </div>
  <div id="dlabel" class="clip" data-start="${TITLE - 0.4}" data-duration="${(TOTAL - TITLE + 0.4).toFixed(3)}" data-track-index="2">Dashboard &middot; screen recording</div>
  <div id="tlabel" class="clip" data-start="${TITLE - 0.4}" data-duration="${(TOTAL - TITLE + 0.4).toFixed(3)}" data-track-index="2">Agent transcript, verbatim (ab-audit.jsonl)</div>
  <div id="term" data-layout-allow-overflow data-layout-allow-occlusion class="clip" data-start="${TITLE - 0.4}" data-duration="${(TOTAL - TITLE + 0.4).toFixed(3)}" data-track-index="2">
    <div id="tbar"><i></i><i></i><i></i><span>${esc(cfg.terminalTitle)}</span></div>
    <div id="tbody" data-layout-allow-overflow data-layout-allow-occlusion>
<div class="editnote" id="editnote">[clip edit: log lines from the cut section, original timestamps kept]</div>
${rowHtml}
    </div>
  </div>
  <div id="caps" class="clip" data-start="${TITLE - 0.4}" data-duration="${(TOTAL - TITLE + 0.4).toFixed(3)}" data-track-index="4">
${capHtml}
  </div>
</div>
<script>
window.__timelines = window.__timelines || {};
const tl = gsap.timeline({ paused: true });
// title
tl.from("#h1",{y:30,opacity:0,duration:.7,ease:"power3.out"},.3).from("#rule",{scaleX:0,transformOrigin:"left",duration:.6,ease:"power2.out"},.8).from("#sub",{opacity:0,duration:.6},1.1);
tl.to("#title",{opacity:0,duration:.4,ease:"power1.in"},${TITLE - 0.4});
// transcript rows
const rowT = ${JSON.stringify(rowTimes)};
rowT.forEach((r,i)=>{ tl.set("#row"+i,{display:"block"},r.c); });
const firstCut = rowT.findIndex(r=>r.cut);
if (firstCut>=0) tl.set("#editnote",{display:"block"},rowT[firstCut].c - 0.001);
// captions
const caps = ${JSON.stringify(caps.map((c) => ({ a: c.start, b: c.end })))};
caps.forEach((c,i)=>{ tl.to("#cap"+i,{opacity:1,duration:.2},c.a).to("#cap"+i,{opacity:0,duration:.15},c.b-.15); });
// callouts
const cos = ${JSON.stringify(callouts.map((c) => ({ id: c.id, a: c.start, b: c.end })))};
cos.forEach(c=>{ tl.fromTo("#"+c.id,{opacity:0,y:14},{opacity:1,y:0,duration:.35,ease:"power2.out"},c.a).to("#"+c.id,{opacity:0,duration:.25},c.b-.25); });
// cut badges
const cutT = ${JSON.stringify(cuts.map((c) => c.c))};
cutT.forEach((t,i)=>{ tl.to("#cut"+i,{opacity:1,duration:.15},t).to("#cut"+i,{opacity:0,duration:.3},t+1.6); });
// zoom: uniform scale + pan of the footage wrapper only (an honest crop); origin top-left, so point p maps to s*p + (x,y)
tl.set("#zw",{transformOrigin:"0 0",scale:1,x:0,y:0},0);
const zt = ${JSON.stringify(ztw.map((z) => ({ t: +z.t.toFixed(3), d: z.d, s: +z.s.toFixed(4), x: +(-z.ox * z.s * DASH_W).toFixed(2), y: +(-z.oy * z.s * DASH_H).toFixed(2) })))};
let zc = {s:1,x:0,y:0};
zt.forEach(z=>{ tl.fromTo("#zw",{scale:zc.s,x:zc.x,y:zc.y},{scale:z.s,x:z.x,y:z.y,duration:z.d,ease:"power2.inOut",immediateRender:false},z.t); zc = {s:z.s,x:z.x,y:z.y}; });
const zb = ${JSON.stringify(zbadges.map((z) => ({ a: +z.a.toFixed(3), b: +z.b.toFixed(3) })))};
zb.forEach((z,i)=>{ tl.to("#zb"+i,{opacity:1,duration:.2},z.a).to("#zb"+i,{opacity:0,duration:.2},z.b-.2); });
window.__timelines["main"] = tl;
tl.seek(0);
</script>
</body>
</html>`;
if (STAGE) {
  html = stageHtml();
  // poster: the most representative frame, anchored like everything else; stage.sh grabs it from the render.
  const posterSrc = cfg.poster ? at(cfg.poster, segRaw) : null;
  const poster = posterSrc == null ? null : toComp(posterSrc);
  if (cfg.poster && poster == null) throw new Error(`poster anchor ${JSON.stringify(cfg.poster)} (source ${posterSrc.toFixed(2)}s) is in cut footage`);
  fs.writeFileSync(path.join(OUT, "stage.json"), JSON.stringify({ total: TOTAL, poster, posterSrc, tag: stageTag, endHoldSeconds: cfg.endHoldSeconds ?? 2,
    pieces: pieces.map((p) => ({ s: +p.s.toFixed(3), e: +p.e.toFixed(3), rate: p.rate, c: +p.c.toFixed(3) })) }, null, 2));
}
fs.writeFileSync(path.join(OUT, "index.html"), html);
console.error("out", OUT);
console.error("segs", segs.map((g) => [g.s.toFixed(1), g.e.toFixed(1), g.c.toFixed(1)]), "TOTAL", TOTAL);
if (ramps.length) console.error("pieces", pieces.map((p) => `${p.s.toFixed(1)}-${p.e.toFixed(1)}@${p.rate}x->${p.c.toFixed(1)}`).join(" "));
console.error("rows", rows.length, "cards", cards.map((c) => `${c.index}:${c.kind}:${c.decision}:#${c.txId}`).join(" "), "captions", caps.length, "callouts", callouts.length, "zooms", zwins.map((w) => `${w.source}@${w.start.toFixed(1)}-${w.end.toFixed(1)}`).join(","));
if (!STAGE) { // diagnostics: footage kept with no caption for more than half a second (an empty caption bar)
  const sorted = [...caps].sort((x, y) => x.start - y.start); const gaps = []; let cur = TITLE;
  for (const c of sorted) { if (c.start - cur > 0.5) gaps.push([cur, c.start]); cur = Math.max(cur, c.end); }
  if (TOTAL - cur > 0.5) gaps.push([cur, TOTAL]);
  if (gaps.length) console.error("WARNING empty caption bar (comp s): " + gaps.map(([a, z]) => `${a.toFixed(1)}-${z.toFixed(1)}`).join(", "));
}
if (footageNotes.length) console.error("footage anchors:\n  " + footageNotes.join("\n  "));
if (cardStartNotes.length) console.error("cardStart " + cardStart + ":\n  " + cardStartNotes.join("\n  "));
if (skipped.length) console.error("skipped optional items:\n  - " + skipped.join("\n  - "));
