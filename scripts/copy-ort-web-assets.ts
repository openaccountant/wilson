/**
 * Copy the onnxruntime-web binaries next to the prebuilt hybrid chunk so the
 * browser can load them same-origin.
 *
 * @huggingface/transformers v4 pre-bundles onnxruntime-web (JS side) but the
 * actual .wasm binaries + their .mjs loaders live in the onnxruntime-web
 * package; the library's default wasmPaths points at a public CDN. The hybrid
 * chunk overrides wasmPaths to /assets/ort/ (same-origin), and this script
 * populates src/dashboard/ui/dist-hybrid/ort/ from the installed dependency.
 *
 * Run after `vite build --config vite.hybrid.config.ts` (npm run build:hybrid).
 */

import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(repoRoot, 'src', 'dashboard', 'ui', 'dist-hybrid', 'ort');

const require = createRequire(import.meta.url);

/** Locate <pkgRoot>/dist for an installed package, wherever node_modules puts it. */
function distDirOf(pkg: string): string | null {
  try {
    const entry = require.resolve(pkg);
    const marker = `node_modules/${pkg}/`;
    const idx = entry.lastIndexOf(marker);
    const pkgRoot = idx >= 0 ? entry.slice(0, idx + marker.length - 1) : dirname(dirname(entry));
    const dist = join(pkgRoot, 'dist');
    return existsSync(dist) ? dist : null;
  } catch {
    return null;
  }
}

// onnxruntime-web's dist has every build variant (the jsep pair is the WebGPU
// path); transformers' own dist ships one loader .mjs but no binaries. Try the
// full dist first, fall back to transformers'.
const sources = [distDirOf('onnxruntime-web'), distDirOf('@huggingface/transformers')].filter(
  (d): d is string => d !== null,
);

if (sources.length === 0) {
  console.error(
    'copy-ort-web-assets: none of the expected packages were found.\n' +
      'Expected onnxruntime-web (transitive dep of @huggingface/transformers) — run `bun install` first.',
  );
  process.exit(1);
}

const WASM_PREFIX = 'ort-wasm-simd-threaded';
mkdirSync(outDir, { recursive: true });

let copied = 0;
for (const src of sources) {
  for (const name of readdirSync(src)) {
    // Only the runtime files ORT actually fetches: the threaded wasm builds
    // and their .mjs loaders.
    if (!name.startsWith(WASM_PREFIX)) continue;
    if (!name.endsWith('.wasm') && !name.endsWith('.mjs')) continue;
    cpSync(join(src, name), join(outDir, name));
    copied++;
  }
}

if (copied === 0) {
  console.error(`copy-ort-web-assets: no ${WASM_PREFIX}.* files found in:\n  ${sources.join('\n  ')}`);
  process.exit(1);
}

console.log(`copy-ort-web-assets: copied ${copied} ort files -> ${outDir}`);