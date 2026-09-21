import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Guards issue #37: a stale or downgraded node_modules tree silently broke every
 * WebGPU-tagged model with `Unsupported device` — but only *after* the user had
 * waited out a 350 MB–3.2 GB download. These assertions fail in CI instead.
 */

const repoRoot = join(import.meta.dir, '..', '..');

function installedVersion(pkg: string): string {
  return JSON.parse(
    readFileSync(join(repoRoot, 'node_modules', pkg, 'package.json'), 'utf8'),
  ).version as string;
}

// transformers.js does not re-export its ONNX backend through the package
// `exports` map, so reach the module by file path. The specifier is a variable
// so tsc leaves it alone; the file is shipped in the published package.
const ONNX_BACKEND = join(
  repoRoot,
  'node_modules',
  '@huggingface',
  'transformers',
  'src',
  'backends',
  'onnx.js',
);

describe('transformers.js WebGPU execution provider', () => {
  test('resolves the webgpu device to the webgpu EP', async () => {
    const { deviceToExecutionProviders } = await import(ONNX_BACKEND);
    expect(deviceToExecutionProviders('webgpu')).toEqual(['webgpu']);
  });

  test('still resolves the cpu device, so the CPU model path is unaffected', async () => {
    const { deviceToExecutionProviders } = await import(ONNX_BACKEND);
    expect(deviceToExecutionProviders('cpu')).toEqual(['cpu']);
  });

  test('onnxruntime-node bundles the webgpu backend', async () => {
    const { listSupportedBackends } = await import('onnxruntime-node');
    const names = listSupportedBackends().map((b) => b.name);
    expect(names).toContain('cpu');
    expect(names).toContain('webgpu');
  });
});

describe('installed dependency tree matches the lockfile', () => {
  const declared = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
    dependencies: Record<string, string>;
  };

  test('@huggingface/transformers is the exact version package.json pins', () => {
    const pinned = declared.dependencies['@huggingface/transformers'];
    // Pinned exactly (no range prefix) precisely so this comparison is meaningful.
    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);
    expect(installedVersion('@huggingface/transformers')).toBe(pinned);
  });

  test('onnxruntime-node matches what bun.lock resolved for it', () => {
    const lock = readFileSync(join(repoRoot, 'bun.lock'), 'utf8');
    const match = lock.match(/"onnxruntime-node@(\d+\.\d+\.\d+)"/);
    expect(match).not.toBeNull();
    expect(installedVersion('onnxruntime-node')).toBe(match![1]);
  });
});
