/**
 * HOME guard for scripts/webmcp-live-seed.ts. It is a separate module imported FIRST so it runs before any app module
 * loads: ES imports evaluate before the importing file's body, and app modules create ~/.openaccountant/logs on load.
 */
import { homedir } from 'os';
import { realpathSync } from 'fs';
import { resolve } from 'path';

export const REAL_HOME = '/Users/jdfiscus';
export const home = homedir();
export const envHome = process.env.HOME ?? '';

// Resolve `..` segments and symlinks first: a bare substring check passes "/private/tmp/../../Users/jdfiscus".
// macOS /tmp is a symlink to /private/tmp, so a "/tmp/..." HOME resolves into the allowed prefix. A path that does
// not exist cannot be resolved, so it is refused.
function resolveHome(p: string): string {
  try {
    return realpathSync(resolve(p));
  } catch {
    return '';
  }
}
const scratchPrefix = '/private/tmp/';
const resolvedHome = resolveHome(home);
const resolvedEnvHome = resolveHome(envHome);
const isScratch = (p: string) => (p + '/').startsWith(scratchPrefix) && p.length > scratchPrefix.length - 1;

if (
  home === REAL_HOME ||
  envHome === REAL_HOME ||
  resolvedHome === REAL_HOME ||
  resolvedEnvHome === REAL_HOME ||
  !isScratch(resolvedHome) ||
  !isScratch(resolvedEnvHome)
) {
  console.error(
    `Refusing to seed: homedir() is "${home}" (HOME="${envHome}", resolves to "${resolvedHome}"). ` +
      `HOME must be a scratch directory under "/private/tmp/" and must not be ${REAL_HOME}.`,
  );
  process.exit(1);
}
