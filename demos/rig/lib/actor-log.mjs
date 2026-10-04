// Text helpers for the actor transcript, plus the model-side view of the claude stream (actor.jsonl).
//
// What the actor RAN and what came back is read from ab-audit.jsonl (written by bin/ab-agent, see lib/ab-audit.mjs).
// actor.jsonl (raw stream-json, harness receipt time in `_rx`) is used only for the model's own text and its final
// SUMMARY, and as the other side of the 1:1 stream/audit check.
//
// actor.log is written by the HARNESS: model- and page-controlled text can never forge a harness line. Commands are
// collapsed to ONE line (newlines shown as a literal \n) and every output line is indented, so only the harness ever
// emits a line that starts with "[".

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

export const OUT_INDENT = '  ';
/** Tool output -> indented single-line entries (never a line that could start with "[" or look like a harness line). */
export function outputLines(text) {
  const t = String(text).replace(/\s+$/, '');
  const raw = t ? t.split(/\r\n|\r|\n|\u0085|\u2028|\u2029/) : ['(no output)'];
  return raw.map((l) => OUT_INDENT + oneLine(l));
}

/** Parse actor.jsonl text -> events (each may carry the harness receipt time in `_rx`). */
export function parseJsonl(text) {
  const evs = [];
  for (const l of String(text).split('\n')) { if (!l.trim()) continue; try { evs.push(JSON.parse(l)); } catch { /* skip */ } }
  return evs;
}

/** The model's final text from the stream: {summary, at} where `at` is the harness receipt time (ISO) or null. */
export function summaryFromStream(events) {
  const r = [...events].reverse().find((e) => e?.type === 'result');
  if (!r) return { summary: null, at: null };
  return { summary: String(r.result ?? '').replace(/\s+/g, ' ').trim(), at: r._rx ?? null };
}

/** Number of Bash tool_use blocks in the stream. */
export function countToolUses(events) {
  let n = 0;
  for (const ev of events) if (ev?.type === 'assistant') for (const b of ev.message?.content ?? []) if (b.type === 'tool_use') n++;
  return n;
}
