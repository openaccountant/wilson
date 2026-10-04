/**
 * Build gate for the browser-local chat bundles (CI does not build the UI). It is the
 * last step of `npm run build:hybrid`, so a failing check fails the build. It reads
 * dist/index.html, so run `npm run build` first:
 *
 *   cd src/dashboard/ui && npm run build && npm run build:hybrid
 *
 * It can also be run on its own from the repo root: bun run scripts/check-hybrid-build.ts
 *
 * Asserts (specs/browser-subagent.md D1 and section 11):
 *  - dist/index.html (the singlefile app) contains no onnxruntime / transformers.js;
 *  - dist-hybrid/hybrid-chat.js carries exactly ONE ONNX Runtime banner, so
 *    transformers.js ships once, inside the inlined model worker, and the
 *    main-thread half of the chunk imports none;
 *  - the worker is wrapped as a blob module worker and keeps the
 *    opaque-origin refusal;
 *  - dist-hybrid/ holds no stray .js beyond an explicit allowlist (ort/*
 *    excepted), so a second transformers copy cannot slip in unnoticed;
 *  - Round 4: the second allowlisted bundle, prelabel-worker.js (the open-jev worker shared by
 *    the Review tab and the chat router), carries exactly ONE ORT banner of its own, and the
 *    open-jev library appears in no other bundle (not hybrid-chat.js, not the singlefile app).
 *    Presence and the transformers.js version of prelabel-worker.js are owned by
 *    scripts/check-prelabel-bundle.ts, which runs just before this one.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ORT_BANNER = 'ONNX Runtime Web v';
const PRELABEL_WORKER = 'prelabel-worker.js';

/** Top-level .js files allowed in dist-hybrid/. Workflow B's open-jev labeler adds prelabel-worker.js. */
export const ALLOWED_HYBRID_JS: readonly string[] = ['hybrid-chat.js', PRELABEL_WORKER];

/** Strings that mean "a model runtime got bundled". `transformers` alone is NOT one: unified/remark has a `transformers` field. */
const RUNTIME_MARKERS = ['onnxruntime', 'ONNX Runtime', '@huggingface/transformers', 'ort-wasm'];

/** A module import of the open-jev library, or its exported class (user-facing copy may still NAME open-jev). Mirrors src/prelabel/bundle-guard.ts. */
const OPEN_JEV_IMPORT = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*["'`]open-jev(?:\/[^"'`]*)?["'`]/;
const OPEN_JEV_CLASS = /\bOpenJev\b/;

export interface HybridBuildInputs {
  indexHtml: string;
  hybridJs: string;
  /** Entries directly under dist-hybrid/. */
  hybridEntries: string[];
  /** Contents of dist-hybrid/prelabel-worker.js when it exists (absent = not inspected here). */
  prelabelJs?: string | null;
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/**
 * Vite's `?worker&inline` emits the worker as one JS string literal on the
 * first line: `const jsContent = "...";`. Everything after that line is the
 * main-thread half of the chunk.
 */
export function mainThreadPart(hybridJs: string): string | null {
  const m = /^const jsContent = "/.exec(hybridJs);
  if (!m) return null;
  const nl = hybridJs.indexOf('\n');
  return nl === -1 ? '' : hybridJs.slice(nl + 1);
}

export function checkHybridBuild(input: HybridBuildInputs): string[] {
  const problems: string[] = [];

  for (const marker of RUNTIME_MARKERS) {
    if (input.indexHtml.includes(marker)) {
      problems.push(`dist/index.html contains "${marker}" (the singlefile app must not bundle the model runtime)`);
    }
  }

  if (OPEN_JEV_IMPORT.test(input.indexHtml) || OPEN_JEV_CLASS.test(input.indexHtml)) {
    problems.push('dist/index.html contains the open-jev library (it may only live in dist-hybrid/prelabel-worker.js)');
  }

  const banners = count(input.hybridJs, ORT_BANNER);
  if (banners !== 1) {
    problems.push(
      `hybrid-chat.js has ${banners} "${ORT_BANNER}" banners, expected exactly 1 (transformers.js must ship once, inside the model worker)`,
    );
  }

  const main = mainThreadPart(input.hybridJs);
  if (main === null) {
    problems.push('hybrid-chat.js does not start with `const jsContent = "` (the inlined worker string): is the worker still ?worker&inline?');
  } else {
    for (const marker of [ORT_BANNER, 'onnxruntime-web', '@huggingface/transformers']) {
      if (main.includes(marker)) problems.push(`main-thread part of hybrid-chat.js contains "${marker}"`);
    }
  }

  if (OPEN_JEV_IMPORT.test(input.hybridJs) || OPEN_JEV_CLASS.test(input.hybridJs)) {
    problems.push('hybrid-chat.js contains the open-jev library (it may only live in dist-hybrid/prelabel-worker.js)');
  }

  if (typeof input.prelabelJs === 'string') {
    const n = count(input.prelabelJs, ORT_BANNER);
    if (n !== 1) {
      problems.push(`${PRELABEL_WORKER} has ${n} "${ORT_BANNER}" banners, expected exactly 1 (one transformers.js copy per bundle)`);
    }
  }

  if (!input.hybridJs.includes('new Worker(')) problems.push('hybrid-chat.js has no `new Worker(` wrapper');
  if (!input.hybridJs.includes('createObjectURL')) problems.push('hybrid-chat.js worker wrapper has no blob URL path');
  if (!input.hybridJs.includes('does not match page origin')) {
    problems.push('the worker lost its opaque-origin refusal (checkWorkerOrigin)');
  }

  for (const entry of input.hybridEntries) {
    if (entry.endsWith('.js') && !ALLOWED_HYBRID_JS.includes(entry)) {
      problems.push(`unexpected dist-hybrid/${entry} (allowlist: ${ALLOWED_HYBRID_JS.join(', ')})`);
    }
  }
  return problems;
}

if (import.meta.main) {
  const uiDir = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'src', 'dashboard', 'ui');
  const indexPath = join(uiDir, 'dist', 'index.html');
  const hybridDir = join(uiDir, 'dist-hybrid');
  const hybridPath = join(hybridDir, 'hybrid-chat.js');
  for (const p of [indexPath, hybridPath]) {
    if (!existsSync(p)) {
      console.error(`check-hybrid-build: missing ${p}; run npm run build && npm run build:hybrid first`);
      process.exit(1);
    }
  }
  const prelabelPath = join(hybridDir, PRELABEL_WORKER);
  const problems = checkHybridBuild({
    indexHtml: readFileSync(indexPath, 'utf8'),
    hybridJs: readFileSync(hybridPath, 'utf8'),
    hybridEntries: readdirSync(hybridDir),
    prelabelJs: existsSync(prelabelPath) ? readFileSync(prelabelPath, 'utf8') : null,
  });
  if (problems.length > 0) {
    console.error(`check-hybrid-build: FAILED\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    process.exit(1);
  }
  console.log('check-hybrid-build: ok (one ORT banner per bundle, worker inlined, singlefile app clean)');
}
