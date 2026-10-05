import { describe, expect, test } from 'bun:test';
import { StructuredOutputProcessor } from '@huggingface/transformers-structured-output';
import { z } from 'zod';
import { toConstraintSchema } from '../model/constraint-schema.js';
import { buildCategorizationOutputSchema, offeredCategoryNames } from '../tools/categorize/categorize.js';
import { buildClassificationOutputSchema } from '../tools/entity/entity-classify.js';
import { numberLiteralUnion } from '../tools/literal-union.js';

// Offline: the real StructuredOutputProcessor over a synthetic tokenizer, one
// token per byte 0..127 plus an EOS token. The package accepts such a direct
// { tokens, eosTokenId } tokenizer, so no model files are needed.
const EOS = 128;
const tokenizer = {
  tokens: Array.from({ length: 129 }, (_, i) => (i < 128 ? Uint8Array.of(i) : new Uint8Array())),
  eosTokenId: EOS,
};

function build(schema: z.ZodType) {
  return new StructuredOutputProcessor(tokenizer as never, {
    type: 'json_schema',
    json_schema: toConstraintSchema(schema),
  } as never);
}

/**
 * Feed `text` byte by byte through the processor. Returns the first position
 * where the next byte was masked out, or -1 when every byte was allowed and EOS
 * is allowed at the end.
 */
function firstRejected(schema: z.ZodType, text: string): number {
  const processor = build(schema) as unknown as {
    _call(ids: bigint[][], logits: { dims: number[]; data: Float32Array }): unknown;
  };
  const ids: bigint[] = [0n]; // a one-token prompt
  const allowed = (): ((id: number) => boolean) => {
    const logits = { dims: [1, 129], data: new Float32Array(129) };
    processor._call([ids], logits);
    return (id) => logits.data[id] !== -Infinity;
  };
  for (let i = 0; i < text.length; i++) {
    const ok = allowed();
    const code = text.charCodeAt(i);
    if (!ok(code)) return i;
    ids.push(BigInt(code));
  }
  return allowed()(EOS) ? -1 : text.length;
}

const row = (id: number, category: string) => `{"id":${id},"category":"${category}","confidence":0.9}`;

describe('real StructuredOutputProcessor with the production narrowed schemas', () => {
  const names = offeredCategoryNames(undefined);
  const categorize = buildCategorizationOutputSchema([101, 102, 103], names, true);

  test('the categorize schema compiles', () => {
    expect(() => build(categorize)).not.toThrow();
  });

  test('a valid categorize answer is accepted end to end', () => {
    const text = `{"transactions":[${row(101, names[0]!)},${row(103, 'Other')}]}`;
    expect(firstRejected(categorize, text)).toBe(-1);
  });

  test('an id outside the batch is cannot be completed', () => {
    const text = `{"transactions":[${row(104, names[0]!)}]}`;
    const at = firstRejected(categorize, text);
    // Digits may still prefix a longer allowed id, so the bad id dies at its terminator.
    expect(at).toBe(text.indexOf('104') + 3);
  });

  test('a category outside the offered names is rejected', () => {
    const text = `{"transactions":[{"id":101,"category":"Zzz`;
    expect(firstRejected(categorize, text)).toBeGreaterThan(-1);
  });

  const entities = buildClassificationOutputSchema([7, 8], [1, 2], true);

  test('the entity schema compiles and accepts a valid answer', () => {
    const ok = '{"transactions":[{"id":7,"entityId":2,"confidence":0.8,"reasoning":"payroll"}]}';
    expect(firstRejected(entities, ok)).toBe(-1);
  });

  test('an entity id or batch id outside the sets is rejected', () => {
    const badEntity = '{"transactions":[{"id":7,"entityId":3,';
    expect(firstRejected(entities, badEntity)).toBe(badEntity.length - 1);
    const badId = '{"transactions":[{"id":9,';
    expect(firstRejected(entities, badId)).toBe(badId.length - 1);
  });

  test('single-id and empty-id guards still compile where the schema can', () => {
    expect(() => build(buildCategorizationOutputSchema([5], names, true))).not.toThrow();
    expect(z.toJSONSchema(numberLiteralUnion([1, 2, 3]))).toMatchObject({ type: 'number', enum: [1, 2, 3] });
    expect(z.toJSONSchema(numberLiteralUnion([4, 4]))).toMatchObject({ const: 4 });
  });
});
