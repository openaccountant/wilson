import { describe, expect, test } from 'bun:test';
import { homedir, tmpdir, userInfo } from 'node:os';
import * as os from 'os';
import { LOG_FILE } from '../utils/logger.js';

// Guards src/__tests__/preload.ts: no test may read or write the real
// ~/.openaccountant (a test run used to delete a live dashboard's agent.log).
describe('tests run against a throwaway home', () => {
  const realHome = userInfo().homedir;

  test('os.homedir() is a temp dir in every import style', () => {
    expect(homedir()).not.toBe(realHome);
    expect(homedir().startsWith(tmpdir())).toBe(true);
    expect(os.homedir()).toBe(homedir());
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    expect(require('os').homedir()).toBe(homedir());
    expect(process.env.HOME).toBe(homedir());
  });

  test("the logger's file lives under the test home", () => {
    expect(LOG_FILE.startsWith(homedir())).toBe(true);
    expect(LOG_FILE.startsWith(realHome + '/')).toBe(false);
  });
});
