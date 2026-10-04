// The argv grammar the actor may use. Pure functions, no I/O, so the accept/reject table is unit-tested.
// The wrapper (bin/ab-agent) receives argv from the OS (no shell parsing of its own) and runs ONLY what this accepts.
//
//   webmcp list [--json]
//   webmcp invoke <tool> --params <inline-json> [--detach]      (--params / --detach in either order)
//   webmcp result <id> [--timeout <ms>]                     (1000-300000 ms; agent-browser's own default wait is ~25 s and
//                                                            it CANCELS the call when that wait runs out)
//   snapshot
//   get url
//
// Everything else is refused: other subcommands, any other flag, --cdp/--session/--executable-path (the wrapper injects
// the fixed ones), --params values that are not inline JSON objects (an '@file' read is refused by name), tool names
// outside the dashboard's catalog charset, ids outside [A-Za-z0-9-].

export const TOOL_RE = /^[a-z][a-z0-9_]{0,63}$/;       // every tool in the dashboard catalog is lower snake_case
export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/; // no leading '-': it would be parsed as a global agent-browser flag
export const MAX_PARAMS_BYTES = 16 * 1024;
const OVERRIDES = new Set(['--cdp', '--session', '--executable-path', '--config', '--profile', '--state', '--session-name', '--provider', '--proxy', '--args', '--engine', '--headed', '--auto-connect', '--allowed-domains', '--action-policy', '--init-script', '--extension', '--user-agent', '--download-path', '--screenshot-dir', '-p']);

/** @returns {{ok:true, argv:string[], kind:string, id?:string, tool?:string, detach?:boolean} | {ok:false, reason:string, kind:'policy'|'usage'}} */
export function validateArgv(argv) {
  const bad = (reason, kind = 'policy') => ({ ok: false, reason, kind });
  if (!Array.isArray(argv) || argv.some((a) => typeof a !== 'string')) return bad('argv must be an array of strings');
  if (argv.length === 0) return bad('no subcommand', 'usage');
  for (const a of argv) {
    const flag = a.split('=')[0];
    if (OVERRIDES.has(flag)) return bad(`${flag} is set by the wrapper and cannot be overridden`);
  }
  const [a, b, ...rest] = argv;

  if (a === 'snapshot') return argv.length === 1 ? { ok: true, argv: ['snapshot'], kind: 'snapshot' } : bad('snapshot takes no arguments');
  if (a === 'get') {
    if (b !== 'url') return bad(`get ${JSON.stringify(b ?? '')} is not allowed (only: get url)`);
    return rest.length === 0 ? { ok: true, argv: ['get', 'url'], kind: 'get-url' } : bad('get url takes no arguments');
  }
  if (a !== 'webmcp') return bad(`subcommand ${JSON.stringify(a)} is not allowed (allowed: webmcp list|invoke|result, snapshot, get url)`);

  if (b === 'list') {
    if (rest.length === 0) return { ok: true, argv: ['webmcp', 'list'], kind: 'list' };
    if (rest.length === 1 && rest[0] === '--json') return { ok: true, argv: ['webmcp', 'list', '--json'], kind: 'list' };
    return bad(`webmcp list accepts only an optional --json, got ${JSON.stringify(rest)}`);
  }
  if (b === 'result') {
    if (rest.length !== 1 && rest.length !== 3) return bad('webmcp result takes exactly one id, optionally followed by --timeout <ms>', 'usage');
    if (!ID_RE.test(rest[0])) return bad(`id ${JSON.stringify(rest[0].slice(0, 80))} is outside [A-Za-z0-9-]`);
    if (rest.length === 1) return { ok: true, argv: ['webmcp', 'result', rest[0]], kind: 'result', id: rest[0] };
    if (rest[1] !== '--timeout') return bad(`flag ${JSON.stringify(rest[1].slice(0, 80))} is not allowed on webmcp result (allowed: --timeout <ms>)`);
    if (!/^[0-9]{4,6}$/.test(rest[2]) || Number(rest[2]) < 1000 || Number(rest[2]) > 300000) return bad('--timeout must be a whole number of ms from 1000 to 300000', 'usage');
    return { ok: true, argv: ['webmcp', 'result', rest[0], '--timeout', String(Number(rest[2]))], kind: 'result', id: rest[0] };
  }
  if (b === 'invoke') {
    const [tool, ...flags] = rest;
    if (tool === undefined) return bad('webmcp invoke needs a tool name', 'usage');
    if (!TOOL_RE.test(tool)) return bad(`tool name ${JSON.stringify(tool.slice(0, 80))} is outside the catalog charset ${TOOL_RE}`);
    let params; let detach = false; let sawParams = false;
    for (let i = 0; i < flags.length; i++) {
      const f = flags[i];
      if (f === '--detach') { if (detach) return bad('--detach given twice', 'usage'); detach = true; continue; }
      if (f === '--params') {
        if (sawParams) return bad('--params given twice', 'usage');
        sawParams = true;
        const v = flags[++i];
        if (v === undefined) return bad('--params needs an inline JSON value', 'usage');
        if (v.startsWith('@')) return bad('--params @file would read a local file; only inline JSON is allowed');
        if (Buffer.byteLength(v) > MAX_PARAMS_BYTES) return bad('--params is larger than 16 KB', 'usage');
        try { params = JSON.parse(v); } catch (e) { return bad(`--params is not valid JSON: ${e.message}`, 'usage'); }
        if (params === null || typeof params !== 'object' || Array.isArray(params)) return bad('--params must be a JSON object', 'usage');
        params = v;
        continue;
      }
      return bad(`flag ${JSON.stringify(f.slice(0, 80))} is not allowed on webmcp invoke (allowed: --params, --detach)`);
    }
    if (!sawParams) return bad('webmcp invoke needs --params <inline-json> (use {} for none)', 'usage');
    return { ok: true, argv: ['webmcp', 'invoke', tool, '--params', params, ...(detach ? ['--detach'] : [])], kind: 'invoke', tool, detach };
  }
  return bad(`webmcp ${JSON.stringify(b ?? '')} is not allowed (allowed: list, invoke, result)`);
}
