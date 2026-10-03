/** S2: provenance type and templated rationale (specs/open-jev-labeler.md §4.1, §12). */
import { describe, test, expect } from 'bun:test';
import { PRELABEL_MODEL } from '../prelabel/config.js';
import {
  MODEL_ID_PATTERN,
  PROVENANCE_SCHEMA,
  templateRationale,
  type PrelabelProvenanceV1,
} from '../prelabel/provenance.js';

function prov(over: Partial<PrelabelProvenanceV1> = {}): PrelabelProvenanceV1 {
  return {
    schema: PROVENANCE_SCHEMA,
    modelId: PRELABEL_MODEL.modelId,
    repo: PRELABEL_MODEL.repo,
    dtype: PRELABEL_MODEL.dtype,
    device: PRELABEL_MODEL.device,
    temperature: PRELABEL_MODEL.temperature,
    templateVersion: PRELABEL_MODEL.templateVersion,
    labelSetVersion: 'cat-18-0f7b02225108',
    margin: 0.31,
    p1: 0.5,
    p2: 0.19,
    top2: [['Dining', 0.5], ['Groceries', 0.19]],
    configSha: PRELABEL_MODEL.configSha,
    runtime: { transformers: '4.3.0', ort: '1.31.0', openJev: '0.1.2', device: 'webgpu', dtype: 'q4f16' },
    runId: '6f1b1c3e-3c1c-4a0e-9c55-0d7f6f7e2a11',
    ...over,
  };
}

describe('provenance', () => {
  test('schema tag', () => {
    expect(PROVENANCE_SCHEMA).toBe('prelabel-prov/1');
    expect(prov().schema).toBe('prelabel-prov/1');
  });

  test('modelId matches the judge judgeModel pattern, and so does the pinned one', () => {
    expect(MODEL_ID_PATTERN.source).toBe('^[\\w.:\\/-]{1,64}$');
    expect(MODEL_ID_PATTERN.test(prov().modelId)).toBe(true);
    expect(PRELABEL_MODEL.modelId.length).toBe(51);
    expect(MODEL_ID_PATTERN.test('x'.repeat(65))).toBe(false);
    expect(MODEL_ID_PATTERN.test('has space')).toBe(false);
    expect(MODEL_ID_PATTERN.test('')).toBe(false);
  });
});

describe('templateRationale', () => {
  test('is the honest templated sentence', () => {
    expect(templateRationale(prov())).toBe(
      'open-jev (DeBERTa q4f16, T=1.05) chose Dining over Groceries at margin 0.31; discriminative score, no free-text reasoning.',
    );
  });

  test('length stays within 20..600 for extreme margins', () => {
    for (const margin of [0, 1, -1, 5, 1e9, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0.004999, 0.995]) {
      const s = templateRationale(prov({ margin }));
      expect(s.length).toBeGreaterThanOrEqual(20);
      expect(s.length).toBeLessThanOrEqual(600);
      expect(s).not.toContain('NaN');
      expect(s).not.toContain('Infinity');
    }
  });

  test('margin is clamped into [0, 1]', () => {
    expect(templateRationale(prov({ margin: 7 }))).toContain('margin 1.00;');
    expect(templateRationale(prov({ margin: -3 }))).toContain('margin 0.00;');
    expect(templateRationale(prov({ margin: Number.NaN }))).toContain('margin 0.00;');
  });

  test('very long category names cannot push it past 600 chars', () => {
    const long = 'L'.repeat(5000);
    const s = templateRationale(prov({ top2: [[long, 0.5], [long, 0.2]] }));
    expect(s.length).toBeLessThanOrEqual(600);
    expect(s.length).toBeGreaterThanOrEqual(20);
  });

  test('category names are sanitized: no control characters or newlines reach the sentence', () => {
    const s = templateRationale(prov({ top2: [['Din\ning\r\t\u0000\u202e', 0.5], ['  Gro\u2028ceries  ', 0.2]] }));
    // eslint-disable-next-line no-control-regex
    expect(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e]/.test(s)).toBe(false);
    expect(s).toContain('chose Din ing over Gro ceries at');
  });

  test('empty or blank names fall back to a placeholder instead of an empty gap', () => {
    const s = templateRationale(prov({ top2: [['', 0.5], ['   ', 0.2]] }));
    expect(s).toContain('chose (unnamed) over (unnamed) at');
    expect(s.length).toBeGreaterThanOrEqual(20);
  });
});
