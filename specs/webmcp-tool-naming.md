# WebMCP tool naming convention and rename plan

Status: design spec, revision 2 (2026-10-04, amended by the adversarial plan review at the end of this file). Implemented on `feat/webmcp-tool-naming` in one commit with this file. Where the implementation differs from the text, see "Implementation notes" at the end.
Branch: `feat/webmcp-tool-naming` (worktree `.claude/worktrees/webmcp-tool-naming`), based on local `release/0.10.0` @ `93b7484`.
All `file:line` citations were checked against `93b7484` unless a release tag is named.

Conventions (same as `specs/webmcp-consequential-reauth.md`):
- **Migrations: none.** `v34` is reserved for open-jev. The runner applies only versions greater than `MAX(version)` (`src/db/migrations.ts:111,133`), so a `v35` would make `v34` never run. The current top version is `v33` (`migrations.ts:93`). Persisted names are carried over by an idempotent startup fix-up plus one permanent read-time fallback for policies (§4).
- **TDD**: each slice lists its tests in the order to write them. Make each one fail first.
- **Gates** for every slice: `bun run typecheck`; the CI per-file loop `for f in src/__tests__/*.test.ts; do bun test "$f" || FAIL=1; done`; `cd src/dashboard/ui && npm run build` when UI files change.
- Tests never touch the real `~/.openaccountant` (`src/__tests__/preload.ts` redirects `HOME`).

---

## §0 Recommendation in one screen

1. **Adopt a test-checked convention.** Names are `verb_object` in lower snake case. The verb comes from a fixed set per classification, and each verb has one meaning. The object is singular or plural by a stated rule. Spelling is US. The maximum length is 32 characters (§1).
2. **Rename 15 of the 26 catalog tools and keep 11** (§2). This removes all six exact-string collisions with chat tool names (`tax_flag`, `edit_transaction`, `transaction_search`, `spending_summary`, `profit_loss`, `net_worth`). Every rename only changes the name: classification, roles, transports, policy defaults and the zod schema stay the same. The schema digest is therefore unchanged for every tool that `/mcp` client tokens can hold (§6, I1).
3. **No ingress alias.** Old names are refused with an `unknown_tool` error whose message names the new tool. The hint grants nothing. Three facts justify this (§4.7):
   - 0.10.0 is unreleased, and 18 of the 26 names never shipped.
   - The 7 renamed names that did ship (in v0.9.x) were reachable only over `/mcp`. 0.10.0 already requires every `/mcp` client to mint a new prefixed client token.
   - 0.10.0 already invalidates every 0.9.x grant, because the schemas changed.
4. **Carry persisted names over without a migration.** An idempotent fix-up runs in `initDatabase` right after `runMigrations` (`src/db/database.ts:53`):
   - Policies are merged most-restrictive-wins into the new name, and the old-name row is **kept as a mirror** holding the same value (AR-P1). `setPolicy` writes both, so a build that still uses old names, run from another worktree on the same `HOME`, never loses a user's Off.
   - Live grants, including client-token grants, are renamed. A rename never adds a second live grant for one grant owner (session, user, profile, origin).
   - Pending non-chat operations are renamed.
   - The audit log, terminal operations and `llm_*` tables are never touched.
   - Policy reads also consult retired names, permanently, so a fix-up that fails or never ran can never let a tool fall back to its default policy (§4.3).
5. **Leave the other two namespaces alone.**
   - **Chat tool names are not renamed.** That is listed as a later decision with its cost (§3.3).
   - **The browser-mirror and open-jev router vocabulary is not renamed either.** That vocabulary is `transaction_search`, `spending_summary`, `profit_loss`, `net_worth` and `forecast`. The router was measured with those exact strings (`openjev-route.ts:27-35`, `specs/eval/round4-openjev-frozen.json`). It now reaches the catalog through one explicit boundary map (§4.9).

---

## §A Recon (verified at `93b7484` unless noted)

| Fact | Where |
|---|---|
| The catalog has 26 tools across four classifications: `read`, `page`, `mutating` and `proposal`. Transports are `BOTH` (tab and `/mcp`), `TAB_ONLY`, or `['http-mcp']` for `get_operation_result`. | `src/mcp/tool-catalog.ts:128-129,186-760` |
| `getToolDef` is an exact `Map` lookup. | `tool-catalog.ts:762-766` |
| `schemaDigest(name)` hashes `z.toJSONSchema(z.object(def.zodShape).strict())`. That includes every `.describe()` string, but not the name, the top-level `description` or `example`. | `tool-catalog.ts:786-802` |
| Four zod `.describe()` strings name other tools. Three of them sit in `BOTH` tools and name tools that keep their names (`list_interactions` at `:177,693`, `get_judge_rubric` at `:730`). One sits in a `TAB_ONLY` tool and names a renamed tool: `open_review_item`'s `'Review ID from list_review_queue'` at `:609`. | `tool-catalog.ts` |
| **Only 8 names shipped.** v0.9.1 (`97c6f6f`) has `categorize_transaction`, `tax_flag`, `edit_transaction`, `transaction_search`, `spending_summary`, `profit_loss`, `net_worth` and `forecast`. It has only the `mcp_grants`, `mcp_operations` and `mcp_approval_tokens` tables. Policies (v30), client tokens (v29) and the audit log (v28) are unreleased. | `git show v0.9.1:src/mcp/tool-catalog.ts`, `v0.9.1:src/db/schema.ts` |
| **0.9.x grants are already dead on 0.10.0.** v0.9.1 builds schemas with non-strict `z.object` and has no `cursor` or `limit`, so every digest differs. v0.9.1 `/mcp` accepted any bearer as the grant session. 0.10.0 accepts only `CLIENT_TOKEN_PREFIX` tokens and tells other bearers to mint one. | `v0.9.1:src/mcp/tool-catalog.ts:149`, `v0.9.1:src/mcp/http-server.ts:44-62`, `http-server.ts:305-307` |
| Grants are checked by exact `grant.tool_name !== toolName`, which returns `scope_mismatch`, and then by digest, which returns `schema_changed`. | `src/mcp/store.ts:338-339` |
| The policy read is exact on `(user_key, tool_name)`. A user's own row wins, and the `user_key` 0 row is the fallback. If no row exists, the tool's `defaultPolicy` applies, and that is `allow` for every read and page tool. | `src/mcp/policies.ts:57-80` |
| `setPolicy` stores the raw request string `tool`, not `def.name`. | `policies.ts:88-104` |
| `callTool` resolves `def` once (`engine.ts:396`) and then passes the raw `toolName` to `parseToolArgs`, `validateGrant` and `schemaDigest` (`:451,457`), `prepareProposal` (`:509`), `proposalCreatedVia` (`:760-762`) and `proposalAnswer` (`:774-776`). | `src/mcp/engine.ts` |
| `proposalCreatedVia` decides `created_via='declarative'` by `toolName === 'judge_interaction'`. The blind-agreement metric excludes declarative proposals. | `engine.ts:760-762`, `src/training/annotations.ts:500-505` |
| `/mcp` builds one `McpServer` per request and registers `def.name` for each granted, visible tool. The SDK refuses an unregistered name before any handler runs. Refused calls are pre-scanned and audited. | `src/mcp/http-server.ts:128-166,169-180,208` |
| Chat cards share `mcp_operations` with `source='chat'` and the chat tool name. `TOOL_LABELS` is keyed by bare name, so a chat `tax_flag` or `edit_transaction` card is titled today by the catalog label. | `src/mcp/confirmation-card.ts:76-103,166` |
| `operation-view.ts` renders a read filter only for `tool_name === 'transaction_search'`. | `src/mcp/operation-view.ts:111` |
| The server-side local handoff runs **mirror** read names through the catalog: `getToolDef(tool)` and `executeRead(db, tool, args)`. | `src/dashboard/local-handoff.ts:102-107,369`; names at `:57-58`, `local-handoff-format.ts:17` |
| `READ_TOOL_SCHEMAS` and `OPEN_JEV_ROUTE_OPTIONS` are keyed by mirror names. Their snapshot tests look the catalog up by the same strings. | `ui/src/hybrid/read-tool-schemas.ts`, `ui/src/hybrid/openjev-route.ts:27-35`, `__tests__/read-tool-schema-snapshot.test.ts`, `__tests__/openjev-route-options-snapshot.test.ts` |
| `annotations.ts` reads `mcp_audit_log WHERE tool_name = 'open_interaction'`. That name is not renamed here. | `src/training/annotations.ts:544` |
| The UI and tests use "judgement" (British) throughout: `/api/judgements`, `judgement-routes.ts`, `JudgementHistory.tsx`, about 300 occurrences. No DB table or column name contains it. | `rg -i judgement src` |
| `app/docs` mentions none of the 26 names. | Inventory |

---

## §1 The naming convention

The rule applies to WebMCP catalog tool names (`MCP_TOOL_CATALOG[].name`) only. It does not cover chat tools, mirror names, routes, files or prose. It is enforced by the new test `src/__tests__/webmcp-tool-naming.test.ts` (§6).

### §1.1 Shape and length

- **N1 Characters.** The name matches `^[a-z]+(_[a-z]+){1,3}$`: lower snake case, letters only, 2 to 4 segments. The first segment is the verb. The rest, 1 to 3 segments, is the object.
- **N2 Length.** At most 32 characters. Many clients cap tool names at 64 characters, and some prefix the server name (Claude Code exposes `mcp__<server>__<tool>`). 32 leaves room for that prefix, and the longest name in this plan is 22 characters (`categorize_transaction`).
- **N3 Object words are nouns.** No object segment is a stop word: `a an and by for from in into of on or the to with`. This keeps names grammatical without prepositions, so `navigate_to_tab` does not pass (§2).

### §1.2 Verbs: one meaning each, allowed per classification

