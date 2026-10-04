/**
 * HOME guard for scripts/webmcp-live-seed.ts. It is a separate module imported FIRST so it runs before any app module
 * loads: ES imports evaluate before the importing file's body, and app modules create ~/.openaccountant/logs on load.
 */
import { homedir } from 'os';

export const REAL_HOME = '/Users/jdfiscus';
export const home = homedir();
export const envHome = process.env.HOME ?? '';

if (home === REAL_HOME || envHome === REAL_HOME || !home.includes('/private/tmp/') || !envHome.includes('/private/tmp/')) {
  console.error(
    `Refusing to seed: homedir() is "${home}" (HOME="${envHome}"). ` +
      `HOME must be a scratch directory containing "/private/tmp/" and must not be ${REAL_HOME}.`,
  );
  process.exit(1);
}
