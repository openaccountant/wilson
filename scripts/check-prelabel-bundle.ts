/**
 * Fail the build if the prelabel bundles break their invariants
 * (src/prelabel/bundle-guard.ts). Run at the end of `npm run build:hybrid`
 * from src/dashboard/ui, and safe to run from anywhere.
 *
 * The bun test of the same checker skips the real-file case when dist/ is
 * absent (CI), so this script is what actually enforces the guard.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPrelabelBundles } from '../src/prelabel/bundle-guard.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ui = join(repoRoot, 'src', 'dashboard', 'ui');
const indexPath = join(ui, 'dist', 'index.html');
const workerPath = join(ui, 'dist-hybrid', 'prelabel-worker.js');

const read = (p: string): string | null => (existsSync(p) ? readFileSync(p, 'utf8') : null);
const transformersVersion = JSON.parse(
  readFileSync(join(repoRoot, 'node_modules', '@huggingface', 'transformers', 'package.json'), 'utf8'),
).version as string;

const indexHtml = read(indexPath);
if (indexHtml === null) {
  console.warn('check-prelabel-bundle: dist/index.html not found (run `npm run build` too); skipping the singlefile check');
}

const problems = checkPrelabelBundles({ indexHtml, workerJs: read(workerPath), transformersVersion });
if (problems.length > 0) {
  console.error('check-prelabel-bundle: FAILED\n' + problems.map((p) => `  - ${p}`).join('\n'));
  process.exit(1);
}
console.log(`check-prelabel-bundle: ok (transformers ${transformersVersion}, one copy in prelabel-worker.js)`);
