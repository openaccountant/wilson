# Plan: Validate tool-call arguments against each tool's zod schema at the definition site

Decomposed from #56 (parent #64). Worktree: `/Users/jdfiscus/.spf/watch/wilson/worktrees/issue-66`

## Problem

Tool-call arguments from the model flow into `tool.func()` raw — no parse anywhere in our code:

- `src/agent/tool-executor.ts` — `tool.func(toolArgs, config)` inside `executeSingle` (agent loop, dashboard chat, CLI chat).
- `src/orchestration/team.ts` `runMember` and `src/orchestration/chain.ts` `runStepAgent` — `tool.func(tc.args)` (orchestration members call tools directly, not via the executor).
- Programmatic callers: `src/cli.ts` (csv_import, categorize), `src/sync.ts` (monarch/firefly imports).

A weak local model's malformed tool-call arguments (tool-call markup is regex-extracted upstream with no schema enforcement) therefore reach record-mutating tools like `edit_transaction`, `delete_transaction`, and `budget_set` unvalidated. The cloud path only gets AI-SDK-internal enforcement.

## Fix: one guard in `defineTool`

Every ToolDef in the repo is created by `defineTool` (`src/tools/define-tool.ts`): all tools under `src/tools/**`, the `skill` tool, orchestration registry tools (`src/orchestration/registry.ts`), and MCP adapter tools (`src/mcp/adapter.ts`, which builds zod schemas from MCP JSON Schema). Wrapping `func` at this single choke point covers the agent executor, orchestration chain/team members, programmatic callers, and any future invoker — no changes needed at the call sites.

### File 1: `src/tools/define-tool.ts` (the only production change)

Replace the pass-through implementation with a guarded one. Public signature and `ToolDef<T>` type stay identical, so ~40 existing call sites compile untouched.

```ts
import { z } from 'zod';
import type { ToolDef, ToolInvokeConfig } from '../model/types.js';

/**
 * Format zod issues as a compact field-first list, e.g.
 * "id: Invalid input: expected number, received string; amount: Required".
 */
function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const field = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `${field}: ${issue.message}`;
    })
    .join('; ');
}

export function defineTool<T extends z.ZodType>(config: {
  name: string;
  description: string;
  schema: T;
  func: (args: z.infer<T>, config?: ToolInvokeConfig) => Promise<string>;
}): ToolDef<T> {
  const { name, schema, func } = config;

  // Guard: every invocation parses args against the tool's own schema before
  // the tool runs. Enforced here (not per-invoker) so the agent executor,
  // orchestration members, programmatic callers, and future invokers all get
  // the same protection.
  const guardedFunc = async (args: z.infer<T>, toolConfig?: ToolInvokeConfig): Promise<string> => {
    const parsed = schema.safeParse(args);
    if (!parsed.success) {
      throw new Error(`Invalid arguments for tool '${name}': ${formatZodIssues(parsed.error)}`);
    }
    return func(args, toolConfig);
  };

  return { ...config, func: guardedFunc };
}
```

Key semantics (these are the design decisions — do not deviate without reason):

- **Validate-only, pass raw args through.** On success, call `func` with the ORIGINAL args object, not `parsed.data`. Rationale: zero behavior change for valid input (no key stripping, no `.default()` injection, no coercion surprises, `passthrough` keys preserved) and the executor logs/records the raw args elsewhere. Acceptance criterion "valid arguments pass through unchanged, including programmatic callers that pass optional-args objects" refers to this.
- **Throw a plain `Error`** (not the raw `ZodError`) with message `Invalid arguments for tool '<name>': <field>: <issue>; ...` so each invoker's existing `catch (err)` paths surface a readable, model-parsable message. zod v4 (`zod@4.3.6`) `error.issues[].path/message` is the API to use (verified working in this repo).
- Return `{ ...config, func: guardedFunc }` — a shallow copy, same shape as today.

### Why the invokers need no code change (verify, don't modify)

- **Agent executor** (`src/agent/tool-executor.ts`): `guardedFunc` is invoked inside the existing `try` block; the `catch` already (a) yields `{ type: 'tool_error', tool, error }` — the chat UI shows it and the model sees the failure, and (b) calls `ctx.scratchpad.addToolResult(tool, args, \`Error: ${message}\`)` — which is what feeds the model on the next iteration, acting as the re-prompt so it can correct its arguments. No executor changes required.
- **Chain steps / team members** (`src/orchestration/chain.ts`, `team.ts`): both already wrap `tool.func(tc.args)` in try/catch and push `[name] Error: <message>` into `toolResults`, which are concatenated into the next iteration prompt. Validation errors therefore flow back to the member/step model automatically.
- **Approval ordering note:** for `categorize` the approval prompt fires before validation (validation happens when `func` is invoked). Do not reorder; that is acceptable.

### Regression surface (checked during planning — no existing test should break)

- `mockTool` in `src/__tests__/helpers.ts` builds ToolDefs directly (bypasses `defineTool`, passthrough schema) → unaffected.
- Programmatic callers pass schema-valid args: `cli.ts` csv_import `{ filePath, bank: 'auto' }` ✓, categorize `{ limit }` ✓; `sync.ts` monarch/firefly `func({})` ✓ (all fields optional in those schemas).
- Existing tool tests call `editTransactionTool.func({ id })`, `{ id, date }`, `deleteTransactionTool.func({ id })`, `budgetSetTool.func({ category, monthlyLimit })`, etc. — all schema-valid.
- No tool schema in `src/tools/**` or `src/orchestration/**` uses `.strict()` (unknown keys are stripped/ignored by default zod objects, which `safeParse` accepts).
- MCP tools go through `defineTool`; `jsonSchemaToZod` output accepts anything its JSON Schema allows — no new failures expected.

