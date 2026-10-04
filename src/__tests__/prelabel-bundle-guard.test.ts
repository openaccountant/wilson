/**
 * S0 (specs/open-jev-labeler.md §13, §14): build guard for the prelabel worker.
 *
 * The pure checker is exercised against synthetic bundles so these tests are
 * never vacuous (CI never builds dist/). When a real build exists on disk the
 * same checker is also run against it.
 */
import { describe, test, expect } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkPrelabelBundles } from '../prelabel/bundle-guard.js';

const ROOT = join(import.meta.dir, '..', '..');
const UI = join(ROOT, 'src', 'dashboard', 'ui');
const V = '4.3.0';

const goodWorker = `// worker\nvar VERSION = "${V}";\nvar env = { version: VERSION };\n`;

describe('checkPrelabelBundles', () => {
  test('clean singlefile html and a worker with one transformers copy pass', () => {
    expect(checkPrelabelBundles({ indexHtml: '<html>react app</html>', workerJs: goodWorker, transformersVersion: V })).toEqual([]);
  });

  test('singlefile html containing open-jev fails', () => {
    const problems = checkPrelabelBundles({ indexHtml: '<script>import "open-jev"</script>', workerJs: goodWorker, transformersVersion: V });
    expect(problems.some((p) => p.includes('open-jev'))).toBe(true);
  });

  test('user-facing copy that names open-jev is not the library (S5 UI text)', () => {
    const copy = `<script>D.jsx("span",{children:"Second opinion (open-jev): off"});const T="open-jev's margin between its top two";x="open-jev needs WebGPU"</script>`;
    expect(checkPrelabelBundles({ indexHtml: copy, workerJs: goodWorker, transformersVersion: V })).toEqual([]);
  });

  test('every way of importing the library still fails', () => {
    for (const html of [
      `import{OpenJev as a}from"open-jev";`,
      `import x from 'open-jev'`,
      'const m=await import(`open-jev`)',
      `const m = require("open-jev")`,
      `import("open-jev/dist/index.js")`,
      `a=OpenJev.load({model:"x"})`,
    ]) {
      const problems = checkPrelabelBundles({ indexHtml: html, workerJs: goodWorker, transformersVersion: V });
      expect(problems.some((p) => p.includes('open-jev'))).toBe(true);
    }
  });

  test('singlefile html containing onnxruntime fails (case-insensitive)', () => {
    const problems = checkPrelabelBundles({ indexHtml: 'x OnnxRuntime-Web y', workerJs: goodWorker, transformersVersion: V });
    expect(problems.some((p) => p.toLowerCase().includes('onnxruntime'))).toBe(true);
  });

  test('missing singlefile html is allowed (build:hybrid can run without build)', () => {
    expect(checkPrelabelBundles({ indexHtml: null, workerJs: goodWorker, transformersVersion: V })).toEqual([]);
  });

  test('missing worker bundle fails', () => {
    const problems = checkPrelabelBundles({ indexHtml: null, workerJs: null, transformersVersion: V });
    expect(problems.some((p) => p.includes('prelabel-worker.js'))).toBe(true);
  });

  test('worker with no transformers copy fails', () => {
    const problems = checkPrelabelBundles({ indexHtml: null, workerJs: 'console.log(1)', transformersVersion: V });
    expect(problems.some((p) => p.includes('transformers'))).toBe(true);
  });

  test('worker with two transformers copies fails', () => {
    const two = `${goodWorker}\n${goodWorker}`;
    const problems = checkPrelabelBundles({ indexHtml: null, workerJs: two, transformersVersion: V });
    expect(problems.some((p) => p.includes('2 transformers'))).toBe(true);
  });

  test('a different library VERSION constant is not counted', () => {
    const other = `${goodWorker}\nvar VERSION = "1.2.3";\n`;
    expect(checkPrelabelBundles({ indexHtml: null, workerJs: other, transformersVersion: V })).toEqual([]);
  });
});

describe('real build output (only when built)', () => {
  const indexPath = join(UI, 'dist', 'index.html');
  const workerPath = join(UI, 'dist-hybrid', 'prelabel-worker.js');
  const built = existsSync(indexPath) && existsSync(workerPath);

  test.skipIf(!built)('dist/index.html and dist-hybrid/prelabel-worker.js pass the guard', () => {
    const version = JSON.parse(readFileSync(join(ROOT, 'node_modules', '@huggingface', 'transformers', 'package.json'), 'utf8')).version as string;
    const problems = checkPrelabelBundles({
      indexHtml: readFileSync(indexPath, 'utf8'),
      workerJs: readFileSync(workerPath, 'utf8'),
      transformersVersion: version,
    });
    expect(problems).toEqual([]);
  });
});

describe('S0 plumbing wiring', () => {
  test('open-jev is a pinned (exact) devDependency', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.devDependencies['open-jev']).toBe('0.1.2');
  });

  test('build:hybrid builds the prelabel worker after the hybrid build and runs the guard', () => {
    const pkg = JSON.parse(readFileSync(join(UI, 'package.json'), 'utf8'));
    const script: string = pkg.scripts['build:hybrid'];
    const hybrid = script.indexOf('vite.hybrid.config.ts');
    const prelabel = script.indexOf('vite.prelabel.config.ts');
    const guard = script.indexOf('check-prelabel-bundle');
    expect(hybrid).toBeGreaterThanOrEqual(0);
    expect(prelabel).toBeGreaterThan(hybrid);
    expect(guard).toBeGreaterThan(prelabel);
  });

  test('prelabel vite config does not empty the shared output dir', () => {
    const cfg = readFileSync(join(UI, 'vite.prelabel.config.ts'), 'utf8');
    expect(cfg).toContain('emptyOutDir: false');
    expect(cfg).toContain('inlineDynamicImports: true');
    expect(cfg).toContain('onnxruntime-web-use-extern-wasm');
    expect(cfg).toContain('prelabel-worker.js');
  });

  test('dependabot ignores open-jev', () => {
    const yml = readFileSync(join(ROOT, '.github', 'dependabot.yml'), 'utf8');
    expect(yml).toMatch(/ignore:[\s\S]*?- dependency-name: "open-jev"/);
  });
});