| Verb | The one meaning | Allowed classification |
|---|---|---|
| `get_` | Return one thing: a record by id, or one computed report or document. It may page *within* that one thing. It changes nothing. | `read`; `page` only when `uiEffect` is not true |
| `list_` | Return a collection in a fixed order. It may be narrowed by structured filters, including a substring field, and it is paged. | `read` |
| `search_` | Return records matched by a free-text or natural-language query that a parser interprets. | `read` |
| `open_` | Bring one named thing into view in the dashboard: a tab, or one record in the current tab. It changes only what the user sees. | `page` with `uiEffect: true` |
| `fill_` | Put values into a form on the current tab, so the tab recomputes what it shows. Nothing is stored. | `page` with `uiEffect: true` |
| `set_` | Replace one stored value or setting with the given value, creating it if absent. Idempotent. | `mutating` |
| `update_` | Change some fields of one existing record. At least one field must be given. | `mutating` |
| `categorize_` | Assign a category, and optionally an entity, to one record. | `mutating` |
| `resolve_` | Close one pending item with a decision. | `mutating` |
| `create_`, `delete_` | Reserved: add one record, or remove one record. No tool uses them yet. | `mutating` |
| `propose_` | Submit inert suggestions that a person must accept before anything changes. | `proposal` |

- **N4** The first segment is in the verb set for the tool's classification, and the coupling holds in both directions. For example, a `mutating` tool cannot be named `get_x`, and an `open_` tool must be `page` with `uiEffect: true`. The test encodes it as one predicate per verb, so there is nothing to interpret (AR-P9):
  - `get`: `read`, or `page` with `uiEffect !== true`.
  - `list`, `search`: `read`.
  - `open`, `fill`: `page` with `uiEffect === true`.
  - `set`, `update`, `categorize`, `resolve`, `create`, `delete`: `mutating`.
  - `propose`: `proposal`.
  - A verb outside this table fails. Every def must satisfy the predicate of its own verb, and every classification must be reachable only through its listed verbs.
- **No `navigate_` verb.** The brief offered `navigate_` for page tools. It is dropped because `open_tab` says the same thing within N3, and two page verbs meaning "show something" would break the one-meaning rule.

### §1.3 Plurality of the object

- **N5** For `list_`, `search_` and `fill_`, the last object segment is plural: it ends in `s` but not `ss`.
- **N6** For `get_`, `open_`, `set_`, `update_`, `categorize_`, `resolve_`, `create_` and `delete_`, the last object segment is singular: it does not end in `s` unless it ends in `ss`, as in `loss`. `get_spending_summary` is one report even though it pages its rows.
- **N5/N6 exceptions.** The trailing-`s` test misreads words such as `status`, `analysis`, `series`, `data` and `criteria`. The test file holds an explicit `PLURALITY_EXCEPTIONS` map from word to `'singular' | 'plural'`. It is empty today, and each entry added later needs a one-line reason. No other escape is allowed (AR-P9).
- **N7** For `propose_`, the object is plural exactly when the zod shape has an array-typed `items` field (a batch), and singular otherwise.
- **N8 Twin rule.** If two names differ only by a trailing `s`, they must share `classification`, `minRole` and `defaultPolicy`. The only twins are `propose_judgment` and `propose_judgments`, and they satisfy it. A model that confuses the two can never reach a different authority class.
- **N8b No behavior keyed on a twin's spelling.** The twins differ in `transports` and `exposure`, and today `created_via` and `proposalAnswer` branch on the literal `'judge_interaction'` (`engine.ts:761,775`). After the rename, a one-letter slip (`propose_judgments` for `propose_judgment`) would silently count every batch proposal as declarative, which removes it from the blind-agreement metric, or the reverse. So both are derived from the def: `created_via = 'declarative'` exactly when `def.classification === 'proposal' && def.exposure === 'declarative'`. `prepareProposal` branches on the same predicate. Both attributes are pinned by the I1 baseline (AR-P7).

### §1.4 Spelling: US English. Decision: `judgment`, not `judgement`

- **N9** No name segment is on a British-spelling denylist: `judgement analyse behaviour cancelled cancelling catalogue categorise categorised centre colour defence favour labelled labelling licence modelling organise summarise`.
  - The check matches **stems**, not whole segments. A segment fails if it starts with any of `judgement analys(e|ed|es|ing) behaviour cancell catalogue categoris centre colour defence favour labell licence modell organis summaris`. Whole-segment equality would let the old name `propose_judgements` pass, because `judgements` is not the listed `judgement` (AR-P9).
  - The test also asserts that `propose_judgements` fails N9, which proves the rule bites.
- **Why `judgment`.**
  - It is the primary US spelling: Merriam-Webster lists it first, and US courts and statutes use it exclusively.
  - The product is US-first. Its tax vocabulary is IRS Schedule C, and its amounts are dollars.
  - Tool names are the most stable public surface, so they should follow the house standard even where internal code drifted.
- **What stays British for now, and why.**
  - The internal routes, file names and UI strings (`/api/judgements`, `judgement-routes.ts`, "Judgements" headings) are out of scope. Renaming them is decision D5.
  - The zod `.describe()` string `'1-20 judgements, one per interaction'` in `propose_judgments` is also left as is. Changing it would change the schema digest of a `BOTH` tool, and that would invalidate client-token grants (I1).
  - Top-level descriptions are not part of the digest. They switch to "judgment".

### §1.5 Namespace rules

- **N10** No catalog name equals a chat tool name. The list of chat names comes from `src/__tests__/mutation-audit.ts`, which pins every chat `ToolDef`, rather than from env-conditional registry loading.
- **N10** also requires that no catalog name starts with a dynamic chat prefix: `chain_`, `team_`, `mcp_` or `skill`.
- **N11 Retired names are never reused.** No catalog name is a key of `RETIRED_TOOL_NAMES` (§4.1). The map is injective, every value is a current catalog name, and old and new share the same classification.

---

## §2 Old-to-new map (all 26)

"Shipped" means the name was in a release (v0.9.x). "Coll." marks an exact-string collision with a chat tool. Catalog order is unchanged.

| # | Current | New | Class | Transports | Shipped | Coll. | Reason |
|---|---|---|---|---|---|---|---|
| 1 | `categorize_transaction` | **unchanged** | mutating | BOTH | yes | no | Already verb_object with a singular object. `categorize_` is its own verb, distinct from `set_` and `update_`. |
| 2 | `tax_flag` | `set_tax_flag` | mutating | BOTH | yes | **yes** | No verb. It sets or clears one flag idempotently: `action: flag/unflag` is a value. The chat `tax_flag` has `summary`, `list` and `export`, which are different semantics (AR-2 in `webmcp-consequential-reauth.md`). |
| 3 | `edit_transaction` | `update_transaction` | mutating | BOTH | yes | **yes** | `update_` is the partial-field verb. The chat `edit_transaction` has a loose schema, no `stale` check and re-embeds on change, which are different semantics. |
| 4 | `tax_summary` | `get_tax_summary` | read | BOTH | no | no | No verb. One computed report, with `action: list` paging within it. |
| 5 | `transaction_search` | `search_transactions` | read | BOTH | yes | **yes** | Object-verb order and singular object. The chat version is unpaged and uncapped, which are different semantics. |
| 6 | `spending_summary` | `get_spending_summary` | read | BOTH | yes | **yes** | No verb. The `compareWithPrevious` default differs from chat (true in chat, effectively false here). |
| 7 | `profit_loss` | `get_profit_loss` | read | BOTH | yes | **yes** | No verb. Top 10 per side, bounded `offset`. |
| 8 | `net_worth` | `get_net_worth` | read | BOTH | yes | **yes** | No verb. The capped balance sheet and the Pro error shape differ from chat. |
| 9 | `forecast` | `get_cash_forecast` | read | BOTH | yes | no | No verb. `cash_` separates it from the Forecast tab's net-worth projection (`set_forecast_inputs`), which is a different model. |
| 10 | `get_operation_result` | **unchanged** | read | http-mcp | no | no | Conforms. |
| 11 | `filter_transactions` | `list_transactions` | read | TAB_ONLY | no | no | `filter_` is not a read verb. This is a structured-filter listing, so it is `list_`, unlike the NL-parsed `search_transactions`. |
| 12 | `review_action` | `resolve_review_item` | mutating | TAB_ONLY | no | no | No verb (the name was noun_noun). Matches `open_review_item` and `list_review_items`. |
| 13 | `set_budget` | **unchanged** | mutating | TAB_ONLY | no | no | Conforms: it replaces one category's limit, creating it if absent. |
| 14 | `update_goal` | **unchanged** | mutating | TAB_ONLY | no | no | Conforms: partial fields, at least one required. |
| 15 | `set_forecast_inputs` | `fill_forecast_inputs` | page | TAB_ONLY | no | no | `set_` means a stored write. This tool "changes nothing stored" and defaults to `allow`, so a `set_` name misleads both the agent and the person reading the policy table. |
| 16 | `navigate_to_tab` | `open_tab` | page | TAB_ONLY | no | no | N3: no prepositions. Opening a tab is `open_`. |
| 17 | `get_page_context` | **unchanged** | page (no uiEffect) | TAB_ONLY | no | no | Conforms: `get_` is allowed for page tools without `uiEffect`. |
| 18 | `open_transaction` | **unchanged** | page | TAB_ONLY | no | no | Conforms. |
| 19 | `list_review_queue` | `list_review_items` | read | BOTH | no | no | N5: a list object is plural. It matches `open_review_item` and `resolve_review_item`. |
| 20 | `open_review_item` | **unchanged** | page | TAB_ONLY | no | no | Conforms. Its schema `.describe()` changes to "Review ID from list_review_items", the only digest change in this plan (I1). It is tab-only, so it holds no client-token grants. |
| 21 | `open_interaction` | **unchanged** | page | TAB_ONLY | no | no | Conforms. The `annotations.ts:544` SQL literal therefore stays correct. |
| 22 | `list_interactions` | **unchanged** | read | BOTH | no | no | Conforms. It is named in two `BOTH` schema strings, so it must stay to keep their digests. |
| 23 | `get_interaction` | **unchanged** | read | BOTH | no | no | Conforms. |
| 24 | `get_judge_rubric` | **unchanged** | read | BOTH | no | no | Conforms. It is named in `propose_judgments`' schema and in the engine hint (`engine.ts:512`). |
| 25 | `propose_judgements` | `propose_judgments` | proposal | BOTH | no | no | N9, US spelling. Plural by N7: it has `items[1..20]`. |
| 26 | `judge_interaction` | `propose_judgment` | proposal | TAB_ONLY | no | no | N4: proposals use `propose_`. Singular by N7. Its twin passes N8. |

