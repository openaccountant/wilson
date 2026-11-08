import { execFileSync } from 'child_process';

/**
 * Command that opens `url` in the default browser on `platform`.
 *
 * Windows uses `rundll32 url.dll,FileProtocolHandler` rather than `cmd /c start`:
 * cmd re-parses the URL, so an `&` in a query string splits the command and
 * `start` takes the first quoted argument as a window title.
 */
export function browserCommand(url: string, platform: NodeJS.Platform = process.platform): [string, string[]] {
  if (platform === 'darwin') return ['open', [url]];
  if (platform === 'win32') return ['rundll32', ['url.dll,FileProtocolHandler', url]];
  return ['xdg-open', [url]];
}

/**
 * Open a URL in the user's default browser.
 * @returns true if the browser was opened, false if it failed.
 */
export function openBrowser(url: string): boolean {
  try {
    const [cmd, args] = browserCommand(url);
    execFileSync(cmd, args, { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}
