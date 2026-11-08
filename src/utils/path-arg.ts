import { homedir } from 'os';
import { join } from 'path';

/**
 * Parses a raw file path argument typed into a slash command (e.g. `/import <path>`).
 *
 * The TUI's editor is not a shell — user input is never tokenized by one — so
 * shell-style quoting and backslash-escaping (typed from muscle memory, or
 * pasted straight out of a terminal) survive into the string as literal
 * characters instead of being resolved. Left alone, a path like
 * `Jd\'s\ Finances.csv` is passed to the filesystem exactly as typed, complete
 * with backslashes that don't exist on disk, producing a confusing ENOENT.
 *
 * This undoes that the way a shell would when tokenizing an argument:
 *   - strips one layer of surrounding matching quotes (`"..."` or `'...'`)
 *   - unescapes backslash-escaped characters (`\'` -> `'`, `\ ` -> ` `, etc.)
 *   - strips a leading `@` left over from file-search autocomplete
 *
 * On Windows the backslash is the path separator, not an escape (cmd and
 * PowerShell never escape with it), so it is left alone there: unescaping
 * would turn `C:\Users\me\file.csv` into `C:Usersmefile.csv`.
 */
export function parseFilePathArg(rawPath: string, platform: NodeJS.Platform = process.platform): string {
  const trimmed = rawPath.trim();
  const unquoted = trimmed.replace(/^["']|["']$/g, '');
  const unescaped = platform === 'win32' ? unquoted : unquoted.replace(/\\(.)/g, '$1');
  return unescaped.replace(/^@/, '');
}

/**
 * Expand a leading `~` to the user's home directory (`~`, `~/x`, and `~\x`).
 * Uses os.homedir(), not $HOME, which is unset in a normal Windows session.
 * `~user` forms are left untouched.
 */
export function expandHome(filePath: string, home: string = homedir()): string {
  if (filePath === '~') return home;
  if (filePath.startsWith('~/') || filePath.startsWith('~\\')) return join(home, filePath.slice(2));
  return filePath;
}
