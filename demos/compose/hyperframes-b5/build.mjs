// Generates index.html from the REAL event log + actor transcript. Run: node build.mjs
import fs from "node:fs";
const ev = JSON.parse(fs.readFileSync("assets/events.json", "utf8"));
const log = fs.readFileSync("assets/actor.log", "utf8").split("\n");
const E = (n) => ev.events.find((e) => e.name === n).t_ms / 1000;
const rec0 = Date.parse(ev.recordingStartedAt);
const logT = (hms) => (Date.parse("2026-10-04T" + hms + "Z") - rec0) / 1000; // 1s resolution

// ---- data-driven cut list (source seconds), anchored to event-log keyframes ----
const T = {
  ledgerBefore: E("ledger-before"), grants: E("grants-applied"), cardShown: E("card-shown"),
  press: E("approve-pressed"), held: E("approve-held"), released: E("approve-released"),
  resolved: E("card-resolved"), ledgerAfter: E("ledger-after"),
};
const segs = [
  { s: T.ledgerBefore - 2, e: T.grants + 5 },        // before row + grants panel
  { s: logT("15:46:49") - 1, e: T.resolved + 3 },    // last search -> proposal -> card -> approve -> done
  { s: T.ledgerAfter - 1.2, e: T.ledgerAfter + 3.5 },  // row now reads Shopping
];
const TITLE = 4;
let acc = TITLE; for (const g of segs) { g.c = acc; g.d = g.e - g.s; acc += g.d; }
const TOTAL = +acc.toFixed(2);
const toComp = (src) => { for (const g of segs) if (src >= g.s - 1e-6 && src <= g.e + 1e-6) return g.c + (src - g.s); return null; };
const toCompOrCut = (src) => { // source time in a cut -> the start of the segment that follows
  for (const g of segs) if (src <= g.e) return Math.max(g.c, toComp(src) ?? g.c); return TOTAL; };

// ---- transcript rows (verbatim) ----
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const rows = []; // {src, html, cls}
const cmdRe = /^\[(\d\d:\d\d:\d\d)\] \$ (.*)$/;
const keep = (cmd) => /webmcp (list|invoke|result)/.test(cmd);
let idCmd = null;
for (let i = 0; i < log.length; i++) {
  const m = log[i].match(cmdRe);
  if (m && keep(m[2])) {
    // skip the first "webmcp list --json" (bare, failed to run) - shown verbatim only if it is the agent's own command
    rows.push({ src: logT(m[1]), ts: m[1], cmd: m[2] });
    if (/--detach/.test(m[2])) {
      const nxt = log[i + 1]; // "<id>: pending"
      if (/: pending$/.test(nxt)) rows.push({ src: logT(m[1]), out: nxt, kind: "pending" });
    }
    if (/webmcp result /.test(m[2])) {
      // output printed only when the operation resolved (card-resolved)
      const o = [log[i + 1]];
      const j = log.findIndex((l, k) => k > i && l.startsWith("{"));
      const blk = []; for (let k = j; k < log.length && !log[k].startsWith("[SUMMARY]"); k++) blk.push(log[k]);
      rows.push({ src: T.resolved, out: o[0], kind: "done" });
      rows.push({ src: T.resolved + 0.1, out: blk.join("\n"), kind: "json" });
    }
  }
}
const summary = log.find((l) => l.startsWith("[SUMMARY]"));
rows.push({ src: T.resolved + 1.2, out: summary, kind: "summary" });

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

