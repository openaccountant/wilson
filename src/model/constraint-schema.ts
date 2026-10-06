/**
 * zod → JSON Schema for constrained decoding with
 * @huggingface/transformers-structured-output (local Transformers.js only).
 *
 * The package compiles a "practical 2020-12" profile and throws on keywords it
 * cannot enforce token by token: `pattern`, and any `format` it would have to
 * assert (date, email, uuid, …). Those are stripped here; callLlm's post-hoc zod
 * validation still enforces them. `$schema` is dropped as noise.
 *
 * Only schema KEYWORDS are stripped. A property named `pattern` or `format`
 * (a key inside `properties`, `$defs`, …) is a name, not a keyword, and
 * `const`/`enum`/`default`/`examples` hold instance data that is never rewritten.
 *
 * Whitespace stays flexible (the package default, set explicitly at the root).
 * Forcing compact JSON (`whitespace_flexible: false`) made granite-4.0-350m and
 * Qwen3-0.6B answer every categorize batch with `{"transactions":[]}`, whether
 * the prompt's schema was pretty-printed or compact: with the newline and
 * indent they want after `[` masked, `]` wins. Flexible whitespace reproduced
 * granite's unconstrained answers token for token.
 */

import { z } from 'zod';

/** Mirrors ASSERTED_FORMATS in the package's src/engine/json.ts. */
const ASSERTED_FORMATS = new Set([
  'date',
  'time',
  'date-time',
  'duration',
  'email',
  'hostname',
  'ipv4',
  'ipv6',
  'uuid',
  'uri',
  'uri-reference',
  'regex',
  'json-pointer',
  'relative-json-pointer',
]);

/** Keywords whose value maps NAME → subschema; the keys inside are names, not keywords. */
const SCHEMA_MAPS = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']);

/** Keywords whose value is instance data, not a schema. Never rewritten. */
const DATA_KEYWORDS = new Set(['const', 'enum', 'default', 'examples']);

function stripSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripSchema); // allOf/anyOf/oneOf/prefixItems
  if (!node || typeof node !== 'object') return node; // boolean schemas, scalars
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'pattern' || key === '$schema') continue;
    if (key === 'format' && typeof value === 'string' && ASSERTED_FORMATS.has(value)) continue;
    if (DATA_KEYWORDS.has(key)) {
      out[key] = value;
    } else if (SCHEMA_MAPS.has(key) && value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = Object.fromEntries(Object.entries(value).map(([name, sub]) => [name, stripSchema(sub)]));
    } else {
      out[key] = stripSchema(value);
    }
  }
  return out;
}

/**
 * The package caches token masks per schema OBJECT identity, so the same zod
 * schema must yield the same JSON Schema object. Per-call schemas (fresh zod
 * objects) get a cold mask cache regardless.
 */
const constraintSchemaCache = new WeakMap<z.ZodType, Record<string, unknown>>();

/**
 * `schema` as a JSON Schema the structured-output processor accepts, with the
 * root `x-guidance` set. Memoized by zod schema identity.
 */
export function toConstraintSchema(schema: z.ZodType): Record<string, unknown> {
  let cached = constraintSchemaCache.get(schema);
  if (!cached) {
    cached = {
      ...(stripSchema(z.toJSONSchema(schema)) as Record<string, unknown>),
      'x-guidance': { whitespace_flexible: true },
    };
    constraintSchemaCache.set(schema, cached);
  }
  return cached;
}
