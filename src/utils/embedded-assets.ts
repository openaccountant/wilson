/**
 * Files embedded in a compiled single-file binary (`bun run build:binaries`).
 *
 * A `bun build --compile` executable has no source tree on disk, so code that
 * reads a sibling file (the React dashboard build, the WebMCP bridge script,
 * the builtin SKILL.md files, chain/team YAML, SOUL.md) finds nothing.
 * scripts/build-binaries.ts generates an entry that imports each such file
 * `with { type: "file" }` (Bun embeds it and hands back a `/$bunfs/...` path)
 * and records the result here, keyed by its repo-relative path, BEFORE it
 * imports src/index.tsx.
 *
 * From source (bun run / npm install) the manifest is absent: every lookup
 * returns null and callers keep reading the source tree as before.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface EmbeddedManifest {
  /** Changes whenever any embedded file changes; names the extraction directory. */
  buildId: string;
  /** Repo-relative path (forward slashes, e.g. `src/skills/tax-prep/SKILL.md`) -> embedded file path. */
  files: Record<string, string>;
}

declare global {
  // eslint-disable-next-line no-var
  var __WILSON_EMBEDDED__: EmbeddedManifest | undefined;
}

function manifest(): EmbeddedManifest | undefined {
  return globalThis.__WILSON_EMBEDDED__;
}

/** True when running as a compiled binary that carries an embedded file manifest. */
export function isCompiledBinary(): boolean {
  return manifest() !== undefined;
}

/** The embedded path for a repo-relative file, or null (not compiled, or not embedded). */
export function embeddedFile(repoPath: string): string | null {
  return manifest()?.files[repoPath] ?? null;
}

/** Text of an embedded file, or null. */
export async function readEmbeddedText(repoPath: string): Promise<string | null> {
  const path = embeddedFile(repoPath);
  if (!path) return null;
  try {
    return await Bun.file(path).text();
  } catch {
    return null;
  }
}

const extracted = new Map<string, string | null>();

/**
 * Copy every embedded file under `repoDir` (e.g. `src/skills`) to a real
 * directory and return the directory that stands in for `repoDir`, for code
 * that scans a directory tree. Extracted once per build id to
 * `~/.openaccountant/bundled/<buildId>/`; later runs of the same build reuse it.
 * Returns null when not compiled or nothing is embedded under `repoDir`.
 * Synchronous on purpose: callers resolve directories at module load.
 */
export function extractEmbeddedDir(
  repoDir: string,
  baseDir: string = join(homedir(), '.openaccountant', 'bundled'),
): string | null {
  const m = manifest();
  if (!m) return null;
  const prefix = repoDir.replace(/\/+$/, '') + '/';
  const cacheKey = `${baseDir}\0${prefix}`;
  if (extracted.has(cacheKey)) return extracted.get(cacheKey)!;

  const entries = Object.entries(m.files).filter(([k]) => k.startsWith(prefix));
  if (entries.length === 0) {
    extracted.set(cacheKey, null);
    return null;
  }

  const root = join(baseDir, m.buildId);
  try {
    for (const [repoPath, embedded] of entries) {
      const dest = join(root, ...repoPath.split('/'));
      if (existsSync(dest)) continue;
      mkdirSync(dirname(dest), { recursive: true });
      // Write then rename, so a second process starting at the same time never reads a half-written file.
      const tmp = `${dest}.${process.pid}.tmp`;
      writeFileSync(tmp, readFileSync(embedded));
      renameSync(tmp, dest);
    }
  } catch (err) {
    console.error(`[embedded] could not extract ${repoDir}:`, err);
    extracted.set(cacheKey, null);
    return null;
  }
  const dir = join(root, ...repoDir.replace(/\/+$/, '').split('/'));
  extracted.set(cacheKey, dir);
  return dir;
}
