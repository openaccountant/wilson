import { z } from 'zod';

/**
 * A zod schema accepting exactly one of `values`. z.enum is strings-only, so
 * numeric ids go through literals. Emits `{type:"number", enum:[...]}` (or
 * `const` for a single value) in JSON Schema, which constrained decoding and
 * generateObject (OpenAI strict mode included) both accept, and which stays
 * compact when rendered into a prompt: one entry per id rather than an
 * `anyOf` of objects.
 */
export function numberLiteralUnion(values: number[]): z.ZodType<number> {
  const unique = [...new Set(values)];
  if (unique.length === 0) return z.never() as unknown as z.ZodType<number>;
  if (unique.length === 1) return z.literal(unique[0]!);
  return z.literal(unique as [number, number, ...number[]]);
}