- **Unchanged (11):** `categorize_transaction`, `get_operation_result`, `set_budget`, `update_goal`, `get_page_context`, `open_transaction`, `open_review_item`, `open_interaction`, `list_interactions`, `get_interaction`, `get_judge_rubric`.
- **Renamed (15):** `tax_flag`, `edit_transaction`, `tax_summary`, `transaction_search`, `spending_summary`, `profit_loss`, `net_worth`, `forecast`, `filter_transactions`, `review_action`, `set_forecast_inputs`, `navigate_to_tab`, `list_review_queue`, `propose_judgements`, `judge_interaction`.
- **Shipped and renamed (7):** `tax_flag`, `edit_transaction`, `transaction_search`, `spending_summary`, `profit_loss`, `net_worth`, `forecast`. These matter for external clients (§4.7).
- **No new name is a chat tool name**, and no new name is a retired one. The chat names checked are the ones in `src/tools/registry.ts` and pinned in `mutation-audit.ts`: `account_manage`, `alert_check`, `anomaly_detect`, `balance_update`, `budget_check`, `budget_set`, `categorize`, `category_manage`, `coinbase_sync`, `csv_import`, `delete_transaction`, `edit_transaction`, `entity_classify`, `entity_manage`, `export_transactions`, `firefly_import`, `generate_report`, `goal_manage`, `link_transactions`, `memory_manage`, `monarch_import`, `mortgage_manage`, `net_worth`, `plaid_balances`, `plaid_recurring`, `plaid_sync`, `profit_diff`, `profit_loss`, `rule_manage`, `savings_rate`, `skill`, `spending_summary`, `tax_flag`, `transaction_search` and `web_search`.
- **Near-miss pairs stay** (`categorize` and `categorize_transaction`, `budget_set` and `set_budget`, `goal_manage` and `update_goal`). They are distinct strings, and no agent sees both namespaces as callable tools.

### §2.1 Human labels (`confirmation-card.ts` `TOOL_LABELS`)

Catalog labels are keyed by the new names:

| Name | Label |
|---|---|
| `set_tax_flag` | Set Tax Flag |
| `update_transaction` | Update Transaction |
| `get_tax_summary` | Tax Summary |
| `search_transactions` | Search Transactions |
| `get_spending_summary` | Spending Summary |
| `get_profit_loss` | Profit & Loss |
| `get_net_worth` | Net Worth |
| `get_cash_forecast` | Cash Forecast |
| `list_transactions` | List Transactions |
| `resolve_review_item` | Resolve Review |
| `fill_forecast_inputs` | Fill Forecast Inputs |
| `open_tab` | Open Tab |
| `list_review_items` | List Review Items |
| `propose_judgments` | Propose Judgments |
| `propose_judgment` | Propose Judgment |

- The other labels are unchanged.
- A new `CHAT_TOOL_LABELS` keeps chat cards exactly as they read today: `tax_flag` is "Tax Flag" and `edit_transaction` is "Edit Transaction". Other chat names keep falling back to the raw name.
- The label lookup takes `(op.source, op.tool_name)`. Chat rows only ever use `CHAT_TOOL_LABELS`. Non-chat rows use `TOOL_LABELS[canonical]`, where `canonical` resolves a retired name for history rows (§4.6).

---

## §3 The three namespaces

### §3.1 What they are

| Namespace | Defined in | Who calls it | Renamed here? |
|---|---|---|---|
| Chat agent tools | `src/tools/**`, `src/tools/registry.ts`, `src/agent/init-tools.ts` | The CLI and dashboard chat LLM. Recorded in `llm_interactions` and `llm_tool_results`. | **No** |
| WebMCP catalog | `src/mcp/tool-catalog.ts` `MCP_TOOL_CATALOG` | Browser agents through the in-page bridge, and external clients through `/mcp` and `/api/mcp/call` | **Yes** (§2) |
| Mirror and router read vocabulary | `ui/src/store/mirror-tools.ts:37` `READ_TOOL_NAMES`, `local-handoff-format.ts:17`, `openjev-route.ts:27-35`, `read-tool-schemas.ts`, `specs/eval/heldout-router.*`, `round4-openjev-frozen.json` | The browser subagent, open-jev router and local handoff | **No.** It is mapped at one boundary (§4.9). |

### §3.2 Why the WebMCP side moves, not chat

- **Fewer persisted dependents.** Chat names are stored in `llm_tool_results.tool_name` (`schema.ts:240`) and `llm_interactions.tool_calls_json`. They are exported as training data (`src/training/export.ts:101-110`), routed by `tool-selection.ts`, named in `prompts.ts:86,178-181`, pinned in `mutation-audit.ts`, used in four SKILL.md files and the `smart-categorize` chain, and labelled in `specs/eval/tool-selection.dev.jsonl`. The catalog's only persisted dependents are the four `mcp_*` tables.
- **The judge sees both namespaces at once.** It reads recorded chat traces that contain `transaction_search` while holding catalog tools. While the strings are identical, "a tool in the trace" and "a tool I can call" are indistinguishable. The P4b DPO pairs spec has the same problem.
- **AR-2 in `webmcp-consequential-reauth.md` gets simpler.** It still needs `(surface, name)` keys, because retired catalog names equal chat names in old rows. But no live catalog name can be mistaken for a chat name any more.

### §3.3 Later decision: renaming chat tools (not in this change)

- **Recommendation: don't.** If it is ever wanted, for example `categorize` to `categorize_transactions` or `tax_flag` split into verbs, here is the cost:
  - Update `tool-selection.ts` (`CORE_TOOLS` and the regex lists; selection silently degrades if missed), `prompts.ts`, `local-date-args.ts`, the approval-session keys (`approval-gate.ts`, `sessionApprovalScope`), and the `PROPOSAL_TOOLS` `z.enum`s in `subagent-core.ts:70,268-270` and `local-handoff.ts:58`.
  - Update `mutation-audit.ts`, `tool-mutation.test.ts`, `tool-registry.test.ts`, four SKILL.md files and the chain steps.
  - Relabel or version `tool-selection.dev.jsonl`.
  - Add an export-time alias in `training/export.ts` and `mcp/judge-reads.ts`, so old and new traces don't mix vocabularies in SFT or DPO exports.
  - Retrain or re-measure open-jev if any of the five read names change.
- **Estimate:** about 2 to 3 days, plus an eval re-run.

---

## §4 Compatibility with no migration

### §4.1 The retired-name map

- **New module `src/mcp/tool-names.ts`.** It is pure, imports nothing and has no DOM, so the DB layer, tests and server can all import it without pulling in the catalog.
- **`RETIRED_TOOL_NAMES`** is a frozen record of `old -> { name: new, retiredIn: '0.10.0', shipped: boolean }` holding the 15 pairs in §2.
- **`retiredNamesFor(new): string[]`** returns the retired names for a current name, and **`currentNameFor(old): string | undefined`** does the reverse.
- **Hard rule:** these helpers are called only at the sites listed in §5. They are **never** called on a row or request whose source is chat, and **never** called inside `getToolDef`, which stays an exact match. Five retired names are live chat tool names, so a general-purpose alias would make a chat `tax_flag` row resolve to the catalog's `set_tax_flag`. That is exactly the AR-2 hazard.

### §4.2 What is persisted, and what happens to it

| Store | Action | Why |
|---|---|---|
| `mcp_tool_policies` (PK `(user_key, tool_name)`) | **Fix-up: merge into the new name, most restrictive wins, and set the old-name row to the same merged value. The old row is kept as a mirror, not deleted** (AR-P1). `setPolicy` writes the new row and every retired row for that `user_key` in one transaction. The read fallback (§4.3) covers rows the fix-up missed. | This is the user's persistent choice. A missing row fails **open**: an Off read tool would revert to Allow. That holds for this build and for any old-name build that shares the DB. |
| `mcp_grants`, including client-token grants (`session_generation = 'tok:<id>'`) | **Fix-up: rename live rows, or revoke them if the same grant owner already holds a live grant for the new name.** The owner is `(session_generation, user_id, profile, origin)`. Dead rows (revoked or expired) are left; the 7-day sweep removes them. | `validateGrant` matches the name exactly. The digest is unchanged (I1), so a renamed grant validates for exactly the same tool and schema. |
| `mcp_operations`, `status='pending'`, `source IN ('webmcp','http-mcp')` | **Fix-up: rename.** | The commit path re-validates the grant name against the op name (`engine.ts:1062`, `store.ts:630`), so grants and pending ops must move together, in one transaction. |
| `mcp_operations`, terminal statuses, or `source='chat'` | **Untouched.** | Terminal rows are history. Chat rows carry chat names, which happen to equal retired names. One accepted loss: a read-ask that was approved but not yet fetched (`outcome_json` set, held at most 5 minutes) keeps its old name. Its grant was renamed, so `readDeliveryRefusal` (`store.ts:624-640`) returns `scope_mismatch`, and `get_operation_result` returns the status with the data dropped. That fails closed (AR-P6). |
| `mcp_audit_log` | **Untouched, verbatim, forever.** New rows are written under the canonical name. | The audit is evidence. Its noise-bucket unique index (`schema.ts:596-597`) would also make a naive UPDATE throw. **Note:** `transport='rest'` rows are not only route labels. Lifecycle rows (`engine.ts:873`, `policies.ts:123`, `store.ts:573`) carry `op.tool_name`. The expiry sweep (`store.ts:564-589`) has no source filter, so it also writes **chat** tool names there (AR-P4). |
| `mcp_approval_tokens` | Untouched. | Keyed by operation id. |
| `mcp_client_tokens` | Untouched. | It has no tool column; its tools are grants, which are covered above. |
| `llm_interactions`, `llm_tool_results`, `interaction_annotations` | Untouched. | Chat names and labels, not catalog names. |
| `settings.json`, global state, `localStorage`, `sessionStorage` | Nothing to do. | They hold no tool names. In-page registrations are rebuilt on every load. |
| In-memory rate limiter | Nothing to persist. | Keys are canonical after ingress (I7). |

### §4.3 The fix-up: `applyToolRenames(db)` in a new `src/mcp/tool-rename.ts`

