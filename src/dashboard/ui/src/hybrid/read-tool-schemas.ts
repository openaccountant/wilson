// ── Frozen JSON-schema snapshot of the 5 READ tools + a tiny validator ───────
//
// The dashboard UI cannot import src/mcp/tool-catalog.ts (it pulls node:crypto
// and the server query modules), so the model worker and the mirror port
// validate tool args against this frozen copy of `jsonSchemaFor(name)`.
// src/__tests__/read-tool-schema-snapshot.test.ts asserts the snapshot equals
// the catalog, so when the catalog changes (e.g. the judge's catalog v2) that
// test fails loudly and this file is regenerated deliberately.
//
// Pure, zero-import apart from a type.

import type { ReadToolName } from '../store/mirror-tools.js';

interface JsonSchema {
  type?: string;
  enum?: readonly string[];
  properties?: Record<string, JsonSchema>;
  required?: readonly string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  [k: string]: unknown;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

export const READ_TOOL_SCHEMAS: Readonly<Record<ReadToolName, JsonSchema>> = deepFreeze({
  transaction_search: {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "properties": {
      "query": {
        "type": "string",
        "description": "Natural language query about transactions"
      }
    },
    "required": [
      "query"
    ],
    "additionalProperties": false
  },
  spending_summary: {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "properties": {
      "period": {
        "type": "string",
        "enum": [
          "month",
          "quarter",
          "year"
        ]
      },
      "compareWithPrevious": {
        "type": "boolean"
      }
    },
    "additionalProperties": false
  },
  profit_loss: {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "properties": {
      "period": {
        "type": "string",
        "enum": [
          "month",
          "quarter",
          "year"
        ]
      },
      "offset": {
        "description": "0 = current period, -1 = previous, etc.",
        "type": "number"
      }
    },
    "additionalProperties": false
  },
  net_worth: {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "properties": {
      "action": {
        "type": "string",
        "enum": [
          "summary",
          "trend",
          "balance_sheet"
        ]
      },
      "months": {
        "description": "Number of months for trend (default 12)",
        "type": "number"
      }
    },
    "required": [
      "action"
    ],
    "additionalProperties": false
  },
  forecast: {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "properties": {
      "trailingMonths": {
        "description": "Lookback window in months (default 3)",
        "type": "number"
      },
      "horizonMonths": {
        "description": "Projection horizon in months (default 3)",
        "type": "number"
      },
      "whatIf": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "enum": [
                "adjust_category",
                "drop_recurring"
              ]
            },
            "category": {
              "description": "Category to adjust (adjust_category)",
              "type": "string"
            },
            "monthlyDelta": {
              "description": "Signed change to monthly spend (adjust_category)",
              "type": "number"
            },
            "description": {
              "description": "Description substring to match (drop_recurring)",
              "type": "string"
            }
          },
          "required": [
            "type"
          ],
          "additionalProperties": false
        }
      }
    },
    "additionalProperties": false
  },
} as Record<ReadToolName, JsonSchema>);

export type ArgValidation = { ok: true } | { ok: false; error: string };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function check(schema: JsonSchema, value: unknown, path: string): string | null {
  if (schema.enum && !(typeof value === 'string' && schema.enum.includes(value))) {
    return `${path}: not one of ${schema.enum.join('|')}`;
  }
  switch (schema.type) {
    case 'string':
      return typeof value === 'string' ? null : `${path}: expected string`;
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? null : `${path}: expected a finite number`;
    case 'boolean':
      return typeof value === 'boolean' ? null : `${path}: expected boolean`;
    case 'array': {
      if (!Array.isArray(value)) return `${path}: expected array`;
      if (schema.items) {
        for (let i = 0; i < value.length; i++) {
          const err = check(schema.items, value[i], `${path}[${i}]`);
          if (err) return err;
        }
      }
      return null;
    }
    case 'object': {
      if (!isPlainObject(value)) return `${path}: expected object`;
      const props = schema.properties ?? {};
      for (const key of schema.required ?? []) {
        if (!Object.prototype.hasOwnProperty.call(value, key) || value[key] === undefined) return `${path}.${key}: required`;
      }
      for (const key of Object.keys(value)) {
        if (!Object.prototype.hasOwnProperty.call(props, key)) {
          if (schema.additionalProperties === false) return `${path}.${key}: unknown key`;
          continue;
        }
        const err = check(props[key], value[key], `${path}.${key}`);
        if (err) return err;
      }
      return null;
    }
    default:
      return `${path}: unsupported schema`;
  }
}

/**
 * Validate `args` for one of the 5 READ tools against the frozen snapshot:
 * unknown tool, non-object args, unknown keys, missing required keys, wrong
 * types and bad enum values all fail. Never throws.
 */
export function validateReadToolArgs(tool: string, args: unknown): ArgValidation {
  if (!Object.prototype.hasOwnProperty.call(READ_TOOL_SCHEMAS, tool)) {
    return { ok: false, error: `unknown read tool: ${tool}` };
  }
  const err = check(READ_TOOL_SCHEMAS[tool as ReadToolName], args, 'args');
  return err ? { ok: false, error: err } : { ok: true };
}
