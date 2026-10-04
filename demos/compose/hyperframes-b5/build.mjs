// Generates index.html from a take's REAL event log + audited agent commands + video, and a per-beat config.
//   node build.mjs --take /private/tmp/claude-501/wilson-demos/<beat>/take<N> [--config ../beats/<beat>.json]
// Timing is derived from events.json (host clock) and ab-audit.jsonl (the wrapper's record of every command and output,
// the source of truth for the terminal pane); copy and callouts come from the config.
//  - The terminal is rendered from ab-audit.jsonl, never parsed from actor.log, so model- or page-controlled text cannot
//    forge a command or SUMMARY row. The stream (actor.jsonl) is re-checked 1:1 against the audit: any other command, a
//    refused attempt, or a mismatch refuses the take.
//  - Every card annotation is generated from THAT card's own events (op id + transaction id + category) and bound to the
//    agent proposal that produced it (plan.mjs); a card that cannot be bound, or that was never resolved, refuses the take.
//  - Captions and callouts are clipped so none overlaps another.
import fs from "node:fs";
import path from "node:path";
import { parseJsonl, summaryFromStream } from "../../rig/lib/actor-log.mjs";
import { parseAudit, checkStreamAgainstAudit, auditProblems, transcriptFromAudit } from "../../rig/lib/ab-audit.mjs";
import { joinCards, bindProposals, perCardItems, scheduleOverlays, nonOverlapping } from "./plan.mjs";
const arg = (k) => { const i = process.argv.indexOf("--" + k); return i > 0 ? process.argv[i + 1] : undefined; };
const takeDir = arg("take");
if (!takeDir) { console.error("usage: node build.mjs --take <take dir> [--config <beat json>]"); process.exit(2); }
const ev = JSON.parse(fs.readFileSync(path.join(takeDir, "events.json"), "utf8"));
const cfgPath = arg("config") ?? path.join(path.dirname(new URL(import.meta.url).pathname), "..", "beats", ev.beat + ".json");
const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
const meta = JSON.parse(fs.readFileSync(path.join(takeDir, "actor-meta.json"), "utf8"));
const stream = parseJsonl(fs.readFileSync(path.join(takeDir, "actor.jsonl"), "utf8"));
const audit = parseAudit(fs.readFileSync(path.join(takeDir, "ab-audit.jsonl"), "utf8"));
const violations = [...checkStreamAgainstAudit(stream, audit, meta.wrapper), ...auditProblems(audit)];
if (violations.length) throw new Error("take refused: actor commands are not clean: " + violations.map((v) => JSON.stringify(String(v.command).slice(0, 160)) + " (" + v.reason + ")").join("; "));
const rec0 = Date.parse(ev.recordingStartedAt);
const entries = transcriptFromAudit(audit).map((e) => ({ ...e, src: (e.date.getTime() - rec0) / 1000, endSrc: (e.endDate.getTime() - rec0) / 1000 }));
const { summary: SUMMARY, at: summaryAt } = summaryFromStream(stream);
fs.mkdirSync("assets", { recursive: true });
fs.copyFileSync(path.join(takeDir, "video.mp4"), "assets/take.mp4");
const VIDEO = "assets/take.mp4";

// ---- cards: join per card, bind to proposals ----
const cards = bindProposals(joinCards(ev.events), entries);
const changeCards = cards.filter((c) => c.kind === "change");
const target = changeCards.find((c) => c.target);
if (!target) throw new Error("no decided target card in events.json");
const evT = (n) => { const e = ev.events.find((x) => x.name === n && x.t_ms != null); if (!e) throw new Error(`event ${n} missing from ${takeDir}/events.json`); return e.t_ms / 1000; };
const special = {
  "last-card-resolved": () => Math.max(...cards.map((c) => c.resolved)),
  "first-proposal": () => Math.min(...changeCards.map((c) => c.proposal.src)),
};
const E = (n) => (special[n] ? special[n]() : evT(n));
const lastResolved = E("last-card-resolved");
const lateShown = cards.filter((c) => c.shown > evT("ledger-after"));
if (lateShown.length) throw new Error("a card appears after the ledger is shown: the end frame would not be clean");
const kept = entries.filter((e) => e.accepted && e.argv[0] === "webmcp" && ["list", "invoke", "result"].includes(e.argv[1]));
const proposals = changeCards.map((c) => c.proposal.src).sort((a, b) => a - b);
const beforeFirst = kept.filter((c) => c.src < proposals[0]);
const cmdAnchor = { firstProposal: proposals[0], lastBeforeFirstProposal: (beforeFirst.at(-1) ?? { src: proposals[0] }).src };

