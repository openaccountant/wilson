# Plan: Use Plaid `institution_id` for duplicate Item detection

**Session:** issue-3 · **Priority:** Low · **Scope:** 4 source files + 1 new test file

> **Path note:** the issue text references `cli/src/plaid/…`, but in this repo the files live at
> `src/plaid/…` and `src/tools/import/…`. All paths below are real repo paths.

## Problem

`startPlaidLinkServer`'s `/callback` (`src/plaid/link-server.ts:145-150`) detects duplicate
Plaid Items by comparing `institutionName` case-insensitively. Name matching is fragile:
different institutions can share/similar names, and Plaid name formatting can drift. Plaid's
stable `institution_id` (e.g. `ins_109508`) is already available on every `/accounts/get`
response and should be the dedup key.

## Current state (verified)

- `PlaidItem` (`src/plaid/store.ts:15-23`) has `itemId`, `accessToken`, `institutionName`,
  `accounts`, `cursor`, `linkedAt`, `errorState` — **no** `institutionId`.
- `getItemInfo` (`src/plaid/client.ts:296-371`) returns `{ institutionName, accounts }`.
  Internally **both branches** (proxy and direct) already compute `instId` from the
  `/accounts/get` `item.institution_id` field, then discard it.
- `getItemInstitutionId` (`src/plaid/client.ts:668-688`) exists and works (proxy + direct),
  but is currently imported by `link-server.ts` **unused**. It makes its own `accountsGet` /
  proxy `/plaid/accounts` call.
- Duplicate detection in `link-server.ts` `/callback`:
  ```ts
  const duplicate = existingItems.find(
    (existing) => existing.institutionName.toLowerCase() === info.institutionName.toLowerCase()
      && existing.itemId !== itemId
  );
  ```
  When a duplicate is found the new Item inherits `duplicate.cursor` — the code *intends*
  to replace the old Item, but the old Item is never removed from the store, so it keeps
  syncing forever alongside the new one. We fix that here since we're touching this path.
- `savePlaidItem` upserts by `itemId`; it re-attempts `setSecret` with the resolved token and
  stores `__keychain__` in JSON when the OS keychain holds the token. Calling it with an
  already-resolved item is idempotent and safe.
- Both sync entry points (`plaid_sync` tool loop in `src/tools/import/plaid-sync.ts:328-333`
  and `runSync` in `src/sync.ts:74`) call `syncPlaidItem(db, item, useProxy)` per item —
  that is the single choke point for the backfill migration.
- Tests already reference `institutionId` in mocks (`src/__tests__/sync.test.ts:139,231`) via
  `as any`, so they will keep passing; `bun test` + `bun run typecheck` are the gates.

## Design decision: three-state `institutionId`

`institutionId?: string | null` on `PlaidItem`, with explicit semantics:

- `undefined` — **legacy record** written before this change; never migrated.
- `null` — migration ran (or Item was linked post-change) and Plaid returned no
  institution_id (rare; some Item types). Persisting `null` stops repeat migration calls.
- `string` — Plaid `institution_id`, authoritative.

This lets the backfill run at most once per Item lifetime (`item.institutionId === undefined`
is the trigger) instead of every sync.

## Changes

### 1. `src/plaid/store.ts` — add field + removal helper

- Add to `PlaidItem`:
  ```ts
  /** Plaid institution_id (e.g. "ins_109508") used for duplicate-Item detection.
   *  undefined = legacy record pending migration; null = Plaid returned none. */
  institutionId?: string | null;
  ```
- Add `removePlaidItemById(itemId: string): boolean` next to `removePlaidItem`:
  filter the store by `itemId`, on change `writeStore(store)` and
  `deleteSecret('plaid-' + itemId)` per removed item (same pattern as
  `removePlaidItem`, `store.ts:143-163`). Return whether anything was removed.
- Leave the name-based `findPlaidItem` / `removePlaidItem` alone — the CLI
  `/connect reauth|remove` commands (`src/cli.ts:669-715`) take a *user-typed*
  institution name and must keep working by name.

