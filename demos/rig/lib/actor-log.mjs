// Turns Claude Code stream-json events into actor.log lines (the format compose/build.mjs parses):
//   [HH:MM:SS] $ agent-browser <args>        <- the command (UTC, 1 s resolution), binary + --cdp/--session elided
//   <tool output verbatim>
//   [SUMMARY] <final text of the model>
// Written by the HARNESS from the stream, never by the model.

const pad = (n) => String(n).padStart(2, '0');
export const hms = (d) => `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;

/** "/abs/agent-browser --cdp 9333 --session s webmcp list --json" -> "agent-browser webmcp list --json" */
export function displayCommand(cmd, bin, cdpPort, session) {
  const prefix = `${bin} --cdp ${cdpPort} --session ${session}`;
  const c = String(cmd).trim();
  if (c.startsWith(prefix)) return `agent-browser${c.slice(prefix.length)}`.replace(/\s+$/, '');
  return c;
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
  const pending = new Map(); // tool_use_id -> true
  let summary = null;
  let commands = 0;
  return {
    get summary() { return summary; },
    get commands() { return commands; },
    feed(ev, date = new Date()) {
      const out = [];
      if (ev?.type === 'assistant') {
        for (const b of ev.message?.content ?? []) {
          if (b.type === 'tool_use' && b.name === 'Bash') {
            commands++;
            pending.set(b.id, true);
            out.push(`[${hms(date)}] $ ${displayCommand(b.input?.command ?? '', bin, cdpPort, session)}`);
          } else if (b.type === 'tool_use') {
            pending.set(b.id, true);
            out.push(`[${hms(date)}] $ [${b.name} attempted]`);
          }
        }
      } else if (ev?.type === 'user') {
        for (const b of ev.message?.content ?? []) {
          if (b.type === 'tool_result' && pending.has(b.tool_use_id)) {
            pending.delete(b.tool_use_id);
            const t = resultText(b.content).replace(/\s+$/, '');
            out.push(...(t ? t.split('\n') : ['(no output)']));
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
