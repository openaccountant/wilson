import { describe, expect, test } from 'bun:test';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Round 2: scripts/check-hybrid-build.ts used to be a manual step nobody had to
 * run, so a second transformers.js copy or a leaked model runtime could ship
 * silently. `npm run build:hybrid` now ends with it, so the build itself fails.
 */

const GOOD_HYBRID_JS =
  'const jsContent = "ONNX Runtime Web v1.2.3 does not match page origin";\nexport const x = 1; new Worker(URL.createObjectURL(b));';

const uiDir = new URL('../dashboard/ui/', import.meta.url);
const pkg = JSON.parse(readFileSync(new URL('package.json', uiDir), 'utf8')) as { scripts: Record<string, string> };

describe('build:hybrid enforces scripts/check-hybrid-build.ts', () => {
  const script = pkg.scripts['build:hybrid'];

  test('the script chains the check after the build and the asset copy, with && so a failure fails the build', () => {
    const steps = script.split('&&').map((s) => s.trim());
    const build = steps.findIndex((s) => s.startsWith('vite build --config vite.hybrid.config.ts'));
    const copy = steps.findIndex((s) => s.includes('copy-ort-web-assets.ts'));
    const check = steps.findIndex((s) => s.includes('check-hybrid-build.ts'));
    expect(build).toBe(0);
    expect(copy).toBeGreaterThan(build);
    expect(check).toBeGreaterThan(copy);
    expect(check).toBe(steps.length - 1);
    expect(steps[check].startsWith('bun run ')).toBe(true);
  });

  test('the path in the script resolves, from the ui directory, to the real check script', () => {
    const rel = script.split('&&').map((s) => s.trim()).find((s) => s.includes('check-hybrid-build.ts'))!.replace(/^bun run /, '');
    expect(existsSync(resolve(uiDir.pathname, rel))).toBe(true);
  });

  test('run as a program, the check exits 1 on missing or broken builds and 0 on a clean one', () => {
    // The script finds the UI dir relative to its own location, so run a copy inside a throwaway tree.
    const root = mkdtempSync(join(tmpdir(), 'hybrid-gate-'));
    try {
      mkdirSync(join(root, 'scripts'), { recursive: true });
      copyFileSync(new URL('../../scripts/check-hybrid-build.ts', import.meta.url), join(root, 'scripts/check-hybrid-build.ts'));
      const ui = join(root, 'src/dashboard/ui');
      mkdirSync(join(ui, 'dist-hybrid'), { recursive: true });
      mkdirSync(join(ui, 'dist'), { recursive: true });
      const run = () => Bun.spawnSync(['bun', 'run', join(root, 'scripts/check-hybrid-build.ts')], { cwd: root });
      const err = (r: ReturnType<typeof run>) => new TextDecoder().decode(r.stderr);

      const missing = run();
      expect(missing.exitCode).toBe(1);
      expect(err(missing)).toContain('check-hybrid-build: missing');

      writeFileSync(join(ui, 'dist/index.html'), '<script>onnxruntime</script>');
      writeFileSync(join(ui, 'dist-hybrid/hybrid-chat.js'), GOOD_HYBRID_JS);
      const broken = run();
      expect(broken.exitCode).toBe(1);
      expect(err(broken)).toContain('FAILED');

      writeFileSync(join(ui, 'dist/index.html'), '<html></html>');
      expect(run().exitCode).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// scripts/ sits outside tsconfig's rootDir (src), so load it through a computed specifier.
const gatePath = new URL('../../scripts/check-hybrid-build.ts', import.meta.url).pathname;
const { checkHybridBuild, mainThreadPart } = (await import(gatePath)) as {
  checkHybridBuild(input: { indexHtml: string; hybridJs: string; hybridEntries: string[] }): string[];
  mainThreadPart(hybridJs: string): string | null;
};

describe('checkHybridBuild flags a broken build', () => {
  const good = {
    indexHtml: '<html></html>',
    hybridJs: GOOD_HYBRID_JS,
    hybridEntries: ['hybrid-chat.js', 'ort'],
  };

  test('a clean build has no problems', () => {
    expect(mainThreadPart(good.hybridJs)).not.toBeNull();
    expect(checkHybridBuild(good)).toEqual([]);
  });

  test('a model runtime in the singlefile app, a second ORT banner and a stray .js are each reported', () => {
    const problems = checkHybridBuild({
      indexHtml: '<script>onnxruntime</script>',
      hybridJs: good.hybridJs + '\n// ONNX Runtime Web v9',
      hybridEntries: ['hybrid-chat.js', 'transformers-copy.js'],
    });
    expect(problems.some((p) => p.includes('dist/index.html contains "onnxruntime"'))).toBe(true);
    expect(problems.some((p) => p.includes('banners, expected exactly 1'))).toBe(true);
    expect(problems.some((p) => p.includes('unexpected dist-hybrid/transformers-copy.js'))).toBe(true);
  });
});
