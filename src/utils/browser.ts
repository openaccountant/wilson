import { execFileSync } from 'child_process';
import { RUNDLL32, windowsSystemBinary } from './windows-bin.js';

/**
 * Command that opens `url` in the default browser on `platform`.
 *
 * Windows uses `rundll32 url.dll,FileProtocolHandler` rather than `cmd /c start`:
 * cmd re-parses the URL, so an `&` in a query string splits the command and
 * `start` takes the first quoted argument as a window title.
 */
export function browserCommand(
  url: string,
  platform: NodeJS.Platform = process.platform,
  resolveWin: (rel: string[]) => string | null = (rel) => windowsSystemBinary(rel),
): [string, string[]] | null {
  if (platform === 'darwin') return ['open', [url]];
  if (platform === 'win32') {
    // Absolute System32 path: a bare name would let a planted rundll32.exe in the CWD run.
    const rundll32 = resolveWin(RUNDLL32);
    return rundll32 ? [rundll32, ['url.dll,FileProtocolHandler', url]] : null;
  }
  return ['xdg-open', [url]];
}

/**
 * Open a URL in the user's default browser.
 * @returns true if the browser was opened, false if it failed.
 */
export function openBrowser(url: string): boolean {
  try {
    const command = browserCommand(url);
    if (!command) return false;
    const [cmd, args] = command;
    execFileSync(cmd, args, { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}