**Where it runs.**
- It runs in `initDatabase` right after `runMigrations(db)` (`src/db/database.ts:53`). Every profile DB, the CLI, the dashboard and the tests go through that point. Server maintenance only covers the active profile at startup.
- It imports only `tool-names.ts`, so `src/db` gets no dependency on the catalog.
- **The `initDatabase` hook lands in the same commit as the catalog rename (S3), never earlier** (AR-P2). A build with the fix-up but the old catalog would move a user's `spending_summary` Off row to `get_spending_summary`. That build's catalog only knows `spending_summary`, and `retiredNamesFor('spending_summary')` is empty, so the tool would fall back to its default `allow`. That fails open. S2 ships `applyToolRenames` and its tests, which call it directly on synthetic rows, but does not wire it.
- It runs under the connection's existing `busy_timeout`. If another process holds the write lock (the CLI and the dashboard share one DB), `BEGIN IMMEDIATE` fails, the run is skipped, and the next start retries. That is the I9 path.

**How it runs.**
- Everything happens in one `BEGIN IMMEDIATE` transaction, with every pair applied in order.
- Before touching a table, it checks `sqlite_master` and skips the table if it is missing, which covers DBs older than v26.

**Policies.** For each pair `(OLD, NEW)` and each row `r` with `tool_name = OLD`:
1. If no `(r.user_key, NEW)` row exists, insert `(r.user_key, NEW, r.policy, r.updated_at)`.
2. Otherwise, let `m = minRank(NEW.policy, r.policy)`, where `off < ask < allow`. Set NEW's policy to `m`. Change `updated_at` only if the value changed.
3. Set `r.policy = m` too, so OLD mirrors NEW. **Do not delete `r`** (AR-P1). A second run then finds OLD equal to NEW and changes nothing.

The `user_key` 0 row is handled the same way. Clamping is unchanged because the classification is identical. Policy rows for any other name are ignored.

**Grants.** For each live row `g` with `tool_name = OLD`, where live means `revoked_at IS NULL AND julianday(expires_at) > julianday(now)`, the same comparison `store.ts` uses because `expires_at` formats are mixed:
1. If a live grant for `NEW` already exists with the same owner `(session_generation, user_id, profile, origin)`, set `g.revoked_at = now`. Never two live rows, and never a later expiry than that owner already had. Matching on `session_generation` alone is not enough, because a tab picks its own session id (AR-P5). A pending op whose `grant_id` is `g` then goes `stale` with `grant_invalid:revoked` at commit. That fails closed, and the op is **never** re-pointed at the surviving grant, because that would bind it to a different expiry and role.
2. Otherwise, set `g.tool_name = NEW`.

**Pending operations.** For rows with `tool_name = OLD AND status = 'pending' AND source IN ('webmcp','http-mcp')`, set `tool_name = NEW`. The source filter is a positive list, so a future source is never rewritten by accident.

**Properties.**
- **Idempotent.** A second run matches nothing and changes 0 rows (I8).
- **Logging.** One line, and only when something changed: `[mcp] tool names updated (profile=<name>): policies=N grants=M revoked=R operations=K`.
- **On failure.** The transaction rolls back, a `console.error` is logged, and startup continues. This is safe because of three things:
  - The policy read fallback keeps old choices in force.
  - Old-name grants fail closed with `scope_mismatch`.
  - Old-name pending ops go `stale` at commit with reason `policy_off`. `getEffectivePolicy(op.tool_name)` on an unknown name returns `off` (`policies.ts:77-78`, `engine.ts:1046`), and that check runs before the grant check. A proposal op goes `stale`/`unknown_tool` (`engine.ts:1095-1098`). Revision 1 said `unknown_tool` for all of them, which was wrong (AR-P10).
  - The failure path is tested (I9).

**Policy read fallback (permanent while `RETIRED_TOOL_NAMES` exists).**
- `storedRow(db, userKey, def.name)` in `policies.ts:57` selects `WHERE user_key = @k AND tool_name IN (def.name, ...retiredNamesFor(def.name))` and returns the **most restrictive** policy found. It merges only within one `user_key`. The own-row-beats-`user_key`-0 rule in `storedPolicy` (`policies.ts:69-73`) stays as it is.
- This covers a fix-up that failed. It also covers an older dev binary running against the same DB and writing old-name rows after the fix-up.
- This is the one place where a retired name is read on a security path, and it can only make a policy stricter.

**`setPolicy` dual-write (AR-P1, AR-P3).** `setPolicy(tool = NEW, p)` upserts `(user_key, NEW, p)` **and** `(user_key, OLD, p)` for every `OLD` in `retiredNamesFor(NEW)`, in one transaction.
- Without this, a fix-up that failed, or an old-name build that wrote an Off row afterwards, would leave an OLD row that the most-restrictive fallback can never get past. The user would set Allow in Settings, the response would say `effective: off`, and nothing they did could change it.
- With it, a deliberate loosening in this build also loosens the mirror, so the "startup merge re-tightens a loosened policy" objection in §4.10 no longer applies. A tightening reaches old-name builds at once.
- It writes only rows that the user's own action names, so it can never widen anything the user did not choose.
- When `p = off`, `rejectPendingForTool` (`policies.ts:115-130`) matches `tool_name IN (NEW, ...retiredNamesFor(NEW))`. Its existing `source != 'chat'` filter stays, so a pending op the fix-up missed is rejected at once and does not wait for the commit-time check.

### §4.4 Client tokens and grants, end to end

- A token minted on an earlier 0.10 dev build with `transaction_search` and `tax_flag` has, after the fix-up, live grants `search_transactions` and `set_tax_flag` with the same digest, scope and expiry.
- `tools/list` (`http-server.ts:131-136`) shows exactly the new names.
- The token gains no tool. If the session already had a `NEW` grant, the old row is revoked rather than duplicated (I3).
- Rotate (`client-tokens.ts:268`) and `updateClientTokenTools` read through `listGrantsForSession`, so they see only canonical names.

### §4.5 Pending operations across the upgrade

- A pending card from before the upgrade, for example `edit_transaction` from a `/mcp` client, is renamed together with its grant.
- Approving it commits through `update_transaction` with the same `revision_at_prepare` check.
- `created_via` for a pre-upgrade `judge_interaction` op is derived from the canonical name `propose_judgment`, so it stays `'declarative'` and is still excluded from the blind-agreement metric (I7).

### §4.6 Audit history

- Rows are never rewritten.
- Readers that filter by name expand the filter, but **only to rows that are provably catalog rows** (AR-P4):
  - `listAudit` changes `tool_name = @tool` (`audit.ts:326`) to `tool_name = @tool OR (tool_name IN (...retiredNamesFor(@tool)) AND <catalog-row>)`.
  - `<catalog-row>` is `transport IN ('imperative','declarative','page','http-mcp') OR (transport = 'rest' AND operation_id IN (SELECT id FROM mcp_operations WHERE source IN ('webmcp','http-mcp')))`.
  - Why: the expiry sweep writes `transport='rest'` rows named `tax_flag` and `edit_transaction` for expired **chat** cards (`store.ts:564-589`). A bare `IN` would show them under "Set Tax Flag". That is exactly the AR-2 mis-attribution.
  - A `rest` row whose operation was purged is ambiguous, so it is not mapped. It still appears under its stored name.
  - The Activity dropdown (`AuditLogViewer.tsx:24,95`) keeps listing current names only.
- Entries come back with the stored `tool` plus `toolCurrent`, the result of `currentNameFor`. That field is set under the same `<catalog-row>` predicate, never for REST route rows and never for chat-expiry rows. The viewer shows `transaction_search (now search_transactions)`.
- Hourly compaction (`GROUP BY tool_name`) keeps strings verbatim, so an hour that spans the upgrade can have two summary rows. That is accepted.
- `annotations.ts:544` (`open_interaction`) needs no change, because that name is not renamed. As hardening, it is moved to `tool_name IN (<names for open_interaction>)` via the helper, so a future rename cannot silently stop matching (test in §6).

### §4.7 External `/mcp` clients and the alias question: no alias, refuse with a hint

**Recommendation.** Retired names are **not** accepted on any call path.

- A call to a retired name gets the same `unknown_tool` refusal as any unknown name, with the same audit decision (`invalid_args`, written as a noise row) and nothing executed.
- The message adds `renamed to "<new>" in 0.10.0`.
- **On `/mcp` the pre-scan cannot carry a hint by itself** (AR-P8). `auditRefusedCalls` (`http-server.ts:208-240`) runs after the SDK has already answered, and it only writes audit rows. Revision 1's "the hint is added where it pre-scans" therefore changes nothing the client sees. The binding rule:
  - Once the bearer has resolved to a live token, and only if the POST body is a **single** (not batched) `tools/call` whose `params.name` is a key of `RETIRED_TOOL_NAMES`, the handler answers that request itself, without dispatching to the SDK. The answer is a JSON-RPC result `{ isError: true, content: [{ type: 'text', text: 'unknown_tool: "<old>" was renamed to "<new>" in 0.10.0' }] }` with the request's `id`.
  - It is audited exactly as the SDK refusal is today: an `invalid_args`/`denied_grant` noise row with `UNKNOWN_TOOL_LABEL`.
  - Batched bodies and unauthenticated requests get the SDK's default error and no hint.
  - The retired name is **never** registered on the `McpServer`, not even disabled or as a tombstone.
- Management APIs reject retired names the same way, with a 404 and the hint, and never store them:
  - `POST /api/mcp/grants` (`engine.ts:216`)
  - client-token create and tools update (`client-tokens.ts:107`)
  - `PUT /api/mcp/policies/:tool` (`policies.ts:89`)

**Why no alias.**
1. **Nobody outside dev can depend on 18 of the 26 names**, because they never shipped.
2. **The 7 shipped names cannot work across the upgrade anyway.**
   - 0.10.0 replaces the 0.9.x `/mcp` bearer model with prefixed client tokens. Every 0.9.x client must mint a token in Settings and reconfigure.
   - 0.10.0 also changed every one of those tools' schemas, so 0.9.x grants already fail with `schema_changed`.
   - The rename rides on a reconfiguration that is already mandatory, and the 0.10.0 release notes say so in the same paragraph.
