import { existsSync } from 'fs';
import { win32 } from 'path';

/**
 * Absolute path to a Windows system binary, or null if it isn't there.
 *
 * Never spawn these by bare name: Windows searches the current directory (and
 * then PATH) first, so a `powershell.exe` dropped in Downloads would run instead
 * — inside the process that handles the database encryption key. Callers must
 * fail closed on null rather than fall back to a PATH lookup.
 */
export function windowsSystemBinary(
  relative: string[],
  opts: { env?: Record<string, string | undefined>; exists?: (p: string) => boolean } = {},
): string | null {
  const env = opts.env ?? process.env;
  const exists = opts.exists ?? existsSync;
  const root = env.SystemRoot || env.SYSTEMROOT || env.windir || 'C:\\Windows';
  const p = win32.join(root, 'System32', ...relative);
  return exists(p) ? p : null;
}

export const POWERSHELL = ['WindowsPowerShell', 'v1.0', 'powershell.exe'];
export const RUNDLL32 = ['rundll32.exe'];
export const WHERE = ['where.exe'];
