import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  OPEN_JEV_CHAT_TIMEOUT_MS,
  OPEN_JEV_ROUTE_CUT,
  OPEN_JEV_ROUTE_OPTIONS,
  OPEN_JEV_ROUTE_OPTION_MODE,
  OPEN_JEV_ROUTE_QUESTION,
} from '../dashboard/ui/src/hybrid/openjev-route.js';
import { PRELABEL_MODEL } from '../prelabel/config.js';

/**
 * Round 4 §5 "Freeze": the cut, option strings, question and model pins chosen on DEV data
 * are recorded in specs/eval/round4-openjev-frozen.json, committed before any held-out
 * arm-O run. The product constants must equal it, so a later edit to the router (or a
 * re-tune) fails here instead of silently invalidating the measurement.
 */

const ROOT = new URL('../../', import.meta.url);
const frozen = JSON.parse(readFileSync(new URL('specs/eval/round4-openjev-frozen.json', ROOT), 'utf8'));

describe('round4-openjev-frozen.json', () => {
  test('OPEN_JEV_ROUTE_CUT equals the frozen cut (null = arm O disabled)', () => {
    expect(OPEN_JEV_ROUTE_CUT).toBe(frozen.cut);
  });

  test('the question and the option strings equal the frozen ones', () => {
    expect(frozen.question).toBe(OPEN_JEV_ROUTE_QUESTION);
    expect(frozen.options).toEqual({ ...OPEN_JEV_ROUTE_OPTIONS });
    // With no viable cut nothing was frozen for the option rendering; otherwise it must match.
    if (frozen.cut !== null) expect(frozen.optionMode).toBe(OPEN_JEV_ROUTE_OPTION_MODE);
    else expect(frozen.optionMode).toBeNull();
    expect(frozen.chatTimeoutMs).toBe(OPEN_JEV_CHAT_TIMEOUT_MS);
  });

  test('the model pins equal the pre-labeler pins (one open-jev model, no second pin)', () => {
    expect(frozen.pins).toEqual({
      repo: PRELABEL_MODEL.repo,
      revision: PRELABEL_MODEL.revision,
      configSha: PRELABEL_MODEL.configSha,
      temperature: PRELABEL_MODEL.temperature,
      dtype: PRELABEL_MODEL.dtype,
      device: PRELABEL_MODEL.device,
    });
  });

  test('the cut was chosen on dev files only, and they are unchanged since', () => {
    expect(frozen.devFiles.map((f: { name: string }) => f.name)).toEqual(['v1-burned', 'v2', 'v3', 'spike-route']);
    for (const f of frozen.devFiles as Array<{ path: string; sha256: string }>) {
      expect(f.path).not.toMatch(/heldout-router\.v([4-9]|\d{2,})/);
      const sha = createHash('sha256').update(readFileSync(new URL(f.path, ROOT))).digest('hex');
      expect(sha, f.path).toBe(f.sha256);
    }
  });
});