3. **An alias is a second name for an authority-bearing object.** Even as a pure ingress rewrite, every site that keys on the name has to agree on canonicalization: grants, policies, rate-limit buckets, audit rows, `created_via`, `proposalAnswer`, `rejectPendingForTool` and `operation-view`. Each site that is missed becomes either a bypass, such as a doubled rate-limit budget or an unmatched Off policy, or a mis-attribution, such as declarative proposals counted as blind.
4. **Five retired names are live chat names.** A general resolver is exactly what AR-2 warns against.

**If Jd wants an alias anyway (decision D2), these constraints are binding.**
- Shipped names only (7).
- Ingress only: the first line of `callTool`, plus a rewrite of `params.name` in the `/mcp` pre-scan, before the SDK dispatches.
- After that point, everything uses `def.name`.
- Never listed in `tools/list` and never registered in a tab.
- Never accepted by the management APIs.
- Removed in 0.11.0.
- Tests I6a to I6c (§6) are required.

### §4.8 In-page tabs

- The bridge registers only current catalog names (`webmcp-bridge-core.ts` is catalog-driven, and declarative `toolname` comes from `declarative-submit-core.ts:746`).
- A tab still running a pre-upgrade bundle gets `unknown_tool` plus the hint until it reloads. Its grants were renamed, so a reload works at once.
- `open_review_item`'s digest changes (§2 row 20). Its tab grants minted before the upgrade return `schema_changed` until the bridge re-requests them on reload. That is fail-closed and tab-only.

### §4.9 The mirror and router boundary

- New `HANDOFF_TO_CATALOG: Readonly<Record<HandoffReadToolName, string>>` in `src/dashboard/local-handoff-format.ts`:
  - `transaction_search` maps to `search_transactions`.
  - `spending_summary` maps to `get_spending_summary`.
  - `profit_loss` maps to `get_profit_loss`.
  - `net_worth` maps to `get_net_worth`.
  - `forecast` maps to `get_cash_forecast`.
- `local-handoff.ts:103` (`parseReadArgs`) and `:369` (`executeRead`) look the catalog up through this map and **never** through `RETIRED_TOOL_NAMES`. This map is permanent and is not an alias.
- The handoff keeps rendering mirror names to the chat agent. Four of the five equal chat names, which is correct for that audience.
- `read-tool-schema-snapshot.test.ts` and `openjev-route-options-snapshot.test.ts` resolve catalog defs through the map.
- `READ_TOOL_SCHEMAS`, `OPEN_JEV_ROUTE_OPTIONS`, `READ_TOOL_NAMES`, the router's measured descriptions and `specs/eval/*` are unchanged byte for byte.

### §4.10 Downgrade

- A downgrade to v0.9.x never reads policies, tokens or the audit log, because those tables did not exist yet.
- A downgrade to an earlier 0.10 dev build, or another worktree's build on the same `HOME`, sees new-name grants and ops plus mirrored old-name policies:
  - Grants fail closed: they are not listed, and calls get `scope_mismatch`.
  - Ops go `stale` (`policy_off`, because the old build does not know the new name).
  - Policies stay in force through the old-name mirror rows (§4.3).
- **Revision 1 accepted policy fail-open here "because it only affects dev builds". The review rejected that** (AR-P1). Jd runs several worktrees of unreleased 0.10 builds against one real `~/.openaccountant`, and they are open at the same time (for example `auth-switch-hygiene` and `openjev-latency-harness`). An Off that vanishes in one of them is a real exposure. Dual-write plus mirror rows close it. The re-tightening objection is resolved by `setPolicy` writing both rows (§4.3).

---

## §5 Code changes (no code in this spec; this is the work list)

| File | Change |
|---|---|
| `src/mcp/tool-names.ts` (new) | `RETIRED_TOOL_NAMES`, `retiredNamesFor`, `currentNameFor`, `isRetiredToolName`. Pure. |
| `src/mcp/tool-rename.ts` (new) | `applyToolRenames(db)` (§4.3). |
| `src/db/database.ts:53` | Call `applyToolRenames(db)` after `runMigrations(db)`, inside try/catch. **This lands in S3, in the same commit as the catalog rename** (AR-P2). `migrations.ts` and `schema.ts` are **not** touched. |
| `src/mcp/tool-catalog.ts` | <ul><li>Rename the 15 `name` fields.</li><li>`executeReadSync` switches on `def.name` and the new names (`:1016`).</li><li>The `prepareMutation` and commit `if` chains (`:1364-1455`, `:1593-1665`, `tax_flag` branch `:1419-1423`) use `def.name` and the new names.</li><li>Update every top-level `description` and `example` that names a renamed tool (for example `:196`, `:214`, `:258-261`, `:316-318`, `:352-353`, `:397`, `:598-600`).</li><li>Change the proposal example rationale to stop naming `transaction_search`.</li><li>Update only `open_review_item`'s `.describe()` (`:609`).</li><li>No other zod change.</li><li>**Missed in revision 1 (AR-P3b):** `readEstimate` (`:973`) keys the daily read-budget reservation on `def.name === 'net_worth'`. If it is not renamed, `get_net_worth` `balance_sheet` silently falls through to `limitOf(args)` (10 rows instead of 15), and the budget under-reserves. The fix: key it on `def.name === 'get_net_worth'`, and pin it with I14.</li><li>**Also missed:** agent-facing error strings that name retired tools, which the agent would then call and get `unknown_tool`: `:571` (`use transaction_search`), `:615` (`call list_review_queue`), `:955` (`Call navigate_to_tab`), `:1423` (`tax_flag action … use tax_summary`). I13 now catches all of these.</li></ul> |
| `src/mcp/engine.ts` | <ul><li>After `def` resolves (`:396`), use `def.name` everywhere downstream: `parseToolArgs`, `validateGrant`, `schemaDigest`, `prepareProposal` and audit.</li><li>`proposalCreatedVia` (`:761`) and `proposalAnswer` (`:775`), and all four call sites (`callTool` `:562,569`; `commitProposalOperation` `:1102,1113`), take the def and test `classification === 'proposal' && exposure === 'declarative'`. They never compare a name literal (N8b, AR-P7).</li><li>Unknown-name message hint (`:449`) and grant-request hint (`:216-218`).</li><li>`ownerStillAllowed` (`:897`) is unchanged: an unknown chat name already defaults to `admin`.</li></ul> |
| `src/mcp/policies.ts` | <ul><li>Read fallback in `storedRow` (§4.3).</li><li>`setPolicy` stores `def.name`, not the raw `tool` (`:102-104`). It also dual-writes the retired mirror rows in one transaction (§4.3).</li><li>`rejectPendingForTool` matches retired names too, with `source != 'chat'` kept.</li><li>404 hint for retired names.</li></ul> |
| `src/mcp/http-server.ts` | A single-message `tools/call` short-circuit with the hint, only after the bearer resolves (§4.7, AR-P8). The audit stays as it is. No alias, and no registration of a retired name. |
| `src/mcp/client-tokens.ts` | 404 hint for retired names in tool lists (`:107`). |
| `src/mcp/audit.ts` | `listAudit` filter expansion (`:326`) and `toolCurrent` on entries, both under the `<catalog-row>` predicate (§4.6, AR-P4). |
| `src/mcp/confirmation-card.ts` | <ul><li>`TOOL_LABELS` keyed by new names (§2.1).</li><li>New `CHAT_TOOL_LABELS`.</li><li>`labelFor(source, name)` replaces `TOOL_LABELS[op.tool_name]` (`:166`).</li></ul> |
| `src/mcp/operation-view.ts:111` | Compare against `search_transactions` via `catalogNameOf(op)`, which returns null for chat and canonical otherwise. |
| `src/mcp/rate-limit.ts:34` | Comment only. |
| `src/training/annotations.ts:544` | Use the helper-built `IN` list (hardening; the name is unchanged). |
| `src/dashboard/local-handoff-format.ts`, `local-handoff.ts:103,369` | Add `HANDOFF_TO_CATALOG` and use it at both call sites (§4.9). |
| `src/dashboard/declarative-submit-core.ts:24-29,41,45` | Rename the `DECLARATIVE_FORMS` keys: `list_transactions`, `resolve_review_item`, `propose_judgment` and `fill_forecast_inputs`. `set_budget` and `update_goal` are unchanged. |
| `src/dashboard/webmcp-page-tools-core.ts:2,3,18,31,55` | `open_tab`. `:133` and `:193` are unchanged. |
| `src/dashboard/webmcp-page-registry.ts:96`, `webmcp-session.ts:74` | `open_tab`. `webmcp-session.ts:70` is the `forecast` **tab id**, so leave it. |
| `src/dashboard/judge-ui-core.ts:6,19` | `propose_judgment`. |
| `src/dashboard/ui/src/agent/WebMcpProvider.tsx:11,54` | `open_tab`. `get_page_context` lines are unchanged. |
| `ui/src/tabs/TransactionsTab.tsx:280,289` | `list_transactions`. |
| `ui/src/tabs/ReviewTab.tsx:177,232,383` | `resolve_review_item` and `list_review_items`. |
| `ui/src/tabs/ForecastTab.tsx:61,154`, `ManualInputsForm.tsx:98,130,134`, `lib/forecastAgentAwait.ts:2` | `fill_forecast_inputs`. |
| `ui/src/components/judge/JudgeInteractionForm.tsx:6,19` | `propose_judgment`. |
| `ui/src/components/agent/AuditLogViewer.tsx` | Show `toolCurrent` when present. |
| `ui/vite.config.ts:93` | Comment only. |
| Untouched on purpose | <ul><li>`src/tools/**`, `src/agent/**`, `ui/src/hybrid/**` (including `read-tool-schemas.ts` and `openjev-route.ts`), `ui/src/store/mirror-*.ts`, `subagent-*.ts`.</li><li>`training/export.ts`, `judge-reads.ts` (its `transaction_search` mention at `:12` refers to chat).</li><li>`server.ts:942` (a chat `tax_flag` comment), `agent-access-model.ts:101` (names unchanged), `ClientTokensPanel.tsx:146-147` (`get_operation_result` unchanged), `demo/auto-book.ts` (`categorize_transaction` unchanged).</li></ul> |

---

## §6 Security invariants and the tests that pin them

