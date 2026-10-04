# Re-auth for consequential agent operations (opt-in, admin-controlled)

Status: design spec, **revision 2** (2026-10-04, amended after the adversarial review at the end of this file; findings are cited as AR-n). Follow-up to `specs/webmcp-security-judge.md` (#160), which deferred this as Open Question 8 ("Re-auth goes to a follow-up, opt-in per tool, only when auth is enabled"; §U "OQ8: re-auth for consequential tools is a follow-up"). Threats `T01`–`T38`, assets `A1`–`A8`, actors `ACT-1`–`ACT-9` and invariants 1–9 are the ones in `specs/webmcp-threat-model.md`; this spec adds `A9`–`A11`, `T39`–`T47` and invariants 10–14 (§4).
Branch: `docs/webmcp-followup-specs` (spec only). Implementation goes on its own branch off `release/0.10.0`.
All line citations were checked against `release/0.10.0` @ `e8d0d0a`, plus `fix/auth-switch-hygiene` (read-only worktree `.claude/worktrees/auth-switch-hygiene`) where stated.

> **Rebase requirement (binding).** Implementation **must rebase onto `fix/auth-switch-hygiene` after that branch lands on `release/0.10.0`**, and must not start the server-side slices (S3 onward) before it has. Three of its commits change the exact code paths this spec hooks into: `b58d2d6` (re-validate the login after the body of every write route), `b843a6a` (deactivating a user cancels their in-flight chat run and its pending card) and `1c2bc6b` (deny-policy runs ignore the runner's session approvals). §2.9 lists what each one means for this design. If the branch has not landed when S3 is due, stop and ask Jd; do not cherry-pick its commits.

Conventions (same as #160):
- **Migrations**: this spec needs **none** (§6). `v34` is reserved for open-jev and must not be used. If Jd chooses the persistent lockout in Open Question 4, it is **v35**, ALTER-only, and the implementer re-checks the highest version on `origin/*` right before writing it.
- **Shared browser modules** stay import-free and DOM-free (bundled by Bun.build for the bridge and by vite for React, tested from root). The new one is `src/dashboard/reauth-ui-core.ts` (alias `@reauth-ui`).
- **TDD**: each slice's tests are listed in the order to write them. Make each fail first.
- **Gates** for every slice: `bun run typecheck`; the CI per-file loop `for f in src/__tests__/*.test.ts; do bun test "$f" || FAIL=1; done` (CI runs each file in its own process, `.github/workflows/*.yml:164,521`); `cd src/dashboard/ui && npm run build` when UI changed.
- **Naming.** The catalog's `consequentialHint` (`tool-catalog.ts:806,823`) already means "mutating or proposal" and is advice to agents. It is **not** changed. The narrower class this spec gates is called **re-auth consequential (RC)** everywhere, in code and copy, so the two are never confused.

---

## §A Recon (verified at `e8d0d0a` unless noted)

| Fact | Where |
|---|---|
| Auth is per profile: the flag is the `dashboard_config` row `auth_enabled` in the profile DB, read fresh on every call | `src/dashboard/auth.ts:31-33,44-58` |
| Sessions: 32 random bytes hex, stored **raw** in `dashboard_sessions.token`, 7-day expiry, validated by a join on `is_active = 1` | `auth.ts:162-205` (T33) |
| `verifyLogin` returns early for an unknown or inactive user (no dummy hash), so the response time tells an unknown username from a wrong password | `auth.ts:170-180` |
| **`POST /api/auth/login` has no rate limit or lockout.** Anyone who can reach the server can guess passwords at argon2id speed | `server.ts:486-496` |
| There is no password-change route and no role-change route. Users are created (`POST /api/auth/users`, `:518-530`) and deactivated (`DELETE /api/auth/users/:id`, `:532-542`); auth is toggled by `PATCH /api/auth/config` (`:544-552`) | `server.ts` |
| The auth middleware takes the bearer from `Authorization` only (query `?token=` only for `GET /api/export/*`) and exempts `/api/auth/{status,setup,login}`, the HTML page, the bridge script and `/mcp` | `server.ts:347-379` |
| Every approval surface ends in one route pair: `POST /api/mcp/operations/:id/approve` and `/reject`. Both require browser proof (`browserProof`, `mcp-routes.ts:172`). Approve checks visibility, `canWrite`, then branches: chat cards go to `respondToChatOperation` after expiry, admin and dwell checks; WebMCP/HTTP-MCP ops go to `approveWebMcpOperation` | `mcp-routes.ts:437-473` (approve), `:475-494` (reject) |
| `approveWebMcpOperation`: visibility, resolved read-back, expiry, role (`kind !== 'read'` needs admin), dwell floor (`isApprovalTooFast`, 1,000 ms), then issues and consumes a one-shot approval token and commits; commit re-checks owner state, policy Off and "http-mcp needs auth" | `engine.ts:942-964`, dwell `:902-926`, commit `:1015-1060` |
| Chat cards: `getPendingChatOperation` binds one `mcp_operations` row to the runner's exact pending request (request object, per-request nonce, tool, canonical args hash); `respondToChatOperation` refuses anything else as stale (409) and retires the card | `chat.ts:117-125,188-262,282-332` |
| Dashboard chat answers only `allow-once` / `deny` (`mcp-routes.ts:466,485`). The runner's `sessionApprovedTools` are shared across that runner's runs; `gateToolCall` skips the prompt entirely when `allow-session` already covers the call | `approval-gate.ts:31-52`, `agent-runner.ts:181-212` |
| The TUI runner (`cli.ts:345`) prompts in the terminal and offers `allow-session` (`components/select-list.ts:108`). Headless (`--run`) uses `approvals: 'deny'` and explains each denial (`headless.ts:51-61`) | |
| A denied tool call yields `tool_denied` with no reason, and records no tool result, so the model is not told why | `tool-executor.ts:100-113`, `agent/types.ts:126-130` |
| Control-plane routes an agent driving the page could press: client-token mint / rotate / tools (`mcp-routes.ts:519-567`), `PUT /api/mcp/settings` (kill switch, TTL, judge limit, `:580-604`), `PUT /api/mcp/policies/:tool` (`:610-619`), `PATCH /api/auth/config`, `POST /api/auth/users`, `PUT /api/settings/custom-prompt` (`server.ts:864`), judgement bulk accept (`judgement-routes.ts:109`), training exports with opt-ins (`server.ts:1227-1259`, GET with `includeJudge` etc.) | |
| Human REST writes a DOM-driving agent can press with no card (T34): `PATCH`/`DELETE /api/transactions/:id` (`server.ts:707-720`), `DELETE /api/entities/:id` (`:793`), `POST /api/import` (`:803`), `DELETE /api/memories/:id` (`:851`), budgets/goals PUT/PATCH | |
| `isAgentPresent(db, userId, profile)` already computes "this user has a live grant or pending non-chat op" | `store.ts:453` |
| `mcp_audit_log.decision` is free `TEXT` (no CHECK), so new decision values need no migration; the TS union is `AuditDecision` | `schema.ts:579`, `audit.ts:29-36` |
| CORS preflight allows `Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, X-Wilson-Agent-Session` | `server.ts:298` |
| The live seed creates the default profile with **auth off**; only `scripts/demo-enable-auth.ts` turns auth on, and only for the `demo` profile | `scripts/webmcp-live-seed.ts:52-53`, `scripts/demo-enable-auth.ts` |
| `fix/auth-switch-hygiene` (not on release yet): `PUBLIC_AUTH_PATHS` + `isPublicAuthPath`; the write-time hook now re-runs `validateToken` after the body for every state-changing non-public, non-`/mcp` route and replaces `currentUser` with the fresh row; `cancelChatRunForUser` is called from the deactivate route; deny runs get an empty `sessionApprovedTools` | worktree `auth-switch-hygiene`: `server.ts:164-168,400-423,575-580`, `chat.ts` `cancelChatRunForUser`, `agent-runner.ts:210-217` |

---

## §1 Goals and non-goals

### Goals
1. An **admin-controlled, opt-in, per-profile** setting that makes the logged-in user re-enter their password before an RC operation is approved, on every approval surface: the bridge card, Settings → Pending approvals, and the dashboard chat card. Operations from all sources are covered: WebMCP tab tools, declarative forms, `/mcp` client-token tools, and chat agent tool calls.
2. A precise, table-driven, **fail-closed** definition of RC (§2.1) shared by the catalog tools and the chat agent's tools.
3. The same password gate on **control-plane loosening** (minting write-capable client tokens, policy loosening, re-enabling the kill switch, turning auth or re-auth off, creating admins, changing the system prompt, opt-in training exports, bulk judge accepts). Tightening is never gated.
4. Two modes: **every time** (a single-use re-auth token bound to one operation) and **recent-auth window** (1, 5 or 15 minutes, bound to the browser session; never used for control-plane actions).
5. Brute-force resistance that cannot be routed around through `/api/auth/login` (which gets its first limiter here).
6. Defined behaviour where nobody can type a password: the TUI and headless runs **deny with a message**.
7. With auth off the setting is **unavailable** (no ghost protection).
8. Composition with the #160 controls and the auth-switch fixes, with no weakening of any of them.

### Non-goals
- Passkeys / WebAuthn, TOTP, OS-level user presence. (`requestUserInteraction()` has not shipped; revisit with Open Question 19 of #160.)
- Re-auth for reads, including read-ask cards (reads are never RC; a viewer can read the same data directly).
- Re-auth when creating tab grants (the approval of every write that grant enables is already gated; Open Question 12).
- Password change, password reset, or role-change routes (none exist; §2.6 still defines what they must purge when added).
- Hashing `dashboard_sessions.token` at rest (T33, its own follow-up).
- The CSV/XLSX/P&L/net-worth export links that still use `?token=` (T29 follow-up). Only the training exports, which already use `fetch` + Blob, are gated (§2.4).
- Making a local process (ACT-4) unable to bypass this. It can read and write the SQLite file. The boundary stays the OS user (§4.4 residuals).

---

## §2 Design

### §2.1 What is re-auth consequential (RC)

RC is decided on the **server** from `(surface, toolName, args)` by one function, `classifyConsequence(surface: 'catalog' | 'chat', toolName, args, scope)` in the new import-free module `src/mcp/consequential.ts`. Authorization never depends on the client saying a call is or is not RC. The table names each tool explicitly; **a mutating tool not in the table is RC** (fail closed), and a coverage test (T-C2) fails the build when a tool in `MUTATING_TOOL_NAMES` (`src/__tests__/mutation-audit.ts`) or a catalog `mutating`/`proposal` tool is missing from the table, so a new tool is classified on purpose.

**Surface is part of the key (adversarial review AR-2).** Two chat names used to exist on the catalog too, with different meanings: `tax_flag` (chat: flag/unflag plus `summary`, `list` and `action='export'`) and `edit_transaction`. The catalog renamed them to `set_tax_flag` and `update_transaction` (specs/webmcp-tool-naming.md), so the exact-string collision is gone for live names. `(surface, name)` keys are still required: retired catalog names equal chat names in old rows (history, pending ops and audit), and a chat-facing lookup by name alone could still pick up a catalog row. A lookup by name alone would let the catalog row ("never") decide a chat call. The surface is derived on the server, never from the request: `op.source === 'chat'` or any `AgentRunnerController` call → `'chat'`; `op.source ∈ {webmcp, http-mcp, declarative}` → `'catalog'`. A `(surface, name)` pair missing from the table is RC `unknown_tool`. T-C6 pins it: "chat tax_flag export is RC egress even though catalog set_tax_flag is never RC".

**Action-dependent rows are allow-lists of non-RC actions (AR-3).** A row that says "RC when `action ∈ {…}`" fails open the day a tool gains a new write action (that is already true today: `entity_manage` has `assign`, which re-points many transactions and accounts at an entity, and the first draft of this table did not list it). So every action-dependent row is written as **"not RC for actions in {…}; any other mutating action is RC"**, the same shape as `mutatesUnlessAction` (`src/tools/mutation.ts:20`). T-C7 enumerates each tool's zod `action` enum and fails when an action is neither in the non-RC set nor named in the table's RC column.

RC kinds (a call can have several; the card names the first):

| Kind | Rule | Why |
|---|---|---|
| `delete` | Removes a row or deactivates something | Not undone by a later edit; the revision precondition cannot help |
| `bulk` | Can change more than one existing row in one call, or installs a rule that changes future rows | Blast radius; one card hides many changes |
| `value` | Changes the money identity of a transaction (amount, date) or an account balance, account or mortgage | Corrupts reports and taxes (A2) in ways a category change does not |
| `egress` | Writes data out of the ledger (files, exports) | Confidentiality (A1) |
| `external` | Pulls from or syncs with an external service using stored credentials | Spends credentials; writes many rows |
| `prompt` | Changes what every later agent run is told (memories, custom system prompt) | Persistent prompt injection (T10, T24) |
| `control` | Control-plane loosening (§2.4) | Disables the other controls |
| `unknown_tool` | A mutating tool missing from the table, or an MCP-adapter tool from an external server | Fail closed |

The table (initial, Open Question 8 asks Jd to confirm it):

| Tool (source) | RC when | Kind |
|---|---|---|
| `categorize_transaction` (catalog) | never | — |
| `set_tax_flag` (catalog) | never (flag/unflag one row) | — |
| `update_transaction` (catalog) and `edit_transaction` (chat) | `amount` or `date` present | `value` |
| `resolve_review_item`, `set_budget`, `update_goal` (catalog) | never | — |
| `propose_judgments`, `propose_judgment` (catalog, proposal) | never (rows are inert until a human accepts; the **bulk accept** is gated, §2.4) | — |
| `delete_transaction` (chat) | always | `delete` |
| `categorize` (chat, bulk categorizer) | always | `bulk` |
| `csv_import`, `monarch_import`, `firefly_import` (chat) | always | `bulk` |
| `plaid_sync`, `plaid_balances`, `coinbase_sync` (chat) | always | `external` |
| `export_transactions`, `generate_report` (chat) | always | `egress` |
| `tax_flag` (chat) | any action except `flag`, `unflag` (reads `summary`, `list` are not mutating); today that is `export` | `egress` |
| `category_manage` (chat) | any action except `add` (today: `delete`) | `delete` |
| `goal_manage` (chat) | any action except `add`, `update`, `progress`, `complete`, `pause` (today: `abandon`) | `delete` |
| `memory_manage` (chat) | any write action (no non-RC writes; today `add`, `deactivate`) | `prompt` |
| `entity_manage` (chat) | any action except `add`, `update` (today: `delete` → `delete`; `assign` → `bulk`) | `delete` / `bulk` |
| `entity_classify`, `link_transactions` (chat) | `dryRun !== true` | `bulk` |
| `rule_manage` (chat) | any write action (today `add`, `update`, `delete`) | `bulk` |
| `account_manage` (chat) | any write action (today `add`, `update`, `remove`) | `value` |
| `balance_update`, `mortgage_manage` writes (chat) | any write action | `value` |
| `budget_set` (chat) | never | — |
| `chain_*`, `team_*` (chat orchestration) | never at the run level: every write **inside** the run passes the gate on its own (`approval-gate.ts:21-25`) and is classified there | — |
| any other mutating tool, incl. MCP-adapter tools (`src/mcp/adapter.ts`) | always | `unknown_tool` |

**Not covered: non-mutating egress (AR-13, Open Question 15).** The chat agent's web search tools (`brave.ts`, `perplexity.ts`, `exa.ts`, `tavily.ts`, all `mutates: false`) send a model-chosen query string to a third party. A prompt-injected chat run can put ledger data in that query. They never reach the approval gate (`approval-gate.ts:38`), so re-auth cannot see them. This spec does not change that; Settings copy and §4.4 name it.

**Scope setting.** The policy's `scope` is `rc` (default: only the rows above) or `all_writes` (every approval of an operation with `kind ∈ {mutation, proposal}` and every chat approval). `all_writes` exists for admins who want it on everything; it does not change the control-plane rules.

`classifyConsequence` is called **at approve time against the stored args** (`op.args_json`, or the chat binding's args, whose hash `respondToChatOperation` already pins). Never at prepare time only: a policy turned on while a card is pending must apply to that card.

### §2.2 The setting

Stored in the profile DB, in `dashboard_config` under the key `reauth_policy`, as JSON. **Not** in the profile `settings.json` (`getSetting` / `setSetting`): those are files any agent with a shell tool can edit and they are not covered by dashboard auth, while `dashboard_config` sits next to `auth_enabled` and is only changed through authenticated routes. Per profile, like auth itself (T35 note: this is deliberate, a profile without auth cannot have re-auth).

```ts
// src/dashboard/reauth/policy.ts
export interface ReauthPolicy {
  mode: 'off' | 'every_time' | 'window';
  windowMinutes: 1 | 5 | 15;          // used only when mode = 'window'; default 5
  scope: 'rc' | 'all_writes';          // default 'rc'
  restGate: 'always' | 'agent_present'; // §2.4 D; default 'always' (AR-1)
  updatedAt: string; updatedBy: number; // audit only
}
export function getReauthPolicy(db): ReauthPolicy;          // missing/invalid row → mode 'off' (and a console warning for invalid)
export function isReauthActive(db): boolean;               // isAuthEnabled(db) && mode !== 'off'
export function isLoosening(from: ReauthPolicy, to: ReauthPolicy): boolean;
export function setReauthPolicy(db, next, actor): Result;  // admin only, auth on, see rules
```

Rules:
- **Auth off → unavailable.** `isReauthActive` is false whatever the row says, `GET /api/auth/reauth/policy` returns `{available:false, reason:'auth_off'}`, and `PUT` returns 409 `auth_required` "Turn on dashboard auth first; re-auth checks the logged-in user's password." The stored row is **kept, inert**, so turning auth back on restores the admin's choice (Open Question 14). Settings shows the control disabled with that sentence.
- **Admin only** (`canWrite`), browser proof, zod `.strict()` body.
- **Tightening** (off → any, window → every_time, shorter window, rc → all_writes, agent_present → always) needs no re-auth.
- **Loosening** (`isLoosening`: any → off, every_time → window, longer window, all_writes → rc, always → agent_present) is a **control** action (§2.4): fresh re-auth, never the window. `isLoosening` is true when **any** dimension loosens, whatever the others do (a body that tightens `mode` and loosens `scope` is loosening).
- A change writes a `rest_write` audit row (`reauth_policy from=… to=…`) and, when loosening, the `reauth_ok` row of the token it consumed.
- `isReauthActive` is read fresh on every approve (like `isAuthEnabled`), so turning the policy on applies to cards already pending.

### §2.3 Re-auth core (in memory, no migration)

New directory `src/dashboard/reauth/`:

**`verify.ts`**
- `verifyPassword(db, userId, password): Promise<boolean>` reads `password_hash` for an **active** user by id and runs `Bun.password.verify`. When the user is missing or inactive it verifies against a fixed dummy argon2id hash, so the time does not reveal it. Never creates a session.
- `auth.ts` `verifyLogin` gets the same dummy-hash treatment for unknown usernames (closes the timing oracle in §A).

**`attempts.ts`: one password-attempt ledger for login and re-auth.** In-memory, injectable clock, created per DB like `limiterFor` (`rate-limit.ts:253`).
- Key: `user:<id>` for re-auth; for login, `user:<id>` when the username exists, else `name:<sha256(lowercased username)>`. So a failed re-auth and a failed login of the same account draw on **the same** budget, and guessing cannot move to `/api/auth/login`.
- **Pessimistic counting**: `beginAttempt(key)` increments the failure count **before** the argon2 verify and returns a ticket; `succeed(ticket)` decrements it. A crash or a dropped connection therefore counts as a failure, and parallel guesses cannot all run before the first failure is recorded.
- **One in-flight verify per key**: a second `beginAttempt` while one is running returns `busy` → 429 `reauth_busy` (re-auth) / 429 `rate_limited` (login), no verify.
- Limits: **5 failures per 15 minutes per key → locked for 15 minutes.** Login also has a per-remote-address bucket, 20 failures per 15 minutes (`Bun.Server.requestIP`), so one host cannot spray many usernames.
- **Remote logins get their own account key (AR-9).** On a LAN bind, a login whose peer is not loopback (`isLoopbackPeer`, `origin-gate.ts:102`) counts against `user:<id>:remote`, not `user:<id>`. Otherwise any LAN peer could send 5 wrong logins every 15 minutes and keep the person at the machine from approving any RC card or loosening anything, with no way out but a restart. A guesser therefore gets at most 5 local + 5 remote tries per 15 minutes per account; re-auth always uses `user:<id>` (it needs a valid session, so it is the person's realm). A loopback login keeps sharing `user:<id>` with re-auth, which is the T39 point (guessing cannot move from the card to `/api/auth/login`).
- **Order inside the route (AR-8):** `POST /api/auth/reauth` runs browser proof, JSON content type, zod body, post-body re-validation, visibility (404), `canWrite` / admin for the action (403), and "is re-auth needed for this purpose" (409) **before** `beginAttempt`. Only a request that would mint a token reaches the ledger and the verify. A viewer, a hidden op or a non-RC op never costs an attempt and never runs a verify (no password oracle through a 409 path, no attempt burned by a malformed call).
- While locked: re-auth answers 429 `reauth_locked` with `Retry-After`; login answers 429 `rate_limited` with `Retry-After` and the same body for existing and unknown usernames.
- **Lockout consequences (Open Question 5):** when a **re-auth** key locks **and the failure that tripped it came through `/api/auth/reauth`** (an unauthenticated login failure never revokes anything, or a LAN peer could kill the person's agent grants without a session, AR-9), the user's WebMCP / HTTP-MCP grants are revoked (`revokeGrantsForUser`) and their pending non-chat operations expired (`expirePendingOperationsForUser(db, id, 'reauth_locked')`), and a `reauth_locked` sentinel row is written (shown in Activity like the other sentinels). Five wrong passwords on an approval card is the clearest "something else is typing here" signal we get. The dashboard session is **not** revoked (the human is likely still there and needs to reject things).
- The ledger is in memory: a restart clears it. Only ACT-4 can restart the server, and ACT-4 already has the DB file. Persisting it is Open Question 4 (that would be v35).

**`tokens.ts`: re-auth tokens and recent-auth windows.** In memory, never written to the DB, never logged.
- `issueReauthToken({profile, userId, sessionHash, purpose}) → {token, expiresAt}`: plaintext `wra_` + base64url(32 random bytes); stored under `sha256(token)`; TTL **60 s**; `sessionHash = sha256(bearer)` (the raw bearer is never kept).
- `purpose` is one of:
  - `{kind:'operation', operationId, opDigest}` where `opDigest = sha256(source ‖ tool_name ‖ canonical args_json ‖ created_at)` of the stored row at issue time;
  - `{kind:'control', action: ControlAction, bodyDigest}` where `bodyDigest = sha256(canonical JSON of the request body the action will carry)`.
  - `{kind:'rest', route: RestRcRoute, targetId, bodyDigest}` for a §2.4 D human REST write (AR-1): the route key (e.g. `transactions.delete`), the path id, and the canonical body. The first draft gated these writes but never said what the token was bound to.
- `checkReauthToken(token, expect) → ok | {code}` (no side effect) and `consumeReauthToken(token, expect) → ok | {code}` (compare and delete, synchronous). Both require: token known and unexpired; same `profile` (`getCurrentProfileName()`), same `userId`, same `sessionHash`, same `purpose.kind`, same `operationId` **and** same `opDigest` recomputed from the row **now** (or same `action` and `bodyDigest`). Any mismatch → `reauth_invalid` and the token is deleted (a token that was offered for the wrong thing is burned).
- Recent-auth window (mode `window` only): `markRecentAuth({profile, userId, sessionHash}, now)` after a successful re-auth **whose purpose is an operation or a §2.4 D REST write**. A re-auth for a control action never opens a window (AR-6): otherwise a person minting a client token would hand the page-driving agent minutes of free RC approvals; `hasRecentAuth(...)` true for `windowMinutes` from that moment. **Absolute, not sliding**: approving inside the window does not extend it.
- Purge hooks (all synchronous): `purgeReauthForUser(userId)` (deactivate, lockout), `purgeReauthForSession(sessionHash)` (logout), `purgeReauthForProfile(profile)` (profile switch, auth turned off, policy changed), `purgeAll()` (kill switch flipped off, server stop).

**`guard.ts`: the one enforcement function.**
```ts
export type ReauthNeed = { needed: false } | { needed: true; kind: RcKind; windowOk: boolean };
export function reauthNeedForOperation(db, op, actor, sessionHash): ReauthNeed;
export function reauthNeedForControl(db, action, actor): ReauthNeed;         // windowOk always false
export function enforceReauth(req, need, expect): { ok: true; commit(): void } | { ok: false; response: Response };
```
- Not needed when: auth off; policy off; the operation is `kind='read'`; not RC under the current scope.
- `windowOk` only in mode `window`, only for operations, only if `hasRecentAuth` for **this** session.
- Otherwise the request must carry header `X-Wilson-Reauth: wra_…`. Missing → **428 `reauth_required`** `{purpose, kind, mode}`. Invalid → **403 `reauth_invalid`**.
- `enforceReauth` only **checks**; it returns `commit()` which **consumes** the token. The caller calls `commit()` with **no `await` between it and the write**, so a token is never spent on a request that then fails an earlier check, and never survives a write it authorized.
- The header is not in the CORS `Access-Control-Allow-Headers` list (`server.ts:298`), on purpose: only same-origin pages can send it, and every route that reads it also requires browser proof.

### §2.4 Where it is enforced

Order inside every gated route is fixed: **browser proof → (b58d2d6 post-body re-validation) → visibility/ownership → role (`canWrite`) → expiry → dwell floor → existing route checks → `enforceReauth` → `commit()` and the write, synchronously.** Re-auth is the last gate, so it never leaks whether an operation exists to someone who could not see it, and the dwell floor and hold-to-approve still apply to a person who knows the password.

**A. Operation approvals** (`mcp-routes.ts:437-473`). After the existing checks and before `respondToChatOperation` (chat) or `approveWebMcpOperation` (WebMCP / HTTP-MCP):
- `need = reauthNeedForOperation(activeDb, op, actor, sessionHash)`. Chat ops are classified from the row's stored tool and args, which `respondToChatOperation` re-checks against the binding (request object, nonce, args hash: the stale-card fix). A token issued for a chat card whose request was then superseded still matches the row's digest, but `respondToChatOperation` refuses the card as stale (409) and nothing runs; the token is spent with it (next bullet), so it cannot carry over to the replacement card, which is a new row with a new id.
- Because `respondToChatOperation` and `approveWebMcpOperation` are synchronous, the route calls `const gate = enforceReauth(...)`, returns its response if not ok, then runs `gate.commit()` and the approve call **in the same tick**. If the approve then answers stale / expired / forbidden, the token is already spent; that is accepted (the person re-enters the password for the next card) and is the safe side.
- `approval_too_fast` is checked **before** re-auth (it is cheaper and does not consume anything).
- Reject never needs re-auth. Cancel never needs re-auth.
- `approveWebMcpOperation` gets an optional `reauthVerified?: boolean` parameter and refuses an RC op without it when `isReauthActive(db)` (defence in depth, so a future caller that skips the route cannot commit an RC op). The route passes `true` only after `commit()`.
- **`respondToChatOperation` gets the same option (AR-11).** It is the chat card's commit point (`chat.ts:282`) and the first draft gave it no defence in depth. With `decision = 'allow-once'`, an RC card (classified with surface `'chat'` from its bound request) and `isReauthActive(db)`, it refuses without `reauthVerified: true` and leaves the card pending. `'deny'` never needs it. T-R13: "respondToChatOperation allow-once on an RC card without reauthVerified → refused, runner still waiting".

**B. `/mcp` client-token operations.** Agents never approve over `/mcp`; their ops are approved in the dashboard through A, so a `/mcp` client gets RC protection with no protocol change. `get_operation_result` keeps answering `unknown` while a card waits for the password. The 240 s `/mcp` wait (#160 P0b) is unchanged; a person who takes longer to find the password produces `{outcome:'unknown', operationId}` and the agent polls.

**C. Control-plane actions (always fresh re-auth, never the window, when `isReauthActive`)**:

| `ControlAction` | Route | Gated when |
|---|---|---|
| `client_token_mint` | `POST /api/mcp/client-tokens` | the token's tools include any `isWriteTool` |
| `client_token_rotate` | `POST /api/mcp/client-tokens/:id/rotate` | the token carries a write tool |
| `client_token_tools` | `PUT /api/mcp/client-tokens/:id/tools` | the new set adds a write tool |
| `policy_loosen` | `PUT /api/mcp/policies/:tool` | `off → ask`, `off → allow`, `ask → allow` (reads/proposals; mutating is clamped anyway) |
| `agent_access_on` | `PUT /api/mcp/settings {enabled:true}` | re-enabling the kill switch (turning it **off** is never gated) |
| `grant_ttl_up`, `judge_limit_up` | `PUT /api/mcp/settings` | TTL or `judgeDailyLimit` increased |
| `reauth_loosen` | `PUT /api/auth/reauth/policy` | `isLoosening` |
| `auth_off` | `PATCH /api/auth/config {auth_enabled:false}` | always (with re-auth on, this is the one switch that would remove it) |
| `user_create` | `POST /api/auth/users` | **any role** (AR-5; the first draft gated only `role: 'admin'`). A viewer account whose password the agent chose is a 7-day credential that survives grant revocation, the kill switch and the admin's logout, and reads the whole ledger over unaudited REST (`server.ts:518-530`; threat model §7 row 5). The route also validates `role ∈ {admin, viewer}` with zod (today `body.role` is cast, `:522`). |
| `custom_prompt` | `PUT /api/settings/custom-prompt` | always (`prompt` kind) |
| `model_egress` | `POST /api/models` | the new model for any task resolves to a **non-local** provider (`resolveProvider(model).id` not Ollama / on-device) and the current one for that task is local, or the task's provider changes between two non-local providers (AR-10). Switching the chat model from Ollama to a cloud provider sends every later chat's system prompt, memories and tool results (A1, A4) to that provider. Switching to a local model is never gated. Note: this setting lives in `settings.json` (`api.ts:827`), which a shell-capable local process can edit (ACT-4/ACT-9 residual, unchanged); the gate covers the page path. |
| `judgements_bulk_accept` | `POST /api/judgements/bulk` (accept) | always (bulk write to A3) |
| `training_export_optin` | `GET /api/export/training/{sft,dpo}` | any of `includeJudge`, `includeAgentPresent`, `includeHandoff` true (the UI already fetches these, so it can send the header). **These GETs then also require browser proof** (AR-7): today `/api/export/*` takes `?token=` and no proof (`server.ts:355-359`), which contradicts §2.3's "every route that reads the header also requires browser proof". A training-export request that carries opt-ins, or `X-Wilson-Reauth`, without browser proof is 403 `origin_required` and does not consume the token. |

**One body, one decision (AR-12).** `PUT /api/mcp/settings` and `PUT /api/auth/reauth/policy` take several fields. The route computes the set of control actions the **whole** body triggers (e.g. `{enabled:false, grantTtlMinutes:1440}` is a kill-switch-off plus `grant_ttl_up`); if any is gated the whole request needs a token, and nothing in the body is applied without it (no partial apply of the safe half). The token's `action` is the first gated one in table order and `bodyDigest` covers the entire body.

**The prompt says what it is for (AR-4).** A 428 from a control route carries `summary`, a server-built sentence describing the exact change from the body ("Create a client token 'claude-code' that can change data: categorize_transaction, update_transaction", "Turn dashboard sign-in off for profile demo", "Send chat conversations to OpenAI (gpt-4o)"). `POST /api/auth/reauth` for `kind:'control'` returns the same `summary` with the token. The dialog renders it as plain text above the field, with "If you did not start this, press Cancel." A page-driving agent can press the button that raises the dialog, and the person must be able to tell that the password is being asked for something they did not do. Built only from enums, ids, tool names and model ids (never free text from the body, T20 rule).

The `bodyDigest` binds the token to the exact body (or, for the export GET, the canonical query), so a token minted for "mint a read-only token" cannot mint a write token, and one for `ask → allow` on tool X cannot be spent on tool Y.

**D. Human REST writes that do what an RC tool does (T34; Open Question 9, revised by AR-1).**

The first draft gated these only while `isAgentPresent` was true. That check (`store.ts:453-465`) only sees agents that used Wilson's own agent access: a live WebMCP/HTTP-MCP grant or a pending non-chat operation. The agent this control exists for is the one that **clicks the human button instead of the card**, and such an agent needs no grant at all: Chrome's built-in agent or any CDP-driven browser agent can open the Transactions tab and press Delete without ever registering a WebMCP tool. For that agent `isAgentPresent` is always false, so the gate never fires. Presence detection cannot be the boundary.

So the policy has `restGate` (§2.2):
- **`always` (default).** With the policy active, every route in the table below needs re-auth, with or without an agent. In `window` mode a live window of this session covers it (these are the session holder's own writes, the same trade-off as T41); in `every_time` mode each write asks.
- **`agent_present`** (admin opt-down, a loosening). Re-auth only while `annotateAgentPresent(db, user, profile)` is true (`judgement-routes.ts:70`: a live grant or pending non-chat op now, or any grant / op / kill-switch flip for this user in the last 2 hours; the first draft named `isAgentPresent` but described this function). Settings copy for this choice: "Only asks when Wilson can see agent access. An agent that drives this page without asking Wilson for access is not detected."

Routes (the token purpose is `{kind:'rest', route, targetId, bodyDigest}`; the server classifies from method, path and body, never from a client flag):

| Route key | Route | RC when | Kind |
|---|---|---|---|
| `transactions.delete` | `DELETE /api/transactions/:id` (`server.ts:716`) | always | `delete` |
| `transactions.patch` | `PATCH /api/transactions/:id` (`:709`) | body has `amount` or `date` | `value` |
| `entities.delete` | `DELETE /api/entities/:id` (`:793`) | always | `delete` |
| `import` | `POST /api/import` (`:803`) | always | `bulk` |
| `demo.trace.import` | `POST /api/demo/trace/step` with `step: 'import'` (`:816`) | always (same write as `/api/import`; missed in the first draft) | `bulk` |
| `memories.add` | `POST /api/memories` (`:843`) | always (AR-14: the chat `memory_manage add` is RC `prompt`; the REST add writes the same row and was ungated) | `prompt` |
| `memories.delete` | `DELETE /api/memories/:id` (`:851`) | always | `prompt` |
| `training.export` | `GET /api/export/training/{sft,dpo}` without opt-ins (fetch + Blob, so it can carry the header) | always (`egress`: prompts, responses and tool results, A4). With opt-ins it is the control action above. | `egress` |

A coverage guard (T-R14, source scan of `server.ts`) lists every `POST|PUT|PATCH|DELETE` branch and fails unless each one is in this table, in §2.4 C, or in an explicit non-RC list (budgets, goals, review confirm/correct, entity create/update, annotate, chat, `/api/chat/local`, profile switch, logout, setup, login), so a new write route is classified on purpose. The CSV/XLSX/P&L/net-worth `?token=` links stay ungated (Open Question 10, T29 follow-up) and are named in the Settings copy.

### §2.5 Routes

| Method / path | Auth | Body (zod `.strict()`) | Response |
|---|---|---|---|
| `POST /api/auth/reauth` | bearer (not public), browser proof, `Content-Type: application/json` required | `{password: string 1..1024, purpose: {kind:'operation', operationId: uuid} \| {kind:'control', action: ControlAction, body: unknown} \| {kind:'rest', route: RestRcRoute, targetId?: number, body?: unknown}}` | 200 `{token, expiresAt, windowUntil?, summary?}` (`summary` for control and rest purposes, AR-4); checks run in the AR-8 order (§2.3) before any verify; 403 `reauth_failed` (wrong password, no attempt count in the body); 404 when the operation is not visible to the caller; 409 `reauth_not_required` (policy off, auth off, or not RC: no token is minted for nothing); 429 `reauth_locked` / `reauth_busy` with `Retry-After`. `Cache-Control: no-store`. |
| `GET /api/auth/reauth/status` | bearer | — | `{available, mode, scope, windowMinutes, windowRemainingSec, lockedForSec}` for **this** session (no other user's state) |
| `GET /api/auth/reauth/policy` | admin | — | `{available, policy}` |
| `PUT /api/auth/reauth/policy` | admin, browser proof, re-auth if loosening | `{mode?, windowMinutes?, scope?}` | `{available:true, policy}`; 409 `auth_required` with auth off |

- For `purpose.kind='operation'` the server loads the op, checks visibility and `canWrite` exactly as approve would, and computes `opDigest` **from the row**; the client never supplies a digest. For `control` it computes `bodyDigest` from `purpose.body`.
- The password is read from the JSON body only: a password in the query string or a `text/plain` body is a 400 and is **not** verified (so it does not count as an attempt and cannot be sent by a no-cors form).
- `/api/auth/reauth` is **not** in `PUBLIC_AUTH_PATHS`, so after the rebase the b58d2d6 hook re-validates the login after the body and swaps in the fresh `currentUser`; the route uses that user's id for the ledger key and the token.

Error codes added to #160 §1.3:

| Code | Status |
|---|---|
| `reauth_required` | 428 |
| `reauth_invalid` | 403 |
| `reauth_failed` | 403 |
| `reauth_locked`, `reauth_busy` (+`Retry-After`) | 429 |
| `reauth_not_required` | 409 |
| `auth_required` | 409 |

### §2.6 Session, user and state changes

| Event | Effect on re-auth state |
|---|---|
| Logout (`server.ts:498`) | `purgeReauthForSession(sha256(bearer))` |
| User deactivated (`server.ts:532`; after rebase also `cancelChatRunForUser`) | `purgeReauthForUser(id)` in the same synchronous block as `revokeGrantsForUser` and `cancelChatRunForUser` |
| Auth turned off | `purgeReauthForProfile(profile)`; policy row kept but inert |
| Policy changed (any direction) | `purgeReauthForProfile(profile)` (a window opened under every-time cannot survive a change to window mode, and vice versa) |
| Profile switch | `purgeReauthForProfile(old)` (sessions are per profile DB anyway) |
| Kill switch turned off | `purgeAll()` |
| Re-auth lockout | `purgeReauthForUser(id)` + grants revoked + pending ops expired (§2.3) |
| Server restart | everything in memory is gone (fail closed: the next RC approval asks again) |
| Future password change / role change routes | must call `purgeReauthForUser` (T-R10 is the guard test: a source scan fails if a route updates `dashboard_users.password_hash` or `role` without it) |

### §2.7 UI

Forensic Noir per `app/BRAND.md`; amber for "needs your password" (a permission), red for lockout. All three approval surfaces share one model from `src/dashboard/reauth-ui-core.ts`:

```ts
export function reauthChip(view: OperationView): { label: 'PASSWORD' | null; kindLine: string | null };   // "Deletes a transaction", "Exports data", ...
export const REAUTH_FIELD_ATTRS = { type: 'password', autocomplete: 'off', name: 'wilson-reauth', spellcheck: 'false', 'data-lpignore': 'true', 'data-1p-ignore': 'true' } as const;
export function acceptReauthSubmit(ev: { isTrusted: boolean; type: string; key?: string }): boolean;      // trusted Enter keydown or trusted click only
export function reauthErrorCopy(code: string, retryAfterSec?: number): string;
```

- `OperationView` (`operation-view.ts:33`) gains `reauth: { required: boolean; kind: RcKind | null; windowOk: boolean }`, computed on the server for the viewer at view time. It is a **hint** for drawing the chip; the approve route decides.
- **Flow on a card that needs it:** the chip `PASSWORD` and a kind line ("Deletes a transaction") show from the start. The person does the normal hold (800 ms enable, 600 ms hold, `isTrusted`, #160 P1). Only then a password row appears **inside the card** (not a page-level modal, so it cannot be confused with the login form and it cannot cover another card). Submit (trusted Enter or trusted click) → `POST /api/auth/reauth` → `POST …/approve` with `X-Wilson-Reauth`. The field is cleared (`value = ''`) right after the first request is sent, on any error, on card removal and after 30 s idle. The token lives only in a local variable of that click handler.
- A 428 from approve when the hint said "not required" (the policy was turned on meanwhile) opens the same row: the server is the source of truth.
- Errors: `reauth_failed` → "Wrong password. The change was not made." (field cleared, card stays pending); `reauth_locked` → red "Too many wrong passwords. Agent access for your account was revoked; try again in N min." and the Approve control is disabled until `Retry-After`; Reject stays available. `reauth_invalid` → "That confirmation expired. Enter your password again."
- **Bridge card** (`webmcp-bridge.ts`, `finish` at `:400`): builds the row with `el()` and `textContent` only, attributes from `REAUTH_FIELD_ATTRS`; same copy. **PendingApprovalsList** (`ui/src/components/agent/PendingApprovalsList.tsx:15`) and **ChatApprovalCard** (`ui/src/components/ChatApprovalCard.tsx`, via `usePendingChatApproval.ts:57`) use a new `ui/src/components/agent/ReauthPrompt.tsx`.
- **Control-plane buttons** (ClientTokensPanel, ToolPolicyTable, KillSwitch, GrantTtlSelect, JudgeLimitInput, the auth toggle and user form in Settings, the Models panel, the custom-prompt editor, judge bulk Accept, the training-export downloads) and the §2.4 D buttons (transaction delete/edit, entity delete, import, memory add/delete) go through `withReauth(purpose, body, send)` in `ui/src/lib/agent-api.ts`: send; on 428 show `ReauthPrompt` in a `Dialog.tsx` with the server's `summary` (AR-4) as plain text; on token, resend once with the header. Never a retry loop. **One prompt at a time:** a second 428 while a prompt is open is answered "Another confirmation is already open" and is not queued behind it, so an agent cannot stack a dialog under the one the person is reading. The body sent with the token is the one captured when the first request was made (closure), never re-read from the form.
- **Card binding (AR-15).** The card's password row captures `operationId` when the hold completes, in the click handler's closure, and the `POST /api/auth/reauth` body uses that value, never an index into the current list. The 1.5 s poll can re-render or reorder cards while the row is open; the row stays attached to its card element and is removed with it.
- **Settings → Security → "Confirm risky approvals with your password"** (`ReauthPolicyPanel.tsx`, admin only; viewers see read-only text): Off / Every time / For N minutes after I enter it; scope "Risky changes only (recommended)" / "Every change"; page buttons "Always ask for risky changes made with this page's buttons (recommended)" / "Only while Wilson sees agent access" (the second with the AR-1 sentence). With auth off: disabled, "Turn on dashboard auth first." Footer: "This makes an agent that drives this page unable to approve risky changes without your password. It does not protect against software on this computer, and a browser extension with access to this page can still read what you type. Not covered: the CSV/XLSX/P&L/net-worth download links, and web searches the chat assistant makes."
- No `dangerouslySetInnerHTML` (existing source guard under `components/agent` covers the new files).

### §2.8 TUI and headless

The TUI and `--run` cannot show a dashboard password prompt, and a password typed into a terminal would be visible to the agent's own shell tools and the scrollback. They **deny with a message**:

- `AgentRunnerController` (`agent-runner.ts`) gets an option `reauthSurface: 'dashboard' | 'none'`, default **`'none'`**. `chat.ts:416` passes `'dashboard'`; `cli.ts:345` and `headless.ts:52` keep the default.
- With `'none'`: in `requestToolApproval`, before the prompt is raised, if `isReauthActive(db)` and `classifyConsequence('chat', tool, args, scope)` is RC → resolve `'deny'` with reason `reauth_unavailable`. No prompt is shown, so `allow-session` cannot be chosen for it.
- **`gateToolCall`** (`approval-gate.ts:31`) gets a `mustAsk?: (tool, args) => boolean` argument: when it returns true the call is **never** waved through by `sessionApprovedTools`, and an `allow-session` answer for it is stored as `allow-once`. The runner passes `mustAsk = (t, a) => isReauthActive(db) && isRc('chat', t, a)`. Without this, a TUI user who chose "don't ask again for delete_transaction" before an admin turned the policy on would keep deleting with no check. This keeps 1c2bc6b's rule (deny runs get their own empty set) unchanged and adds to it.
- `ToolDeniedEvent` (`agent/types.ts:126`) gets `reason?: 'reauth_unavailable' | 'headless' | 'denied'`, and `tool-executor.ts:111` records a tool result for a denied call: for `reauth_unavailable`, "Not run: this profile requires the dashboard user's password for `<tool>` (<kind line>). Ask the user to do it from the Wilson dashboard (wilson --dashboard)." So the model stops retrying.
- The TUI shows the same line in the chat log (`components/tool-event.ts`). `headlessDenialMessage` (`headless.ts:56`) appends " This profile also requires the dashboard password for it." when the reason is `reauth_unavailable`.
- Honest scope (T44): the TUI runs as the OS user, who can edit the database. The deny is **policy consistency** (the admin's "risky agent writes need a password" holds on every agent surface), not a security boundary against that user.

### §2.9 Composition with existing controls

| Control | How re-auth composes |
|---|---|
| Hold-to-approve, 800 ms enable, `isTrusted` (#160 P1, T16) | Unchanged and first. The password row appears only after a completed trusted hold. |
| Server dwell floor `approval_too_fast` (`engine.ts:902-926`) | Checked before re-auth; never consumes a token. |
| Origin gate / browser proof (P0b, T04/T05) | Required on `/api/auth/reauth`, the policy PUT, approve, and every gated control route. The re-auth header is not CORS-allowed. |
| Approval-card binding, stale-card fix (`chat.ts:117-332`) | The token binds to the operation id and to a digest recomputed from the stored row; `respondToChatOperation` still refuses a card whose request changed. A token cannot outlive or move to another card. |
| Expiry (`expires_at`), owner-changed staleness, policy Off at commit | Unchanged; all run before (expiry) or after (commit checks) the token is consumed in the same tick. |
| Kill switch (T35) | Turning it off is never gated and purges all re-auth state; turning it on is a control action. |
| Read-ask cards (P1) | Never RC; no password. |
| P4a agent-present provenance | §2.4 D reuses the same window; a re-authenticated human REST write while an agent is present is still recorded with `agent_present=true` in its audit row (the password proves knowledge, not that no agent was around). |
| **b58d2d6** (post-body login re-validation) | `/api/auth/reauth` and every gated route are state-changing and non-public, so the hook re-validates the bearer after the body and replaces `currentUser`. The route must take `userId` and `role` from the **post-hook** `currentUser`, and the token check compares against that user. Test T-R12 holds a re-auth body open, deactivates the user, then releases: 401, no token. |
| **b843a6a** (deactivation cancels the chat run and its card) | The deactivate route calls `purgeReauthForUser` next to `cancelChatRunForUser`, so neither a window nor an unspent token survives. |
| **1c2bc6b** (deny runs ignore session approvals) | Kept as is; `mustAsk` (§2.8) is an additional rule for active runs. |
| **410d219** (ownerless chat card is admin-only) | The admin who approves it re-authenticates as themselves; the token binds to the admin's user id. |
| **cb867c0** (refuse enabling auth with no active admin) | Policy can only become active once auth is on, which already requires an active admin; nothing to add. |

---

## §3 File changes

| File | Change |
|---|---|
| `src/mcp/consequential.ts` (new, import-free) | `RcKind`, `RC_TABLE`, `classifyConsequence(toolName, args, scope)`, `ControlAction` union, `CONTROL_ACTIONS`. |
| `src/dashboard/reauth/policy.ts` (new) | §2.2. |
| `src/dashboard/reauth/verify.ts` (new) | `verifyPassword`, `DUMMY_HASH`. |
| `src/dashboard/reauth/attempts.ts` (new) | Ledger (§2.3), `attemptsFor(db)`, `setAttemptsFor` (tests). |
| `src/dashboard/reauth/tokens.ts` (new) | Tokens, windows, purge hooks. |
| `src/dashboard/reauth/guard.ts` (new) | `reauthNeedForOperation`, `reauthNeedForControl`, `enforceReauth`, `opDigest`, `bodyDigest`. |
| `src/dashboard/reauth-routes.ts` (new) | §2.5 routes; returns null when the path does not match (same pattern as `handleMcpRoute`). |
| `src/dashboard/reauth-ui-core.ts` (new, import-free, alias `@reauth-ui`) | §2.7 helpers. |
| `src/dashboard/auth.ts` | `verifyLogin` dummy-hash on unknown/inactive user. |
| `src/dashboard/server.ts` | Mount `handleReauthRoute`; login limiter + ledger (`:486`); purge on logout (`:498`), deactivate (`:532`), auth off (`:544`), profile switch (`:564`); control gates on `/api/auth/config`, `/api/auth/users` (any role, zod role enum), `/api/models` (`model_egress`), `/api/settings/custom-prompt`, training exports (browser proof + opt-in gate); §2.4 D gates (route table, `restGate`) on the human REST writes; login ledger key split by peer (`user:<id>:remote`). |
| `src/dashboard/mcp-routes.ts` | Approve gate (§2.4 A); control gates on client-token mint/rotate/tools, settings, policies. Reject and cancel untouched. |
| `src/dashboard/judgement-routes.ts` | Control gate on bulk accept (`:109`). |
| `src/mcp/engine.ts` | `approveWebMcpOperation(…, opts?: {reauthVerified?: boolean})` refuses an RC op without it when active (returns `{outcome:'reauth_required'}`, mapped to 428). `setKillSwitch` off → `purgeAll()`. |
| `src/mcp/operation-view.ts` | `reauth` field on `OperationView`. |
| `src/mcp/confirmation-card.ts` | Card model carries `reauthChip`. |
| `src/mcp/audit.ts` | New decisions: signal `reauth_ok`, `reauth_window_used`; noise `reauth_failed`, `denied_reauth_required`, `denied_reauth_invalid`; sentinel `reauth_locked`. The preview holds `purpose=<operation|control> op=<id>|action=<name> kind=<rc kind>`, **never** the password or token. |
| `src/mcp/schemas.ts` | `ReauthBody`, `ReauthPolicyBody`. |
| `src/dashboard/chat.ts` | Runner built with `reauthSurface: 'dashboard'`. |
| `src/agent/approval-gate.ts` | `mustAsk` parameter (§2.8). |
| `src/agent/types.ts` | `ToolDeniedEvent.reason`. |
| `src/agent/tool-executor.ts` | Pass `mustAsk`; record a tool result for denials with a reason. |
| `src/controllers/agent-runner.ts` | `reauthSurface` option; deny with reason; build `mustAsk`. |
| `src/headless.ts`, `src/components/tool-event.ts` | Message text. |
| `src/dashboard/webmcp-bridge.ts` | Card password row (§2.7). |
| `ui/src/components/agent/{ReauthPrompt,ReauthPolicyPanel}.tsx` (new) | §2.7. |
| `ui/src/components/agent/{PendingApprovalsList,ClientTokensPanel,ToolPolicyTable,KillSwitch,GrantTtlSelect,JudgeLimitInput}.tsx`, `ui/src/components/ChatApprovalCard.tsx`, `ui/src/hooks/usePendingChatApproval.ts`, Settings auth/users section, custom-prompt editor, judge bulk Accept, training-export download | Use `ReauthPrompt` / `withReauth`. |
| `ui/src/lib/agent-api.ts` | `withReauth`. |
| `ui/vite.config.ts`, `ui/tsconfig.json` | `@reauth-ui` alias. |
| `scripts/webmcp-live-seed.ts` | `--auth` and `--reauth=<every_time\|window>` flags (§8 step 3). Still refuses a HOME outside `/private/tmp/`. |
| `scripts/webmcp-live-check.md` | Part 4 (§8 step 3). |
| `specs/webmcp-threat-model.md` | §4 delta folded in when the implementation lands (not in this spec commit). |
| `CHANGELOG.md` | New setting; login is now rate-limited (5 wrong passwords per account per 15 min). |

---

## §4 Threat-model delta (cross-referenced to `specs/webmcp-threat-model.md`)

### §4.1 New assets

| ID | Asset | Where | Why it matters |
|---|---|---|---|
| A9 | The user's dashboard **password**, re-entered in the page | the re-auth field in the page JS realm (TB1), the `/api/auth/reauth` body | Before this spec it was typed once per 7-day login; re-auth types it many times, in the same realm as ACT-1/ACT-3. A password is worth more than a session (it mints new sessions and may be reused elsewhere). |
| A10 | Re-auth tokens and recent-auth windows | server memory only (`reauth/tokens.ts`) | Whoever holds one can approve one RC operation (token) or several (window) |
| A11 | The re-auth policy | `dashboard_config.reauth_policy` (profile DB) | Turning it off silently removes the control |

A5 (credentials) gains A9 and A10; A6 (audit) gains the re-auth decisions.

### §4.2 Actors

No new actor. Capabilities that matter here:
- **ACT-1** (browser agent, may drive the DOM through CDP with trusted events): cannot type a password it does not know. **Can** use the browser's password manager if Chrome offers the saved credential in the re-auth field (UNCERTAIN, recorded live, §8 RA.11), and can act inside a recent-auth window.
- **ACT-3** (extension with localhost host permission): can read the field's value as the person types (keylogging) and so learns A9. Not preventable in-page.
- **ACT-4 / ACT-9 with a shell** (local process): can forge headers and edit SQLite; re-auth does not bind it (§7 residual of the threat model, unchanged).
- **ACT-6** (viewer): cannot approve writes at all (`canWrite`), so re-auth never applies to a viewer's approvals; a viewer can hit `/api/auth/reauth` only for its own read ops, which answer 409 `reauth_not_required`.

### §4.3 New threats

Format as in the threat model: vector, control, test.

| ID | Threat | STRIDE | Actor | Sev | Related |
|----|--------|--------|-------|-----|---------|
| T39 | Password guessing through re-auth, moved to `/api/auth/login`, or run in parallel | S/E | ACT-1/3/4/8 | High | T15, T16 |
| T40 | Re-auth token replay or reuse on a different operation, user, session, body or profile | S/E | ACT-1/3 | High | T06, T16, T36 |
| T41 | Page-driving agent approves its own RC cards inside a recent-auth window the human opened | E | ACT-1/3 | Medium (window mode only) | T16, T34 |
| T42 | Password capture in the page realm (keylogging, autofill driven by the agent, value left in the DOM, password in logs/audit) | I | ACT-1/3 | High (ACT-3) / Medium (ACT-1) | T17, T34 |
| T43 | Downgrade: turning off re-auth, auth, or loosening scope/window, or editing the policy outside the routes | T/E | ACT-1/3/9 | High | T18, T35 |
| T44 | Bypass through another surface: human REST buttons, TUI `allow-session`, chat `allow-session`, a different approval route, profile switch | E | ACT-1/3 | High | T16, T21, T34 |
| T45 | CSRF / cross-origin use of `/api/auth/reauth` or of a token | T | ACT-5 | Medium | T04, T05 |
| T46 | Lockout as denial of service (an agent burns the user's attempts to block approvals) | D | ACT-1/3 | Low | T15 |
| T47 | Policy-active ghost: setting appears on with auth off, or is shown as protecting a surface it does not cover | R/T | — | Medium | T35 |

**T39: Password guessing**
- **Vector:** a page-driving agent or extension already holds a valid bearer (it is the page) and calls `/api/auth/reauth` in a loop; or it drops to `/api/auth/login`, which today has no limit at all (`server.ts:486-496`); or it fires 50 parallel requests so all verifies start before the first failure is counted. ACT-8 on a LAN bind does the same against login.
- **Control:** one ledger for login and re-auth keyed by account (§2.3), pessimistic counting, one in-flight verify per account, 5 failures / 15 min → 15-minute lock; per-address login bucket; dummy-hash verify for unknown or inactive users (no username oracle); on re-auth lock, grants revoked and pending agent ops expired, `reauth_locked` sentinel.
- **Test:** `reauth-attempts.test.ts`: "6th wrong re-auth in 15 min → 429 reauth_locked"; "wrong logins count against re-auth and vice versa"; "50 parallel wrong re-auths verify at most once at a time and lock after 5"; "a dropped request counts as a failure"; "lock revokes grants and expires pending webmcp ops, writes reauth_locked sentinel"; "unknown username and wrong password take the same path (dummy verify called)"; "per-address login bucket".

**T40: Token replay and cross-binding**
- **Vector:** reuse a token a second time; spend a token issued for card A on card B; for a categorize card on a delete card; for "mint read-only token" on "mint write token"; from another tab's session, another user, or after a profile switch; after the chat request behind the card was superseded.
- **Control:** single-use compare-and-delete; 60 s TTL; bound to profile, user id, `sha256(bearer)`, purpose kind, operation id + digest recomputed from the stored row, or control action + body digest; any mismatch burns the token; tokens never leave memory, never appear in a URL, response other than the issuing one, audit or log.
- **Test:** `reauth-tokens.test.ts`: "second consume → reauth_invalid"; "expired after 60 s (fake clock)"; "token for op A on op B → 403 and burned"; "different bearer of the same user → 403"; "other user → 403"; "profile switch → 403"; "op args changed in the row after issue → 403"; "control token with a different body → 403"; `reauth-approval.test.ts`: "chat card superseded between issue and approve → 409 stale, nothing runs".

**T41: Window abuse**
- **Vector:** in `window` mode the human enters the password on one card; within the window the agent raises more RC cards and clicks Approve through CDP.
- **Control:** default mode is `every_time` (Open Question 1); the window is bound to the session that entered the password, absolute (never extended by use), at most 15 minutes, purged on logout, deactivate, policy change, kill switch off and profile switch; never used for control actions; each window approval is audited `reauth_window_used`, and Activity groups them under the `reauth_ok` that opened the window. Hold-to-approve and the dwell floor still apply. **Residual** (stated in Settings copy and §7): inside a window, a DOM-driving agent with trusted clicks can approve RC cards.
- **Test:** `reauth-approval.test.ts`: "window mode: second RC approve within window passes without header, after window → 428"; "window not extended by an approval"; "window does not cover a control action"; "window from session A does not cover session B"; "policy change purges the window".

**T42: Password capture**
- **Vector:** (a) ACT-3 reads `input.value` or listens to key events; (b) ACT-1 clicks the field and picks the saved credential from Chrome's password manager; (c) the value stays in the DOM or React state after use; (d) the password reaches a log, an error message, the audit preview or a crash report.
- **Control:** (a) none possible in-page: stated in Settings copy and §7, and the reason this is opt-in. (b) `REAUTH_FIELD_ATTRS` (`autocomplete="off"`, a non-login `name`, no username field in the same form, password-manager ignore hints); whether Chrome 154 still offers the credential is UNCERTAIN and recorded live (RA.11); if it does, Open Question 13. (c) field cleared on send, error, removal and 30 s idle; the value is never put in React state (uncontrolled input read once). (d) the route never echoes the body; `ReauthBody` zod errors name the field, never the value; audit preview built from purpose only; a source guard fails on any `console.*` call in `reauth/**` or `reauth-routes.ts` that references `password` or `token`.
- **Test:** `reauth-ui-core.test.ts`: "REAUTH_FIELD_ATTRS has autocomplete off and no username sibling"; `reauth-audit.test.ts`: "no audit row or response body ever contains the password or token (seeded canary strings)"; source guard "no console.* with password/token in reauth sources".

**T43: Downgrade**
- **Vector:** the agent clicks Settings → turn re-auth off, or widens the window, or turns auth off (making the setting unavailable), or creates a second admin, or edits the setting where it is stored, or re-enables agent access after the human turned it off.
- **Control:** loosening the policy, `auth_off`, `user_create` (any role, AR-5), `model_egress` (AR-10), `agent_access_on` are control actions (fresh re-auth, never window). The policy lives in `dashboard_config`, not in `settings.json`. Turning re-auth **on**, turning agent access **off**, revoking, rejecting are never gated (safety actions stay one click). `open_tab` already refuses `settings` (#160 P3 deviation), so a tool-path agent cannot even open the panel.
- **Test:** `reauth-control-plane.test.ts`: one case per row of §2.4 C ("PATCH /api/auth/config off without header → 428, auth still on"; "PUT policy off without header → 428"; "tightening needs no header"; "kill switch off needs no header"; "mint read-only token needs no header, write token → 428"); `reauth-policy.test.ts`: "policy is read from dashboard_config, a settings.json key named reauth_policy is ignored".

**T44: Other surfaces**
- **Vector:** the agent cannot approve the delete card, so it (a) clicks the human Delete button, (b) runs the same request from the TUI where `allow-session` was granted earlier, (c) gets a future dashboard change to answer `allow-session`, (d) uses `/api/mcp/operations/:id/approve` with a crafted source, (e) switches to a profile without the policy.
- **Control:** (a) §2.4 D gates human RC REST writes, by default always (`restGate: 'always'`), because a page-driving agent with no Wilson grant is invisible to presence detection (AR-1); (b)/(c) `mustAsk` (§2.8) makes RC calls bypass `sessionApprovedTools` and never store `allow-session`; TUI and headless deny RC; (d) one approve route, classification from the stored row, and `approveWebMcpOperation` refuses an RC op without `reauthVerified`; (e) a profile switch reaches **another profile's data**, governed by that profile's own policy and auth (T03/T35 rules on LAN unchanged); the kill switch is global.
- **Test:** `reauth-rest-presence.test.ts`: "restGate always: DELETE /api/transactions/:id with no grant at all → 428"; "restGate agent_present: with a live grant → 428; without any agent in 2 h → 200"; "POST /api/memories and demo trace import are gated"; T-R14 route coverage guard; `reauth-agent-gate.test.ts`: "allow-session given before the policy turned on does not cover an RC call"; "TUI runner denies RC with reason reauth_unavailable and records the tool result"; "headless message mentions the password"; "deny run (viewer) still gets an empty session set (1c2bc6b)"; `mcp-approval.test.ts` (extend): "approveWebMcpOperation on an RC op without reauthVerified → reauth_required".

**T45: CSRF and cross-origin**
- **Vector:** `evil.example` posts `text/plain` to `/api/auth/reauth` or approve; a sibling localhost port (`same-site`) does; a link carries the token in a query.
- **Control:** browser proof (allowlisted Origin **and** `Sec-Fetch-Site: same-origin`) on `/api/auth/reauth`, the policy PUT and every gated route; JSON content type required (a `text/plain` body is 400 and not an attempt); token only in the `X-Wilson-Reauth` header, which is not CORS-allowed; with auth on the bearer is a header, not a cookie. Auth off: the routes are inert (409) so there is nothing to forge.
- **Test:** extend `dashboard-origin-gate.test.ts`: "POST /api/auth/reauth from evil Origin → 403, no attempt counted"; "Sec-Fetch-Site same-site → 403"; "Origin null → 403"; "text/plain body → 400, no attempt"; "?reauth= query is ignored (approve still 428)".

**T46: Lockout DoS**
- **Vector:** an agent burns 5 attempts to lock the person out of approving.
- **Control:** the lock is fail-closed (nothing gets approved, which is the safe direction); Reject and the kill switch stay available; the lock revokes the agent's grants, which removes the agent; 15-minute lock; the sentinel tells the person why. Login lock uses the same body for existing and unknown users.
- **Test:** `reauth-attempts.test.ts`: "while locked, reject and kill-switch-off still succeed".

**T47: Ghost or overstated protection**
- **Vector:** the UI says "protected" with auth off; or the admin believes CSV export links or ACT-3 are covered.
- **Control:** `isReauthActive` requires auth; GET returns `available:false`; Settings copy names what is not covered; `/api/auth/reauth/status` drives the UI.
- **Test:** `reauth-policy.test.ts`: "auth off → available false, PUT 409 auth_required, approve never asks"; "auth back on → stored policy active again".

### §4.4 Changes to existing threats and residuals

- **T16** (approval fatigue, self-approval): adds a knowledge factor on RC approvals. Residual narrows from "a DOM-driving agent can wait out the timers" to "...for non-RC writes, and for RC writes inside a window".
- **T34** (DOM-reading/driving agent): §2.4 D adds the first control on human REST RC writes while an agent is present.
- **T17** (malicious extension): **worsens slightly** with re-auth on (A9 is typed more often in the realm the extension reads). Accepted because opt-in, and stated in the UI.
- **T33** (plaintext session tokens): unchanged; the window keys on `sha256(bearer)`, so no new plaintext is stored.
- **§7 residuals**, new row: "With re-auth on, a browser extension with access to the page can capture the password as it is typed; a DOM-driving agent can approve RC cards inside a recent-auth window; the TUI deny is policy, not a boundary (the OS user owns the DB); the chat assistant's web searches and the CSV/XLSX/P&L/net-worth links are egress paths re-auth does not see (AR-13, OQ10); a page-driving agent can still approve its own **read-ask** cards, which are never RC (AR-19)."
- **§8 invariants**, new:
  10. With re-auth active, no RC operation commits, no §2.4 D REST write is applied (subject to `restGate`), and no control-plane loosening is applied, without a re-auth token consumed in the same tick for exactly that operation, route+target+body or control body, or (operations and REST writes only, window mode) a live window of the same session opened by an operation or REST re-auth.
  11. A re-auth token is single-use, ≤60 s, and bound to profile, user, session hash and operation digest or body digest.
  12. Password failures for one account share one budget across login and re-auth; at most one verify per account is in flight.
  13. Neither the password nor a re-auth token appears in any URL, log, audit row, or response other than the issuing one.
  14. With auth off, re-auth is inert and reported unavailable; turning re-auth or auth off requires a fresh re-auth.

---

## §5 Edge cases decided

| Case | Decision |
|---|---|
| Policy turned on while a card is pending | The card needs the password (classification and policy at approve time). |
| Policy turned off while a token is unspent | Purged (`purgeReauthForProfile`). |
| Two admins | Each re-authenticates as themselves; an admin approving another user's op cannot happen (ops are owner-only with auth on, #160 P0a). |
| Ownerless chat card (auth on, admin-only per 410d219) | The approving admin re-authenticates. |
| Card expires while the password row is open | Approve answers 409 `expired`; the token, if issued, is unspent and dies at 60 s. |
| `/mcp` op waiting longer than 240 s | Agent gets `unknown` and polls `get_operation_result`; unchanged. |
| Viewer | Never asked (cannot approve writes). |
| Read-ask cards | Never asked. |
| `all_writes` scope + proposals under Ask | Asked (the proposal card is an approval of a write). |
| Re-auth on, auth turned off with re-auth | Allowed with fresh re-auth; then everything is ungated, by the admin's explicit choice, and `auth_off` is audited. |
| Multiple tabs | Window is per session (bearer), and the bearer is shared by tabs of one login (`localStorage`), so tabs of one login share a window. Stated in the copy ("for this login"). |
| Server restart mid-approval | Token gone → 403 `reauth_invalid` → person re-enters. |
| Proposal tool already at policy `allow` when the admin picks `all_writes` | Its proposals never become cards, so `all_writes` does not reach them. Settings lists tools at `allow` under the scope choice; moving one back to `ask` is a tightening (no password). (AR-16) |
| A LAN peer locks remote login | Only `user:<id>:remote` locks; the person at the machine still logs in and approves (AR-9). |
| Control re-auth in window mode | No window is opened (AR-6). |

---

## §6 Migrations

**None.** The policy is a `dashboard_config` key/value row (existing table), re-auth tokens, windows and the attempt ledger live in memory, and the new audit decisions fit the free-text `decision` column.

- `v34` is reserved for open-jev and is not used.
- **Conditional v35** (only if Jd answers Open Question 4 "persistent lockout"): `add_dashboard_user_reauth_lockout`, ALTER-only:
  ```sql
  ALTER TABLE dashboard_users ADD COLUMN pw_failures INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE dashboard_users ADD COLUMN pw_failure_window_start TEXT;
  ALTER TABLE dashboard_users ADD COLUMN pw_locked_until TEXT;
  ```
  Unknown-username login failures stay in memory either way (there is no row). Re-check the highest version on `origin/*` right before writing it; `migrations.test.ts` asserts contiguity.

---

## §7 Test plan

Unit and route tests, in the order to write them (each fails first). New files under `src/__tests__/`:

1. `consequential.test.ts`: T-C1 "each table row classifies as specified (one case per row, including action/dryRun variants)"; T-C2 "every name in MUTATING_TOOL_NAMES and every catalog mutating/proposal tool has a row" (fail-closed coverage); T-C3 "an unlisted mutating tool and an MCP-adapter tool are RC unknown_tool"; T-C4 "all_writes scope makes every mutation/proposal RC, never reads"; T-C5 "update_transaction with only category/notes is not RC, with amount is".
2. `reauth-policy.test.ts`: stored in `dashboard_config`; invalid JSON → off + warning; auth off → unavailable / 409 / inert, restored on auth on; admin only; viewer 403; tightening without header; loosening → 428; `settings.json` key ignored; policy change purges tokens and windows.
3. `reauth-attempts.test.ts` (fake clock): T39 and T46 cases above.
4. `reauth-tokens.test.ts` (fake clock): T40 cases; purge hooks (logout, deactivate, auth off, profile switch, kill switch off, lockout).
5. `reauth-route.test.ts`: `POST /api/auth/reauth` happy path; 403 `reauth_failed` body has no attempt count; 409 `reauth_not_required` for a non-RC op, a read op, policy off, auth off; 404 for an op the caller cannot see; viewer → 409/404, never a token; `Cache-Control: no-store`; window mode returns `windowUntil`.
6. `reauth-approval.test.ts`: per source (webmcp, http-mcp, chat): RC without header → 428 and op still pending; with token → committed; non-RC → no header needed; order: dwell checked first (`approval_too_fast` does not consume the token), expiry 409 does not commit; reject/cancel never 428; chat stale-card cases; window cases (T41); `all_writes`.
7. `reauth-control-plane.test.ts`: one case per §2.4 C row, gated and not-gated direction, body-digest binding.
8. `reauth-rest-presence.test.ts`: §2.4 D routes with and without agent presence (2-hour window), and audit `agent_present=true` on a re-authenticated write.
9. `reauth-agent-gate.test.ts`: §2.8 (`mustAsk`, TUI deny with reason and tool result, headless message, dashboard runner unaffected, 1c2bc6b still holds).
10. `reauth-audit.test.ts`: decisions written; noise aggregation for `reauth_failed`; sentinel on lock; canary strings for password and token never in `mcp_audit_log`, responses or captured console output.
11. `reauth-ui-core.test.ts`: chip model; `REAUTH_FIELD_ATTRS`; `acceptReauthSubmit` rejects untrusted events; error copy.
12a. `consequential.test.ts` additions: T-C6 surface key (chat `tax_flag export` RC, catalog `set_tax_flag` not); T-C7 every zod `action` enum value of each action-dependent tool is in the non-RC set or the RC column (catches `entity_manage assign`).
12b. `reauth-control-plane.test.ts` additions: `user_create` viewer → 428; `model_egress` local→cloud → 428, cloud→local → 200; mixed settings body `{enabled:false, grantTtlMinutes:up}` → 428 and the kill switch is **not** flipped; 428 body has a `summary` with no free text from the body; training export with opt-ins and no browser proof → 403, token unspent.
12c. `reauth-attempts.test.ts` additions: remote-peer login failures lock `user:<id>:remote` only, re-auth still verifies; login-only lock revokes no grants; 409/404/403 re-auth paths never call the verifier and never count (AR-8).
12d. `reauth-tokens.test.ts` additions: control re-auth in window mode opens no window (AR-6); REST token bound to route+target+body.
12. Source guards (in `reauth-audit.test.ts` or a new `reauth-source-guard.test.ts`): no `console.*` with password/token in reauth sources; no `innerHTML` in the bridge's new code; no `dangerouslySetInnerHTML` in the new components; any code updating `dashboard_users.password_hash` or `role` calls `purgeReauthForUser` (T-R10).

Extended existing files:
- `mcp-approval.test.ts`: `reauthVerified` defence in depth.
- `chat-approval-binding.test.ts`: token bound to the bound card; superseded request.
- `dashboard-origin-gate.test.ts`: T45 cases.
- `dashboard-auth.test.ts`: login limiter, dummy-hash path, deactivate purges.
- After the rebase: `held-body-offboarding.test.ts` gains T-R12 ("held `/api/auth/reauth` body, user deactivated → 401, no token") and `chat-deactivation.test.ts` gains "deactivation purges the user's window and tokens".
- `approval-surfaces.test.ts`: RC denial reason on the TUI path.

Gates per slice: `bun run typecheck`; the per-file loop `for f in src/__tests__/*.test.ts; do bun test "$f" || FAIL=1; done; test -z "$FAIL"`; UI build when UI changed. Each touched test file also passes alone (`bun test src/__tests__/<file>`).

---

## §8 Verification plan

Three steps, in order. A step that finds a problem loops back through step 2 before moving on.

### Step 1: Adversarial Opus review of the implementation

Run after S8, on the full diff against the rebased base (`fix/auth-switch-hygiene` landed in `release/0.10.0`). One Opus reviewer with this spec, the threat model and the diff, told to **break** it, not to summarise. Required checklist (the reviewer reports each as held / broken / not tested, with a file:line):
1. Any path that commits an RC operation or applies a §2.4 C action without consuming a matching token in the same tick (look for an `await` between `enforceReauth` and the write, a second approve route, a direct `commitWebMcpOperation` caller, chat `respondToChatOperation` callers outside the route).
2. Token binding: can any field of the binding be supplied by the client (digest, user, purpose)? Is the digest recomputed from the stored row at consume time?
3. Ledger: can parallel requests, a dropped connection, login vs re-auth, or a username case change get more than 5 guesses per 15 minutes per account?
4. Downgrade: every loosening path in §2.4 C and any other route that changes `dashboard_config`, `dashboard_users`, agent-access state or grants, including routes added since #160.
5. Surfaces: TUI `allow-session`, chain/team inner calls, MCP-adapter tools, human REST routes, declarative forms, page tools, profile switch.
6. Secrets: password or token in any log, error, audit preview, URL, React state, or response other than the issuing one.
7. Composition: b58d2d6 post-body re-validation actually covers the new routes (not in `PUBLIC_AUTH_PATHS`, not `/mcp`); b843a6a purge; 1c2bc6b intact; dwell order; stale-card refusal.
8. Auth off: nothing asks, nothing is shown as protected, nothing mints a token.
9. Timing oracle on login/re-auth (dummy hash used on every miss path).
10. Classification table vs the real tool registry (`tool-registry.test.ts` coverage).
Output: a findings list, each with a concrete failure scenario. No fixes in this step.

### Step 2: Issue-scoped verification of each fix

For **each** finding from step 1 (and each live-check failure from step 3), separately:
1. Write the failing test that reproduces exactly that finding, named after it (`"F<n>: …"`), and run it alone: it must fail for the stated reason.
2. Apply the smallest fix for that finding only.
3. Run that test file alone, then every test file the fix touches, then `bun run typecheck`, then the full per-file loop.
4. Record in the PR: finding, test name, fix commit, result. A finding judged "not a bug" gets the reasoning and a test that pins the safe behaviour anyway.
5. A fix that touches the token, ledger or approve path re-runs Step 1's checklist items 1–3 by the same reviewer on the fix diff only.

### Step 3: Live Chrome 154 WebMCP check (throwaway env)

Runs as **Part 4 of `scripts/webmcp-live-check.md`** (sections RA.0–RA.14), written in S8. Never a real profile; never anything under the real `~/.openaccountant`; never the macOS `security` CLI (the seed's shim makes it fail on purpose).

Environment, exactly:
```sh
mkdir -p /private/tmp/claude-501/webmcp-live-home
HOME=/private/tmp/claude-501/webmcp-live-home PATH=/private/tmp/claude-501/webmcp-live-home/.webmcp-live-bin:$PATH \
  bun run scripts/webmcp-live-seed.ts --auth --reauth=every_time
HOME=/private/tmp/claude-501/webmcp-live-home PATH=/private/tmp/claude-501/webmcp-live-home/.webmcp-live-bin:$PATH \
  bun run src/index.tsx --dashboard --port 3141
```
`--auth` creates a throwaway admin `live-admin` with a random password the seed prints (never reuse it), plus a viewer `live-viewer`, and turns auth on for the seeded profile; `--reauth` writes the `reauth_policy` row. Build the UI first if `src/dashboard/ui/dist` is stale.

**Why "JD WATCHES":** claude-in-chrome tabs report `document.visibilityState === 'hidden'`, and the card poller is visibility-gated by design (#160 "Operational notes"), so a card never draws in an agent-driven tab. Every step that needs a card on screen, a hold, or a password typed into a card is done by Jd in a foreground tab while the orchestrator reads state through `GET /api/mcp/operations` (`w.pending()`) and `GET /api/auth/reauth/status`. The orchestrator never types the live password into a card.

| Step | Who | Action | Expected |
|---|---|---|---|
| RA.0 | orchestrator | Seed, start, open `http://localhost:3141`, log in as `live-admin` (login form, not a card), install the Part 4 helper | `GET /api/auth/reauth/status` → `{available:true, mode:'every_time'}` |
| RA.1 | orchestrator | Grant `categorize_transaction`, `update_transaction` to the tab | both in `getTools()` |
| RA.2 | **JD WATCHES** | Agent: `categorize_transaction` on a seeded row. Jd holds Approve | card has no `PASSWORD` chip; committed without a password |
| RA.3 | **JD WATCHES** | Agent: `update_transaction {id, amount}`. Jd sees `PASSWORD` chip + "Changes an amount", holds, password row appears, types a **wrong** password | "Wrong password…", `w.pending()` still has the op, row unchanged |
| RA.4 | **JD WATCHES** | Same card, correct password | committed; Activity shows `reauth_ok` then `approved`/`committed` with the same op id; no password or `wra_` string anywhere in Activity |
| RA.5 | orchestrator | New RC op via agent; `fetch` approve with no header; with a token issued for another op; replay a consumed token | 428; 403 `reauth_invalid`; 403 |
| RA.6 | orchestrator | `curl` `POST /api/auth/reauth` with `Origin: https://evil.example`; with no Origin/Sec-Fetch-Site; `text/plain` from the page | 403; 403; 400 — `status` shows no attempt consumed |
| RA.7 | orchestrator, then **JD WATCHES** | 5 wrong re-auths via `fetch`; Jd looks at the open card | 6th → 429 `reauth_locked` + `Retry-After`; grants revoked (`getTools()` empty); card shows the red locked message; Reject still works |
| RA.8 | orchestrator | 1 wrong `POST /api/auth/login` for `live-admin` while locked | 429 (shared ledger) |
| RA.9 | orchestrator | Restart the server (same env) to clear the in-memory lock; log in again | status `lockedForSec: 0` |
| RA.10 | **JD WATCHES** | Settings → Security → switch to "For 5 minutes" | password prompt (loosening); after it, status `mode:'window'` |
| RA.11 | **JD WATCHES** | Re-grant; two RC agent ops. Jd approves the first with the password, the second within 5 min | second has no password row; Activity `reauth_window_used`; after logout + login, a third asks again. Also record: does Chrome offer the saved `live-admin` credential in the re-auth field (save it at login first)? **UNCERTAIN, record exactly** |
| RA.12 | **JD WATCHES** | Control plane: mint a client token with `categorize_transaction`; set a read tool `ask → allow`; turn agent access off then on; try turning auth off | prompt on mint, on loosen, on re-enable (not on turning off), on auth off; each without the password → nothing changed (check `GET /api/mcp/state`, `GET /api/auth/status`) |
| RA.13 | orchestrator | Headless: `HOME=… PATH=… bun run src/index.tsx --run "delete transaction <id>"` (only if a model is configured in the throwaway env; else skip and say so) | denial line mentions the dashboard password; row still exists |
| RA.16 | **JD WATCHES** + orchestrator via `mcp__chrome-devtools__*` (its own visible Chrome window on the throwaway server; CDP input events are trusted) | With no WebMCP grant at all: drive the Transactions tab Delete button on a seeded row; then raise an RC agent op (re-grant) and drive Approve + hold on its card; then click into the password row and open the browser's autofill list | Delete → password dialog with the server summary, row still exists (`restGate: always`); card → password row, op still pending; autofill: record whether the saved credential is offered (feeds Open Question 13). This is the only step that exercises the actual ACT-1 capability; skip and say so if `chrome-devtools` cannot reach the page. (AR-17) |
| RA.14 | **JD WATCHES**, then orchestrator | Turn auth off (with password). Then `GET /api/auth/reauth/policy` | `{available:false}`; Settings control disabled with "Turn on dashboard auth first."; `PUT` → 409. Cleanup: stop the server, `rm -rf /private/tmp/claude-501/webmcp-live-home` |

Dashboard chat card (optional, RA.15, **JD WATCHES**): only if a chat model is configured in the throwaway env: ask the chat to delete a seeded transaction; the chat card shows `PASSWORD`; approve with password → deleted; a second chat request while the first card waits → the first card is refused as stale and the token does not carry over.

Result template: one row per step with pass/fail/skipped, the observed JSON, `document.visibilityState` for each JD WATCHES step (must be `visible`), and the RA.11 autofill observation.

---

## §9 Slices and estimates

Each slice ends green on the gates. Estimates are focused engineering hours.

| Slice | Content | Depends on | Est. |
|---|---|---|---|
| S0 | Wait for `fix/auth-switch-hygiene` to land; rebase; re-verify §A citations; re-check migration head | — | 0.5 h |
| S1 | `consequential.ts` + `consequential.test.ts` (table, coverage, fail-closed) | — | 3 h |
| S2 | `reauth/policy.ts`, policy routes, auth-off behaviour, Settings panel (read/write, no gating yet) | S1 | 3 h |
| S3 | `verify.ts`, `attempts.ts` (shared with login), `tokens.ts`, `guard.ts`, `POST /api/auth/reauth`, `/status`, purge hooks, audit decisions | S0, S2 | 6 h |
| S4 | Approve gate for webmcp / http-mcp / chat; `approveWebMcpOperation` defence in depth; `OperationView.reauth` | S3 | 4 h |
| S5 | Control-plane gates (§2.4 C) incl. policy loosening, auth off, admin create, custom prompt, bulk accept, training opt-in | S3 | 4 h |
| S6 | Human REST gate (§2.4 D: route table, `restGate`, REST purpose, T-R14 coverage guard) | S3 | 3.5 h |
| S7 | UI: `reauth-ui-core.ts`, bridge card row, `ReauthPrompt`, `withReauth`, all control buttons, chat card | S4, S5 | 6 h |
| S8 | TUI/headless deny with message, `mustAsk`, `ToolDeniedEvent.reason`; seed `--auth/--reauth`; live-check Part 4 | S3 | 4 h |
| V1 | Step 1 adversarial Opus review | S1–S8 | 2 h |
| V2 | Step 2 issue-scoped fixes | V1 | 2–6 h (depends on findings) |
| V3 | Step 3 live check with Jd | V2 | 1.5 h (Jd present for the JD WATCHES rows) |
| | **Total** | | **≈ 38–42 h** |

---

## §10 Open questions for Jd (with a recommendation each)

| # | Question | Recommendation |
|---|---|---|
| 1 | Default mode when an admin turns re-auth on: every time, or a window? | **Every time.** The window is the main residual (T41); it stays available for admins who want it. |
| 2 | Default scope: RC only, or every write? | **RC only** (§2.1). Every write makes approvals painful and trains people to type the password without reading. |
| 3 | Window lengths 1 / 5 / 15 minutes, default 5, absolute, never for control actions? | **Yes.** |
| 4 | Lockout state in memory (no migration; a restart clears it) or persistent (v35)? | **In memory** now. Only a local process can restart the server, and that actor already owns the DB. Revisit if the dashboard ever runs as a service. |
| 5 | On a re-auth lockout, also revoke the user's agent grants and expire their pending agent operations? | **Yes.** Five wrong passwords on an approval card is the strongest "not the person" signal we have. |
| 6 | Add the login limiter (5 failures per account per 15 min, 20 per address) in this work, though it changes login for everyone with auth on? | **Yes.** Without it the re-auth lockout is meaningless: guessing moves to `/api/auth/login`. |
| 7 | TUI: deny RC with a message (this spec) or prompt for the dashboard password in the terminal? | **Deny.** A terminal prompt is visible to the agent's own shell tools and adds nothing against the OS user. Revisit if people ask. |
| 8 | Confirm the RC table in §2.1, in particular: `update_transaction` (chat `edit_transaction`) is RC only for amount/date; `memory_manage add` and `rule_manage add/update` are RC; single-row categorize, budgets and goals are not; `goal_manage abandon` is RC but `complete`/`pause` are not. | Confirm as written. |
| 9 | (Revised by AR-1.) Default `restGate` for the human REST RC writes (§2.4 D): `always`, or only while Wilson sees agent access? | **`always`.** Presence detection only sees agents that took a Wilson grant; a CDP/DOM agent that just clicks Delete takes none. `agent_present` stays as an admin opt-down with honest copy. In window mode the cost is one password per window. |
| 10 | Gate the CSV/XLSX/P&L/net-worth export links too? | **Not now.** They use `?token=` links that cannot send a header; do it with the T29 follow-up that moves them to `fetch`. |
| 11 | Gate the creation of tab grants for write tools? | **No.** Each write still needs an approved card, which is gated. |
| 12 | Should a re-authenticated human REST write made while an agent is present still be marked `agent_present`? | **Yes** (the password proves knowledge, not absence of an agent). |
| 13 | (AR-18: Chrome is known to ignore `autocomplete="off"` on password inputs, so expect the credential to be offered; RA.11/RA.16 should also try `autocomplete="one-time-code"` and a field that is not inside a `<form>` and has no username sibling, and record which suppresses the offer.) If the live check (RA.11) shows Chrome 154 offering the saved credential in the re-auth field to a CDP-driven click, what then? | Record it, keep the field attributes, and add a Settings note ("Do not let your browser save the dashboard password if you use agents on this page"). A real fix needs a user-presence primitive (WebAuthn), which is a separate spec. |
| 14 | With auth turned off, keep the stored re-auth policy (inert) so it comes back when auth is turned on, or clear it? | **Keep it.** Turning auth off already required a fresh re-auth; restoring the admin's last choice is the safer default when auth returns. |
| 15 | (AR-13) Gate or warn on the chat assistant's web search tools (non-mutating, so never carded) as an egress path while re-auth is on? | **Not in this spec.** Name it in Settings copy and §4.4; a separate issue for an "ask before searching the web with ledger data" policy. |
| 16 | (AR-10) Is gating `POST /api/models` local→cloud the right line, or should every model change be a control action? | **Local→cloud and cloud→cloud only.** Moving to a local model reduces egress and stays one click. |

---

## Adversarial review (2026-10-04)

Reviewer: Opus, adversarial pass on revision 1 against `release/0.10.0` @ `e8d0d0a` (code read: `src/dashboard/{server,mcp-routes,judgement-routes,origin-gate,api}.ts`, `src/mcp/{engine,store,policies}.ts`, `src/agent/approval-gate.ts`, `src/tools/mutation.ts`, the chat tool definitions under `src/tools/`). Each finding is either fixed in the spec above (revision 2) or left as an open question for Jd. No implementation exists yet; "fixed-in-spec" means the design now closes it and names a test.

| ID | Sev | Issue | Disposition |
|---|---|---|---|
| AR-1 | **High** | §2.4 D gated human REST RC writes only while `isAgentPresent` was true. That function (`store.ts:453-465`) only sees Wilson grants and pending non-chat ops. The agent D exists for (one that clicks the human Delete button through CDP instead of the card) needs no grant, so presence is never detected and the gate never fires: the whole "agent clicks the human button" defence was bypassable by not using WebMCP. Also: D named `isAgentPresent` but described `annotateAgentPresent`, and gave the token no purpose binding. | **Fixed-in-spec**: `restGate: 'always' \| 'agent_present'`, default `always`; `agent_present` is a loosening with honest copy; new token purpose `{kind:'rest', route, targetId, bodyDigest}`; function named correctly. OQ9 revised (Jd may still pick the opt-down default). |
| AR-2 | **High** | `classifyConsequence(toolName, args, scope)` had no surface. `tax_flag` and `edit_transaction` existed on both the catalog and chat with different semantics (the catalog has since renamed them to `set_tax_flag` and `update_transaction`; `(surface, name)` keys stay for retired names in old rows); a name-only lookup makes the catalog's "never RC" row decide chat `tax_flag action=export` (egress) or vice versa, depending on table order. | **Fixed-in-spec**: surface is part of the key, derived server-side from `op.source` / the runner; missing pair is RC `unknown_tool`; T-C6. |
| AR-3 | Medium | Action-dependent rows were deny-lists ("RC when action ∈ {…}"), fail-open for any new action, and already wrong today: `entity_manage assign` (re-points many transactions or a whole account to an entity, which drives Schedule C splits) was not RC. | **Fixed-in-spec**: rows are allow-lists of non-RC actions; `assign` is `bulk`; T-C7 enumerates each zod `action` enum. |
| AR-4 | Medium | Confused deputy on control actions: the page-driving agent presses "Mint token" / "Turn auth off"; `withReauth` pops a bare password dialog; the person types out of habit. Nothing in the dialog said what the password was for. | **Fixed-in-spec**: 428 and the re-auth response carry a server-built `summary` (enums/ids only); dialog shows it with "If you did not start this, press Cancel"; one prompt at a time; body captured in closure. Residual: a person who does not read the summary still approves. |
| AR-5 | Medium | `user_create` was gated only for `role: 'admin'`. A viewer account with an agent-chosen password is a 7-day credential that survives grant revoke, kill switch and the admin's logout, and reads the full ledger over unaudited REST. `body.role` is also unvalidated (`server.ts:522`). | **Fixed-in-spec**: `user_create` gated for any role; zod role enum. |
| AR-6 | Medium | A successful re-auth for any purpose opened the recent-auth window, so a control re-auth (e.g. minting a client token) gave the agent minutes of password-free RC approvals. | **Fixed-in-spec**: only operation and REST purposes open a window; test in 12d. |
| AR-7 | Medium | Training-export opt-in was gated by a header on `GET /api/export/training/*`, but those GETs take `?token=` and have no browser proof, contradicting §2.3's own rule that any route reading the header requires browser proof. | **Fixed-in-spec**: opt-in or header-carrying training export requires browser proof; failure does not consume the token. |
| AR-8 | Medium | The re-auth route did not fix the order of checks vs. the verify. If the verify ran before the visibility/role/"needed?" checks, the 409/404 paths would burn attempts (DoS) or act as a verify path for callers who could never get a token. | **Fixed-in-spec**: all cheap checks before `beginAttempt`; test in 12c. |
| AR-9 | Medium | Shared login/re-auth ledger lets any LAN peer (no session) send 5 wrong logins per 15 min and lock the person at the machine out of every RC approval and every loosening, indefinitely; and a login-tripped lock revoked the user's agent grants. | **Fixed-in-spec**: non-loopback logins use `user:<id>:remote`; only a lock tripped through `/api/auth/reauth` revokes grants. Total guesses ≤ 5 local + 5 remote per 15 min. |
| AR-10 | Medium | `POST /api/models` (not in §2.4 C) can move the chat model from Ollama to a cloud provider, sending every later system prompt, memory and tool result off-box: an egress loosening a page-driving agent can make with one click. | **Fixed-in-spec**: `model_egress` control action (local→cloud, cloud→cloud); OQ16 asks Jd to confirm the line. Shell-edit of `settings.json` stays an ACT-4/9 residual. |
| AR-11 | Medium | Defence in depth covered `approveWebMcpOperation` only; `respondToChatOperation` (the chat commit point) had none, so a future second caller could commit an RC chat card without a token. | **Fixed-in-spec**: `reauthVerified` option on `respondToChatOperation`; T-R13. |
| AR-12 | Low | Multi-field bodies (`PUT /api/mcp/settings`, policy PUT) could pair a never-gated tightening with a gated loosening; the spec did not say whether the safe half is applied without a token. | **Fixed-in-spec**: whole-body decision, no partial apply; digest over the whole body; `isLoosening` true if any dimension loosens. |
| AR-13 | Medium | The chat assistant's web search tools are `mutates: false`, never reach the approval gate, and send model-chosen strings to third parties: an exfiltration path re-auth cannot see. | **Open question for Jd** (OQ15). Named in Settings copy and §4.4 residuals. Not a regression from this spec. |
| AR-14 | Medium | REST `POST /api/memories` (persistent prompt injection, same row as chat `memory_manage add`, which is RC) and `POST /api/demo/trace/step {step:'import'}` (same write as `/api/import`) were missing from D; the default training export (A4 egress) was ungated. | **Fixed-in-spec**: added to the D table; T-R14 source guard forces every REST write route to be classified. |
| AR-15 | Low | The card password row could be bound to a card by list position while the 1.5 s poll re-renders/reorders; a well-timed agent op could take the row's purpose. | **Fixed-in-spec**: `operationId` captured at hold completion in closure; row lives inside its card element. |
| AR-16 | Low | `all_writes` scope silently does not cover proposal tools already at policy `allow` (they never become cards). | **Fixed-in-spec** (edge case): Settings lists them; moving to `ask` is a tightening. |
| AR-17 | Medium | Verification never exercised the actual ACT-1 capability: claude-in-chrome tabs are hidden, so every card step was Jd's hand, and no step drove the page with trusted CDP input or tested the REST button path. | **Fixed-in-spec**: RA.16 via `chrome-devtools` in its own visible window on the throwaway server (no grant; Delete button; card hold; autofill list). Skipped-and-reported if unreachable. |
| AR-18 | Medium | `REAUTH_FIELD_ATTRS` relies on `autocomplete="off"`, which Chrome ignores for password inputs; a CDP agent may be able to pick the saved credential from the autofill list, which would defeat the knowledge factor for ACT-1 entirely. | **Open question for Jd** (OQ13, amended): RA.11/RA.16 test variants and record; the real fix is a user-presence primitive (WebAuthn), out of scope. Until measured, Settings advises not saving the dashboard password in the browser. |
| AR-19 | Low | Read-ask approvals are never RC, so a page-driving agent can approve its own read-ask cards with trusted clicks. | Accepted residual (it can read the rendered DOM anyway); named in §4.4. |
| AR-20 | Low | `GET /api/auth/reauth/status` tells the page (and the agent in it) `windowRemainingSec`, which helps time RC ops inside the window. | Accepted residual: the UI needs it, and window mode is already the stated T41 residual. |
| AR-21 | Low | One-in-flight-verify (`reauth_busy`) lets an agent spamming `/api/auth/reauth` make the person's own attempt fail with 429. | Accepted (fail-closed, T46 class); Reject and kill switch unaffected. |

**Unresolved high findings in revision 2: none.** AR-1's default is reversible by Jd through OQ9; choosing `agent_present` as the default would re-open AR-1 as a documented residual rather than a design hole, since the copy then says what it does not detect.