## Tests

### File 2: extend `src/__tests__/tool-executor.test.ts` (the existing executor seam)

Add `import { z } from 'zod';` and `import { defineTool } from '../tools/define-tool.js';`. The file already has `makeLlmResponse`, `createRunContext`, `collectEvents`, and constructs `new AgentToolExecutor(toolMap)`.

1. **Malformed args → rejected before func runs.**
   ```ts
   let funcCalls = 0;
   const tool = defineTool({
     name: 'edit_transaction',
     description: 'Edit',
     schema: z.object({ id: z.number(), amount: z.number().optional() }),
     func: async () => { funcCalls++; return 'edited'; },
   });
   const executor = new AgentToolExecutor(new Map([['edit_transaction', tool]]));
   const ctx = createRunContext('test query');
   const response = makeLlmResponse([
     { id: 'tc1', name: 'edit_transaction', args: { id: 'abc', amount: 'not-a-number' } },
   ]);
   const events = await collectEvents(executor.executeAll(response, ctx));
   expect(funcCalls).toBe(0);                                   // tool function never invoked
   const errEvent = events.find((e) => e.type === 'tool_error')!;
   expect((errEvent as any).error).toContain('Invalid arguments for tool');
   expect((errEvent as any).error).toContain('id');             // offending fields named
   expect((errEvent as any).error).toContain('amount');
   expect(events.some((e) => e.type === 'tool_end')).toBe(false);
   expect(ctx.scratchpad.getToolResults()).toContain('Invalid arguments'); // fed back to model next iteration
   ```
   (The executor emits `tool_start` before the throw — that is fine; assert on `tool_error`/`tool_end`.)

2. **Valid args execute normally.** Same tool, args `{ id: 42, amount: -12.5 }` → `funcCalls === 1`, `tool_end` emitted with result `'edited'`.

### File 3: new `src/__tests__/define-tool.test.ts` (guard unit tests)

Direct `tool.func(...)` calls against `defineTool`-built tools:

1. Malformed args → rejects with `Invalid arguments for tool '<name>'` naming the offending field(s); func not called (call counter stays 0).
2. Valid args → func receives the ORIGINAL object unchanged: pass `{ id: 1, extra: 'keep-me', notes: undefined }` against schema `z.object({ id: z.number() })`; assert func got the same reference (`toBe`) with `extra` still present (proves no stripping and that optional-args objects from programmatic callers pass through).
3. Config forwarding: invoke with a second `config` arg (`{ metadata: { onProgress: () => {} } }`) and assert func received it (guards against the wrapper dropping `ToolInvokeConfig`).

### File 4: extend `src/__tests__/chain.test.ts` (non-executor invoker path)

Reuse the existing `mockToolsByNames` seam, but populate it with a **defineTool-built** tool (required field in schema). Adapter script:

- call 1: tool call with malformed args (`{ id: 'abc' }` against `z.object({ id: z.number() })`),
- call 2: final text response.

Record the prompts the mock adapter receives (the mock already sees them — capture the second call's prompt in an array). Assert the second prompt contains `Invalid arguments for tool '<name>'`, proving chain-step members get the guard and the error is fed back to the step model. (`team.ts` uses the identical `tool.func` + try/catch pattern; the chain test covers the shared mechanism — no separate team test needed.)

Note: `chain.test.ts` mocks `getToolsByNames` but NOT `define-tool.js`, so real `defineTool` guards apply inside the chain step.

### Optional but recommended: end-to-end loop test in `src/__tests__/agent.test.ts`

The real registry is live in that file. Adapter sequence: (1) `csv_import` with malformed args `{}` (schema requires `filePath` → validation error), (2) final text answer. Assert a `tool_error` event was emitted and `done` follows with the answer — proves the loop continues and lets the model retry after a validation failure.

## Verification

```
bun install            # only if node_modules absent in the worktree (it is now installed)
bun test               # full suite; baseline green (20 pass on the 3 touched files)
bun run typecheck      # tsc --noEmit (the repo has no separate build script — this is the build gate)
```

### Manual check (from the acceptance criteria)

1. `bun run src/index.tsx` with a local model configured (Ollama; small models produce malformed tool calls readily).
2. Open the dashboard → Chat tab. Seed a transaction (import or `/import` a file).
3. Request a transaction edit in a way that produces malformed parameters (or force an invalid tool call, e.g. ask for `edit_transaction` with the id as a word instead of a number). Expect: the chat shows a validation error for that step ("Invalid arguments for tool 'edit_transaction': id: …"), the model may retry, and the transaction record in the Transactions tab is unchanged.
4. Then issue a well-formed edit request ("change transaction N's category to Dining"). Expect: it succeeds and the record updates — proving valid calls still pass through.

## Out of scope

- Coercing/repairing near-miss args (e.g. numeric strings) — rejection + re-prompt is the intended behavior.
- Hardening the regex tool-call extraction itself (separate concern).
- Reordering approval-before-validation for `categorize`.