**Baseline fixture.** Slice S1 first generates `src/__tests__/fixtures/webmcp-tool-baseline.json` from the **pre-rename** catalog at `93b7484`. For each of the 26 names it records `classification`, `minRole`, `transports`, `surface`, `exposure`, `uiEffect`, `autosubmit`, `defaultPolicy`, `untrustedOutput`, `allowedPolicies(def)` and `schemaDigest(name)`. The fixture is committed and never regenerated by this change.

| # | Invariant | Test (file: case) |
|---|---|---|
| N | The name grammar in §1 holds for every catalog name. | `webmcp-tool-naming.test.ts`: <ul><li>"N1 shape"</li><li>"N2 ≤ 32"</li><li>"N3 no stop words"</li><li>"N4 verb ∈ VERBS[classification] and verb implies classification"</li><li>"N5–N7 plurality"</li><li>"N8 twins share class, minRole, defaultPolicy"</li><li>"N9 no British spellings"</li><li>"N10 no chat-name equality and no chain_/team_/mcp_/skill prefix" (chat names from `mutation-audit.ts`)</li><li>"N11 retired map injective, values current, same class, keys never current"</li></ul> |
| I1 | **The rename changes nothing but names.** For each `(old, new)` and each unchanged name, `def(new)` equals `baseline[old]` on every recorded attribute. `schemaDigest` is identical for all 26, except `open_review_item`. Any digest change must be on a `TAB_ONLY` tool, and the expected set of changed digests is listed explicitly. | `webmcp-tool-naming.test.ts`: "baseline equivalence", "digest unchanged for every http-mcp tool" |
| I1b | No catalog string contains a retired name used as a tool reference. "Catalog string" means `description`, every `.describe()`, `example`, and every `NotFoundError`, `PrepareError` and page-error message built in `tool-catalog.ts`. **Matching is exact and testable** (AR-P9): <ul><li>For the 14 retired names that contain `_`, the regex `(?<![A-Za-z0-9_])NAME(?![A-Za-z0-9_])` is case-sensitive and must not match anywhere.</li><li>`forecast` has no underscore and is an English word and a tab id (`open_tab`'s enum, "net-worth forecast", "Forecast tab"). For it, only the reference forms fail: `` `forecast` ``, `use forecast`, `call forecast` and `forecast tool`.</li></ul> | `webmcp-tool-naming.test.ts`: "no retired name in catalog prose" |
| I2 | **Policy equivalence; never default-allow.** For every pair, every `user_key` (including 0), every OLD value in `{off, ask, allow}` and every NEW state in `{absent, off, ask, allow}`: after the fix-up, `getConfiguredPolicy(new)` equals `clamp(minRank(old, new?))`, and the OLD row holds the same value (mirror). With OLD = `off` and the fix-up **not** run, the effective policy is still `off`, through the read fallback. `setPolicy(NEW, 'allow')` over a stale OLD `off` row leaves effective `allow`, because the dual-write updates the mirror. `setPolicy(NEW, 'off')` leaves OLD `off`, so an old-name build reading the same DB enforces it. | `tool-rename.test.ts`: "policy merge matrix", "mirror row kept and equal", "read fallback without fix-up", "user_key 0 row carried", "own row still beats user 0 row"; `mcp-policies.test.ts`: "set loosens past stale old row", "set off reaches old-name row", "set off rejects old-name pending op" |
| I3 | **No widening of grants.** A token holding OLD grants ends with exactly the mapped set: same digest, scope and `expires_at`. Dead grants are untouched. If the same owner `(session_generation, user_id, profile, origin)` already had a live NEW grant, the OLD grant is revoked, never duplicated. A grant held by a **different** owner with the same `session_generation` is never revoked. A pending op bound to a revoked OLD grant commits as `stale`/`grant_invalid:revoked` and is never re-pointed. `tools/list` for the token equals the mapped pre-upgrade list. | `tool-rename.test.ts`: "live grants renamed", "dead grants untouched", "existing NEW grant wins, OLD revoked", "collision scoped to full owner", "op on revoked OLD grant goes stale"; `mcp-client-tokens.test.ts`: "tools/list after rename" |
| I4 | **Chat isolation.** A pending `source='chat'` op named `tax_flag` or `edit_transaction` is untouched and still binds to its runner request (`chat.ts:225,316`). Chat card titles are unchanged ("Tax Flag", "Edit Transaction"). `llm_tool_results` and `llm_interactions` have the same row count and content hash before and after. The retired-name helpers are never called with a chat source. | `tool-rename.test.ts`: "chat ops untouched", "llm tables untouched"; `mcp-confirmation-card.test.ts`: "chat labels unchanged", "catalog labels by new name", "history row with retired name gets new label" |
| I5 | **Audit is verbatim.** The `mcp_audit_log` row count and a content hash are unchanged by the fix-up. New rows carry canonical names. `listAudit({tool: NEW})` returns the OLD and NEW catalog rows, including `rest` lifecycle rows whose op is `webmcp`/`http-mcp`. It does **not** return a `rest` expiry row for a chat op named `tax_flag` or `edit_transaction`, a REST route row, or a `rest` row whose op was purged. `toolCurrent` follows the same predicate. A noise upsert under NEW next to an OLD row in the same bucket does not throw. | `tool-rename.test.ts`: "audit untouched"; `mcp-audit-log.test.ts`: "filter expands to retired catalog rows", "chat expiry row not mapped", "purged-op rest row not mapped", "route rows not mapped", "toolCurrent" |
| I6 | **A retired name grants nothing.** On `/api/mcp/call` and on `/mcp` `tools/call`: 404 or tool error `unknown_tool` with the hint, audited as today, and no handler runs. `tools/list` never contains a retired name, and the bridge never registers one. `POST /api/mcp/grants`, client-token create and update, and `PUT /api/mcp/policies/:tool` reject retired names, and no row with a retired name is ever written after the fix-up. | `mcp-bridge-server.test.ts`, `mcp-http-wait.test.ts`: "retired name refused with hint"; `webmcp-bridge-core.test.ts`: "no retired name registered"; `mcp-policies.test.ts`, `mcp-client-tokens.test.ts`: "retired name 404" |
| I6a–c | Only if D2 picks an alias: <ul><li>(a) The alias resolves to exactly the same grant, policy and rate-limit bucket as the new name. Alternating OLD and NEW calls share one budget.</li><li>(b) No alias for the 8 unshipped names.</li><li>(c) Removed at 0.11.0: a version-gated test fails once `package.json` reaches 0.11.0.</li></ul> | `mcp-alias.test.ts` |
| I6d | **The `/mcp` hint path grants nothing.** A single `tools/call` for a retired name with a live token gets `isError` and the hint, runs no handler and writes the same noise row as before. A batched body gets the SDK error. With no token the response is the 401 and carries no hint. `tools/list` is unchanged by the short-circuit. | `mcp-http-wait.test.ts` or `mcp-bridge-server.test.ts`: "retired name hint single call", "batch gets sdk error", "no hint without token" |
| I7 | **Canonical after ingress.** Operation rows, audit rows, rate-limit keys, `created_via` and `proposalAnswer` all use the def, not the raw request name. `created_via` and `proposalAnswer` come from `classification` and `exposure` (N8b): `propose_judgment` gives `'declarative'` and the `{created, id}` answer, and `propose_judgments` gives the transport and the `{created, ids, skipped}` answer, on both the direct path and the Ask path (`commitProposalOperation`). A pre-upgrade pending `judge_interaction` op, after the fix-up, commits with `created_via = 'declarative'` and is excluded from the blind-agreement metric. `setPolicy` stores `def.name`. | `tool-rename.test.ts`: "pending proposal keeps declarative provenance"; `mcp-policies.test.ts`: "stores def.name"; `judge-tools.test.ts`: "created_via from exposure, both twins, both paths" |
| I8 | **Idempotent, always on.** A second `applyToolRenames` changes 0 rows and logs nothing. `initDatabase` runs it for every DB, including `:memory:` and a DB without `mcp_*` tables. | `tool-rename.test.ts`: "idempotent", "missing tables skipped", "runs from initDatabase" |
| I9 | **A failed fix-up is not fail-open.** With a failure injected mid-transaction, every table is unchanged. OLD policies stay effective through the fallback. OLD grants give `scope_mismatch` and are not listed. OLD pending mutating and read ops commit as `stale`/`policy_off`. An OLD pending proposal op commits as `stale`/`policy_off`, because the policy check runs before `commitProposalOperation`. A `SQLITE_BUSY` on `BEGIN IMMEDIATE` takes the same path. | `tool-rename.test.ts`: "failure rolls back and stays closed", "busy lock skips and stays closed" |
| I10 | **No migration.** `MIGRATIONS` is unchanged (the top version is still 33), and `schema.ts` and `migrations.ts` have no diff. | `migrations.test.ts`: "top version is 33" (new case) |
| I11 | **Mirror boundary.** `HANDOFF_TO_CATALOG` covers `READ_TOOL_NAMES` exactly, and every value is a `read` catalog tool. `READ_TOOL_SCHEMAS[m]` deep-equals `jsonSchemaFor(HANDOFF_TO_CATALOG[m])`. The open-jev options are unchanged. A handoff step `transaction_search` executes `search_transactions`. | `read-tool-schema-snapshot.test.ts`, `openjev-route-options-snapshot.test.ts`, `local-handoff.test.ts` |
| I12 | **Parity tests still bind UI to catalog.** Page handlers, declarative forms and tab ids match the catalog names. The declarative parity check is exact: the keys of `DECLARATIVE_FORMS` equal the set of catalog names with `exposure: 'declarative'`, with the same classification and autosubmit. The keys of `ALLOWED_READONLY_INPUTS` and `ALLOWED_HIDDEN_INPUTS` are a subset of those names. Every `useDeclarativeTool({ tool: '…' })` literal in `ui/src` is a key. A missing key matters because `activatesTool` (`declarative-submit-core.ts:335-345`) decides whether to show the agent-filled banner from `DECLARATIVE_FORMS[name]?.classification === 'mutating'`. | Existing `page-tool-handlers-parity`, `tab-ids-parity`, `mcp-declarative` and `use-declarative-tool` tests, updated to the new names and extended as stated |
| I13 | **No retired name left in runtime code outside the allowed places** (AR-P3). A source scan of `src/**/*.ts(x)` (tests excluded) and `src/dashboard/ui/src/**` looks for any of the 14 underscore retired names as a quoted string or a backticked identifier, and fails on a hit. `forecast` is not scanned: it is a tab id and a mirror name. Allowed: <ul><li>`src/mcp/tool-names.ts`</li><li>`src/dashboard/local-handoff*.ts`</li><li>`src/dashboard/ui/src/hybrid/**` and `ui/src/store/mirror-*.ts`</li><li>`src/tools/**`, `src/agent/**`, `src/cli.ts`, `src/skills/**`</li><li>`src/mcp/judge-reads.ts`</li><li>`src/mcp/confirmation-card.ts` (`CHAT_TOOL_LABELS` only)</li></ul> This is what would have caught `readEstimate` `:973` and the four error strings. | `webmcp-tool-naming.test.ts`: "no retired literal in runtime code" |
| I14 | **The read budget is unchanged by the rename.** For every read tool and a fixed argument set (including `get_net_worth` with `action: 'balance_sheet'`), `readEstimate(def(new), args)` equals the value recorded in the baseline fixture for the old name. | `webmcp-tool-naming.test.ts`: "readEstimate baseline equivalence" (add `readEstimate` samples to the S1 fixture) |

Mechanical test updates: about 40 test files assert the old literals (the inventory lists them, for example `mcp-bridge-server` with about 60 lines). Update them with an exact-word rewrite limited to the 15 pairs. **Never** rewrite in chat-tool tests (`tool-mutation`, `tool-registry`, `mutation-audit`, `tool-selection*`, `local-date-args`, `hybrid-*`, `mirror-*`, `subagent-*`). Review each hit by hand where a retired name is also a chat name.

---

## §7 Docs, demos, specs and scripts touched

| File | Action |
|---|---|
| `specs/webmcp-tool-naming.md` | This spec (new). |
| `CHANGELOG.md` | <ul><li>**Unreleased:** rewrite the names in the unreleased WebMCP entries (P1 to P4a, lines 5-75), because they describe 0.10.0 features under their shipping names.</li><li>Add a **Breaking** entry: the 7 shipped names, their new names, "mint a client token and update tool names", and no alias.</li><li>Leave the v0.9.x sections untouched.</li></ul> |
| `demos/scripts/webmcp-agent.mjs:95,109` | `get_spending_summary` and `search_transactions`. `:134` `categorize_transaction` is unchanged. |
| `demos/scripts/record-webmcp-agent.mjs:39` | `GRANT` list updated the same way. |
| `demos/README.md:116,141` | Names. |
| `scripts/webmcp-live-seed.ts:102,148-171` | Names in prints and calls. The `:183` injection fixture is unchanged (`categorize_transaction`). |
| `scripts/demo-enable-auth.ts:7` | No change. |
| `scripts/webmcp-live-check.md` (1,545 lines) | <ul><li>Add the §2 rename table at the top.</li><li>Rewrite the runbook steps to the new names.</li><li>Leave dated findings and session logs verbatim, as records.</li></ul> |
| `specs/webmcp-consequential-reauth.md` | It is unimplemented, so update §2.1's RC table and the test names to the new catalog names. Add to AR-2: the exact-string collision is gone for live names, but `(surface, name)` keys are still required because retired names equal chat names in old rows. |
| `specs/webmcp-judge-full-results.md`, `specs/webmcp-p4b-dpo-pairs.md` | Unimplemented: update the catalog names. In P4b, keep chat names wherever they refer to tool calls inside recorded traces. |
| `specs/webmcp-threat-model.md` | A living reference for T-numbers: update the catalog names in place (for example `:172,187,234,262`). Keep chat-name mentions (`:169`, an `mcp-args` test name, becomes `update_transaction`; check each one). |
| `specs/webmcp-security-judge.md`, `specs/issue-94_auto-book-confirmation-gate.md` | Implemented design records: add a one-line header note pointing to this spec's §2. Do not rewrite the body. |
| `specs/browser-subagent*.md`, `specs/open-jev-labeler.md`, `specs/issue-42/63/66/76/79/80/81/86*.md` | No change. They use mirror or chat vocabulary or the Forecast tab, all unchanged. |
| `specs/eval/**` | **No change** (frozen). |
| `specs/DECISIONS.md` | After Jd decides D1 to D7, add a "WebMCP tool naming (2026-10-xx)" table. |
| `README.md`, `app/docs/**` (monorepo) | No mentions, so no change. |

---

## §8 Slices

Order matters: **S2 must land before or together with S3, and the `initDatabase` hook must land in S3 itself.** A catalog rename without the fix-up would orphan dev policy rows, and those orphans fail open. A fix-up wired before the rename fails open the other way (AR-P2). **S3 and S4 must land in one PR**, because the parity tests bind the UI registration to the catalog.

| Slice | Scope | Tests first | Size |
|---|---|---|---|
| S1 | Baseline fixture, `tool-names.ts`, and `webmcp-tool-naming.test.ts`. The naming cases are expected to fail until S3. Commit them with S3, or mark them `test.todo` in S1. | N, N11 | S |
| S2 | `tool-rename.ts` (called directly by its tests, **not** wired into `initDatabase`), the policy read fallback, `setPolicy` dual-write, the `rejectPendingForTool` expansion, audit filter expansion with `toolCurrent` under the catalog-row predicate, and the `annotations.ts` helper. Tested with synthetic old-name rows. The catalog is not touched yet. | I2, I3 (store level), I4 (tables), I5, I9, I10 | M |
| S3 | Server: catalog rename and prose (including the error strings and `readEstimate`), **the `initDatabase` hook (AR-P2)**, engine canonicalization, `created_via` from `exposure`, hints, `policies.ts` `def.name`, the `/mcp` single-call hint, management hints, confirmation-card label split, `operation-view`, the `HANDOFF_TO_CATALOG` boundary, snapshot tests, and mechanical test updates. | I1, I1b, I4 (labels), I6, I6d, I7, I8, I11, I13, I14 | L |
| S4 | UI: provider, page tools, page registry, session, declarative forms, tabs, the judge form, `AuditLogViewer`, then a bundle rebuild. | I12, `webmcp-bridge-bundle` | M |
| S5 | Docs, demos, scripts, specs and CHANGELOG (§7). | Run the demo scripts against a live seed. | S |
| S6 | Verification (§9). | none | S |

---

## §9 Verification

1. **Gates.** Typecheck, the CI per-file test loop, and the UI build.
2. **Upgrade rehearsal in a throwaway `HOME`.** Never the real `~/.openaccountant`. Never the macOS `security` CLI.
   - Build `93b7484` (detached, in a scratch worktree). Seed with `scripts/webmcp-live-seed.ts`.
   - Turn auth on for the demo profile (`scripts/demo-enable-auth.ts`).
   - Set these policies: `spending_summary` Off, `transaction_search` Ask, `tax_flag` Ask.
   - Mint a client token with `transaction_search`, `tax_flag` and `list_review_queue`.
   - Leave one pending `edit_transaction` op from `/mcp`, and one pending chat `tax_flag` card.
   - Stop that build and start this branch on the same `HOME`. Check:
     - The log line shows the counts.
     - Settings shows `get_spending_summary` Off and `search_transactions` Ask.
     - The token's `tools/list` shows the three new names.
     - The pending op approves and commits.
     - The chat card is still "Tax Flag" and still answers its run.
     - The audit rows from before the upgrade are unchanged and filterable under the new names.
     - Calling `transaction_search` on `/mcp` returns `unknown_tool` with the hint.
   - Restart once more and confirm no log line (idempotent).
3. **Live Chrome WebMCP check** with the `scripts/webmcp-live-check.md` runbook, as updated: every registered tool name passes N, and the declarative forms submit under their new `toolname`.
4. **Adversarial review.** Run one review pass focused on I2, I4, I6 and I7, the places where a missed canonicalization would widen or mis-attribute.

---

## §10 Decisions for Jd (each with a recommendation)

- **D1. Approve the map in §2.** The calls most open to taste:
  - `open_tab` instead of `navigate_to_tab`.
  - `list_transactions` instead of `filter_transactions`.
  - The `fill_` verb for `set_forecast_inputs`.
  - `get_cash_forecast` instead of `get_forecast`.
  - `propose_judgment` for the declarative form.
  - Recommend: approve as written.
- **D2. Alias period for the 7 shipped names.** Recommend **none**: refuse with a "renamed to" hint (§4.7). If you want one, it is ingress-only, for shipped names only, and removed in 0.11.0, with tests I6a to I6c.
- **D3. Rename chat tools.** Recommend **no**. Cost is in §3.3, about 2 to 3 days plus an eval re-run.
- **D4. Align the mirror and router vocabulary with the catalog.** Recommend deferring this to the next deliberate open-jev re-measurement. Until then, `HANDOFF_TO_CATALOG` is the only bridge.
- **D5. Internal "judgement" spellings** (`/api/judgements`, file and component names, UI copy). Recommend a separate mechanical PR after 0.10.0. Agents never see these. Only tool names and descriptions change here.
- **D6. Lifetime of the fix-up and the read fallback.** Recommend keeping both through 0.11.x and removing the fix-up in 0.12.0. Keep `RETIRED_TOOL_NAMES` permanently: it powers N11 (no reuse), the audit display and the hint.
- **D7. Issues surfaced but out of scope** (file separately):
  - The `get_spending_summary` `compareWithPrevious` default differs from chat (`spending-summary.ts:236` vs `computeSpendingSummary:185`).
  - The `update_transaction` commit may not re-embed a changed description (seen in a read of the code, not confirmed).
  - `list_transactions` changes the visible tab filter but is advertised `readOnlyHint: true` (no `uiEffect`).
  - The `cash-flow-forecast` SKILL.md names `forecast`, which is not a chat tool.

---

## Adversarial review (plan)

Reviewed 2026-10-04 against `93b7484` before any implementation. The question was whether any rename, alias, fix-up or naming rule can widen access, mis-attribute work, or leave a name lookup that silently falls back to a default.

Each finding was checked by reading the code at the cited lines. "Amended" means the fix is already written into the sections above.

### Findings and dispositions

| # | Sev | Finding | Disposition |
|---|---|---|---|
| AR-P1 | **High** | **Policy fail-open across worktrees.** Revision 1's fix-up deleted old-name policy rows, and §4.10 accepted fail-open "only on dev builds". But Jd runs several unreleased 0.10 worktrees against one real `~/.openaccountant`, at the same time. Once this branch starts, another worktree's build finds no `spending_summary` row, and an Off read tool reverts to `allow`. | **Amended** (§0, §4.2, §4.3, §4.10, I2). The old-name rows are kept as mirrors set to the merged value. `setPolicy` dual-writes NEW and the retired names. The objection that a startup merge would re-tighten a loosened policy no longer holds, because the rows stay equal. |
| AR-P2 | **High** | **Slice order can fail open.** §8 allowed S2 (fix-up plus hook) to land before S3 (catalog rename). A build at S2 moves `spending_summary`'s Off row to `get_spending_summary`, which that build's catalog does not know. `retiredNamesFor('spending_summary')` is empty, so the tool falls back to its default `allow`. | **Amended** (§4.3, §5, §8). The `initDatabase` hook ships only in S3, together with the rename. S2's tests call `applyToolRenames` directly. |
| AR-P3 | **High** | **Policy lock-in from the fallback.** Most-restrictive across NEW and OLD means that a leftover OLD `off` row (from a failed fix-up or an old-name build) wins over any later Allow under NEW. Settings shows Off and the user cannot change it. | **Amended** (§4.3 dual-write, I2 "set loosens past stale old row"). `rejectPendingForTool` also matches retired names now, keeping the existing `source != 'chat'` filter. |
| AR-P3b | **Medium** | **A name-keyed lookup the work list missed.** `readEstimate` (`tool-catalog.ts:973`) reserves the daily read budget with `def.name === 'net_worth'`. Renamed without that line, `get_net_worth` `balance_sheet` falls through to 10 rows instead of 15, and the budget under-reserves. Four agent-facing error strings (`:571,615,955,1423`) also named retired tools, which would send agents into `unknown_tool`. | **Amended** (§5, new I13 source scan, new I14 `readEstimate` baseline). I13 is the general guard: a retired literal anywhere outside the allowed chat, mirror and handoff files fails CI. |
| AR-P4 | **Medium** | **Audit mis-attribution.** Revision 1 mapped every non-`rest` row and assumed `rest` rows were route labels. In fact `rest` rows include lifecycle rows that carry catalog names. The expiry sweep (`store.ts:564-589`, no source filter) also writes **chat** `tax_flag` and `edit_transaction` rows. A bare `IN (NEW, ...OLD)` would list chat expiries under "Set Tax Flag". | **Amended** (§4.2 note, §4.6 `<catalog-row>` predicate, I5). Transport-based for client and `/mcp` rows. For `rest` rows, a join to the op's source. A purged op stays unmapped. |
| AR-P5 | **Medium** | **Grant collision keyed on `session_generation` alone.** A tab picks its own session id (`store.ts:285-289`), so two owners can share one. Revoking by session id alone could revoke another owner's grant. That narrows rather than widens, but it is still wrong, and the live-grant test ignored the mixed `expires_at` formats. | **Amended** (§4.2, §4.3, I3). The full owner tuple is used, with `julianday` comparison. A pending op bound to a revoked OLD grant goes stale and is never re-pointed. |
| AR-P6 | Low | **An approved but unfetched read-ask loses its data.** A terminal `committed` read row with `outcome_json` keeps its old name, its grant is renamed, and `readDeliveryRefusal` returns `scope_mismatch`. | **Accepted and documented** (§4.2). It fails closed, the window is the 5-minute outcome TTL, and renaming terminal rows would widen the fix-up's write surface. |
| AR-P7 | Medium | **Twin names make literal comparisons fragile.** `created_via` and `proposalAnswer` branch on a name literal at four call sites. With `propose_judgment` next to `propose_judgments`, one typo silently moves every proposal in or out of the blind-agreement metric. | **Amended** (N8b, §5 engine, I7). Both are derived from `classification === 'proposal' && exposure === 'declarative'`, which the I1 baseline pins. |
| AR-P8 | Medium | **The `/mcp` hint was not implementable as written.** The pre-scan (`auditRefusedCalls`) runs after the SDK has answered and only writes audit rows. Making the hint visible needs a response path, and the obvious shortcut (registering a disabled tombstone tool) would register a retired name. | **Amended** (§4.7, §5, I6d). A single-message short-circuit runs only after the bearer resolves. A batch gets the SDK error, and nothing is ever registered. |
| AR-P9 | Medium | **Naming-rule tests were ambiguous or toothless.** <ul><li>N9 compared whole segments, so `propose_judgements` would pass, because `judgements` is not `judgement`.</li><li>N5/N6's trailing-`s` heuristic misreads `status`/`analysis`.</li><li>N4 "both directions" left `get_` on page tools to interpretation.</li><li>I1b's "retired name as a word" cannot pass, because `forecast` is an English word and a tab id in `open_tab`'s and `fill_forecast_inputs`' prose.</li></ul> | **Amended** (N4 predicate table, `PLURALITY_EXCEPTIONS`, N9 stem match plus a self-test that the old name fails, I1b exact regex with a `forecast` carve-out). |
| AR-P10 | Low | **The failure-mode claim was wrong.** I9 said old-name pending ops go `stale`/`unknown_tool`. The commit path checks policy first (`engine.ts:1046`), and `getConfiguredPolicy` on an unknown name returns `off`, so they go `stale`/`policy_off`. Still fail-closed. | **Amended** (§4.3, I9). A busy-lock case was added. |

### Attack surfaces checked and found sound (no change)

- **Old-name `allow` policy vs new-name default.** The merge is most-restrictive. Classification and transports are pinned identical (I1), so `allowedPolicies` and clamping are the same. With AR-P1 and AR-P3 there is no path to a default.
- **A client token's stored tool list gaining or losing a tool.** A token's tools are `mcp_grants` rows and nothing else (`mcp_client_tokens` has no tool column, `schema.ts:608-620`). The map is injective, the rename is 1:1, a collision revokes and never adds, and the digests are unchanged for every `BOTH` tool.
- **A pending op approved under a different name.** The approval token is keyed by op id (`store.ts:682-710`). The card was rendered from the same args and digest. The commit re-checks policy and grant under the renamed name, and `revision_at_prepare` is unchanged.
- **Rate-limit buckets reset by a rename.** The per-tool key is `pt:<principal>:<def.name>` (`engine.ts:577,608,619`). With no alias, only one name reaches a bucket. Process restart at upgrade already resets the in-memory limiter. The `judge:` and per-user buckets are not keyed by name.
- **Classifier lookups falling through to a default.** All `getToolDef(op.tool_name)` defaults point the safe way: `ownerStillAllowed` falls back to `admin`; expiry and lifecycle classification fall back to `mutating`; `getConfiguredPolicy` on an unknown name returns `off`; `toolAnnotations` on an unknown name is never served. The one unsafe fall-through was `readEstimate` (AR-P3b). Chat cards found their label in the catalog only because the names collided, and `CHAT_TOOL_LABELS` keeps that behavior.
- **Judge-only or proposal tools changing class.** I1 compares every recorded attribute of `def(new)` with `baseline[old]` through the map. A wrong pairing, even between two `read`/`BOTH`/`allow` tools, fails on the digest.
- **Declarative `toolname` vs the catalog.** `toolname` comes from the server's exposed-tools info (`declarative-submit-core.ts:744-746`), not from the form. A stale bundle gets `toolInfo(old) === undefined`, so the form is not live, which fails closed. `activatesTool` marks every mutating form when it sees an unrecognized name (`:335-345`). I12 is now exact.
- **CLI and chat collision.** No new name equals a chat `ToolDef.name` (checked against every `name:` in `src/tools/**`). External MCP tools in chat are `mcp_<server>_<tool>` (`adapter.ts:130`), which N10's prefix rule covers. `forecast` exists as a chat-side function (`src/tools/query/forecast.ts`) but not as a registered chat tool, and it is retired here anyway (N11).
- **Audit-log integrity.** Rows are never rewritten, and there is no hash chain to break. New rows use the canonical name, and the noise unique index keys on `tool_name`, so OLD and NEW never collide.

### Residual risks (accepted)

- **Hourly compaction** can split one hour into two summary rows, one per name, across the upgrade.
- **The mirror rows live until D6 removes them.** At that point the fix-up and the fallback are removed in the same change, and the mirror rows are deleted by an idempotent cleanup, which is still not a migration.
- **An old-name build can write a stricter OLD row after the fix-up.** This build then enforces the stricter value until the user sets the policy again. That fails safe.

---

## Implementation notes (2026-10-04)

Deviations and choices made while implementing, each small and deliberate:

- **`scripts/webmcp-live-seed.ts:148-171` is unchanged.** Those lines record fake CHAT traces (`llm_tool_results` rows named `spending_summary` and `transaction_search`, the dashboard chat agent's own tool names). They are not catalog calls, and §4.2 says the `llm_*` tables hold chat names. A comment now says so.
- **Hint wording.** The refusal text is `Unknown tool "<old>": renamed to "<new>" in 0.10.0` (grant, token and policy management answer 404 with the same tail; a name that was never a tool stays a 400). The `/mcp` single-call short-circuit answers `unknown_tool: "<old>" was renamed to "<new>" in 0.10.0`.
- **`prepareProposal` and the engine** take the batch-versus-single shape from `classification` and `exposure`, not from a name literal (N8b).
- **`specs/DECISIONS.md`** is not edited: D1 to D7 are still open.
- **Fix-up seam.** `applyToolRenames(db, { profile, onStep, quiet })` has an `onStep` test seam so the failure-injection case (I9) can throw between steps.
- **Test updates.** The mechanical rewrite was an exact-word rewrite limited to the 15 pairs, with property accesses (`grants.edit_transaction`) handled separately. Chat-trace fixtures in `judge-tools.test.ts`, and the mirror and router snapshot tests, keep the mirror and chat vocabulary and resolve catalog defs through `HANDOFF_TO_CATALOG`.
