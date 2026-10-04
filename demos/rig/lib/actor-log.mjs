// Turns Claude Code stream-json events into actor.log lines (a human-readable view) and structured entries.
//   [HH:MM:SS] $ agent-browser <args>        <- the command (UTC, 1 s resolution), binary + --cdp/--session elided
//     <tool output, every line indented 2 spaces>
//   [SUMMARY] <final text of the model>
// Written by the HARNESS from the stream, never by the model. Model- and page-controlled text can never forge a
// harness line: commands are collapsed to ONE line (newlines shown as a literal \n) and every output line is indented,
// so only the harness ever emits a line that starts with "[". The cut (compose/build.mjs) does not parse actor.log at
// all: it replays actor.jsonl through this module and renders the structured entries.

const pad = (n) => String(n).padStart(2, '0');
export const hms = (d) => `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;

/** Any line-ish control character -> visible escape, so one command is always exactly one log line. */
export function oneLine(s) {
  return String(s)
    .replace(/\r\n|\r|\n/g, '\\n')
    .replace(/[\u0085\u2028\u2029\v\f]/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000e-\u001f\u007f]/g, '?');
}

/** "/abs/agent-browser --cdp 9333 --session s webmcp list --json" -> "agent-browser webmcp list --json" (single line). */
export function displayCommand(cmd, bin, cdpPort, session) {
  const prefix = `${bin} --cdp ${cdpPort} --session ${session}`;
  const c = String(cmd).trim();
  if (c.startsWith(prefix)) return oneLine(`agent-browser${c.slice(prefix.length)}`.replace(/\s+$/, ''));
  return oneLine(c);
}

export const OUT_INDENT = '  ';
/** Tool output -> indented single-line entries (never a line that could start with "[" or look like a harness line). */
export function outputLines(text) {
  const t = String(text).replace(/\s+$/, '');
  const raw = t ? t.split(/\r\n|\r|\n|\u0085|\u2028|\u2029/) : ['(no output)'];
  return raw.map((l) => OUT_INDENT + oneLine(l));
}

// ---- policy: the only commands the actor may run (mirrors allowedBashPatterns in agent-browser.mjs) ----
export const ALLOWED_SUBCOMMANDS = ['webmcp list', 'webmcp invoke', 'webmcp result', 'snapshot', 'get url'];
const ALLOWED_FLAGS = new Set(['--json', '--detach', '--params', '-i', '-c', '--interactive', '--compact']);

/** Quote-aware split. Returns {tokens:[{text,quoted}], bad:string|null}; unquoted shell metacharacters are `bad`. */
function shellTokens(s) {
  const tokens = []; let cur = ''; let has = false; let quoted = false; let q = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q === "'") { if (ch === "'") q = null; else cur += ch; continue; }
    if (q === '"') {
      if (ch === '"') q = null;
      else if (ch === '$' || ch === '`' || ch === '\\') return { tokens, bad: `expansion or escape inside double quotes` };
      else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') { q = ch; has = true; quoted = true; continue; }
    if (/\s/.test(ch)) { if (has || cur) tokens.push({ text: cur, quoted }); cur = ''; has = false; quoted = false; continue; }
    if (/[;&|<>`$()\\{}*?~!#]/.test(ch)) return { tokens, bad: `unquoted shell metacharacter ${JSON.stringify(ch)}` };
    cur += ch; has = true;
  }
  if (q) return { tokens, bad: 'unterminated quote' };
  if (has || cur) tokens.push({ text: cur, quoted });
  return { tokens, bad: null };
}

/** Returns null when `cmd` is an allowed actor command, else a human-readable reason. */
export function auditCommand(cmd, bin, cdpPort, session) {
  const prefix = `${bin} --cdp ${cdpPort} --session ${session} `;
  const c = String(cmd).trim();
  if (!c.startsWith(prefix)) return 'not the vendored agent-browser attached with the rig --cdp port and session';
  const { tokens, bad } = shellTokens(c.slice(prefix.length));
  if (bad) return bad;
  const words = tokens.map((t) => t.text);
  const sub = ALLOWED_SUBCOMMANDS.find((a) => { const p = a.split(' '); return p.every((w, i) => words[i] === w && !tokens[i].quoted); });
  if (!sub) return `subcommand ${JSON.stringify(words.slice(0, 2).join(' '))} is not one of: ${ALLOWED_SUBCOMMANDS.join(', ')}`;
  for (const t of tokens.slice(sub.split(' ').length)) {
    if (!t.quoted && t.text.startsWith('-') && !ALLOWED_FLAGS.has(t.text)) return `flag ${JSON.stringify(t.text)} is not allowed`;
  }
  return null;
}

/** Audit a whole stream: every tool_use must be an allowed Bash command. Returns [{command, reason}]. */
export function auditEvents(events, bin, cdpPort, session) {
  const out = [];
  for (const ev of events) {
    if (ev?.type === 'unparsed') { out.push({ command: '[unparsed stream line]', reason: 'stream line was not valid JSON, so it cannot be audited' }); continue; }
    if (ev?.type !== 'assistant') continue;
    for (const b of ev.message?.content ?? []) {
      if (b.type !== 'tool_use') continue;
      if (b.name !== 'Bash') { out.push({ command: `[${b.name}]`, reason: 'tool other than Bash' }); continue; }
      const reason = auditCommand(b.input?.command ?? '', bin, cdpPort, session);
      if (reason) out.push({ command: String(b.input?.command ?? ''), reason });
    }
  }
  return out;
}

/** Parse actor.jsonl text -> events (each may carry the harness receipt time in `_rx`). */
export function parseJsonl(text) {
  const evs = [];
  for (const l of String(text).split('\n')) { if (!l.trim()) continue; try { evs.push(JSON.parse(l)); } catch { /* skip */ } }
  return evs;
}

/** Replay events through the formatter -> {entries:[{date,ts,cmd,out:[lines (unindented)]}], summary}. */
export function transcriptFromEvents(events, { bin, cdpPort, session }) {
  const f = createFormatter({ bin, cdpPort, session });
  for (const ev of events) f.feed(ev, ev?._rx ? new Date(ev._rx) : new Date(0));
  return { entries: f.entries, summary: f.summary };
}

function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((b) => (typeof b === 'string' ? b : b?.text ?? '')).join('\n');
  return '';
}

/**
 * Stateful formatter. feed(event, date) returns the log lines (without trailing newline) to append.
 * `date` is the harness receipt time of the event.
 */
export function createFormatter({ bin, cdpPort, session }) {
  const pending = new Map(); // tool_use_id -> entry
  const entries = [];
  let summary = null;
  let commands = 0;
  return {
    get summary() { return summary; },
    get commands() { return commands; },
    get entries() { return entries; },
    feed(ev, date = new Date()) {
      const out = [];
      if (ev?.type === 'assistant') {
        for (const b of ev.message?.content ?? []) {
          if (b.type === 'tool_use' && b.name === 'Bash') {
            commands++;
            const cmd = displayCommand(b.input?.command ?? '', bin, cdpPort, session);
            const entry = { date, ts: hms(date), cmd, out: [] };
            entries.push(entry); pending.set(b.id, entry);
            out.push(`[${hms(date)}] $ ${cmd}`);
          } else if (b.type === 'tool_use') {
            const entry = { date, ts: hms(date), cmd: `[${oneLine(b.name)} attempted]`, out: [] };
            entries.push(entry); pending.set(b.id, entry);
            out.push(`[${hms(date)}] $ ${entry.cmd}`);
          }
        }
      } else if (ev?.type === 'user') {
        for (const b of ev.message?.content ?? []) {
          if (b.type === 'tool_result' && pending.has(b.tool_use_id)) {
            const entry = pending.get(b.tool_use_id);
            pending.delete(b.tool_use_id);
            const lines = outputLines(resultText(b.content));
            entry.out = lines.map((l) => l.slice(OUT_INDENT.length));
            out.push(...lines);
          }
        }
      } else if (ev?.type === 'result') {
        summary = String(ev.result ?? '').replace(/\s+/g, ' ').trim();
        out.push(`[SUMMARY] ${summary}`);
      }
      return out;
    },
  };
}
