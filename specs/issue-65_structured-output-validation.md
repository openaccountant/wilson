# Plan: Structured-output validation at the `callLlm` boundary (issue-65)

Parent: #56 (decomposed). Outcome: a local model emitting malformed/off-schema JSON for
categorization or entity classification gets exactly one schema-aware repair re-prompt; if
that still fails, the call rejects with a typed validation error and the consumer's existing
safe fallback applies — transaction records are never touched with NaN confidences or junk
categories.

## Current state (why this is broken)

- `callLlm` (`src/model/llm.ts`) passes `outputSchema` to the adapter but **never validates**
  what comes back. `LlmResponse.structured` (`src/model/types.ts`) is `unknown`.
- The vercel-ai adapter (`generateObject`) does enforce the schema, but the transformers
  adapter (`src/model/providers/transformers.ts:267`) just does `JSON.parse` of a regex-matched
  blob and stuffs it into `structured` — anything the model emits lands there.
- The four consumers blind-cast `response.structured`:
  - `src/tools/categorize/categorize.ts:135` — casts, clamps `Math.max(0, Math.min(1, cat.confidence))`
    (undefined → **NaN**), writes via `updateCategory`. Only falls back to parsing
    `response.content` when `structured` is missing; a present-but-garbage `structured` is trusted.
  - `src/tools/entity/entity-classify.ts:109` — same pattern.
  - `src/utils/in-memory-chat-history.ts:230` — `structured?.message_ids || []`.
  - `src/orchestration/team.ts:114` — dispatcher `(structured as ...)?.assignments ?? []`
    (falls back to the dispatcher's raw content when assignments are empty, but the call itself
    is not guarded against a rejecting `callLlm`).
- Output schemas only require `confidence: z.number()` — no range, so `1.5`, `-3`, or a string
  flows straight through the clamp into the DB.

## Design

### 1. New module `src/model/structured-output.ts`

```ts
import { z } from 'zod';
import type { LlmResponse } from './types.js';

export class LlmValidationError extends Error {
  override readonly name = 'LlmValidationError';
  constructor(
    message: string,
    readonly issues: string[],          // human-readable zod issues
    readonly lastResponse: LlmResponse, // raw (invalid) response, for graceful degradation
  ) { super(message); }
}

export type StructuredValidation =
  | { ok: true;  response: LlmResponse }   // response.structured set to the validated value
  | { ok: false; issues: string[] };

export function validateStructuredOutput(response: LlmResponse, schema: z.ZodType): StructuredValidation;
```