const grantEv = ev.events.find((e) => e.name === "grants-applied");
const afterEv = ev.events.find((e) => e.name === "ledger-after");
const decisions = changeCards.map((c) => c.decision);
const nA = decisions.filter((d) => d === "approve").length; const nR = decisions.filter((d) => d === "reject").length;
const ledgerLine = `${nA} approved, ${nR} rejected. ${cfg.target} ` + (target.decision === "approve" ? `is now ${target.after}.` : "is unchanged.");
const vars = { target: cfg.target, tools: (grantEv?.tools ?? []).join(" \u00b7 "), ledgerLine, category: target.after, id: target.txId };
const fill = (s) => s.replace(/\{(\w+)\}/g, (_, k) => (k in vars ? String(vars[k]) : `{${k}}`));

// ---- anchors -> source seconds ----
const at = (a, segs) => {
  if (a.event) return E(a.event) + (a.offset ?? 0);
  if (a.cmd) return cmdAnchor[a.cmd] + (a.offset ?? 0);
  if (a.seg !== undefined) return segs[a.seg][a.edge] + (a.offset ?? 0);
  throw new Error("bad anchor " + JSON.stringify(a));
};
const segs = cfg.segments.map((g) => ({ s: at(g.from), e: at(g.to) }));
for (let i = 1; i < segs.length; i++) if (segs[i].s < segs[i - 1].e) segs[i].s = segs[i - 1].e; // never overlap or reorder footage
const holdS = segs[segs.length - 1].e - E("ledger-after");
if (holdS < (cfg.minLedgerHoldSeconds ?? 2.5)) throw new Error(`ledger-after hold is ${holdS.toFixed(2)}s, need >= ${cfg.minLedgerHoldSeconds ?? 2.5}s`);
const TITLE = cfg.titleSeconds ?? 4;
let acc = TITLE; for (const g of segs) { g.c = acc; g.d = g.e - g.s; acc += g.d; }
const TOTAL = +acc.toFixed(2);
const toComp = (src) => { for (const g of segs) if (src >= g.s - 1e-6 && src <= g.e + 1e-6) return g.c + (src - g.s); return null; };
const toCompOrCut = (src) => { for (const g of segs) if (src <= g.e) return Math.max(g.c, toComp(src) ?? g.c); return TOTAL; };

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
const targetTxId = ev.events.find((e) => e.name === 'ledger-before')?.txId ?? null;
const pc = perCardItems(cfg.perCard, cards, { target: cfg.target, targetTxId });
const mapT = (src) => toCompOrCut(src);
const capItems = [
  ...cfg.captions.map((c) => ({ start: mapT(at(c.at, segs)), end: mapT(at(c.end, segs)), t: fill(c.t), optional: !!c.optional })),
  ...pc.caps.map((c) => ({ start: mapT(c.start), end: mapT(c.end), t: c.t, optional: !!c.optional, card: c.card })),
].filter((c) => c.end > c.start);
const coItems = [
  ...cfg.callouts.map((c) => ({ id: c.id, start: mapT(at(c.at, segs)), end: mapT(at(c.end, segs)), x: c.x, y: c.y, txt: fill(c.txt), sub: fill(c.sub) })),
  ...pc.cos.map((c) => ({ ...c, start: mapT(c.start), end: mapT(c.end) })),
].filter((c) => c.end > c.start);
const caps = scheduleOverlays(capItems);
const callouts = scheduleOverlays(coItems, { minDur: 0.4 });
if (!nonOverlapping(caps) || !nonOverlapping(callouts)) throw new Error("overlay scheduling left overlapping lower-thirds");
const cuts = segs.slice(1).map((g, i) => ({ c: g.c, gap: g.s - segs[i].e })).filter((c) => c.gap >= 1); // contiguous footage is not a cut

const segVideo = segs.map((g, i) => `      <video id="seg${i}" class="vid" src="${VIDEO}" data-start="${g.c.toFixed(3)}" data-duration="${g.d.toFixed(3)}" data-media-start="${g.s.toFixed(3)}" data-track-index="1" muted playsinline></video>`).join("\n");
const capHtml = caps.map((c, i) => `<div class="cap" id="cap${i}"${c.card !== undefined ? ` data-card="${c.card}"` : ""}>${esc(c.t)}</div>`).join("\n");
const coHtml = callouts.map((c) => `<div class="co" id="${c.id}"${c.card !== undefined ? ` data-card="${c.card}"` : ""} style="left:${c.x}px;top:${c.y}px"><div class="cot">${esc(c.txt)}</div><div class="cos">${esc(c.sub)}</div></div>`).join("\n");
const cutHtml = cuts.map((c, i) => `<div class="cutbadge" id="cut${i}">CUT \u2013 ${Math.round(c.gap)} s of dead time removed</div>`).join("\n");

