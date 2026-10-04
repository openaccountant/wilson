/** Round 4, R4-4: the `choose`/`chosen` protocol messages and the optional init.labels. */
import { describe, test, expect } from 'bun:test';
import {
  CHOOSE_MAX_OPTIONS,
  CHOOSE_MAX_STATE_CHARS,
  CHOOSE_MIN_OPTIONS,
  parseFromWorker,
  parseToWorker,
  type FromWorker,
  type PrelabelPins,
  type ToWorker,
} from '../dashboard/ui/src/prelabel/protocol.js';

const pins: PrelabelPins = {
  repo: 'onnx-community/open-jev-deberta-v3-large-ONNX',
  dtype: 'q4f16',
  device: 'webgpu',
  temperature: 1.05,
  templateVersion: 'prelabel-tmpl-v1',
  modelId: 'onnx-community/open-jev-deberta-v3-large-ONNX:q4f16',
  revision: '7c79f25b5ac496089f448a969c801872ad59d31c',
  configSha: '2ec35432332ee6b5880509eefe44e6279fd9d3543f6ba96098119ffe0b0c2d5e',
};
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

const choose = (over: Record<string, unknown> = {}) => ({
  v: 1, type: 'choose', reqId: 'c1', state: 'What was my income last month?',
  question: 'Which tool should answer this user question?', options: ['net_worth', 'forecast'], ...over,
});

describe('init.labels is optional (chat-only host)', () => {
  const base = { v: 1, type: 'init', pins, labelSetVersion: '', assetBase: '/assets/' };
  test('init without a labels key parses', () => {
    expect(parseToWorker(clone(base))).toEqual(base as unknown as ToWorker);
  });
  test('init with labels still parses; an EMPTY labels list and a non-array are refused', () => {
    expect(parseToWorker({ ...base, labels: ['Dining', 'Other'] })).not.toBeNull();
    expect(parseToWorker({ ...base, labels: [] })).toBeNull();
    expect(parseToWorker({ ...base, labels: 'Dining' })).toBeNull();
    expect(parseToWorker({ ...base, labels: ['Dining', ''] })).toBeNull();
  });
  test('strict parse is kept: an extra key still rejects', () => {
    expect(parseToWorker({ ...base, extra: 1 })).toBeNull();
  });
});

describe('parseToWorker choose', () => {
  test('round-trips, with and without descriptions', () => {
    expect(parseToWorker(clone(choose()))).toEqual(choose() as unknown as ToWorker);
    const withDesc = choose({ descriptions: { net_worth: 'Net worth summary.', forecast: 'Projection.' } });
    expect(parseToWorker(clone(withDesc))).toEqual(withDesc as unknown as ToWorker);
  });
  test('options must number 2..8, be non-empty strings and be unique', () => {
    expect(CHOOSE_MIN_OPTIONS).toBe(2);
    expect(CHOOSE_MAX_OPTIONS).toBe(8);
    expect(parseToWorker(choose({ options: ['a'] }))).toBeNull();
    expect(parseToWorker(choose({ options: [] }))).toBeNull();
    expect(parseToWorker(choose({ options: Array.from({ length: 9 }, (_, i) => `o${i}`) }))).toBeNull();
    expect(parseToWorker(choose({ options: Array.from({ length: 8 }, (_, i) => `o${i}`) }))).not.toBeNull();
    expect(parseToWorker(choose({ options: ['a', ''] }))).toBeNull();
    expect(parseToWorker(choose({ options: ['a', 7] }))).toBeNull();
    expect(parseToWorker(choose({ options: ['a', 'a'] }))).toBeNull();
    expect(parseToWorker(choose({ options: 'a,b' }))).toBeNull();
  });
  test('state is at most 512 characters; question and reqId are non-empty', () => {
    expect(CHOOSE_MAX_STATE_CHARS).toBe(512);
    expect(parseToWorker(choose({ state: 'x'.repeat(512) }))).not.toBeNull();
    expect(parseToWorker(choose({ state: 'x'.repeat(513) }))).toBeNull();
    expect(parseToWorker(choose({ state: '' }))).toBeNull();
    expect(parseToWorker(choose({ question: '' }))).toBeNull();
    expect(parseToWorker(choose({ reqId: '' }))).toBeNull();
    expect(parseToWorker(choose({ reqId: 5 }))).toBeNull();
  });
  test('descriptions may only describe listed options, with string values', () => {
    expect(parseToWorker(choose({ descriptions: { other: 'x' } }))).toBeNull();
    expect(parseToWorker(choose({ descriptions: { net_worth: 3 } }))).toBeNull();
    expect(parseToWorker(choose({ descriptions: [] }))).toBeNull();
  });
  test('extra or missing keys reject', () => {
    expect(parseToWorker(choose({ extra: 1 }))).toBeNull();
    const { options: _o, ...noOptions } = choose();
    expect(parseToWorker(noOptions)).toBeNull();
  });
});

describe('parseFromWorker chosen', () => {
  const okMsg = {
    v: 1, type: 'chosen', reqId: 'c1', ok: true, choice: 'net_worth', p1: 0.6, p2: 0.2, margin: 0.4,
    top2: [['net_worth', 0.6], ['forecast', 0.2]], ms: 84,
  };
  test('ok and failure shapes round-trip', () => {
    expect(parseFromWorker(clone(okMsg))).toEqual(okMsg as unknown as FromWorker);
    for (const reason of ['not_loaded', 'decide_error', 'options_too_large']) {
      const m = { v: 1, type: 'chosen', reqId: 'c1', ok: false, reason };
      expect(parseFromWorker(clone(m))).toEqual(m as unknown as FromWorker);
    }
  });
  test('malformed shapes are refused', () => {
    expect(parseFromWorker({ ...okMsg, extra: 1 })).toBeNull();
    expect(parseFromWorker({ ...okMsg, reqId: '' })).toBeNull();
    expect(parseFromWorker({ ...okMsg, top2: [['a', 1]] })).toBeNull();
    expect(parseFromWorker({ ...okMsg, p1: '0.6' })).toBeNull();
    expect(parseFromWorker({ v: 1, type: 'chosen', reqId: 'c1', ok: false, reason: 'weird' })).toBeNull();
    expect(parseFromWorker({ v: 1, type: 'chosen', reqId: 'c1', ok: false, reason: 'not_loaded', extra: 1 })).toBeNull();
    expect(parseFromWorker({ v: 1, type: 'chosen', reqId: 'c1', ok: 'yes' })).toBeNull();
  });
  test('non-finite numbers pass (the host, not the parser, rejects them)', () => {
    expect(parseFromWorker({ ...okMsg, margin: Number.NaN })).not.toBeNull();
  });
});