### 2. `src/plaid/client.ts` — thread `institutionId` through `getItemInfo`

- Change `getItemInfo` return type to
  `{ institutionName: string; institutionId: string | null; accounts: [...] }`.
- Proxy branch: return `institutionId: accountsData.item?.institution_id ?? null`
  (`instId` is already in scope at `client.ts:320`) — return it even when the
  institution-*name* lookup fails.
- Direct branch: same with `accountsRes.data.item.institution_id` (`client.ts:353`).
- Keep `getItemInstitutionId` exported — the sync-side backfill uses it (it's the cheapest
  standalone way to get the id for an existing Item, since `transactions/sync` doesn't
  return item metadata).
- No other client changes.

### 3. `src/plaid/link-server.ts` — dedup by `institution_id`

In `/callback` of `startPlaidLinkServer`:

- Remove the unused `getItemInstitutionId` import; `getItemInfo` now supplies the id.
- Extract the duplicate lookup into an exported pure helper for testability:
  ```ts
  export function findDuplicateItem(
    existingItems: PlaidItem[],
    newItem: { institutionId: string | null; institutionName: string; itemId: string },
  ): PlaidItem | undefined
  ```
  Logic (in order):
  1. Always skip `existing.itemId === newItem.itemId` (re-linking the same Item is an
     upsert, not a duplicate).
  2. **Institution-id match wins:** if `newItem.institutionId` is truthy, match
     `existing.institutionId === newItem.institutionId` — and *only* consider existing
     items with a truthy `institutionId`. Different ids ⇒ not a duplicate even if names
     match; this is what makes the check robust.
  3. **Name fallback** only when the id path can't fire — i.e. existing item's
     `institutionId` is falsy (`undefined` legacy or `null`) or `newItem.institutionId`
     is falsy: case-insensitive `institutionName` comparison (current behavior).
  4. Return the first match.
- Replace the inline `existingItems.find(...)` with `findDuplicateItem(getPlaidItems(), { itemId, institutionId: info.institutionId, institutionName: info.institutionName })`.
- Build the new `PlaidItem` with `institutionId: info.institutionId` (keep
  `cursor: duplicate?.cursor ?? null` cursor inheritance).
- After `savePlaidItem(item)`, if a duplicate was found:
  `removePlaidItemById(duplicate.itemId)` and
  `logger.info('plaid:link:replaced-duplicate', { replacedItemId: duplicate.itemId, institutionId: info.institutionId })`.
  Rationale: the path already treats the link as a replacement (cursor inheritance);
  leaving the old Item in `plaid.json` means two Items syncing the same institution.
  Guard it with try/catch? No — `removePlaidItemById` is sync and can't throw; just call it.
- Response JSON keeps its shape; `duplicate` stays the matched item's `institutionName`.
- `startPlaidLinkUpdateServer` needs no change (it re-saves the same item object, which now
  carries `institutionId` once set).

### 4. `src/tools/import/plaid-sync.ts` — backfill migration on next sync

- Add imports: `getItemInstitutionId` (from `../../plaid/client.js`, already imported
  module), `savePlaidItem` (from `../../plaid/store.js`).
- New exported helper near the top:
  ```ts
  /**
   * One-time migration: backfill institution_id for legacy Items written before
   * institutionId existed. No-ops for items that already have the field (string or null).
   * Never throws — a failed backfill must not block the sync; it retries next sync.
   */
  export async function ensureInstitutionId(item: PlaidItem, useProxy: boolean): Promise<void>
  ```
  Body:
  ```ts
  if (item.institutionId !== undefined) return;              // already migrated (or post-change item)
  if (!item.accessToken || item.accessToken === '__keychain__') return; // can't call API; skip silently
  try {
    item.institutionId = (await getItemInstitutionId(item.accessToken, useProxy)) ?? null;
    savePlaidItem(item);                                     // upserts by itemId; keychain path idempotent
  } catch (err) {
    logger.info('plaid:backfill:institution-id-failed', { itemId: item.itemId }); // leave undefined → retry next sync
  }
  ```
  - Check whether `logger` is already imported in this file; add the import if not.
  - The `__keychain__` guard matters: `savePlaidItem` would otherwise persist the literal
    placeholder string as a token.
  - Mutating `item` in place is fine — callers pass the objects straight from
    `getPlaidItems()`.
