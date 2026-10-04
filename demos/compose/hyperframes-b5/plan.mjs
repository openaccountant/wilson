// Pure planning for the cut: join the host's card events per card, bind every card to the agent proposal it shows,
// expand per-card callouts/captions from that card's OWN data, and schedule overlays so none overlap. No I/O.
// Tested in src/__tests__/demo-cut-plan.test.ts.

/** Group the host's events by card index. Throws if any card was shown and never resolved (no pending card may reach the cut). */
export function joinCards(events) {
  const by = new Map();
  const get = (i) => { if (!by.has(i)) by.set(i, { index: i }); return by.get(i); };
  for (const e of events) {
    if (e.t_ms == null || e.index === undefined) continue;
    const c = get(e.index); const t = e.t_ms / 1000;
    switch (e.name) {
      case 'card-shown': Object.assign(c, { opId: e.opId ?? null, txId: e.txId ?? null, tool: e.tool, kind: e.change ? 'change' : 'read', shown: t, text: e.text ?? '' }); break;
      case 'card-checked': {
        c.target = !!e.target; c.problems = e.problems ?? [];
        const cat = (e.rows ?? []).find((r) => /^categor/i.test(r?.[0] ?? ''));
        if (cat) { c.before = cat[1]; c.after = cat[2]; }
        break;
      }
      case 'reject-clicked': c.rejectClicked = t; c.reason = e.reason; break;
      case 'approve-pressed': c.pressed = t; break;
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
 * Bind each CHANGE card to the audited `webmcp invoke <tool> --params {...} --detach` that produced it: same tool, same
 * transaction id (the card text's "#<id>"), same category as the card's "after", started before the card was shown.
 * Each invoke is used at most once. `entries` are transcriptFromAudit() entries with `src` seconds on the recording clock.
 */
export function bindProposals(cards, entries) {
  const used = new Set();
  for (const c of cards) {
    if (c.kind !== 'change') continue;
    const cands = entries.filter((e, i) => !used.has(i) && e.accepted && e.argv[0] === 'webmcp' && e.argv[1] === 'invoke' && e.argv[2] === c.tool && e.argv.includes('--detach') && e.src <= c.shown + 0.5)
      .map((e) => { let p = null; try { p = JSON.parse(e.argv[e.argv.indexOf('--params') + 1]); } catch { /* skip */ } return { e, p, i: entries.indexOf(e) }; })
      .filter((x) => x.p && String(x.p.id) === String(c.txId));
    const m = cands.at(-1);
    if (!m) throw new Error(`cannot bind card ${c.opId ?? '#' + c.index} (${c.tool} #${c.txId}) to an agent proposal in ab-audit.jsonl; refusing to annotate it`);
    if (c.after && String(m.p.category).toLowerCase() !== String(c.after).toLowerCase()) throw new Error(`card ${c.opId ?? '#' + c.index} shows category ${c.after} but the bound proposal asked for ${m.p.category}`);
    used.add(m.i);
    c.proposal = { src: m.e.src, endSrc: m.e.endSrc, args: m.p, argv: m.e.argv };
  }
  return cards;
}

const fillWith = (vars) => (s) => String(s).replace(/\{(\w+)\}/g, (_, k) => (k in vars ? String(vars[k]) : `{${k}}`));

/** Template variables that come ONLY from this card (and the beat target). */
export function cardVars(c, base = {}) {
  const args = c.proposal?.args ?? {};
  return { ...base, txId: c.txId ?? '?', opId: c.opId ?? '', category: c.after ?? args.category ?? '?', before: c.before ?? '?', tool: c.tool,
    proposalArgs: JSON.stringify(args).replace(/"(\w+)":/g, '$1:').replace(/"([^"]*)"/g, '\u201c$1\u201d') };
}

/**
 * Per-card overlays, each filled from that card's own data and timed on that card's own events (source seconds).
 * perCard config: { propose, shown, hold, resolved:{approve,reject,rejectOther}, coShown:{x,y,txt,sub}, coDecide:{approve:{...},reject:{...}} }
 * Returns {caps:[{start,end,t,optional,card}], cos:[{id,start,end,x,y,txt,sub,card}]}; `card` is the card's index, so a
 * test (and a reader of index.html) can see which card every overlay describes.
 */
export function perCardItems(cfg, cards, base = {}) {
  const caps = []; const cos = [];
  for (const c of cards) {
    if (c.kind !== 'change') continue;
    const f = fillWith(cardVars(c, base));
    const approve = c.decision === 'approve';
    const decideAt = approve ? c.pressed : c.rejectClicked;
    if (decideAt == null) throw new Error(`card ${c.opId ?? '#' + c.index} has no ${approve ? 'approve-pressed' : 'reject-clicked'} event`);
    const tail = c.resolved + (cfg.resolvedHold ?? 1.5);
    if (c.proposal && c.proposal.src < c.shown) caps.push({ start: c.proposal.src, end: c.shown, t: f(cfg.propose), optional: true, card: c.index });
    caps.push({ start: c.shown, end: decideAt, t: f(cfg.shown), card: c.index });
    if (approve) {
      caps.push({ start: c.pressed, end: c.released ?? c.resolved, t: f(cfg.hold), card: c.index });
      caps.push({ start: c.released ?? c.resolved, end: tail, t: f(cfg.resolved.approve), card: c.index });
    } else {
      // "Not the target" copy only when this card is provably a different transaction; otherwise (a duplicate or
      // failed-check proposal for the target, or an unknown target id) use the neutral reject caption.
      const otherTx = base.targetTxId != null && c.txId != null && String(c.txId) !== String(base.targetTxId);
      caps.push({ start: c.rejectClicked, end: tail, t: f(otherTx ? cfg.resolved.rejectOther : cfg.resolved.reject), card: c.index });
    }
    const co = cfg.coShown; const cd = cfg.coDecide[approve ? 'approve' : 'reject'];
    cos.push({ id: `co_c${c.index}_a`, start: c.shown + 0.2, end: decideAt - 0.1, x: co.x, y: co.y, txt: f(co.txt), sub: f(co.sub), card: c.index });
    cos.push({ id: `co_c${c.index}_b`, start: decideAt, end: tail, x: cd.x ?? co.x, y: cd.y ?? co.y, txt: f(cd.txt), sub: f(cd.sub), card: c.index });
  }
  return { caps, cos };
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
