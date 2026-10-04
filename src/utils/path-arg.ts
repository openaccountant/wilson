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
 */
export function parseFilePathArg(rawPath: string): string {
  const trimmed = rawPath.trim();
  const unquoted = trimmed.replace(/^["']|["']$/g, '');
  const unescaped = unquoted.replace(/\\(.)/g, '$1');
  return unescaped.replace(/^@/, '');
}
