# Plan: Per-response provenance indicator in the dashboard chat UIs (local-with-context vs server fallback)

**Repo:** `/home/jd/.spf/watch/wilson/worktrees/issue-69` (branch `spf-watch/69-per-response-provenance-indicator-local-with-context-vs`)
**Parent:** #49 — **Blocked by:** #68, which has **already landed** in this tree (commit `d29e69e` "Add local-first WebGPU hybrid chat…"). Verify with `git log --oneline -3` before starting; everything below builds directly on that commit.

## Outcome

After this lands, a user chatting in the Wilson dashboard sees, on each live response, a small badge saying which path actually produced it: answered locally on their GPU from the pre-fetched bundle (`local-with-context`), answered by the server agent after the local layer was in play (`server-fallback` — hand-off, WebGPU unavailability, or error), or a neutral state when local inference was never in play (`unavailable` — the hybrid layer itself is absent). History-loaded messages show no badge. No server, endpoint, or chat-history schema changes.

## Provenance semantics (the one interpretation that must not drift)

| State | Meaning | When it happens |
|---|---|---|
| `local-with-context` | The browser's WebGPU model answered from the pre-fetched bundle | `tryLocal` returned `{ok:true}` |
| `server-fallback` | The server agent answered **after the local layer was in play** | Hybrid chunk present and `tryLocal` returned `{ok:false}` — any reason: `tool-call` / `outside-bundle` / `no-answer` hand-off, cached WebGPU `unavailable`/`failed` verdict, config or bundle fetch failure, local error |
| `unavailable` (neutral) | The server answered but **local inference was skipped entirely** — nothing to fall back from | The hybrid layer itself was absent: `/assets/hybrid-chat.js` 404'd (hybrid build not deployed) → `window.WilsonHybridChat` undefined / hook `status === 'unavailable'` |

The distinction "WebGPU unavailable → `server-fallback`, hybrid layer absent → `unavailable`" comes straight from the task prompt: server fallback explicitly includes "WebGPU unavailability", while the neutral state is "when local inference was skipped". The badge describes the path that produced **this** answer, decided at send time — never inferred from message text.

## Grounding — what exists today (verified in this tree)

