/** S0: PRELABEL_MODEL pins (specs/open-jev-labeler.md §4.1; DECISIONS OQ7, OQ6). */
import { describe, test, expect } from 'bun:test';
import { PRELABEL_MODEL } from '../prelabel/config.js';

describe('PRELABEL_MODEL', () => {
  test('pins the calibrated DeBERTa repo, q4f16 on webgpu at T=1.05', () => {
    expect(PRELABEL_MODEL.repo).toBe('onnx-community/open-jev-deberta-v3-large-ONNX');
    expect(PRELABEL_MODEL.dtype).toBe('q4f16');
    expect(PRELABEL_MODEL.device).toBe('webgpu');
    expect(PRELABEL_MODEL.temperature).toBe(1.05);
    expect(PRELABEL_MODEL.templateVersion).toBe('prelabel-tmpl-v1');
  });

  test('modelId is repo:dtype and matches the judge model pattern', () => {
    expect(PRELABEL_MODEL.modelId).toBe(`${PRELABEL_MODEL.repo}:${PRELABEL_MODEL.dtype}`);
    expect(PRELABEL_MODEL.modelId).toMatch(/^[\w.:\/-]{1,64}$/);
  });

  test('revision is a 40-hex HF commit sha and configSha a 64-hex sha256', () => {
    expect(PRELABEL_MODEL.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(PRELABEL_MODEL.configSha).toMatch(/^[0-9a-f]{64}$/);
  });

  test('no wasm fallback is pinned (OQ6)', () => {
    expect(PRELABEL_MODEL.device).not.toBe('wasm');
    expect(PRELABEL_MODEL.dtype).not.toBe('fp32');
  });
});
