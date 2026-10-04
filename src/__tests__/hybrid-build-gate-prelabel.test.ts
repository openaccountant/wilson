import { describe, expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Round 4, R4-7: the hybrid build now ships TWO bundles that each carry transformers.js
 * (hybrid-chat.js with the inlined Qwen worker, and prelabel-worker.js with open-jev).
 * check-hybrid-build must allow the second file but still hold the line: exactly one ORT
 * banner in EACH bundle, and no open-jev library in the chat chunk or the singlefile app.
 */

const gatePath = new URL('../../scripts/check-hybrid-build.ts', import.meta.url).pathname;
const gate = (await import(gatePath)) as {
  ALLOWED_HYBRID_JS: readonly string[];
  checkHybridBuild(input: { indexHtml: string; hybridJs: string; hybridEntries: string[]; prelabelJs?: string | null }): string[];
};

const HYBRID_JS = 'const jsContent = "ONNX Runtime Web v1.2.3 does not match page origin";\nexport const x = 1; new Worker(URL.createObjectURL(b));';
const PRELABEL_JS = '/*! ONNX Runtime Web v1.2.3 */\nvar VERSION = "4.3.0";\nexport class OpenJev {}';
const good = { indexHtml: '<html></html>', hybridJs: HYBRID_JS, hybridEntries: ['hybrid-chat.js', 'prelabel-worker.js', 'ort'], prelabelJs: PRELABEL_JS };

describe('check-hybrid-build with the prelabel worker', () => {
  test('both bundles allowlisted, one banner each: clean', () => {
    expect(gate.ALLOWED_HYBRID_JS).toEqual(['hybrid-chat.js', 'prelabel-worker.js']);
    expect(gate.checkHybridBuild(good)).toEqual([]);
  });

  test('prelabel-worker.js without its content to inspect is still allowed (the standalone bundle guard owns presence)', () => {
    expect(gate.checkHybridBuild({ ...good, prelabelJs: undefined })).toEqual([]);
    expect(gate.checkHybridBuild({ ...good, prelabelJs: null })).toEqual([]);
  });

  test('a second ORT banner in the prelabel bundle is reported', () => {
    const problems = gate.checkHybridBuild({ ...good, prelabelJs: PRELABEL_JS + '\n// ONNX Runtime Web v9' });
    expect(problems.some((p) => p.includes('prelabel-worker.js has 2') && p.includes('expected exactly 1'))).toBe(true);
  });

  test('no ORT banner in the prelabel bundle is reported (a broken build is not "clean")', () => {
    const problems = gate.checkHybridBuild({ ...good, prelabelJs: 'export class OpenJev {}' });
    expect(problems.some((p) => p.includes('prelabel-worker.js has 0'))).toBe(true);
  });

  test('a third bundle (any other .js) is reported', () => {
    const problems = gate.checkHybridBuild({ ...good, hybridEntries: [...good.hybridEntries, 'second-transformers.js'] });
    expect(problems.some((p) => p.includes('unexpected dist-hybrid/second-transformers.js'))).toBe(true);
  });

  test('the chat chunk must not bundle the open-jev library (it lives only in prelabel-worker.js)', () => {
    for (const leak of ['import{OpenJev}from"open-jev";', 'class OpenJev { }']) {
      const problems = gate.checkHybridBuild({ ...good, hybridJs: HYBRID_JS + '\n' + leak });
      expect(problems.some((p) => p.includes('hybrid-chat.js') && p.includes('open-jev')), leak).toBe(true);
    }
  });

  test('the singlefile app may name open-jev in copy but not bundle the library or a runtime', () => {
    expect(gate.checkHybridBuild({ ...good, indexHtml: '<p>Second opinion (open-jev)</p><script>const w="/assets/prelabel-worker.js"</script>' })).toEqual([]);
    const problems = gate.checkHybridBuild({ ...good, indexHtml: '<script>import {OpenJev} from "open-jev"</script>' });
    expect(problems.some((p) => p.includes('dist/index.html') && p.includes('open-jev'))).toBe(true);
  });

  test('as a program: reads dist-hybrid/prelabel-worker.js when present and exits 1 on a duplicate banner', () => {
    const root = mkdtempSync(join(tmpdir(), 'hybrid-gate-prelabel-'));
    try {
      mkdirSync(join(root, 'scripts'), { recursive: true });
      copyFileSync(gatePath, join(root, 'scripts/check-hybrid-build.ts'));
      const ui = join(root, 'src/dashboard/ui');
      mkdirSync(join(ui, 'dist-hybrid'), { recursive: true });
      mkdirSync(join(ui, 'dist'), { recursive: true });
      writeFileSync(join(ui, 'dist/index.html'), '<html></html>');
      writeFileSync(join(ui, 'dist-hybrid/hybrid-chat.js'), HYBRID_JS);
      writeFileSync(join(ui, 'dist-hybrid/prelabel-worker.js'), PRELABEL_JS);
      const run = () => Bun.spawnSync(['bun', 'run', join(root, 'scripts/check-hybrid-build.ts')], { cwd: root });
      expect(run().exitCode).toBe(0);
      writeFileSync(join(ui, 'dist-hybrid/prelabel-worker.js'), PRELABEL_JS + '\n// ONNX Runtime Web v9');
      const bad = run();
      expect(bad.exitCode).toBe(1);
      expect(new TextDecoder().decode(bad.stderr)).toContain('prelabel-worker.js has 2');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