- Call `await ensureInstitutionId(item, useProxy);` as the first statement of
  `syncPlaidItem` (before the `isReauthRequired` bookkeeping is used is fine anywhere;
  put it first so the persisted Item is up to date even if the sync later errors).
- Covers both `/sync` (tool) and `--sync` (`runSync`) since both funnel through
  `syncPlaidItem`. Intentionally NOT adding backfill to the balances-only path
  (`plaid-balances.ts`) — transaction sync is the natural migration trigger.

### 5. Tests — new file `src/__tests__/plaid-duplicate-item.test.ts`

Use `bun:test` with `mock.module` (pattern proven in `src/__tests__/sync.test.ts`).

**A. `findDuplicateItem` unit tests (required):**
1. matches by `institutionId` even when names differ
   (`'First National Bank'` vs `'First National Bank, N.A.'`).
2. does NOT match when both have ids and ids differ, even if names are identical.
3. name fallback: legacy existing item (`institutionId: undefined`) with same name matches.
4. name fallback: new item with `institutionId: null` matches same-named existing.
5. never matches an existing item with the same `itemId` (same-Item re-link).
6. legacy item whose name differs AND has a different... — no id on either side, names
   differ ⇒ no match.
7. existing item with `institutionId: null` is matched by name fallback, not by id
   (`null !== null` must never be treated as an id match — assert an existing item with
   `institutionId: null` and a *different* name does not match a new item that has a real id).

**B. `ensureInstitutionId` tests (required):**
Mock `../plaid/client.js` (`getItemInstitutionId`) and `../plaid/store.js`
(`savePlaidItem` via spy; `getPlaidItems` not needed by the helper). Cases:
1. legacy item (`institutionId: undefined`) → helper calls `getItemInstitutionId`,
   calls `savePlaidItem` with `institutionId` set to the mocked id.
2. already-set item (`'ins_1'`) → no API call, no save.
3. `null` case: mocked API returns `null` → saves with `institutionId: null` so the
   migration doesn't retry every sync.
4. `getItemInstitutionId` throws → helper resolves without throwing, `savePlaidItem`
   not called, item left with `institutionId: undefined`.
5. `accessToken` is `'__keychain__'` → no API call, no save.

**C. Regression sweep (no new code):** `bun test` and `bun run typecheck` must pass —
existing mocks in `sync.test.ts` already carry `institutionId: 'ins1'` (under `as any`),
and the local item types in `plaid-sync-modified-removed.test.ts` /
`plaid-balances-tool.test.ts` are structural and unaffected by the added optional field.

## Out of scope

- Changing CLI `/connect remove|reauth` (still by name — user-facing command input).
- Backfill from the balances tool path.
- Any `plaid.json` version bump or schema migration machinery — the optional field plus
  `undefined`-sensing backfill is the whole migration.

## Verification

```bash
bun run typecheck        # tsc --noEmit — must be clean
bun test                 # full suite — must be green, incl. new plaid-duplicate-item.test.ts
```

Manual smoke (optional, sandbox creds): link the same sandbox institution twice via
`/connect`; second link should log `plaid:link:replaced-duplicate`, the old ItemId
disappears from `~/.openaccountant/plaid.json`, and the surviving Item carries
`institutionId`.

## Commit plan

Single commit: `feat(plaid): dedup Items by institution_id with backfill on sync`
(plus CHANGELOG entry only if the release tooling expects manual edits — it currently
looks release-generated, so skip).