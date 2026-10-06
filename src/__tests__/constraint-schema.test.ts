import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { toConstraintSchema } from '../model/constraint-schema.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Schema = Record<string, any>;

/** Every occurrence of `key` used as an object key anywhere in `node`, with its path. */
function keyPaths(node: unknown, key: string, path = '$'): string[] {
  if (Array.isArray(node)) return node.flatMap((v, i) => keyPaths(v, key, `${path}[${i}]`));
  if (!node || typeof node !== 'object') return [];
  return Object.entries(node).flatMap(([k, v]) => [
    ...(k === key ? [path] : []),
    ...keyPaths(v, key, `${path}.${k}`),
  ]);
}

describe('toConstraintSchema', () => {
  test('strips pattern, asserted formats and $schema at every depth', () => {
    const schema = z.object({
      code: z.string().regex(/^[A-Z]{3}$/),
      email: z.email(),
      when: z.iso.date(),
      id: z.uuid(),
      nested: z.object({ items: z.array(z.object({ sku: z.string().regex(/^\d+$/) })) }),
      either: z.union([z.string().regex(/^a+$/), z.number()]),
    });
    const out = toConstraintSchema(schema);
    expect(keyPaths(out, 'pattern')).toEqual([]);
    expect(keyPaths(out, '$schema')).toEqual([]);
    expect(keyPaths(out, 'format')).toEqual([]);
    // The rest of the structure survives.
    expect((out as Schema).properties.nested.properties.items.items.properties.sku.type).toBe('string');
    expect((out as Schema).required).toContain('either');
  });

  test('keeps a format the package does not assert', () => {
    // "currency" is not in the package's asserted list, so it is an annotation.
    const schema = z.object({ n: z.string().meta({ format: 'currency' }) });
    expect((z.toJSONSchema(schema) as Schema).properties.n.format).toBe('currency');
    expect((toConstraintSchema(schema) as Schema).properties.n.format).toBe('currency');
  });

  test('properties NAMED pattern / format / $schema are left alone', () => {
    const schema = z.object({
      pattern: z.string(),
      format: z.string(),
      $schema: z.string(),
      rule: z.object({ pattern: z.string().regex(/^x/) }),
    });
    const out = toConstraintSchema(schema) as Schema;
    expect(Object.keys(out.properties)).toEqual(['pattern', 'format', '$schema', 'rule']);
    expect(out.properties.pattern).toEqual({ type: 'string' });
    expect(out.properties.format).toEqual({ type: 'string' });
    expect(out.required).toEqual(['pattern', 'format', '$schema', 'rule']);
    // The nested property named pattern survives; its own pattern keyword does not.
    expect(out.properties.rule.properties.pattern).toEqual({ type: 'string' });
  });

  test('const / enum / default / examples values are never rewritten', () => {
    const data = { pattern: '^x$', format: 'email', $schema: 'y' };
    const schema = z.object({
      kind: z.enum(['pattern', 'format', '$schema']),
      fixed: z.literal('pattern'),
      blob: z.object({ pattern: z.string(), format: z.string(), $schema: z.string() }).default(data),
    });
    const out = toConstraintSchema(schema) as Schema;
    expect(out.properties.kind.enum).toEqual(['pattern', 'format', '$schema']);
    expect(out.properties.fixed.const).toBe('pattern');
    expect(out.properties.blob.default).toEqual(data);

    // examples is data too (injected by hand: zod only emits it via .meta()).
    const withExamples = z.object({ s: z.string().meta({ examples: [{ pattern: 'a', format: 'date' }] }) });
    expect((toConstraintSchema(withExamples) as Schema).properties.s.examples).toEqual([
      { pattern: 'a', format: 'date' },
    ]);
  });

  test('x-guidance is set at the root only', () => {
    const out = toConstraintSchema(
      z.object({ a: z.object({ b: z.array(z.object({ c: z.number() })) }) }),
    );
    // Flexible on purpose: compact JSON collapsed small models' arrays to [] (see constraint-schema.ts).
    expect(out['x-guidance']).toEqual({ whitespace_flexible: true });
    expect(keyPaths(out, 'x-guidance')).toEqual(['$']);
  });

  test('the same zod schema yields the same object; a different one does not', () => {
    const a = z.object({ x: z.number() });
    const b = z.object({ x: z.number() });
    expect(toConstraintSchema(a)).toBe(toConstraintSchema(a));
    expect(toConstraintSchema(b)).not.toBe(toConstraintSchema(a));
    expect(toConstraintSchema(b)).toEqual(toConstraintSchema(a));
  });

  test('the categorize schema keeps its numeric bounds', () => {
    const schema = z.object({
      transactions: z.array(
        z.object({ id: z.number(), category: z.string(), confidence: z.number().min(0).max(1) }),
      ),
    });
    const row = (toConstraintSchema(schema) as Schema).properties.transactions.items;
    expect(row.properties.confidence).toMatchObject({ type: 'number', minimum: 0, maximum: 1 });
  });
});
