import { describe, test, expect, spyOn, afterEach } from 'bun:test';
import * as childProcess from 'child_process';
import { openBrowser } from '../utils/browser.js';

describe('openBrowser', () => {
  let execSpy: ReturnType<typeof spyOn>;

  afterEach(() => {
    execSpy?.mockRestore();
  });

  test('returns true on success (darwin)', () => {
    execSpy = spyOn(childProcess, 'execFileSync').mockReturnValue(Buffer.from(''));
    const result = openBrowser('https://example.com');
    expect(result).toBe(true);
    expect(execSpy).toHaveBeenCalled();
  });

  test('returns false when execFileSync throws', () => {
    execSpy = spyOn(childProcess, 'execFileSync').mockImplementation(() => {
      throw new Error('command not found');
    });
    const result = openBrowser('https://example.com');
    expect(result).toBe(false);
  });

  test('passes URL as argument', () => {
    execSpy = spyOn(childProcess, 'execFileSync').mockReturnValue(Buffer.from(''));
    openBrowser('https://test.example.com');
    const args = execSpy.mock.calls[0];
    // The URL is always the last argv entry, never shell-joined (Windows prefixes the handler).
    expect(args[1].at(-1)).toBe('https://test.example.com');
  });

  test('uses xdg-open on linux', () => {
    const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    execSpy = spyOn(childProcess, 'execFileSync').mockReturnValue(Buffer.from(''));
    openBrowser('https://example.com');
    expect(execSpy.mock.calls[0][0]).toBe('xdg-open');
    if (origPlatform) Object.defineProperty(process, 'platform', origPlatform);
    else Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  });

  test('uses System32 rundll32 on windows (cmd /c start would split URLs on &)', () => {
    const hostIsWindows = process.platform === 'win32';
    const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      execSpy = spyOn(childProcess, 'execFileSync').mockReturnValue(Buffer.from(''));
      const opened = openBrowser('https://example.com');
      // On a real Windows host rundll32 resolves under System32; elsewhere there is no
      // System32, so openBrowser fails closed without spawning anything.
      if (hostIsWindows) {
        expect(execSpy.mock.calls[0][0]).toMatch(/\\System32\\rundll32\.exe$/i);
        expect(execSpy.mock.calls[0][1]).toEqual(['url.dll,FileProtocolHandler', 'https://example.com']);
      } else {
        expect(opened).toBe(false);
        expect(execSpy).not.toHaveBeenCalled();
      }
    } finally {
      if (origPlatform) Object.defineProperty(process, 'platform', origPlatform);
      else Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    }
  });
});
