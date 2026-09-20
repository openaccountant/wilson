import { z } from 'zod';
import type { LlmResponse } from './types.js';

/**
 * Thrown by callLlm when a structured output fails schema validation even after
 * one schema-aware repair re-prompt. Carries the human-readable validation issues
 * and the raw (invalid) final response so consumers can degrade gracefully
 * (e.g., team dispatch falling back to the dispatcher's direct answer) without
 * ever writing unvalidated data.
 */
export class LlmValidationError extends Error {
  override readonly name = 'LlmValidationError';

  constructor(
    message: string,
    /** Human-readable zod issues, e.g. `transactions.0.confidence: Invalid input: expected number, received string`. */
    readonly issues: string[],
    /** The raw, schema-violating response that was rejected. */
    readonly lastResponse: LlmResponse,
  ) {
    super(message);
  }
}

export type StructuredValidation =
  | { ok: true; response: LlmResponse }
  | { ok: false; issues: string[] };

function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `${path}: ${issue.message}`;
  });
}

/**
 * Validate a model response against the output schema it was called with.
 *
 * 1. If the adapter populated `response.structured`, that value is checked against the schema.
 * 2. Otherwise the response content is parsed as JSON and checked — this centralizes the
 *    "adapter gave no structured value" fallback that consumers previously duplicated.
 * 3. On success the response is returned with `structured` set to the validated value;
 *    on failure the zod issues are returned so a repair re-prompt can quote them.
 */
export function validateStructuredOutput(response: LlmResponse, schema: z.ZodType): StructuredValidation {
  if (response.structured !== undefined) {
    const parsed = schema.safeParse(response.structured);
    if (parsed.success) {
      return { ok: true, response: { ...response, structured: parsed.data } };
    }
    return { ok: false, issues: formatIssues(parsed.error) };
  }

  if (typeof response.content === 'string' && response.content.trim().length > 0) {
    try {
      const candidate: unknown = JSON.parse(response.content);
      const parsed = schema.safeParse(candidate);
      if (parsed.success) {
        return { ok: true, response: { ...response, structured: parsed.data } };
      }
      return { ok: false, issues: formatIssues(parsed.error) };
    } catch {
      // Content isn't JSON — fall through to the generic failure below.
    }
  }

  return {
    ok: false,
    issues: ['Response contained no structured value and its content did not parse to an object matching the schema'],
  };
}

/**
 * Build the one-shot repair re-prompt sent after a schema violation: the original
 * task, an excerpt of what the model produced, the validation issues, and the
 * JSON schema it must match.
 */
export function buildRepairPrompt(
  originalPrompt: string,
  failedResponse: LlmResponse,
  schema: z.ZodType,
  issues: string[],
): string {
  const schemaJson = JSON.stringify(z.toJSONSchema(schema), null, 2);
  const excerpt = failedResponse.content.slice(0, 2000);
  const numberedIssues = issues.map((issue, index) => `${index + 1}. ${issue}`).join('\n');

  return [
    'Your previous response did not match the required JSON schema.',
    '',
    'Original task:',
    originalPrompt,
    '',
    'Your previous response (excerpt):',
    excerpt,
    '',
    'Validation issues:',
    numberedIssues,
    '',
    'Required JSON schema:',
    schemaJson,
    '',
    'Respond with ONLY a single JSON object that matches this schema exactly.',
    'No markdown fences, no explanations, no extra text — just the JSON object.',
  ].join('\n');
}