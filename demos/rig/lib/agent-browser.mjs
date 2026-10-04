// Resolves the VENDORED agent-browser (demos/rig/node_modules, pinned in demos/rig/package.json).
// Never the global install, never a scratchpad copy. The version is checked on every resolve.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const AGENT_BROWSER_VERSION = '0.38.2';
export const SYSTEM_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export const RIG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Pure: parse "agent-browser 0.38.2" -> "0.38.2" (or null). */
export function parseVersion(out) {
  return /(\d+\.\d+\.\d+)/.exec(String(out))?.[1] ?? null;
}

/**
 * Returns { bin, version } for demos/rig/node_modules/.bin/agent-browser (realpath), or throws a clear error.
 * `opts.rigDir` and `opts.exec` exist for tests.
 */
export function resolveAgentBrowser(opts = {}) {
  const rigDir = opts.rigDir ?? RIG_DIR;
  const exec = opts.exec ?? ((bin) => execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 15000 }));
  const link = path.join(rigDir, 'node_modules', '.bin', 'agent-browser');
  if (!fs.existsSync(link)) {
    throw new Error(`vendored agent-browser not found at ${link}. Run: (cd ${rigDir} && npm install)`);
  }
  const bin = fs.realpathSync(link);
  let out;
  try { out = exec(bin); } catch (e) { throw new Error(`could not run ${bin} --version: ${e.message}`); }
  const version = parseVersion(out);
  if (version !== AGENT_BROWSER_VERSION) {
    throw new Error(`vendored agent-browser is ${version ?? `unknown (${String(out).trim()})`}, need exactly ${AGENT_BROWSER_VERSION}. Run: (cd ${rigDir} && npm install)`);
  }
  return { bin, version };
}

/** Env for anything that launches or attaches agent-browser: always system Chrome, never Chrome for Testing. */
export function agentBrowserEnv(base = process.env, chrome = SYSTEM_CHROME) {
  return { ...base, AGENT_BROWSER_EXECUTABLE_PATH: chrome };
}

/** The ONLY thing the actor may run: the argv-validating wrapper (see lib/ab-policy.mjs). */
export const WRAPPER = path.join(RIG_DIR, 'bin', 'ab-agent');

/** Per-take isolated state, all under the take dir (scratch): socket dir (daemon .sock/.pid), HOME for the daemon, empty config. */
export function takeIsolation(takeDir) {
  const root = path.join(takeDir, 'ab');
  return { root, socketDir: path.join(root, 'sock'), home: path.join(root, 'home'), config: path.join(root, 'config.json'), audit: path.join(takeDir, 'ab-audit.jsonl') };
}

/** Env vars the wrapper reads (set by actor.mjs). The wrapper builds the child's env itself; none of these reach agent-browser as-is. */
export function wrapperEnv({ bin, cdpPort, session, takeDir, chrome = SYSTEM_CHROME }) {
  const iso = takeIsolation(takeDir);
  return { AB_AGENT_BIN: bin, AB_AGENT_CDP: String(cdpPort), AB_AGENT_SESSION: session, AB_AGENT_SOCKET_DIR: iso.socketDir, AB_AGENT_HOME: iso.home, AB_AGENT_CONFIG: iso.config, AB_AGENT_AUDIT: iso.audit, AB_AGENT_CHROME: chrome };
}

/** The single claude -p allow pattern: the wrapper's absolute path, any args (the wrapper validates argv exactly). */
export function allowedBashPatterns(wrapper = WRAPPER) {
  return [`Bash(${wrapper}:*)`];
}
