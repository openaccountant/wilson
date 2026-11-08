import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserCommand } from '../utils/browser.js';
import { WHERE, windowsSystemBinary } from '../utils/windows-bin.js';
import { noticeUnencryptedOnce } from '../db/database.js';
import { syncCrontab } from '../schedule/cron.js';
import { DASHBOARD_ASSETS_DIR } from '../dashboard/server.js';

describe('browserCommand', () => {
  const url = 'http://localhost:3000/link?token=a&b=c';

  test('macOS and Linux use open / xdg-open', () => {
    expect(browserCommand(url, 'darwin')).toEqual(['open', [url]]);
    expect(browserCommand(url, 'linux')).toEqual(['xdg-open', [url]]);
  });

  test('Windows avoids cmd (so & survives) and runs rundll32 by absolute System32 path', () => {
    const [cmd, args] = browserCommand(url, 'win32', (rel) => windowsSystemBinary(rel, { env: {}, exists: () => true }))!;
    expect(cmd).toBe('C:\\Windows\\System32\\rundll32.exe');
    expect(args).toEqual(['url.dll,FileProtocolHandler', url]);
  });

  test('Windows without System32 rundll32 opens nothing rather than search PATH', () => {
    expect(browserCommand(url, 'win32', () => null)).toBeNull();
  });

  test('where.exe resolves under System32 too', () => {
    expect(windowsSystemBinary(WHERE, { env: { SystemRoot: 'C:\\Windows' }, exists: () => true })).toBe(
      'C:\\Windows\\System32\\where.exe',
    );
    expect(windowsSystemBinary(WHERE, { env: {}, exists: () => false })).toBeNull();
  });
});

describe('noticeUnencryptedOnce', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test('prints once per database, then stays quiet', () => {
    dir = mkdtempSync(join(tmpdir(), 'oa-notice-'));
    const dbPath = join(dir, 'data.db');
    const write = spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      noticeUnencryptedOnce(dbPath, 'stored unencrypted');
      noticeUnencryptedOnce(dbPath, 'stored unencrypted');
      expect(write).toHaveBeenCalledTimes(1);
      expect(String(write.mock.calls[0]![0])).toContain('stored unencrypted');
      expect(existsSync(`${dbPath}.unencrypted-notice`)).toBe(true);
    } finally {
      write.mockRestore();
    }
  });
});

test('dashboard asset dir is a real filesystem path (no /C:/ or %20)', () => {
  expect(DASHBOARD_ASSETS_DIR).not.toMatch(/^\/[A-Za-z]:/);
  expect(DASHBOARD_ASSETS_DIR).not.toContain('%20');
  expect(DASHBOARD_ASSETS_DIR).toContain('dist-hybrid');
});

describe.skipIf(process.platform !== 'win32')('Windows-only', () => {
  test('scheduling explains cron is unavailable instead of spawning crontab', () => {
    expect(() => syncCrontab()).toThrow(/Task Scheduler/);
  });
});