// ---- annotations, anchored to events ----
const callouts = [
  { id: "co1", at: T.grants - 0.4, end: T.grants + 4.6, x: 400, y: 300, txt: "Agent sees only the 3 tools you granted", sub: "categorize_transaction · transaction_search · spending_summary" },
  { id: "co2", at: T.cardShown + 0.2, end: T.press - 0.1, x: 80, y: 520, txt: "Exact row + before/after, computed by the server", sub: "#279 · Uncategorized \u2192 Shopping" },
  { id: "co3", at: T.press, end: T.resolved + 1.6, x: 80, y: 520, txt: "Nothing changes until you hold Approve", sub: "Hold to approve / Reject" },
];
const caps = [
  { at: T.ledgerBefore - 2, end: T.grants - 0.4, t: "Real recording. The row SQ *KILN & CO STUDIO, -$240.00 is still Uncategorized." },
  { at: T.grants - 0.4, end: segs[0].e, t: "Access grants applied in the dashboard: categorize_transaction, transaction_search, spending_summary." },
  { at: segs[1].s, end: logT("15:46:54"), t: "After several read-only searches, the agent looks up \u201cstudio\u201d." },
  { at: logT("15:46:54"), end: T.cardShown, t: "The agent proposes categorize_transaction { id: 279, category: \u201cShopping\u201d }. It chose Shopping itself." },
  { at: T.cardShown, end: T.press, t: "A confirmation card appears in the dashboard. Nothing has changed yet." },
  { at: T.press, end: T.released, t: "The human presses and holds Approve." },
  { at: T.released, end: segs[1].e, t: "\u201cDone. The change was applied.\u201d" },
  { at: segs[2].s, end: segs[2].e, t: "Ledger afterwards: SQ *KILN & CO STUDIO is now Shopping." },
];
const cuts = segs.slice(1).map((g, i) => ({ c: g.c, gap: g.s - segs[i].e }));

const segVideo = segs.map((g, i) => `      <video id="seg${i}" class="vid" src="assets/b5-take1.mp4" data-start="${g.c.toFixed(3)}" data-duration="${g.d.toFixed(3)}" data-media-start="${g.s.toFixed(3)}" data-track-index="1" muted playsinline></video>`).join("\n");
const capHtml = caps.map((c, i) => `<div class="cap" id="cap${i}">${esc(c.t)}</div>`).join("\n");
const coHtml = callouts.map((c) => `<div class="co" id="${c.id}" style="left:${c.x}px;top:${c.y}px"><div class="cot">${esc(c.txt)}</div><div class="cos">${esc(c.sub)}</div></div>`).join("\n");
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
    <div class="k"><b>$</b> OPEN ACCOUNTANT &nbsp;/&nbsp; BEAT 5</div>
    <h1 id="h1">It proposes. <span>You decide.</span></h1>
    <div class="rule" id="rule"></div>
    <div class="s" id="sub">A real recording: an AI agent over WebMCP, a confirmation card, a human who holds Approve.</div>
  </div>
  <div id="hdr" class="clip" data-start="${TITLE - 0.4}" data-duration="${(TOTAL - TITLE + 0.4).toFixed(3)}" data-track-index="2">
    <div class="brand"><b>$</b> Open Accountant &nbsp;<span style="color:var(--ink);font-weight:600">It proposes. You decide.</span></div>
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
  <div id="tlabel" class="clip" data-start="${TITLE - 0.4}" data-duration="${(TOTAL - TITLE + 0.4).toFixed(3)}" data-track-index="2">Actor transcript, verbatim (actor.log)</div>
  <div id="term" data-layout-allow-overflow data-layout-allow-occlusion class="clip" data-start="${TITLE - 0.4}" data-duration="${(TOTAL - TITLE + 0.4).toFixed(3)}" data-track-index="2">
    <div id="tbar"><i></i><i></i><i></i><span>Agent (Claude, cloud) \u2014 via WebMCP</span></div>
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
const caps = ${JSON.stringify(caps.map((c) => ({ a: toComp(c.at), b: toComp(c.end) })))};
caps.forEach((c,i)=>{ tl.to("#cap"+i,{opacity:1,duration:.2},c.a).to("#cap"+i,{opacity:0,duration:.15},c.b-.15); });
// callouts
const cos = ${JSON.stringify(callouts.map((c) => ({ id: c.id, a: toComp(c.at), b: toComp(c.end) })))};
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
console.error("rows", rows.length, JSON.stringify(rowTimes));
