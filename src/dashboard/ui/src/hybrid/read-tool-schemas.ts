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
        "minLength": 1,
        "maxLength": 200,
        "description": "Natural language query, e.g. \"dining in August\""
      },
      "cursor": {
        "description": "nextCursor from the previous page of the same call. Omit for page 1.",
        "type": "string",
        "maxLength": 200
      },
      "limit": {
        "description": "Rows per page, 1-25 (default 10)",
        "type": "integer",
        "minimum": 1,
        "maximum": 25
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
        "description": "Calendar period (default month)",
        "type": "string",
        "enum": [
          "month",
          "quarter",
          "year"
        ]
      },
      "compareWithPrevious": {
        "description": "Include the previous period total per category",
        "type": "boolean"
      },
      "cursor": {
        "description": "nextCursor from the previous page of the same call. Omit for page 1.",
        "type": "string",
        "maxLength": 200
      },
      "limit": {
        "description": "Rows per page, 1-25 (default 10)",
        "type": "integer",
        "minimum": 1,
        "maximum": 25
      }
    },
    "additionalProperties": false
  },
  profit_loss: {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "properties": {
      "period": {
        "description": "Calendar period (default month)",
        "type": "string",
        "enum": [
          "month",
          "quarter",
          "year"
        ]
      },
      "offset": {
        "description": "0 = current period, -1 = previous, down to -24",
        "type": "integer",
        "minimum": -24,
        "maximum": 0
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
        ],
        "description": "summary, trend or balance_sheet"
      },
      "months": {
        "description": "Months of history for trend, 1-120 (default 12)",
        "type": "integer",
        "minimum": 1,
        "maximum": 120
      },
      "cursor": {
        "description": "nextCursor from the previous page of the same call. Omit for page 1.",
        "type": "string",
        "maxLength": 200
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
        "description": "Lookback window in months, 1-24 (default 3)",
        "type": "integer",
        "minimum": 1,
        "maximum": 24
      },
      "horizonMonths": {
        "description": "Projection horizon in months, 1-60 (default 3)",
        "type": "integer",
        "minimum": 1,
        "maximum": 60
      },
      "whatIf": {
        "description": "Up to 5 what-if adjustments",
        "maxItems": 5,
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "enum": [
                "adjust_category",
                "drop_recurring"
              ],
              "description": "What-if kind"
            },
            "category": {
              "description": "Category to adjust (adjust_category)",
              "type": "string",
              "maxLength": 64
            },
            "monthlyDelta": {
              "description": "Signed change to monthly spend (adjust_category)",
              "type": "number",
              "minimum": -1000000000,
              "maximum": 1000000000
            },
            "description": {
              "description": "Description substring to match (drop_recurring)",
              "type": "string",
              "maxLength": 60
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
    case 'string': {
      if (typeof value !== 'string') return `${path}: expected string`;
      if (typeof schema.minLength === 'number' && value.length < schema.minLength) return `${path}: shorter than ${schema.minLength}`;
      if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) return `${path}: longer than ${schema.maxLength}`;
      return null;
    }
    case 'number':
    case 'integer': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return `${path}: expected a finite number`;
      if (schema.type === 'integer' && !Number.isInteger(value)) return `${path}: expected an integer`;
      if (typeof schema.minimum === 'number' && value < schema.minimum) return `${path}: below ${schema.minimum}`;
      if (typeof schema.maximum === 'number' && value > schema.maximum) return `${path}: above ${schema.maximum}`;
      return null;
    }
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
