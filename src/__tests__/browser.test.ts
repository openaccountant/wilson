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
    expect(args[1]).toEqual(['https://test.example.com']);
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

  test('uses cmd on windows', () => {
    const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    execSpy = spyOn(childProcess, 'execFileSync').mockReturnValue(Buffer.from(''));
    openBrowser('https://example.com');
    expect(execSpy.mock.calls[0][0]).toBe('cmd');
    if (origPlatform) Object.defineProperty(process, 'platform', origPlatform);
    else Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  });
});