- `src/dashboard/ui/src/hybrid/core.ts` — DOM-free shared core, dual-compiled (root tsc + UI tsconfig), already unit-tested from `src/__tests__/local-chat-{config,bundle,handoff}.test.ts` via `import ... from '../dashboard/ui/src/hybrid/core.js'`. Exports `HybridResult = {ok:true, answer, sessionId, source:'local'} | {ok:false, reason?}`, `HandoffReason`, `shouldAttemptLocal`. This is the natural home for the shared provenance type + derivation.
- `src/dashboard/ui/src/hybrid/client.ts` — every failure resolves `{ok:false}` (reason only on classified hand-offs and the catch-all `'error'`); never throws. The no-reason `{ok:false}` paths (capability cached unavailable, config/bundle fetch fail) are all genuinely "local layer in play → server".
- `src/dashboard/ui/src/hooks/useHybridChat.ts` — `status: 'unknown' | 'available' | 'unavailable'` (chunk loadability, not GPU capability). `tryLocal` returns bare `{ok:false}` when the chunk is missing. **Caveat:** `status` is React state; a `handleSend` closure can hold a stale value — the plan adds a ref-based getter (Step 2).
- `src/dashboard/ui/src/tabs/ChatTab.tsx` — `handleSend()` is local-first: `hybrid.tryLocal(...)` → `local` set or not → server `POST /api/chat` or Error bubble. `DisplayMessage {role, content}` is local state only; `loadSession()` fills it from `/api/chat/sessions/:id` (no provenance → exactly where history messages must stay badge-free).
- `src/dashboard/html.ts` — one self-contained template string; chat UI via `addChatMsg(sender, text, useMarkdown)` (~line 1132, returns the message div; bubbles are `.bubble > .text`), `sendChat()` (~line 1170) already local-first with `hybridInit(); if (window.WilsonHybridChat) {...}`, history via `renderSessionMessages()`. CSS block ~lines 79–102 (ink `#8b949e`, money `#22c55e`). `<meta charset="UTF-8">` present, so a `·` in badge text is safe. `el(tag, className, text)` helper at line 426.
- `src/dashboard/ui/src/styles/app.css` — Tailwind v4 `@theme` tokens: `--color-text-muted`, `--color-green`, etc. ChatTab already uses `text-text-muted`, `text-green`-family classes.
- No "provenance" code exists anywhere yet (grepped). `ChatResponse = {answer, sessionId}` — no server change needed; provenance is fully known client-side at send time.
- Gates: `bun run typecheck`; `bun test` (CI runs each `src/__tests__/*.test.ts` in its own process — match that loop locally); UI builds `cd src/dashboard/ui && npm ci && npm run build && npm run build:hybrid` (not in CI but required for this slice — the hybrid chunk must exist to see local badges). No lint script exists in this repo.
- Forensic Noir (BRAND.md): status/metadata is ink gray, terse, lowercase; green (`money` #22c55e) is punctuation for value. Badge plan: local = green, the two server states = muted ink. No decorative signal colors.

## Step 1 — Shared derivation in `src/dashboard/ui/src/hybrid/core.ts`

Add at the end of the capability-decision section (~30 lines, no new imports):

```ts
// ── Response provenance ─────────────────────────────────────────────────────

/**
 * Which path actually produced a live chat response. Carried on the live
 * message only — never persisted (no chat-history schema change), so
 * history-loaded messages render with no indicator.
 */
export type ChatProvenance = 'local-with-context' | 'server-fallback' | 'unavailable';

export const PROVENANCE_BADGES: Record<ChatProvenance, string> = {
  'local-with-context': 'answered locally · on-device',
  'server-fallback': 'server fallback',
  'unavailable': 'server agent',
};

/**
 * Single source of truth for the indicator, pinned by
 * src/__tests__/local-chat-provenance.test.ts. `hybridLayerPresent` = the
 * prebuilt hybrid chunk was loadable at send time (window global defined /
 * hook status !== 'unavailable'). WebGPU-unavailable counts as present —
 * the local layer was in play and the server covered for it.
 */
export function deriveChatProvenance(outcome: {
  localAnswered: boolean;
  hybridLayerPresent: boolean;
}): ChatProvenance {
  if (outcome.localAnswered) return 'local-with-context';
  return outcome.hybridLayerPresent ? 'server-fallback' : 'unavailable';
}
```

Rationale for shape: the UIs already collapse `HybridResult` → a boolean; two booleans keep the derivation total, pure, and exhaustively testable without widening `HybridResult` or overloading `HandoffReason` (which describes *why local bounced*, not *which path answered* — mixing them would make `{ok:false}` without a reason ambiguous).

## Step 2 — React hook: always-current availability

`src/dashboard/ui/src/hooks/useHybridChat.ts`:

- Add `const statusRef = useRef<ChunkStatus>('unknown');`
- Inside `ensure()` (after the chunk load resolves), set `statusRef.current = hybrid ? 'available' : 'unavailable';` — so the ref is accurate the moment any `tryLocal` resolves, independent of re-renders.
- The mount `useEffect` keeps calling `setStatus(...)` as today (also seed it from the ref).
- Extend `UseHybridChatResult` with `getStatus(): ChunkStatus` returning `statusRef.current`, and return it.

## Step 3 — React ChatTab (`src/dashboard/ui/src/tabs/ChatTab.tsx`)

1. `import { deriveChatProvenance, PROVENANCE_BADGES, type ChatProvenance } from '@/hybrid/core';`
2. `interface DisplayMessage { role: 'user' | 'assistant'; content: string; provenance?: ChatProvenance; }` — optional, so history rows (`loadSession()`) naturally carry none.
3. In `handleSend()`, after the local attempt and `setProgressLabel(null)`, compute once:
   ```ts
   const provenance = deriveChatProvenance({
     localAnswered: local !== null,
     hybridLayerPresent: hybrid.getStatus() !== 'unavailable',
   });
   ```
   (`'unknown'` counts as present → `server-fallback`; that only occurs if `tryLocal` itself threw, in which case the local layer genuinely was in play.)
4. Attach `provenance` to **all three** appended assistant messages: the local answer, the server answer, and the `Error: ${errMsg}` bubble (the error text was produced by the server path — the badge says which path, and that path was the server's).
5. Render the badge inside the assistant bubble, after `{msg.content}`:
   ```tsx
   {msg.role === 'assistant' && msg.provenance && (
     <div className={`mt-1.5 text-[11px] tracking-wide ${
       msg.provenance === 'local-with-context' ? 'text-green' : 'text-text-muted'
     }`}>
       {PROVENANCE_BADGES[msg.provenance]}
     </div>
   )}
   ```
   No badge when `provenance` is undefined → history-loaded messages stay clean automatically.

## Step 4 — Legacy dashboard (`src/dashboard/html.ts`, inside the template string)

⚠ All edits are inside a JS template literal: use string concatenation, **no backticks and no `${`** in the added JS (the file already escapes them as `BT`/`BT3` — follow that discipline).

1. CSS (near the other `.chat-msg` rules, ~line 102):
   ```css
   .chat-msg .prov { font-size:11px; color:#8b949e; margin-top:4px; letter-spacing:.02em; }
   .chat-msg .prov-local { color:#22c55e; }
   ```
2. JS helpers (near `addChatMsg`):
   ```js
   // Provenance badge — mirrors deriveChatProvenance in
   // src/dashboard/ui/src/hybrid/core.ts (matrix pinned by
   // src/__tests__/local-chat-provenance.test.ts). Inline copy because this
   // page cannot import ES modules and the hybrid chunk 404s in exactly the
   // state ('unavailable') this badge must render.
   var PROV_LABELS = { 'local-with-context':'answered locally · on-device', 'server-fallback':'server fallback', 'unavailable':'server agent' };
   function deriveProv(localAnswered, hybridPresent) {
     if (localAnswered) return 'local-with-context';
     return hybridPresent ? 'server-fallback' : 'unavailable';
   }
   function stampProv(msgDiv, prov) {
     var b = el('div','prov'+(prov==='local-with-context'?' prov-local':''),PROV_LABELS[prov]||'');
     var bubble = msgDiv.querySelector('.bubble'); if (bubble) bubble.appendChild(b);
   }
   ```
3. `sendChat()`: track presence and stamp every terminal render of the pending bubble:
   - `var localAnswer = null, hybridPresent = false;`
   - In the existing `if (window.WilsonHybridChat) {` block set `hybridPresent = true;` first (keep the try/catch as is).
   - After the block: `var prov = deriveProv(localAnswer != null, hybridPresent);`
   - Local branch: after `pendingText.innerHTML = renderMd(localAnswer);` add `stampProv(pending, prov);`
   - Server branch: after `pendingText.innerHTML = renderMd(answer);` add `stampProv(pending, prov);`
   - Server catch: after `pendingText.textContent = 'Error: '+e.message;` add `stampProv(pending, prov);`
4. `renderSessionMessages()` and `loadSessions()` untouched → history and session reloads render no badges (no schema change, nothing persisted).

Known pre-existing race (unchanged by this slice, now observable): if the user's very first send fires before the deferred module script defines `window.WilsonHybridChat`, that exchange derives `unavailable` — which is honest, since local genuinely did not answer it; later sends in the session badge correctly.

## Step 5 — Tests: `src/__tests__/local-chat-provenance.test.ts` (new)

Same style as `local-chat-handoff.test.ts` (bun:test, imports the DOM-free core directly):

```ts
import { describe, expect, test } from 'bun:test';
import { deriveChatProvenance, PROVENANCE_BADGES } from '../dashboard/ui/src/hybrid/core.js';
import type { ChatProvenance } from '../dashboard/ui/src/hybrid/core.js';
```

Pin, at minimum:
- `{localAnswered:true}` → `'local-with-context'` **regardless of** `hybridLayerPresent` (both boolean variants).
- `{localAnswered:false, hybridLayerPresent:true}` → `'server-fallback'` (covers every `{ok:false}` reason: hand-offs, WebGPU unavailability, errors — the reason never changes the badge).
- `{localAnswered:false, hybridLayerPresent:false}` → `'unavailable'` (neutral; hybrid chunk absent).
- `PROVENANCE_BADGES`: exactly the three `ChatProvenance` keys, every label non-empty, all three labels distinct (guards a copy-paste typo shipping a wrong badge).

Run with the CI-style per-file loop (`for f in src/__tests__/*.test.ts; do bun test "$f"; done`) to catch cross-file contamination.

## Step 6 — CHANGELOG

Add one `feat:` bullet under `## [Unreleased] → Features` in `CHANGELOG.md`, matching the house style, e.g.:

> feat: per-response provenance indicator in both dashboard chat UIs — each live answer is badged `answered locally · on-device`, `server fallback`, or a neutral `server agent` when the hybrid layer is absent; derived at send time from the exchange's actual path (never from message text), not persisted, so history-loaded messages show no badge (#69)

## Files touched

| File | Change |
|---|---|
| `src/dashboard/ui/src/hybrid/core.ts` | Add `ChatProvenance`, `PROVENANCE_BADGES`, `deriveChatProvenance` (~25 lines) |
| `src/dashboard/ui/src/hooks/useHybridChat.ts` | `statusRef` + `getStatus()` |
| `src/dashboard/ui/src/tabs/ChatTab.tsx` | `provenance` on `DisplayMessage`, derive in `handleSend`, badge render |
| `src/dashboard/html.ts` | `.prov` CSS, `PROV_LABELS`/`deriveProv`/`stampProv` inline JS, stamp in `sendChat`'s three terminal paths |
| `src/__tests__/local-chat-provenance.test.ts` | New derivation-matrix test |
| `CHANGELOG.md` | Feature bullet |

No changes: server (`server.ts`/`api.ts`/`chat.ts`), `HybridResult`/`HandoffReason` shapes, DB schema, `standalone.ts` (no new global surface needed — the legacy page carries its inline mirror by design), vite configs.

## Out of scope

Persisting provenance (forbidden — no chat-history schema change), badges on history-loaded messages, server-side knowledge of why the browser fell back, showing which server model answered (that's issue #88's turf), CLI/TUI chat, streaming, worker-mode inference.

## Verify

1. `bun install` (fresh worktree) → `bun run typecheck` → per-file `bun test` loop → all green.
2. `cd src/dashboard/ui && npm ci && npm run build && npm run build:hybrid` → both builds pass; `dist/index.html` still contains no `onnxruntime`/`transformers` strings (the new core imports are types + tiny consts, nothing that could pull the chunk into the singlefile build).
3. Manual matrix (maps to the AC):
   - `bun run src/index.tsx --dashboard --port 3141` with a seeded DB; open in Chrome/Edge (WebGPU).
   - Ask a bundle-covered question ("how much did I spend on groceries this week?") → answer carries the green **answered locally · on-device** badge.
   - Same session, ask outside the 30-day bundle window ("what did I spend on rent last year?") → answer carries the **server fallback** badge. **Both badges visible in one session** (AC 4).
   - Firefox/Safari (no WebGPU), hybrid build present → **server fallback** badge (WebGPU unavailability is a fallback, not the neutral state).
   - Legacy check: rename `src/dashboard/ui/dist-hybrid/` aside, restart, reload the legacy page → live answers carry the neutral **server agent** badge; restore the dir → local badges appear there too.
   - Reload / open an old session in either UI → no badges on history messages.
   - React UI check: badge renders for all three states with the right tone (green vs muted).

## Acceptance-criteria mapping

| AC | Where |
|---|---|
| Every live response in both UIs carries the indicator matching the actual path (local-with-context / server fallback / unavailable) | Steps 3–4 (all three terminal render paths in each UI stamped: local answer, server answer, error bubble) |
| Derives from provenance carried on each exchange, not message text | `DisplayMessage.provenance` / stamped element set at send time from the `tryLocal` outcome + layer presence; `deriveChatProvenance` never sees message content |
| Provenance derivation covered by tests; test/lint/typecheck/build pass | Step 5 (`local-chat-provenance.test.ts`); Step Verify 1–2 (no lint script exists in this repo — typecheck + per-file tests + both UI builds are the gates) |
| Manual check: bundle-covered → local; outside-bundle or no-WebGPU → server/unavailable; both in one session | Step Verify 3 |

## Risks / notes for the builder

- The whole legacy change lives inside one giant template string — any stray backtick or `${` breaks the build; keep the added JS backtick-free and re-run `bun run typecheck` (html.ts is compiled, the inner JS is not).
- Do not "fix" the semantics by keying off `HybridResult.reason`: no-reason `{ok:false}` results are deliberately ambiguous, and layer presence is what separates fallback from neutral.
- The React `status` state is stale inside `handleSend` closures — that's why Step 2 adds the ref-based getter; don't derive from `hybrid.status` directly.
- Tailwind class for the local tone: ChatTab already uses green utilities (`bg-green-700`, `text-text-muted`); `text-green` resolves via the `--color-green` `@theme` token — match whatever sibling utilities compile to (`text-[11px]` arbitrary value is already used in the file? if not, use `text-xs`).
- Keep `PROVENANCE_BADGES` copy terse and lowercase per BRAND.md metadata rules; don't add icons or signal colors to the server states.