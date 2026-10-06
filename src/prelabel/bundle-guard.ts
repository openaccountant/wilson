/**
 * Pure bundle checks for the open-jev prelabel build (specs/open-jev-labeler.md
 * §13, S0). Lives under src/ so it is typechecked and bun-tested;
 * scripts/check-prelabel-bundle.ts is the thin CLI that feeds it real files at
 * the end of `npm run build:hybrid` (a failing guard fails the build).
 *
 * Invariants:
 *  - the singlefile React bundle (dist/index.html) must never contain the
 *    open-jev LIBRARY (an import/require of it, or its `OpenJev` class) or
 *    onnxruntime. User-facing copy may NAME open-jev ("Second opinion
 *    (open-jev)"), so a bare substring is not a violation;
 *  - dist-hybrid/prelabel-worker.js must exist and bundle exactly ONE copy of
 *    transformers.js (a second copy means open-jev resolved a different
 *    instance than the one the worker configures via `env`).
 */

export interface BundleGuardInput {
  /** Contents of ui/dist/index.html, or null when `npm run build` was not run. */
  indexHtml: string | null;
  /** Contents of ui/dist-hybrid/prelabel-worker.js, or null when missing. */
  workerJs: string | null;
  /** Installed @huggingface/transformers version (its bundle has `var VERSION = "<v>"`). */
  transformersVersion: string;
}

/** A module specifier import of the library: from"open-jev", import("open-jev/..."), require('open-jev'). */
const OPEN_JEV_IMPORT = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*["'`]open-jev(?:\/[^"'`]*)?["'`]/;
/** The library's exported class, which a bundled copy would keep (it is not a UI word). */
const OPEN_JEV_CLASS = /\bOpenJev\b/;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function checkPrelabelBundles(input: BundleGuardInput): string[] {
  const problems: string[] = [];

  if (input.indexHtml !== null) {
    const lower = input.indexHtml.toLowerCase();
    if (OPEN_JEV_IMPORT.test(input.indexHtml) || OPEN_JEV_CLASS.test(input.indexHtml)) {
      problems.push('dist/index.html (singlefile React bundle) contains "open-jev" library code; it may only live in dist-hybrid');
    }
    if (lower.includes('onnxruntime')) {
      problems.push('dist/index.html (singlefile React bundle) contains "onnxruntime"; it may only live in dist-hybrid');
    }
  }

  if (input.workerJs === null) {
    problems.push('dist-hybrid/prelabel-worker.js is missing; run the prelabel vite build after the hybrid build');
  } else {
    const re = new RegExp(`^\\s*var VERSION = "${escapeRe(input.transformersVersion)}";`, 'gm');
    const copies = (input.workerJs.match(re) ?? []).length;
    if (copies === 0) {
      problems.push(`prelabel-worker.js has no transformers ${input.transformersVersion} copy`);
    } else if (copies > 1) {
      problems.push(`prelabel-worker.js bundles ${copies} transformers copies (expected exactly 1)`);
    }
  }

  return problems;
}
