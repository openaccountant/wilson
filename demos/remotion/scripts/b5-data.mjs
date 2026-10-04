// Parses the real actor transcript into timed lines (source-video seconds). Verbatim text only.
import fs from 'node:fs';
const D = process.argv[2] || '/private/tmp/claude-501/wilson-demos/b5/take1';
const ev = JSON.parse(fs.readFileSync(`${D}/events.json`, 'utf8'));
const start = Date.parse(ev.recordingStartedAt);
const day = ev.recordingStartedAt.slice(0, 10);
const log = fs.readFileSync(`${D}/actor.log`, 'utf8').split('\n');
const entries = []; let cur = null;
for (const l of log) {
  const m = l.match(/^\[(\d\d:\d\d:\d\d)\] \$ (.*)$/);
  if (m) { cur = { t: (Date.parse(`${day}T${m[1]}Z`) - start) / 1000, cmd: m[2], body: [] }; entries.push(cur); continue; }
  if (l.startsWith('[SUMMARY]')) { entries.push({ summary: l }); cur = null; continue; }
  if (cur && !l.startsWith('(eval)') && !l.startsWith('[note]')) cur.body.push(l);
}
const out = entries.filter(e => e.summary || e.cmd.startsWith('agent-browser')).map(e => e);
const events = ev.events.filter(e => e.t_ms != null).map(e => ({ name: e.name, t: e.t_ms / 1000 }));
fs.writeFileSync('src/b5-data.json', JSON.stringify({ entries: out, events }, null, 1));
console.log(out.map(e => (e.t ?? 'sum') + ' ' + (e.cmd || 'SUMMARY')).join('\n'));
