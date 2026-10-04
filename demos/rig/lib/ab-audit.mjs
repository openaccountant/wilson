// Audit + stream/audit correspondence. ab-audit.jsonl (written by bin/ab-agent) is the SOURCE OF TRUTH for what the actor
// ran and what came back; actor.jsonl (the claude stream) remains only for the model's own text and the SUMMARY.
import { oneLine, hms, outputLines, OUT_INDENT } from './actor-log.mjs';

export function parseAudit(text) {
  const recs = [];
  for (const l of String(text).split('\n')) { if (!l.trim()) continue; try { recs.push(JSON.parse(l)); } catch { recs.push({ accepted: false, argv: [], malformed: true, raw: l.slice(0, 200) }); } }
  return recs;
}

/** Quote-aware split of the Bash command string the model sent. Anything a shell would expand/chain is `bad`. */
export function shellTokens(s) {
  const tokens = []; let cur = ''; let has = false; let q = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q === "'") { if (ch === "'") q = null; else cur += ch; continue; }
    if (q === '"') {
      if (ch === '"') q = null;
      else if (ch === '$' || ch === '`' || ch === '\\') return { tokens, bad: 'expansion or escape inside double quotes' };
      else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') { q = ch; has = true; continue; }
    if (/\s/.test(ch)) { if (has || cur) tokens.push(cur); cur = ''; has = false; continue; }
    if (/[;&|<>`$()\\{}*?~!#]/.test(ch)) return { tokens, bad: `unquoted shell metacharacter ${JSON.stringify(ch)}` };
    cur += ch; has = true;
  }
  if (q) return { tokens, bad: 'unterminated quote' };
  if (has || cur) tokens.push(cur);
  return { tokens, bad: null };
}

/**
 * Every stream tool_use must be a Bash call of exactly `<wrapper> <argv...>` and must correspond 1:1 (same order, same argv)
 * to a record in ab-audit.jsonl. Returns [{command, reason}] (empty = clean). Extra audit records (no stream tool_use) and
 * extra tool_uses (no audit record) are both violations.
 */
export function checkStreamAgainstAudit(events, audit, wrapper) {
  const out = [];
  const used = [];
  for (const ev of events) {
    if (ev?.type === 'unparsed') { out.push({ command: '[unparsed stream line]', reason: 'stream line was not valid JSON, so it cannot be audited' }); continue; }
    if (ev?.type !== 'assistant') continue;
    for (const b of ev.message?.content ?? []) {
      if (b.type !== 'tool_use') continue;
      if (b.name !== 'Bash') { out.push({ command: `[${b.name}]`, reason: 'tool other than Bash' }); continue; }
      used.push(String(b.input?.command ?? ''));
    }
  }
  const expected = [];
  for (const cmd of used) {
    const { tokens, bad } = shellTokens(cmd.trim());
    if (bad) { out.push({ command: cmd, reason: bad }); expected.push(null); continue; }
    if (tokens[0] !== wrapper) { out.push({ command: cmd, reason: `not the wrapper ${wrapper}` }); expected.push(null); continue; }
    expected.push(tokens.slice(1));
  }
  for (let i = 0; i < Math.max(used.length, audit.length); i++) {
    if (i >= audit.length) { out.push({ command: used[i], reason: 'stream tool_use has no ab-audit.jsonl record' }); continue; }
    if (i >= used.length) { out.push({ command: JSON.stringify(audit[i].argv), reason: 'ab-audit.jsonl record has no stream tool_use' }); continue; }
    if (expected[i] === null) continue;
    if (JSON.stringify(expected[i]) !== JSON.stringify(audit[i].argv)) out.push({ command: used[i], reason: `argv differs from audit record #${i}: ${JSON.stringify(audit[i].argv).slice(0, 200)}` });
  }
  return out;
}

/** Audit records the wrapper refused or that never completed. A refused attempt fails the take. */
export function auditProblems(audit) {
  const out = [];
  audit.forEach((r, i) => {
    if (r.malformed) out.push({ command: r.raw ?? '', reason: `audit line ${i} is not valid JSON` });
    else if (!r.accepted) out.push({ command: JSON.stringify(r.argv), reason: `refused by the wrapper: ${r.reason ?? 'unknown'}` });
    else if (r.daemon && r.daemon.verified === false) out.push({ command: JSON.stringify(r.argv), reason: `daemon not verified: ${r.daemon.problem ?? 'unknown'}` });
  });
  return out;
}

const q = (a) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);
/** Display form of an audited command: "ab-agent webmcp invoke x --params '{...}'" on ONE line. */
export function displayArgv(argv) { return oneLine(['ab-agent', ...argv.map(q)].join(' ')); }

/** Audit records -> transcript entries with exact start/end times. out = stdout lines (+ stderr, + refusal) unindented. */
export function transcriptFromAudit(audit) {
  return audit.map((r) => {
    const start = new Date(r.ts); const end = new Date(r.endTs ?? r.ts);
    const out = [];
    if (!r.accepted) out.push(`REFUSED: ${r.reason ?? 'not allowed'}`);
    const so = String(r.stdout ?? '').replace(/\s+$/, '');
    if (so) out.push(...so.split(/\r\n|\r|\n|\u0085|\u2028|\u2029/).map(oneLine));
    const se = String(r.stderr ?? '').replace(/\s+$/, '');
    if (se) out.push(...se.split(/\r\n|\r|\n|\u0085|\u2028|\u2029/).map((l) => `(stderr) ${oneLine(l)}`));
    if (!out.length) out.push('(no output)');
    return { date: start, endDate: end, ts: hms(start), cmd: displayArgv(r.argv), accepted: !!r.accepted, exitCode: r.exitCode ?? null, argv: r.argv, out };
  });
}

/** actor.log text (harness-written): command lines + indented outputs from the audit, then [SUMMARY] from the stream. */
export function actorLogFromAudit(audit, summary) {
  const lines = [];
  for (const e of transcriptFromAudit(audit)) {
    lines.push(`[${e.ts}] $ ${e.cmd}`);
    for (const l of e.out) lines.push(OUT_INDENT + l);
  }
  if (summary != null) lines.push(`[SUMMARY] ${summary}`);
  return lines.join('\n') + '\n';
}
export { outputLines };