const html = `<!doctype html>
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
#hdr{position:absolute;left:32px;top:0;width:1856px;height:84px;display:flex;align-items:center;justify-content:space-between}
#hdr .brand{font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:30px;color:var(--ledger)}
#hdr .brand b{color:var(--money)}
#hdr .tag{font-family:'JetBrains Mono',monospace;font-size:18px;color:var(--ink)}
#hdr .tag em{font-style:normal;color:var(--money)}
#dash{position:absolute;left:32px;top:96px;width:1200px;height:750px;border:2px solid var(--carbon);border-radius:10px;overflow:hidden;background:var(--void)}
#dash .vid{position:absolute;left:0;top:0;width:1200px;height:750px;object-fit:fill}
#dlabel,#tlabel{position:absolute;top:852px;font-family:'JetBrains Mono',monospace;font-size:15px;color:var(--ink)}
#dlabel{left:36px}#tlabel{left:1268px}
#term{position:absolute;left:1264px;top:96px;width:624px;height:750px;border:2px solid var(--carbon);border-radius:10px;background:var(--void);overflow:hidden}
#tbar{height:44px;background:var(--slate);border-bottom:2px solid var(--carbon);display:flex;align-items:center;padding:0 16px;gap:8px;font-family:'JetBrains Mono',monospace;font-size:15px;color:var(--mint)}
#tbar i{width:11px;height:11px;border-radius:50%;background:var(--carbon);display:inline-block}
#tbar span{margin-left:8px}
#tbody{position:absolute;left:0;right:0;top:44px;bottom:0;padding:12px 16px;display:flex;flex-direction:column;justify-content:flex-end;overflow:hidden;font-family:'JetBrains Mono',monospace;font-size:14.5px;line-height:21px}
.row{display:none;word-break:break-all;white-space:pre-wrap;margin-top:7px}
.ts{color:var(--ink)}.pr{color:var(--money);font-weight:700}.cm{color:var(--ledger)}.pend{color:var(--caution)}.ok{color:var(--money)}.js{color:var(--lead)}.sm{color:var(--mint)}
.editnote{display:none;margin-top:7px;font-size:13px;color:var(--caution);border-top:1px dashed var(--carbon);border-bottom:1px dashed var(--carbon);padding:4px 0}
#caps{position:absolute;left:32px;top:884px;width:1856px;height:164px;background:var(--slate);border:2px solid var(--carbon);border-left:6px solid var(--money);border-radius:10px}
.cap{position:absolute;left:32px;right:32px;top:0;bottom:0;display:flex;align-items:center;font-family:'Space Grotesk',sans-serif;font-weight:600;font-size:40px;line-height:1.25;color:var(--ledger);opacity:0}
.co{position:absolute;z-index:5;opacity:0;max-width:560px;background:rgba(10,15,26,.94);border:2px solid var(--money);border-radius:8px;padding:14px 18px;box-shadow:0 0 0 6px var(--glow)}
.co .cot{font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:27px;color:var(--money);line-height:1.2}
.co .cos{font-family:'JetBrains Mono',monospace;font-size:14px;color:var(--ink);margin-top:6px}
#calayer{position:absolute;left:32px;top:96px;width:1200px;height:750px;overflow:hidden;pointer-events:none}
.cutbadge{position:absolute;left:36px;top:36px;z-index:6;opacity:0;font-family:'JetBrains Mono',monospace;font-size:16px;color:var(--caution);background:rgba(10,15,26,.92);border:1px solid var(--caution);border-radius:4px;padding:6px 10px}
#title{position:absolute;inset:0;z-index:20;background:var(--deep);display:flex;flex-direction:column;justify-content:center;padding-left:160px}
#title .k{font-family:'JetBrains Mono',monospace;font-size:24px;color:var(--ink);margin-bottom:26px}
#title .k b{color:var(--money)}
#title h1{font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:112px;letter-spacing:-.02em;color:var(--ledger)}
#title h1 span{color:var(--money)}
#title .s{font-family:Inter,sans-serif;font-size:30px;color:var(--ink);margin-top:28px}
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
    <div class="tag">real footage &middot; <em>annotations only</em> &middot; cuts marked</div>
  </div>
  <div id="dash" data-track-index="1">
${segVideo}
  </div>
  <div id="calayer" class="clip" data-start="${TITLE}" data-duration="${(TOTAL - TITLE).toFixed(3)}" data-track-index="3">
${coHtml}
${cutHtml}
  </div>
  <div id="dlabel" class="clip" data-start="${TITLE - 0.4}" data-duration="${(TOTAL - TITLE + 0.4).toFixed(3)}" data-track-index="2">Dashboard &middot; screen recording</div>
  <div id="tlabel" class="clip" data-start="${TITLE - 0.4}" data-duration="${(TOTAL - TITLE + 0.4).toFixed(3)}" data-track-index="2">Actor transcript, verbatim (ab-audit.jsonl)</div>
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
window.__timelines["main"] = tl;
tl.seek(0);
</script>
</body>
</html>`;
fs.writeFileSync("index.html", html);
console.error("segs", segs.map((g) => [g.s.toFixed(1), g.e.toFixed(1), g.c.toFixed(1)]), "TOTAL", TOTAL);
console.error("rows", rows.length, "cards", cards.map((c) => `${c.index}:${c.kind}:${c.decision}:#${c.txId}`).join(" "), "captions", caps.length, "callouts", callouts.length);
