import { execFileSync } from 'child_process';

/**
 * Open a URL in the user's default browser.
 * @returns true if the browser was opened, false if it failed.
 */
export function openBrowser(url: string): boolean {
  try {
    if (process.platform === 'darwin') {
      execFileSync('open', [url]);
    } else if (process.platform === 'linux') {
      execFileSync('xdg-open', [url]);
    } else {
      execFileSync('cmd', ['/c', 'start', url]);
    }
    return true;
  } catch {
    return false;
  }
}