Semantics of `validateStructuredOutput`:
1. If `response.structured !== undefined` → `schema.safeParse(structured)`.
2. Else (or `structured === undefined`) → try `schema.safeParse(JSON.parse(response.content))`;
   on success, return the response with `structured` set to the parsed value (this is the
   adapters' missing-structured fallback and replaces the duplicated fallback code in consumers).
3. On failure return `{ ok: false, issues }` where issues are formatted zod issues
   (path + message). Use `error.issues` (zod v4 is in use, `z.toJSONSchema` already used in
   `transformers.ts`).

Also export a `buildRepairPrompt(originalPrompt, failedResponse, schema, issues): string`:
- includes the original prompt, a truncated excerpt of the model's previous raw output
  (`content.slice(0, 2000)`), the numbered validation issues, and
  `JSON.stringify(z.toJSONSchema(schema), null, 2)`, ending with an instruction to respond
  with ONLY a JSON object matching the schema (no markdown/explanation).

Keep `LlmValidationError` in this file (not `utils/errors.ts`) — it's a model-layer error and
avoids touching the error-classification module.

### 2. `src/model/llm.ts` — validate + one repair at the boundary

Inside the existing `try`, after `withRetry(() => adapter.call(...))` returns `response`, and
**before** the `traceStore.record` / `interactionStore.recordInteraction` calls:

```
let finalResponse = response;
if (outputSchema) {
  const first = validateStructuredOutput(response, outputSchema);
  if (!first.ok) {
    logger.warn(`Structured output failed schema validation; requesting one repair`, { issues: first.issues });
    finalResponse = await withRetry(() =>
      adapter.call({
        model: apiModel,
        systemPrompt: finalSystemPrompt,          // original system prompt, role context preserved
        userPrompt: buildRepairPrompt(prompt, response, outputSchema, first.issues),
        outputSchema,                              // adapter-level format enforcement still on
        signal,
      }),
      provider.displayName,
    );
    const second = validateStructuredOutput(finalResponse, outputSchema);
    if (!second.ok) {
      throw new LlmValidationError(
        `LLM structured output failed schema validation after one repair attempt: ${second.issues.join('; ')}`,
        second.issues,
        finalResponse,
      );
    }
    finalResponse = second.response;
  }
}
```

Then the existing trace/interaction recording proceeds unchanged against `finalResponse`
(`status: 'ok'` only ever records validated data). The `LlmValidationError` throw lands in the
existing `catch`, which records an error trace and rethrows — no new error-path code needed.

Guarantees after this change:
- `outputSchema` supplied ⇒ returned `response.structured` satisfies the schema, or the call
  rejected with `LlmValidationError`.
- Exactly **one** repair attempt per call, regardless of outcome.
- Validation errors are never retried as network errors by `withRetry` (validation happens
  outside it); a network failure *during* the repair call still gets the normal retry/backoff
  and, if exhausted, throws its normal provider error (consumers already treat any rejection
  the same).

### 3. `src/tools/categorize/categorize.ts`

- Tighten schema: `confidence: z.number().min(0).max(1)` inside the per-transaction object.
- Delete the three-way branch at lines ~132-140 (`structured` cast / content re-parse /
  `errors.push('Unexpected LLM response format')`). Replace with:
  ```ts
  const categorizations = result.response.structured as z.infer<typeof categorizationOutputSchema>;
  ```
  The call either returned validated data or threw; the existing `catch (err)` around the
  batch loop already pushes `` `Batch ${n}: ${err.message}` `` into the `errors` channel and
  `continue`s — a rejected batch therefore writes nothing (transactions stay uncategorized,
  no `updateCategory` call, no NaN). Keep the `Math.max(0, Math.min(1, confidence))` clamp as
  a no-op safety net — it can no longer receive undefined.
- No other behavior changes (rules path, batching, needingReview thresholds stay as-is).

### 4. `src/tools/entity/entity-classify.ts`

- Same tightening: `confidence: z.number().min(0).max(1)` in `classificationOutputSchema`.
- Same deletion of the parse branch → direct typed use of `result.response.structured`.
- Rejected batch flows into the existing `errors.push(...)` catch; nothing is assigned,
  nothing lands in `reviewItems` for that batch.

### 5. `src/utils/in-memory-chat-history.ts` (`selectRelevantMessages`)

- `callLlm` now guarantees `response.structured` is a validated `SelectedMessagesSchema`
  value. Simplify line ~230 to
  `const selectedIds = (response.structured as { message_ids: number[] }).message_ids ?? [];`
  (drop the `structured?.`-style blind-cast defensiveness; keep the `?? []`).
- Rejection path is already correct: the existing `catch { return []; }` degrades to no
  injected history. No behavioral change needed beyond the simplification.

### 6. `src/orchestration/team.ts` (dispatcher)

- Wrap the dispatch `callLlm` (line ~108) in try/catch:
  ```ts
  let dispatchResponse: LlmResponse;
  try {
    ({ response: dispatchResponse } = await callLlm(dispatchPrompt, { ... }));
  } catch (err) {
    if (err instanceof LlmValidationError) {
      // Degrade to the dispatcher answering directly with its raw content.
      const content = err.lastResponse.content?.trim();
      return content || 'No subtasks were assigned.';
    }
    throw err; // network/provider errors keep propagating (already retried upstream)
  }
  ```
- The following `assignments ?? []` line stays (now reading validated data).

### 7. Tests (existing seams only)

Seams already in the repo:
- `src/__tests__/llm.test.ts` mocks the adapter via `mock.module('../model/providers/index.js')`
  → real `callLlm` runs (validation exercised end-to-end). Follow its pattern; do not mock
  trace-store/interaction-store (same note as in that file).
- `src/__tests__/categorize-tool.test.ts` and `src/__tests__/in-memory-chat-history.test.ts`
  `spyOn(llmModule, 'callLlm')` → tool/class-level behavior with `mockResolvedValue` /
  `mockRejectedValue`.

Add/extend:

- **`llm.test.ts`** (adapter-mock seam):
  - valid `structured` for a test schema passes through unchanged; adapter called exactly once.
  - `structured` absent but `content` parses to schema-valid JSON → validated, `structured`
    populated, no repair call.
  - malformed `structured` (wrong shape) → second adapter call whose `userPrompt` contains the
    JSON schema text and the validation issue; repaired second response returned with
    validated `structured`.
  - malformed on both attempts → rejects with error whose `name` is `'LlmValidationError'`,
    exactly two adapter calls total.
  - `confidence: '0.9'` (string) against the tightened tool schema → repair then reject.
- **`categorize-tool.test.ts`** (callLlm spy seam):
  - `llmSpy.mockRejectedValue(new LlmValidationError(...))` with one uncategorized txn →
    `result.data.errors` contains the batch error, `categorized: 0`, and the DB row still has
    no category (assert via `getTransactions`) — no NaN anywhere.
  - existing valid-`structured` tests keep passing unchanged (they mock valid data already).
- **new `src/__tests__/entity-classify-tool.test.ts`** (no entity test exists today; mirror
  `categorize-tool.test.ts`): valid mock → assignments happen; rejected mock → errors channel,
  `classified: 0`, `entity_id` untouched.
- **`in-memory-chat-history.test.ts`**: `mockRejectedValue(new LlmValidationError(...))` →
  `selectRelevantMessages` resolves `[]`.
- **new `src/__tests__/team.test.ts`** (spyOn callLlm, mirroring how tool tests do it):
  - dispatch call rejects with `LlmValidationError` → `runTeam` resolves with the raw
    `lastResponse.content` (or the `'No subtasks were assigned.'` fallback when empty).
  - happy path: dispatch returns valid assignments → members run (can stub member calls).

## Files touched

| File | Change |
|---|---|
| `src/model/structured-output.ts` | **new** — `LlmValidationError`, `validateStructuredOutput`, `buildRepairPrompt` |
| `src/model/llm.ts` | validate + single repair before trace/interaction recording; throw typed error |
| `src/tools/categorize/categorize.ts` | tighten schema `[0,1]`; drop blind-cast branch; rely on guarantee |
| `src/tools/entity/entity-classify.ts` | tighten schema `[0,1]`; drop blind-cast branch |
| `src/utils/in-memory-chat-history.ts` | simplify structured access; rejection already → `[]` |
| `src/orchestration/team.ts` | catch `LlmValidationError` on dispatch → direct-answer fallback |
| `src/__tests__/llm.test.ts` | +5 validation/repair/rejection tests |
| `src/__tests__/categorize-tool.test.ts` | +rejected-batch → errors channel, DB untouched |
| `src/__tests__/entity-classify-tool.test.ts` | **new** — same coverage for entity classification |
| `src/__tests__/in-memory-chat-history.test.ts` | +rejection → `[]` |
| `src/__tests__/team.test.ts` | **new** — dispatch rejection → direct-answer fallback |

## Verification

1. `bun test` — all green (existing suites + new ones).
2. `bun run typecheck` — clean (no `build` script exists in package.json; typecheck + tests are
   the repo gates per CONTRIBUTING.md).
3. Manual (from the acceptance criteria): with a local model configured (Ollama default), run
   **"categorize my uncategorized transactions"** from the dashboard chat tab on a database
   with uncategorized rows; then in Overview/Budget confirm every touched transaction shows a
   whitelisted category (no "Other" spam from malformed input) and a confidence within [0,1];
   and in the test suite confirm a simulated off-schema response is rejected rather than
   written.

## Out of scope / notes

- No adapter changes (transformers/vercel-ai keep their current output behavior; validation is
  centralized in `callLlm`).
- Don't retry validation failures via `withRetry` — the single repair attempt is the retry.
- Don't record the *repair* attempt as a separate trace/interaction entry; the final validated
  response is the recorded one and repair attempts surface via `logger.warn`. (If trivial, a
  separate interaction entry with callType suffix `-repair` is a nice-to-have, not required.)
- `agent.ts`, `chain.ts`, `generateSummary` don't pass `outputSchema` — untouched by design.
- `LlmValidationError.lastResponse` intentionally carries the invalid response so `runTeam`
  can degrade to the dispatcher's direct answer; categorization/entity consumers must NOT use
  it to write data.