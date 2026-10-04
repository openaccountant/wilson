# P4b: server-generated DPO pairs, a pair picker, and judge pair proposals

Status: design draft, **revision 2** (2026-10-04, amended by the adversarial review at the end of this file; amended text is marked **[AR-n]**). Branch `docs/webmcp-followup-specs` (off local `release/0.10.0` @ `e8d0d0a`). Nothing here is built.
Parent spec: `specs/webmcp-security-judge.md` (#160; P4a shipped on release, this is its deferred P4b, "§P4b" at `:1010-1018`). Threats `Txx`, assets `Ax`, actors `ACT-x` and invariants are the IDs in `specs/webmcp-threat-model.md`; new ones in this spec continue those sequences (A9+, T39+, invariant 10+).
Gate: **#160 Open Question 22** said "defer P4b until P4a has run for a while", and §U records "P4b deferred (out of scope)". Building this needs Jd's sign-off (Q1 below). The DPO-pair-picking issue topic Jd approved for the open-jev batch (memory note: "tax flags/dupes/CSV mapping/**DPO pair picking**", filed among #144-#150) is the ticket this spec answers; no GitHub call was made to read it.

Conventions (same as #160 unless stated):
- **Migrations**: appended to `MIGRATIONS` in `src/db/migrations.ts`, SQL as an exported const in `src/db/schema.ts`, ALTER-only on existing tables, one transaction per migration (`migrations.ts:119-123`), numbers contiguous (`migrations.test.ts` asserts version = `MIGRATIONS.length`). **v34 is reserved for open-jev B1-b** (`migrations.ts:91` comment; `specs/open-jev-labeler.md` §8.2). P4b needs **exactly one migration and takes v35**, which therefore cannot merge until v34 exists on the base (Q2).
- **TDD**: each slice's tests are listed in the order to write them. Make each fail first.
- **Tool limits**: name ≤30, description ≤500, each param `.describe()` ≤150, serialized output ≤1,500 (catalog test). New tool names are appended to `EXPECTED_TOOL_NAMES` in `mcp-tool-catalog.test.ts`.
- **Errors as results**: Chrome 154 replaces thrown handler errors with a generic `UnknownError`, so every refusal from a judge tool is a result `{error:{code,message}}` (#160 "Live findings", L4). REST status codes are unchanged.
- **No credential, prompt hash or human label leaves the server** through any agent path. That is the security bar of #160 (invariants 4-6) and it is restated per surface below.

---

## §A Recon (verified against this worktree)

| Fact | Where |
|---|---|
| DPO pairs today live **inside annotation rows**: a free-text `pair_id` plus `preference` on each side's current human row; `qualifyingDpoPairs` groups `qualifyingAnnotations` by `pair_id` and emits complete pairs | `src/training/annotations.ts:465-486`; `pair_id` column `src/db/schema.ts:255`, index `:270` |
| Nothing checks that both sides answer the same prompt (T28). The export uses `chosen.user_prompt` as the line's prompt and each side's own `system_prompt` | `src/training/export.ts:145-188` (`prompt = chosen.user_prompt` at `:158`) |
| The DPO export's assistant messages carry `response_content` and raw `llm_tool_results`, **not** `tool_calls` | `export.ts:160-178` |
| `pair_id` is immutable on a row (v33 trigger 1); a human changes it only by writing a new version, and `writeHumanVersion` carries the previous `pair_id` forward | `schema.ts:701-711`; `annotations.ts:85-124` (`pick('pairId', …)` at `:113`) |
| `AnnotateBody` still accepts `pairId: string ≤64` ("a later phase replaces it") | `src/dashboard/api.ts:1134-1144` (`:1138-1139`) |
| The UI's pair input is a free-text box; the label form model carries `pairId` | `src/dashboard/ui/src/tabs/LlmTab.tsx:264,338,419,610`; `src/dashboard/judge-ui-core.ts:64-120` |
| Judge proposals: `propose_judgments` (proposal, admin, both transports, `tab:llm`, Ask) and `propose_judgment` (declarative); neither has a pair input | `src/mcp/tool-catalog.ts:715-760`; `prepareProposal :1242-1293` |
| Proposal dispatch: shared 6/min bucket `judge:<userKey>`, rubric check (409 `rubric_changed`), daily cap `judgeDailyLimit` via `judgeRowsToday`, Ask → `kind='proposal'` op, Allow → `insertProposals` and `{kind:'read', data}` | `src/mcp/engine.ts:500-571`; commit `:1089-1115`; `LIMIT_USER_JUDGE_CALLS` `src/mcp/rate-limit.ts:37` |
| `created_via` for a proposal is derived from the TOOL and the server-derived `/mcp` transport, never the client-reported transport | `engine.ts:759-762` |
| Human review side: `/api/judgements/:id/accept\|reject\|revoke`, `/bulk` (≤10), browser proof, admin, 1 s dwell, `review_agent_present` by the 2-hour window rule | `src/dashboard/judgement-routes.ts:42-161` |
| Agent presence helpers | `src/mcp/store.ts:453` `isAgentPresent`, `:473` `principalHeldGrantSince`, `:488` `userHeldAgentSince`; `annotateAgentPresent` `judgement-routes.ts:70-72` |
| Blind rule in the page: `withoutHumanLabels` strips `annotations`, `annotation`, `history` from an agent-opened detail | `judge-ui-core.ts:14-58` |
| `apiInteractionDetail` returns `annotation`, `history`, `judgements` | `api.ts:1089-1121` |
| Interactions are written in one place | `src/utils/interaction-store.ts:45` |
| `KNOWN_PROMPT_CALL_TYPES` = agent, chain, team, categorization, entity-classification, summarize, relevance, **demo-showdown** | `src/agent/iteration-prompt-format.ts:40` |
| Same-prompt interactions occur naturally: the speed showdown sends one prompt to a local and a cloud model (`demo-showdown`); categorization batches repeat; a user re-asking can match on iteration 1 only if the system prompt (memories, data context) is unchanged | `specs/issue-92_speed-showdown.md` decisions 1-2 |
| Migrations are SQL strings only; SQLite has no built-in sha256, so a prompt hash cannot be backfilled inside a migration | `migrations.ts:96-111` |
| **The live seed has no same-prompt interactions**: every seeded `user_prompt` is distinct, so today's seed yields zero candidates | `scripts/webmcp-live-seed.ts` (the `llm` list and the P4a.2b rows) |
| Training tab sub-tabs: `traces`, `training`, `judge` | `LlmTab.tsx:28,675-677,733-745` |
| Export audit detail carries `provenance=… agent_present=…` | `src/dashboard/server.ts:392-405`; DPO route `:1246-1257` |

---

## §1 Goals and non-goals

### Goals
1. **Pairs are first-class rows**, not fields on annotation rows: a new `dpo_pairs` table with provenance, status, versioning and the same allow-list trigger discipline as v33.
2. **The server generates candidates**: interactions that answered a byte-identical prompt (system prompt, user prompt and tool definitions) are grouped by a server-side prompt key. Candidate lists are computed on demand and are **never** training data by themselves.
3. **A human picks pairs** in a new **Pairs** sub-tab of the Training area and from the detail panel ("Pair with…"), replacing the free-text `pairId` box. A human pick is an `accepted` human pair; its provenance is `dashboard` or `dashboard_agent_present` by the existing window rule.
4. **The judge may propose pairs** through one new proposal-class tool, `propose_pairs`, with every constraint `propose_judgments` has (admin, grant, policy default Ask, shared rate bucket and daily cap, rubric version, strict schema, items-only output), plus a blind read tool `list_pair_candidates`. Judge pairs are `proposed` until a person accepts them.
5. **Exports**: the default DPO export contains human, non-agent-present pairs only; accepted judge pairs need `includeJudge` (and `includeAgentPresent` when reviewed while an agent was around); every exported pair's sides are **re-verified at export time** to share an identical prompt. Legacy free-text pairs keep exporting.
6. Close **T28** fully.

### Non-goals
- Changing the DPO line format (adding `tool_calls` to assistant messages, chat-template prompts, dropping the system prompt from exported lines). The current format is kept byte-for-byte; Q9 records the follow-up.
- Auto-derived pairs (exporting "higher rating vs lower rating on the same prompt" without an explicit pick). Candidates may *suggest* a direction; nothing is exported without a pick (Q5).
- A pair agreement metric for the judge (Q8). The P4a rating agreement is unchanged.
- A declarative pair form for agents. There is no `toolname` on any pair UI; pairs reach the judge only as the imperative `propose_pairs`.
- Fuzzy or semantic prompt matching. Only exact matches pair (Q3).
- Migrating legacy free-text `pair_id`s into `dpo_pairs` (an optional "Re-pair" helper in the #160 sketch; dropped, see §7).
- Dropping `?token=` from export links (the #160 follow-up stays separate).

---

## §2 Design

### §2.1 Prompt key (`src/training/prompt-key.ts`, new, server-only)

```ts
export const PROMPT_KEY_VERSION = 'v1';
/**
 * Length-prefixed so no two different (system, user, tools) triples encode to the same bytes.
 * [AR-1] Keyed: HMAC-SHA256 under a per-profile random secret (`prompt_key_secret`, created by v35 with randomblob(32)),
 * so a key that leaks anyway (a `SELECT *`, a debug dump) is not an offline confirmation oracle for guessed prompts.
 */
export function promptKey(db: Database, row: { system_prompt: string | null; user_prompt: string; tool_defs_json: string | null }): string {
  const lp = (s: string) => `${Buffer.byteLength(s, 'utf8')}:${s}`;
  return createHmac('sha256', promptKeySecret(db))      // cached per Database handle
    .update(`wilson-prompt-key/${PROMPT_KEY_VERSION}\0${lp(row.system_prompt ?? '')}${lp(row.user_prompt)}${lp(row.tool_defs_json ?? '')}`)
    .digest('hex');
}
export function backfillPromptKeys(db: Database, opts: { limit: number }): { updated: number; remaining: number };
export function samePrompt(a: InteractionRow, b: InteractionRow): boolean;   // byte equality of the three fields, no hash
```

- **Stored as an index only.** v35 adds `llm_interactions.prompt_key TEXT` (nullable) with an index. `interaction-store.ts` writes it at insert. Existing rows (and rows the live seed inserts directly) are backfilled by `backfillPromptKeys` in batches of 500: at dashboard startup, in the existing 6-hour sweep, and lazily (at most 500 rows) before a candidate query. A candidate response says `indexing: {remaining}` while rows are unkeyed.
- **Never trusted for a write or an export.** `createHumanPair`, `insertPairProposals` and `qualifyingPairs` call `samePrompt` on the live rows (byte comparison of `system_prompt`, `user_prompt`, `tool_defs_json`). The stored key only narrows a lookup.
- **Self-invalidating.** v35 adds `AFTER UPDATE OF system_prompt, user_prompt, tool_defs_json ON llm_interactions` that sets `prompt_key = NULL` (no app code updates those columns today; the trigger makes a future one safe).
- **Never leaves the server** (new invariant 11). No route, tool, audit `args_preview` or UI payload contains a prompt key. Groups are referred to by their **anchor interaction id** (the lowest id in the group). Reason: for deterministic prompts (categorization of one transaction row, the showdown fixtures) an unkeyed hash is a confirmation oracle: anyone holding it can test a guessed description and amount offline (T40). The HMAC secret (AR-1) is defence in depth, not a licence to expose keys.
- **[AR-2] Existing `SELECT *` readers must stop at the new column.** `apiInteractionDetail` (`api.ts:1092`, `SELECT * FROM llm_interactions`) and `apiRunInteractions` (`api.ts:1123`, `SELECT i.*`) would return `prompt_key` the moment v35 adds it, and the detail object is what `open_interaction` puts into page state (the `withoutHumanLabels` spread keeps every interaction column). Both switch to an explicit column list (`INTERACTION_DETAIL_COLUMNS`, everything the UI reads today, minus `prompt_key`), and a guard test fails if any `SELECT *` / `i.*` over `llm_interactions` remains outside `src/training/export.ts` (whose readers emit explicit fields only). `export.ts:77` and `:152` keep `SELECT *` but are covered by the "no 64-hex key in export output" test.
- Including `tool_defs_json` is deliberate: a response that calls tools depends on which tools were offered. Q3 asks whether to relax it.

### §2.2 Candidate generation (`src/training/dpo-pairs.ts`, new)

`candidateGroups(db, opts)` and `candidatesFor(db, interactionId, opts)`:

1. Backfill up to 500 keys — **human path only [AR-13]**. The judge path never writes (a read tool must not make the dashboard hash megabytes of prompts on an agent's schedule); it groups only rows already keyed and says `indexing` while any are not.
2. Groups = `prompt_key` values with ≥2 **eligible** members. Eligible: `status = 'ok'`, non-empty `response_content` (the export cannot represent a tool-call-only step, Q9), and for the **judge** path also `call_type ∈ KNOWN_PROMPT_CALL_TYPES` (the judge cannot page an unknown-format user prompt, so it must not learn that two unreadable user prompts are equal). The human path lists every call type. **[AR-11] Known residual:** `get_interaction` never shows `system_prompt` or `tool_defs_json` (`judge-reads.ts:10,170`), for any call type, so a judge-path group always tells the judge one bit it cannot read: "the hidden system prompt (memories, data context) and tool list were byte-identical for these calls". It cannot choose either input, so this is an equality bit, not a content oracle. Accepted for P4b (Q15).
3. Within a group, a candidate pair is two members whose `(response_content, tool_calls_json)` differ byte-wise. Identical answers never pair (they would teach nothing and double-count).
4. Each member carries a **suggestion**, never a decision:
   - human path: `suggested: 'a' | 'b' | null` from the members' **current human ratings** when they differ by ≥2 (agent-present labels count, flagged), else from **accepted judge ratings** differing by ≥2 (shown with a `JUDGE` badge), else `null`;
   - judge path: no suggestion and **no human data at all** (blind rule, §2.6).
5. Ordering: groups newest first by the newest member; at most 10 members per group in a human response and 6 in a judge response; groups with a handoff block on any member are flagged `handoff: true` (they export only with `includeHandoff`, existing rule).

Candidates are computed per request. **Nothing is stored** until a human picks or a judge proposes.

### §2.3 Data model: v35 `create_dpo_pairs` (one migration)

```sql
-- [AR-1] Per-profile HMAC secret for prompt keys. Never read by any route or tool; randomblob runs inside the migration.
CREATE TABLE IF NOT EXISTS prompt_key_secret (id INTEGER PRIMARY KEY CHECK (id = 1), secret BLOB NOT NULL CHECK (length(secret) = 32));
INSERT OR IGNORE INTO prompt_key_secret (id, secret) VALUES (1, randomblob(32));

ALTER TABLE llm_interactions ADD COLUMN prompt_key TEXT;
CREATE INDEX IF NOT EXISTS idx_interactions_prompt_key ON llm_interactions(prompt_key);
CREATE TRIGGER IF NOT EXISTS trg_interactions_prompt_key_reset
AFTER UPDATE OF system_prompt, user_prompt, tool_defs_json ON llm_interactions
BEGIN UPDATE llm_interactions SET prompt_key = NULL WHERE id = NEW.id; END;

CREATE TABLE IF NOT EXISTS dpo_pairs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pair_uid TEXT NOT NULL UNIQUE,              -- 'pair_' + uuid (human) | 'jpair_' + uuid (judge); server-generated only
  chosen_interaction_id INTEGER NOT NULL REFERENCES llm_interactions(id) ON DELETE CASCADE,
  rejected_interaction_id INTEGER NOT NULL REFERENCES llm_interactions(id) ON DELETE CASCADE,
  prompt_key TEXT NOT NULL,                   -- the key at creation (after samePrompt passed); audit aid, never exported
  source TEXT NOT NULL CHECK(source IN ('human','judge')),
  status TEXT NOT NULL CHECK(status IN ('proposed','accepted','rejected','superseded')),
  version INTEGER NOT NULL DEFAULT 1,
  supersedes_id INTEGER REFERENCES dpo_pairs(id),
  created_via TEXT NOT NULL,                  -- dashboard | dashboard_agent_present | webmcp | http-mcp
  principal_id TEXT,                          -- judge: audit principal (tab hash / token id); human: NULL
  judge_model TEXT,                           -- judge only, agent-declared, ≤64
  rationale TEXT,                             -- judge only, 20..600, agent-written
  rubric_version TEXT,                        -- judge only
  suggested_by TEXT,                          -- human only: what the picker suggested: human_ratings | judge_ratings | none
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  reviewed_by INTEGER,
  reviewed_at TEXT,
  review_agent_present INTEGER,               -- NULL until reviewed; 0/1 by the window rule
  CHECK (chosen_interaction_id <> rejected_interaction_id)
);
CREATE INDEX IF NOT EXISTS idx_dpo_pairs_status ON dpo_pairs(source, status);
CREATE INDEX IF NOT EXISTS idx_dpo_pairs_chosen ON dpo_pairs(chosen_interaction_id);
CREATE INDEX IF NOT EXISTS idx_dpo_pairs_rejected ON dpo_pairs(rejected_interaction_id);
-- One current human pair per UNORDERED interaction pair (A>B and B>A cannot both be current).
CREATE UNIQUE INDEX IF NOT EXISTS idx_dpo_pairs_one_current_human
  ON dpo_pairs(min(chosen_interaction_id, rejected_interaction_id), max(chosen_interaction_id, rejected_interaction_id))
  WHERE source = 'human' AND status = 'accepted';

-- 1. Immutable except status / reviewed_by / reviewed_at / review_agent_present.
CREATE TRIGGER IF NOT EXISTS trg_dpo_pairs_immutable_columns
BEFORE UPDATE ON dpo_pairs
WHEN NEW.id IS NOT OLD.id OR NEW.pair_uid IS NOT OLD.pair_uid
  OR NEW.chosen_interaction_id IS NOT OLD.chosen_interaction_id OR NEW.rejected_interaction_id IS NOT OLD.rejected_interaction_id
  OR NEW.prompt_key IS NOT OLD.prompt_key OR NEW.source IS NOT OLD.source OR NEW.version IS NOT OLD.version
  OR NEW.supersedes_id IS NOT OLD.supersedes_id OR NEW.created_via IS NOT OLD.created_via
  OR NEW.principal_id IS NOT OLD.principal_id OR NEW.judge_model IS NOT OLD.judge_model
  OR NEW.rationale IS NOT OLD.rationale OR NEW.rubric_version IS NOT OLD.rubric_version
  OR NEW.suggested_by IS NOT OLD.suggested_by OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'dpo_pairs rows are immutable except status/reviewed_by/reviewed_at/review_agent_present'); END;

-- 2. Allowed transitions; review fields change only with a status change.
CREATE TRIGGER IF NOT EXISTS trg_dpo_pairs_status_transitions
BEFORE UPDATE ON dpo_pairs
WHEN (NEW.status IS NOT OLD.status AND NOT (
        (OLD.source = 'human' AND OLD.status = 'accepted' AND NEW.status = 'superseded')
     OR (OLD.source = 'human' AND OLD.status = 'accepted' AND NEW.status = 'rejected'
         AND NEW.reviewed_at IS NOT OLD.reviewed_at)                                  -- withdraw (human route only)
     OR (OLD.source = 'judge' AND OLD.status = 'proposed' AND NEW.status IN ('accepted','rejected','superseded'))
     OR (OLD.source = 'judge' AND OLD.status = 'accepted' AND NEW.status = 'rejected'
         AND NEW.reviewed_at IS NOT OLD.reviewed_at)))                                -- revoke
  OR (NEW.status IS OLD.status AND (NEW.reviewed_by IS NOT OLD.reviewed_by OR NEW.reviewed_at IS NOT OLD.reviewed_at
        OR NEW.review_agent_present IS NOT OLD.review_agent_present))
BEGIN SELECT RAISE(ABORT, 'dpo_pairs status transition not allowed'); END;

-- 3. Insert guard: judge rows are born proposed, unreviewed, with judge fields; human rows are born accepted dashboard rows with no judge fields.
CREATE TRIGGER IF NOT EXISTS trg_dpo_pairs_insert_guard
BEFORE INSERT ON dpo_pairs
WHEN NEW.review_agent_present IS NOT NULL OR NEW.reviewed_by IS NOT NULL OR NEW.reviewed_at IS NOT NULL
  OR (NEW.source = 'judge' AND (NEW.status IS NOT 'proposed' OR NEW.pair_uid NOT LIKE 'jpair\_%' ESCAPE '\'
        OR NEW.created_via NOT IN ('webmcp','http-mcp') OR NEW.principal_id IS NULL OR NEW.judge_model IS NULL
        OR NEW.rationale IS NULL OR NEW.rubric_version IS NULL OR NEW.suggested_by IS NOT NULL))
  OR (NEW.source = 'human' AND (NEW.status IS NOT 'accepted' OR NEW.pair_uid NOT LIKE 'pair\_%' ESCAPE '\'
        OR NEW.created_via NOT IN ('dashboard','dashboard_agent_present') OR NEW.principal_id IS NOT NULL
        OR NEW.judge_model IS NOT NULL OR NEW.rationale IS NOT NULL OR NEW.rubric_version IS NOT NULL))
BEGIN SELECT RAISE(ABORT, 'dpo_pairs insert not allowed'); END;

-- 4. No deletes while both interactions exist (ON DELETE CASCADE still works: a parent is gone when this fires).
CREATE TRIGGER IF NOT EXISTS trg_dpo_pairs_no_orphan_delete
BEFORE DELETE ON dpo_pairs
WHEN EXISTS (SELECT 1 FROM llm_interactions WHERE id = OLD.chosen_interaction_id)
 AND EXISTS (SELECT 1 FROM llm_interactions WHERE id = OLD.rejected_interaction_id)
BEGIN SELECT RAISE(ABORT, 'pairs are never deleted; withdraw, reject or revoke instead'); END;

CREATE VIEW IF NOT EXISTS v_current_human_pairs AS SELECT * FROM dpo_pairs WHERE source = 'human' AND status = 'accepted';
CREATE VIEW IF NOT EXISTS v_accepted_judge_pairs AS SELECT * FROM dpo_pairs WHERE source = 'judge' AND status = 'accepted';
```

Notes:
- `min(a,b)`/`max(a,b)` (scalar, deterministic) in a partial unique index expression, and the `LIKE 'pair\_%' ESCAPE '\'` insert guard, were checked in bun:sqlite while writing this spec (a reversed second current human pair fails with `UNIQUE constraint failed`; `pairx` is refused, `pair_ok` accepted). The migration test pins both. Fallback if a future SQLite refuses the expression: stored generated columns `lo_id`/`hi_id` (allowed, since this is a new table).
- A PRAGMA guard test (same as v33's) fails if any `dpo_pairs` column other than the four mutable ones is missing from trigger 1.
- The `prompt_key` column on `llm_interactions` is **not** covered by any immutability trigger (it is an index cache); the security property comes from `samePrompt` at write and export.
- Withdrawing a human pair is new relative to annotations (which only supersede). It is needed because a human pair has no "next version" to supersede it with when a person simply un-pairs (Q10).
- **Re-pairing in the other direction**: the human route supersedes the current human pair on the same unordered pair and inserts the reversed one (`version+1`, `supersedes_id`), in one transaction. **[AR-12]** A reversal or withdraw made while an agent was around (window rule) does not erase the earlier clean decision silently: the superseding row is `dashboard_agent_present` (so it, and therefore the pair, drops out of the default export, as an agent-present annotation version does today), the withdraw row records `review_agent_present`, and both show "changed while an agent had access" with a **Re-pick** action in the Accepted list. Residual (same as annotations): an agent-driven reversal removes a clean pair from the default export until the person re-picks.
- **[AR-1]** `prompt_key_secret` holds one row; the migration test asserts 32 bytes and that two fresh DBs get different secrets. Keys from one profile never match another profile's (that is fine: pairs never cross profiles).

### §2.4 Domain module (`src/training/dpo-pairs.ts`, new)

| Function | Rule |
|---|---|
| `candidateGroups(db, {forJudge, principalId?, cursor, limit})` / `candidatesFor(db, id, {forJudge})` | §2.2. `forJudge` strips every human or judge label, every pair state, and filters call types |
| `createHumanPair(db, {chosenId, rejectedId, agentPresent})` | **[AR-9]** `suggested_by` is **derived on the server** inside the transaction from the same suggestion rule the picker uses (`suggestionFor(db, chosenId, rejectedId)`: `human_ratings` / `judge_ratings` when that rule suggests the picked direction, else `none`); the client never sends it. One transaction: both rows exist; distinct; `samePrompt`; responses differ; both `status='ok'` with non-empty responses → else typed failure (`not_found`, `prompt_mismatch`, `identical`, `ineligible`). Supersede the current human pair on the unordered pair if any. Insert `source='human', status='accepted', created_via = agentPresent ? 'dashboard_agent_present' : 'dashboard'`, `pair_uid = 'pair_' + randomUUID()`. **Never touches `interaction_annotations`.** |
| `withdrawHumanPair(db, id, {reviewedBy, agentPresent})` | accepted human → rejected, new `reviewed_at`, **[AR-12]** `review_agent_present` from `annotateAgentPresent` (trigger 2 already allows review fields to change with the status) |
| `insertPairProposals(db, {principalId, createdVia, judgeModel, rubricVersion, pairs, dailyLimit})` | Mirrors `insertProposals`: only `judge`/`proposed`; per item the same checks as `createHumanPair` plus `call_type ∈ KNOWN_PROMPT_CALL_TYPES` (`unsupported_call_type`); dedupe key `principal_id + judgeModel + rubricVersion + unordered pair`: an open proposal with the same key (either direction) is superseded, nobody else's is touched; **[AR-6]** if the same principal already has a pair row on that unordered pair in **any terminal status** (accepted, rejected, superseded-by-review) the item is skipped `duplicate` (no re-proposing a rejected flip until a person tires of rejecting it; the reason is the same whatever the human did, so it leaks nothing); a repeated unordered pair inside one batch keeps the first; all-or-nothing against the daily limit, counted **inside the transaction** with `judgeItemsToday` (AR-4). Skip reasons: `not_found`, `prompt_mismatch`, `identical`, `ineligible`, `unsupported_call_type`, `duplicate`. **No skip reason ever reflects human state** (no `already_paired_by_human`) |
| `setPairStatus(db, id, 'accept'\|'reject', {reviewedBy, agentPresent, minAgeMs})` / `revokePair(db, id, …)` | Same as `setJudgementStatus` / `revokeJudgement`: proposed only; 1 s dwell on accept; revoke accepted judge → rejected |
| `pairReviewAgentPresent(db, id, {userId, profile}, clickTimeLive, now)` | `reviewAgentPresent` generalised: live grant, or proposal younger than `REVIEW_AGENT_WINDOW_MS`, or the proposing principal held a grant **live at any point** in the window, **[AR-3] or `userHeldAgentSince(user, window)`** (any agent for this user, not just the proposer: a page agent on a rotated session can click Accept on another principal's proposal). Implemented by extracting the shared core from `judgement-routes.ts:51-61` into `reviewWindowAgentPresent(db, {principalId, createdAt, userId, profile}, clickTimeLive, now)` used by both. **[AR-3] Behaviour change (not a pure extraction):** `principalHeldGrantSince` and `userHeldAgentSince` (`store.ts:473-500`) today count a grant only if it was **created** in the window (`dbTimeMs(created_at) >= sinceMs`). A 4 h or 12 h tab grant (or a 30-day client-token grant) created before the window and revoked or expired a minute before the click therefore counts as "no agent". Both switch to **interval overlap**: a grant counts when `created_at <= now` and `coalesce(revoked_at, expires_at) >= sinceMs` (grants are kept 7 days after expiry, `cleanExpiredGrants`, so the rows exist). Same change applies to `annotateAgentPresent`, so P4a's annotate and judgement routes get it too; their existing tests must keep passing and gain the overlap cases |
| `judgeItemsToday(db, now)` **[AR-4]** | `judgeRowsToday + judgePairsToday` (judge pair rows inserted today, UTC, any status). The daily cap is `judgeItemsToday + n ≤ judgeDailyLimit` (Q6). It is used in all four places: the engine's call-time check for **both** proposal tools, `insertProposals`' in-transaction check (`annotations.ts:182-185`, which today counts annotation rows only, so without this change judgements and pairs would each get the full limit, 2×), `insertPairProposals`' in-transaction check, and `commitProposalOperation` |
| `qualifyingPairs(db, opts: QualifyOptions)` | §2.7 |

### §2.5 Human surfaces

**Routes** (new file `src/dashboard/pair-routes.ts`, mounted from `server.ts` next to `handleJudgementRoute`):

| Method / path | Auth | Body / query (zod, strict) | Response |
|---|---|---|---|
| `GET /api/pairs/candidates?cursor&limit≤20` | any signed-in user | — | `{groups:[{anchorId, size, callType, handoff, members:[{id, model, created_at, responsePreview≤200, humanRating, humanAgentPresent, judgeRating, pairedWith:[{pairId, otherId, role, status}]}]≤10, suggested}], nextCursor, indexing?:{remaining}}`; rate-limited (below) |
| `GET /api/interactions/:id/pair-candidates` | any signed-in user | — | members sharing `:id`'s prompt key (≤10), same member shape; 404 if no interaction |
| `GET /api/pairs?source=human\|judge&status=proposed\|accepted\|rejected&cursor&limit≤50` | any signed-in user | — | `{pairs:[PairView], total, nextCursor}` |
| `POST /api/pairs` | admin (auth on); **browser proof** | `{chosenId:int>0, rejectedId:int>0}` (**[AR-9]** no `suggestedBy`: server-derived; sending it → 400 `invalid_args`) | `201 {pair: PairView}`; 400 `prompt_mismatch` "These interactions answer different prompts."; 400 `identical`; 400 `ineligible`; 404 |
| `POST /api/pairs/:id/withdraw` | admin; browser proof | — | `{pair}`; 409 if not an accepted human pair |
| `POST /api/pairs/:id/accept\|reject` | admin; browser proof | — | `{pair}`; 409 `not_proposed`; 409 `approval_too_fast` (<1 s) |
| `POST /api/pairs/:id/revoke` | admin; browser proof | — | accepted judge → rejected |
| `POST /api/pairs/bulk` | admin; browser proof | `{ids:int[] 1..10 distinct, action:'accept'\|'reject'}` | `{results}` |

- Every POST computes agent presence **on the server**: `POST /api/pairs` uses `annotateAgentPresent` (user-level window rule, `judgement-routes.ts:70`); accept/reject use `pairReviewAgentPresent`. Every POST writes an `appendRestWriteAudit` row with `detail` = `chosen=<id> rejected=<id> agent_present=<bool>` (or `id=<n>`), the same as judgement routes.
- `PairView` = `{id, pairId: pair_uid, chosenId, rejectedId, source, status, createdVia, agentPresent: created_via==='dashboard_agent_present' || review_agent_present===1, judgeModel?, rationale?, rubricVersion?, createdAt, reviewedAt?}`. **Never `prompt_key`.**
- Rate limits (`rate-limit.ts`, per `userKey`): `LIMIT_USER_PAIR_WRITES = 30 / 60 s` across `POST /api/pairs`, withdraw, accept, reject, revoke, bulk; `LIMIT_USER_PAIR_CANDIDATES = 60 / 60 s` across both candidate GETs. 429 with `Retry-After`.
- `apiInteractionDetail` gains `pairs: PairView[]` (every pair row touching this interaction, newest first), and moves to an explicit column list without `prompt_key` (AR-2; same for `apiRunInteractions`).

**Annotate route change** (`api.ts:1134-1144`): `pairId` accepts **only `null`** (to clear a legacy free-text pair on the next version). Any string → `400 invalid_args` "pairId is server-generated: pick a pair in Training → Pairs." `judge-ui-core.ts` `LabelForm` drops `pairId`; `annotateBody` sends `pairId: null` only when the person clicks "Remove legacy pair". A rating-only save still carries a legacy `pair_id` forward (`writeHumanVersion` is unchanged), so legacy pairs keep exporting.

**UI** (Forensic Noir per `app/BRAND.md`; React escaping only; no `dangerouslySetInnerHTML`, no markdown rendering of model text):

| Component | Where | Content |
|---|---|---|
| `PairsTab` (new, `ui/src/components/pairs/`) | `LlmTab` sub-tab **Pairs** after "Judge queue" (`SubTab` gains `'pairs'`) | Two sections. **Candidates**: group list (anchor `#id` mono, size, call type chip, `HANDOFF` chip when flagged); selecting a group shows a side-by-side compare of two members (A/B selectors among ≤10), each response as plain text in a scroll box (`font-mono text-xs`), model, human rating stars (read-only here) with `AGENT PRESENT` chip, accepted judge rating with `JUDGE` badge, and the suggestion line ("Your ratings suggest A" / "Accepted judge ratings suggest A" amber). Buttons "A is better" / "B is better" (`bg-green/20 text-green`) are enabled only after **both** responses were scrolled into view or expanded (friction, not security), then "Save pair". **Judge pair proposals**: rows like `JudgeQueue` (checkbox, `#chosen > #rejected` mono, `DECLARED BY AGENT` badge, `AGENT-WRITTEN` rationale with links replaced by `[link]`, 3-line clamp), Accept/Reject with the P4a controls (800 ms enable, `isTrusted`, press-and-hold for bulk, bulk ≤10 of rows expanded this session). **Accepted pairs**: list with Withdraw (human) / Revoke (judge). Empty states: "No two calls answered the same prompt yet." / "No pair proposals." |
| `PairWithButton` | detail panel, replaces the free-text box at `LlmTab.tsx:610` | "Pair with…" opens the compare view anchored on this interaction (`GET /api/interactions/:id/pair-candidates`). A row with a legacy `pair_id` shows it read-only with "Remove legacy pair". |
| `PairHistory` | detail panel, beside `JudgementHistory` | Pair rows touching this interaction with status chips (proposed amber, accepted green, rejected muted strike, superseded muted) and `AGENT PRESENT` chips |
| Stats card | training header | "Complete DPO pairs" now counts `qualifyingPairs` (legacy + new) with the export's own rule; a sub-line "Judge pairs: proposed / accepted" |
| `ExportOptions` | unchanged checkboxes | The DPO download uses the same flags; filename `wilson-dpo-with-judge.jsonl` when `includeJudge` (already at `server.ts:1252`) |

`withoutHumanLabels` (`judge-ui-core.ts`) adds `pairs` to the stripped fields, so an agent-opened panel holds no human or judge pair state until a trusted interaction (blind rule; P4a carry-over). `PairWithButton` is not rendered while labels are hidden.

Amendments from the adversarial review (binding):
- **[AR-7] A judge pair is accepted only after its two responses were on screen.** A queue row shows `#chosen > #rejected` collapsed; **expanding** it renders the same side-by-side compare view as the picker (both responses, plain text, chosen side labelled "judge prefers"). Accept (single) is enabled only after the row was expanded and both response boxes were scrolled into view or fully shown; bulk Accept keeps "rows expanded this session" with that same definition. The ids-only queue row alone is never acceptable.
- **[AR-8] Blind Pairs tab while a judge-capable agent is live.** When the tab holds a live grant for any judge tool (`list_interactions`, `get_interaction`, `list_pair_candidates`, `propose_*`), the Pairs tab mounts in **hidden mode**: candidates show ids, model, call type and responses but no human rating, no `JUDGE` rating, no suggestion line and no `pairedWith`; the Accepted section is collapsed and not fetched. A trusted `pointerdown` inside the tab (same `isTrusted` reveal as the P4a detail panel) fetches and shows them. This keeps an in-page judge (ACT-1 doubling as ACT-7) from reading human pair state out of the DOM before the person acts (T42); after the reveal the DOM holds it (T34 residual, unchanged).
- **[AR-6] Re-proposals are not a fatigue lever.** A judge proposal whose unordered pair already has a current human pair, or a judge pair a person rejected or revoked, is listed in a collapsed "Already decided" group (no Accept button there; Reject only) instead of the main queue, and is never in bulk. This is a UI filter only: nothing about it reaches any judge output.
- **[AR-12] Withdraw and Revoke** use the P4a press-and-hold and `isTrusted`, and the server records `review_agent_present`/`agent_present` on them.

### §2.6 Judge surfaces (WebMCP and `/mcp`)

Both tools: `surface: {tab:'llm'}`, `exposure: 'imperative'`, `transports: ['webmcp','http-mcp']`.

| Name | Class | RO/UC/CQ | minRole / default policy | Input (strict) | Output (≤1.5K) |
|---|---|---|---|---|---|
| `list_pair_candidates` | read | ✓/✓/– | viewer / allow | `filter?: 'open'\|'all' = 'open'` (open = **no pair row of yours in any status** on any of its pairs, **[AR-6]**: counting only `proposed` rows would make a group reappear the moment a person accepted or rejected, which tells the judge a human reviewed it), `callType?: enum(KNOWN_PROMPT_CALL_TYPES)`, `cursor?`, `limit?: 1..5 = 3` | `{groups:[{anchorId, callType, memberIds:[≤6], handoffNotes:boolean, yourProposals:int}], nextCursor, note, indexing?}` (`yourProposals` = your pair rows on the group in any status; constant under human review) |
| `propose_pairs` | proposal | –/–/✓ | admin / ask | `judgeModel` (same pattern as `propose_judgments`), `rubricVersion` (must equal current, else `rubric_changed` + `currentRubricVersion`), `pairs: 1..5 of {chosenId:int>0, rejectedId:int>0, rationale: 20..600 (input hygiene, `\n\t` allowed)}`. **[AR-10]** No `criteria` input: `dpo_pairs` has no column for it, and an unstored, unvalidated record of agent-chosen keys is only surface. The rationale must cite a criterion id (rubric `pairRules`) | `{created:n, ids:[pair row ids], skipped:[{chosenId, rejectedId, reason}]}` |

Constraints `propose_pairs` shares with `propose_judgments` (each one a test):
- grant required (`validateGrant`), kill switch, policy (default **Ask**; Allow allowed, like proposals today; never clamped beyond that), `minRole: 'admin'`, viewers cannot be granted it, `isWriteTool` → refused on client tokens while auth is off and hidden from `/mcp` `tools/list` then;
- same rate bucket `judge:<userKey>` (6 calls / 60 s across `propose_judgments`, `propose_judgment` and `propose_pairs`), per-principal `p:<id>` all-calls bucket, pending caps (3 per principal, 5 per user) for Ask;
- daily cap: `judgeItemsToday + n ≤ judgeDailyLimit`, checked at call time, again at card approval (`commitProposalOperation`), and inside both insert transactions (AR-4), refused whole;
- **[AR-14]** rubric re-checked at card approval: a `propose_pairs` card approved after `JUDGE_RUBRIC_VERSION` changed goes `stale` with reason `rubric_changed` (P4a's `commitProposalOperation` does not re-check today, `engine.ts:1094-1115`; the pairs branch does, and the same check is recommended for `propose_judgments` as a P4a follow-up). The stored op args use the key `pairs`, never `items`, and the commit branch is chosen by tool name, so a pairs op can never reach `insertProposals`;
- `created_via` from the tool and server-derived transport only (`proposalCreatedVia`), so `webmcp` or `http-mcp`, never `declarative`;
- strict zod; no `status`, `source`, `pairId`, `pair_uid` or `prompt` input (unknown key → `invalid_args`);
- the card (Ask) is server-written: summary "Add N proposed preference pair(s) (not used for training until you accept)"; `after` rows: `pairs: "#12 > #15, #12 > #19"` (ids only, ≤8 shown), `judge model (declared by agent)`, `rubric`. **No rationale and no response text on the card** (T10/T24);
- output contains counts, row ids and skip reasons only.

Rubric: `JUDGE_RUBRIC` gains a `pairRules` entry ("Prefer the response that scores higher on the weighted criteria; if they tie within 0.5, do not propose a pair. Rationale must cite a criterion id and a concrete difference."). This changes `JUDGE_RUBRIC_VERSION`, so in-flight judge sessions get one `rubric_changed` and refetch (Q7).

**Blind rule for pairs (binding).** No judge tool output and no `open_interaction` output contains a human rating, preference, notes, tags, a human pair, a judge pair by another principal, any pair status (only the caller's own all-status `yourProposals` count, AR-6), or a prompt key. `list_pair_candidates` members are ids only; the judge reads responses through `get_interaction` (sections, budgeted, masked) as today. `get_interaction` is unchanged.

**Budget.** `list_pair_candidates` is a read: principal×tool, user aggregate and the daily read budget apply (rows = groups returned + member ids / 6, rounded up; chars = output length). Every call is audited like any read.

**Engine wiring.** `prepareProposal` gains a `propose_pairs` branch returning a `PreparedPairProposal` (`kind: 'pairs'`); `callTool`'s proposal path (`engine.ts:500-571`) and `commitProposalOperation` (`:1089-1115`) branch on it and call `insertPairProposals`; `proposalAnswer` returns `{created, ids, skipped}`. No new wire kind (Allow answers `{kind:'read', data}`, Ask `{kind:'operation'}`), so bridge, `/api/mcp/call` and `/mcp` are unchanged.

### §2.7 Export rules (`qualifyingPairs`, used by `exportDpoJsonl` and `trainingReadiness`)

1. **Human pairs**: `v_current_human_pairs`. Skipped unless `includeAgentPresent` when `created_via = 'dashboard_agent_present'`.
2. **Judge pairs** (only with `includeJudge`): `v_accepted_judge_pairs`, skipped when `review_agent_present = 1` unless `includeAgentPresent`; the newest accepted judge pair per unordered pair wins.
3. **Shadowing**: a current human pair on an unordered pair shadows every judge pair on it, **even when the human pair itself is excluded** (agent-present without the opt-in) — same rule as `qualifyingAnnotations` (`annotations.ts:374-378`). **[AR-5]** A **legacy human pair** (two current human annotation rows sharing a free-text `pair_id` with chosen/rejected preferences) shadows judge pairs on the same unordered pair the same way, also when it is itself excluded (agent-present, handoff, or rule 7 prompt mismatch is irrelevant here since a judge pair on that unordered pair would fail rule 7 too). Without this, the revision-1 dedupe ("the `dpo_pairs` row wins") let an accepted **flipped judge pair replace a person's legacy pair** under `includeJudge`.
4. **Human-rating veto** **[AR-5, widened]**: a judge pair is dropped when any current human rating on either side (agent-present ones count: what a person said wins) contradicts it: the rejected side is rated higher than the chosen side; or the chosen side is rated ≤ 2; or the rejected side is rated ≥ 4 and the chosen side is unrated. Revision 1 vetoed only when both sides were rated, so a judge could pick a side the person rated 1 as "chosen" against an unrated one. Same spirit as the SFT rule that a judge-only run must not contain a response a person rated below `minRating` (`annotations.ts:440-456`).
5. **Legacy pairs**: `qualifyingDpoPairs` output (free-text `pair_id`) is still included under its existing rules, de-duplicated against rules 1-2 by unordered interaction pair with precedence **current human `dpo_pairs` row > legacy human pair > judge pair** (AR-5).
6. **Handoff**: a pair with a handoff block on either side is dropped unless `includeHandoff` (existing rule, now also for new pairs).
7. **Prompt re-verification (all sources, including legacy)**: `samePrompt(chosen, rejected)` on the live rows; a mismatch drops the pair and counts in `promptMismatchExcluded`. For legacy pairs this is a **behaviour change** (a hand-typed cross-prompt pair stops exporting). Q12.
8. Proposed, rejected (withdrawn, revoked) and superseded rows never export.
9. Line format unchanged (`export.ts:151-185`); `X-Wilson-Export-Provenance` unchanged (`exportProvenance`). `trainingReadiness.dpoPairs` = `qualifyingPairs(...).pairs.length`; it gains `judgePairs:{proposed, accepted, rejected}` and `promptMismatchExcluded`.

### §2.8 File changes

| File | Change |
|---|---|
| `src/db/schema.ts`, `src/db/migrations.ts` | `DPO_PAIRS` const; v35 `create_dpo_pairs` (after v34). Update the reserved-slot comment |
| `src/training/prompt-key.ts` (new) | §2.1 |
| `src/training/dpo-pairs.ts` (new) | §2.4 |
| `src/training/annotations.ts` | `qualifyingDpoPairs` keeps the legacy grouping but applies rule 7; `trainingReadiness` delegates DPO to `qualifyingPairs`; **`insertProposals` counts `judgeItemsToday` in its transaction (AR-4)** |
| `src/training/export.ts` | `exportDpoJsonl` uses `qualifyingPairs` |
| `src/training/judge-rubric.ts` | `pairRules` |
| `src/utils/interaction-store.ts` | write `prompt_key` at insert |
| `src/dashboard/pair-routes.ts` (new), `src/dashboard/server.ts` | routes §2.5; startup + 6 h sweep call `backfillPromptKeys` |
| `src/dashboard/judgement-routes.ts` | extract `reviewWindowAgentPresent` (adds the user-level window, AR-3; existing tests keep passing) |
| `src/mcp/store.ts` | `principalHeldGrantSince` / `userHeldAgentSince`: interval overlap instead of created-in-window (AR-3) |
| `src/dashboard/api.ts` | `AnnotateBody.pairId` null-only; `apiInteractionDetail.pairs`; `PairView`; explicit column lists in `apiInteractionDetail` and `apiRunInteractions` (AR-2) |
| `src/mcp/tool-catalog.ts` | `list_pair_candidates`, `propose_pairs`; `prepareProposal` branch |
| `src/mcp/judge-reads.ts` | `listPairCandidatesRead(db, args, ctx, cap)` (blind projection, capOutput, cursor) |
| `src/mcp/engine.ts` | proposal path + commit branch; daily cap sum |
| `src/mcp/rate-limit.ts` | `LIMIT_USER_PAIR_WRITES`, `LIMIT_USER_PAIR_CANDIDATES` |
| `src/mcp/confirmation-card.ts` | `TOOL_LABELS.propose_pairs = 'Propose Preference Pairs'` |
| `src/dashboard/agent-access-model.ts` | grant-row `dataWarning` for `list_pair_candidates`: "Shows which of your chats asked the same thing" |
| `src/dashboard/judge-ui-core.ts` | `withoutHumanLabels` strips `pairs`; `LabelForm` drops `pairId`; new pure `pairPickerModel(group, sel)` (suggestion text, enable rule) and `pairQueueRules` |
| `ui/src/tabs/LlmTab.tsx`, `ui/src/components/pairs/*` (new), `ui/src/types.ts` | §2.5 UI |
| `scripts/webmcp-live-seed.ts`, `scripts/webmcp-live-check.md` | §5.3 seed delta and the P4b part |
| `CHANGELOG.md` | annotate `pairId` string now 400; legacy cross-prompt pairs no longer export; new Pairs tab; new judge tools (schema digests unchanged for old tools; `get_judge_rubric` version changes) |

---

## §3 Threat-model delta (to append to `specs/webmcp-threat-model.md`)

### §3.1 New assets

| ID | Asset | Where | Why it matters |
|---|---|---|---|
| A9 | Preference-pair integrity (part of A3) | `dpo_pairs`, legacy `pair_id`, the DPO export | A wrong or flipped pair trains the model to prefer the worse answer, and DPO amplifies it |
| A10 | Prompt keys | `llm_interactions.prompt_key`, `dpo_pairs.prompt_key` | sha256 of private prompts; for deterministic prompts (one-row categorization, showdown) a confirmation oracle for financial data (A1/A4) |

### §3.2 Actors
No new actors. ACT-1 (browser agent), ACT-2 (injection source), ACT-3 (extension), ACT-6 (viewer), ACT-7 (judge) and ACT-9 (external MCP client) gain the new surfaces. ACT-2 gains one capability: **choosing prompts** that collide into a group it wants paired (e.g. by getting the same question asked twice).

### §3.3 New threats

| ID | Threat | STRIDE | Actor | Sev | Phase |
|----|--------|--------|-------|-----|-------|
| T39 | Cross-prompt or forged pair through the route, the tool, or a stale stored key (closes T28) | T | ACT-1/6/7 | Medium | P4b |
| T40 | Prompt key used as a confirmation oracle for private prompt content | I | ACT-1/3/7/9 | Medium | P4b |
| T41 | Judge pair poisoning and bulk-accept of flipped pairs | T | ACT-7 | **Critical** for A9 | P4b |
| T42 | Judge learns human pair or label state through pair tools to game acceptance | I/T | ACT-7 | Medium | P4b |
| T43 | Page-driving agent creates "human" pairs in the picker | T/E | ACT-1/3 | High (residual) | P4b (contain) |
| T44 | Candidate computation and pair writes as a DoS / audit-flush vector | D/R | ACT-1/3/9 | Low | P4b |
| T45 | Legacy free-text pair path stays writable or silently changes meaning | T | ACT-1/6 | Medium | P4b |
| T46 | XSS or social engineering through side-by-side response text and pair rationales | E/T | ACT-2/7 | High | P4b |

**T39: Cross-prompt or forged pairs** (extends T28).
- **Vector:** `POST /api/pairs {chosenId:A, rejectedId:B}` with A and B answering different prompts; a `propose_pairs` item that does the same; or a stored `prompt_key` that no longer matches content. The export takes `chosen.user_prompt` as the prompt (`export.ts:158`), so a cross-prompt pair teaches "answer X is better than an answer to a different question".
- **Control:** `samePrompt` byte comparison inside the write transaction (route and tool) and again at export (rule 7) for every source including legacy; stored keys only narrow lookups and reset on content update (`trg_interactions_prompt_key_reset`); `pair_uid` is server-generated and immutable; `pairId` strings refused on annotate.
- **Proving tests:** `dpo-pairs.test.ts`: "createHumanPair with different user prompts → prompt_mismatch, no row"; "same user prompt, different system prompt → prompt_mismatch"; "same prompts, different tool_defs_json → prompt_mismatch"; "stale stored key (UPDATE user_prompt) → key reset to NULL, create re-verifies"; `training-export.test.ts`: "legacy pair across prompts → excluded, promptMismatchExcluded=1"; `judge-pair-tools.test.ts`: "propose_pairs cross-prompt → skipped prompt_mismatch".

**T40: Prompt-key oracle.**
- **Vector:** if any API or tool output carried `prompt_key`, an agent could hash guessed one-row categorization prompts (built from `buildCategorizationPrompt` with a guessed description and amount) and confirm a transaction exists without any transaction read, bypassing the read budget (T11).
- **Control:** keys never leave the server (invariant 11): `PairView`, candidates, tool outputs, audit previews and the export omit them; groups are named by anchor id; the judge path excludes unknown-format call types so it learns no equality it could not read itself.
- **Tests:** `dpo-pair-routes.test.ts` and `judge-pair-tools.test.ts`: "no response body contains any 64-hex substring equal to a stored prompt_key" (scan every route and tool output with a seeded DB, **including the pre-existing `GET /api/interactions/:id`, `/api/runs/:runId` and the DPO/SFT export bodies**, AR-2); "AR-1: promptKey differs across two DBs for the same prompt"; source guard "no `SELECT *` / `i.*` over llm_interactions outside src/training/export.ts"; `mcp-audit-log.test.ts` (extend): "propose_pairs args_preview has no prompt_key".

**T41: Judge pair poisoning.**
- **Vector:** a prompt-injected judge (T24) proposes flipped pairs (worse answer as chosen), 5 per call, many calls, and the human bulk-accepts. DPO weights pair errors more than SFT rating noise.
- **Control:** proposals are inert (`proposed`, insert guard); default export has no judge pairs; `includeJudge` opt-in, reset after each export; accept dwell 1 s, 800 ms enable, `isTrusted`, press-and-hold for bulk, bulk ≤10 expanded rows; `review_agent_present` by the window rule and its opt-in; human shadowing and the human-rating veto (rule 3-4); revoke; shared judge rate bucket and daily cap; card never shows rationale.
- **Tests:** `annotations-versioning`-style `dpo-pairs-migration.test.ts`: "insert judge pair accepted → ABORT"; "UPDATE judge chosen_interaction_id → ABORT"; "judge accepted→rejected with new reviewed_at allowed"; `training-export.test.ts`: "default DPO export excludes accepted judge pairs"; "judge pair contradicted by human ratings → excluded"; "human pair shadows a reversed judge pair even when the human pair is agent-present and excluded"; "judge pair accepted with review_agent_present=1 → needs includeAgentPresent"; "AR-5: legacy human pair B>A shadows an accepted judge pair A>B under includeJudge"; "AR-5: judge chosen side rated 1 by a person, rejected unrated → vetoed"; "AR-4: 10 judgements + 1 pair with judgeDailyLimit=10 → pair refused (and the reverse order)"; `dpo-pair-routes.test.ts`: "accept <1 s → 409"; "bulk 11 → 400".

**T42: Judge sees human state.**
- **Vector:** a judge that can tell which pairs a human made (or how members are rated) copies them to look accurate, then gets bulk acceptance on the pairs it invents (T37 for pairs). Skip reasons like `already_paired` or a candidate list that hides human-paired groups leak the same bit.
- **Control:** blind projection in `listPairCandidatesRead`; `yourOpenProposals` counts only the caller's own proposals; no skip reason reflects human state; `withoutHumanLabels` strips `pairs` from an agent-opened panel.
- **Tests:** `judge-pair-tools.test.ts`: "list_pair_candidates output identical with and without a human pair/rating on the group (byte-equal after removing nothing)"; "skip reasons never include a human-state reason (exhaustive enum test)"; "another principal's proposals do not change yourProposals"; "accepting or rejecting the caller's own proposal does not change list_pair_candidates output (filter open and all)" (AR-6); `judge-ui-core.test.ts`: "withoutHumanLabels removes pairs".

**T43: Agent-driven picker** (extends T34).
- **Vector:** an agent with CDP clicks "A is better" and "Save pair", writing `source='human'` pairs.
- **Control (containment):** server-computed `annotateAgentPresent` (window rule, with grant **interval overlap**, AR-3) → `dashboard_agent_present`, excluded from the default export, `AGENT PRESENT` chip; browser proof on every POST; per-user write bucket; audit row with `agent_present`. Residual as T34: a capable agent that waits out the window with no grant is not caught (§4.2).
- **Tests:** `dpo-pair-routes.test.ts`: "POST /api/pairs with a live grant → created_via dashboard_agent_present"; "… after the grant is revoked, within 2 h → still agent_present"; "AR-3: a 12 h grant created 5 h ago and revoked 1 min ago → agent_present"; "AR-3: judge-pair accept by a user whose other session held a grant in the window → review_agent_present=1"; "headerless POST → 403 origin_required"; "viewer POST → 403".

**T44: DoS and audit flush.**
- **Vector:** repeated candidate GETs force backfill hashing over large prompts (iteration prompts embed full tool results); bursts of pair writes or invalid proposals flood the audit log.
- **Control:** backfill bounded to 500 rows per request; candidate GET bucket 60/min per user; pair write bucket 30/min; judge read and proposal buckets as in #160 §1.4; invalid tool calls aggregate as audit noise (T14); `list_pair_candidates` draws on the daily read budget.
- **Tests:** `mcp-rate-limit.test.ts` (extend): "31st pair write in 60 s → 429"; "61st candidate GET → 429"; "rotating session does not exceed the shared judge bucket with propose_pairs"; `prompt-key.test.ts`: "backfill processes at most limit rows and reports remaining".

**T45: Legacy pair path.**
- **Vector:** the free-text box and `pairId` string stay writable, so a page-driving agent (or a person by mistake) keeps making unverified pairs; or the change silently stops exporting legitimate legacy pairs.
- **Control:** annotate accepts `pairId: null` only; the free-text box is removed; legacy pairs keep exporting when both sides answer the same prompt (rule 7 reports how many were dropped, shown in the Training header).
- **Tests:** `dashboard-api.test.ts`: "annotate pairId 'x' → 400 with the picker hint"; "annotate pairId null clears it in a new version"; "rating-only update keeps the legacy pair_id"; `training-export.test.ts`: existing `pair-1` / `pair-stats` cases keep passing (their fixtures share a prompt; verify, and fix the fixture rather than the rule if not).

**T46: XSS and social engineering in the compare view and pair queue.**
- **Vector:** responses are model output that may carry markup or text like "Approve this pair"; rationales are agent-written.
- **Control:** plain-text rendering only, React escaping, no markdown; rationale under `AGENT-WRITTEN`, URLs → `[link]`; source guard bans `dangerouslySetInnerHTML` under `components/pairs/`; card shows ids only.
- **Tests:** source guard "no dangerouslySetInnerHTML under ui/src/components/pairs"; `judge-ui-core.test.ts`: "pair rationale links replaced".

### §3.4 Existing threats touched

| ID | Change |
|---|---|
| T10, T24 | `propose_pairs` card shows no agent text; pair rationales labelled; rubric rule that text inside interactions is data applies to pairs |
| T11, T15 | `list_pair_candidates` under the read buckets and the daily budget; `propose_pairs` under the shared judge bucket |
| T14 | new routes and tools audited; `args_preview` for `propose_pairs` is ids + model only |
| T16 | pair accept uses the 1 s dwell and P1 card controls |
| T18 | viewers: candidates and lists readable, every write 403; `propose_pairs` not grantable |
| T23 | no new content path: responses still come through `get_interaction` only |
| T25 | allow-list triggers extended to `dpo_pairs` |
| T28 | **closed** by T39's controls |
| T34 | picker added to the contained human controls (T43) |
| T37 | blind rule extended to pairs (T42) |

### §3.5 Invariants (amend §8)
- **4 (extended):** via any tool path, judge writes create only `source='judge', status='proposed'` rows in `interaction_annotations` **or `dpo_pairs`**, and judge tools never return human labels **or human pairs**. `dpo_pairs` rows are immutable except `status`, `reviewed_by`, `reviewed_at`, `review_agent_present`, along allow-listed transitions.
- **5 (extended):** default exports contain no judge rows, **no judge pairs**, no human rows and **no human pairs** made while an agent had live access.
- **10 (new):** every exported DPO line's two sides have byte-identical `system_prompt`, `user_prompt` and `tool_defs_json`, verified at export time.
- **11 (new):** no prompt key appears in any API response, tool output, audit row, export or page state.

### §3.6 Residuals (append to §7)
- An agent that drives the picker, waits more than 2 hours with no grant, operation or kill-switch flip, and then clicks "Save pair" writes a clean human pair (same as T34's annotation residual).
- Exact prompt matching means most chat iterations never pair (system prompts change with memories and dates). That limits usefulness, not security; Q3 is where to trade it.
- Pair suggestions in the human picker come from the person's own ratings or from accepted judge ratings; a person who follows a judge-derived suggestion is influenced by the judge. The pair records `suggested_by='judge_ratings'` so that influence is visible and can be filtered later (not filtered by default, Q5).

---

## §4 Migrations

- **One migration: v35 `create_dpo_pairs`** (§2.3). It is needed: pairs require their own provenance and triggers, and the prompt-key index needs a column. **v34 stays reserved for open-jev B1-b**; v35 cannot merge before v34 is on the base because `migrations.test.ts` requires contiguous versions.
- Options if P4b is ready first (Q2): (a) wait for v34; (b) if Jd parks B1-b for good, P4b takes v34 and the reserved-slot comment moves; (c) never ship an empty placeholder v34 (it would collide with B1-b's real one on any profile that ran it). **Recommendation: (a).** Re-check the highest version on `origin/*` before implementing S1.
- No data migration in SQL: legacy `pair_id` rows are untouched; prompt keys are backfilled by code (§2.1).
- First run on a real encrypted profile migrates v→35 and then backfills keys in batches. Jd watches for the first-run backfill time on his profile (Q11 gives a query to size it first).

---

## §5 Test plan

### §5.1 Unit and HTTP tests (TDD order, one slice at a time)

1. `dpo-pairs-migration.test.ts` (new): "v35 on a v34 DB adds prompt_key and dpo_pairs"; "min/max expression unique index accepted by bun:sqlite and rejects A>B plus B>A both current human"; "insert judge pair with status accepted → ABORT"; "insert judge pair without principal/judge_model/rationale/rubric → ABORT"; "insert human pair with judge_model → ABORT"; "insert with review_agent_present → ABORT"; "insert pair_uid without prefix → ABORT"; "chosen = rejected → CHECK fails"; "UPDATE any immutable column → ABORT" (one case per column, generated from PRAGMA); "PRAGMA guard: trigger 1 lists every column except the four mutable ones"; "judge proposed→accepted/rejected/superseded allowed; accepted→proposed ABORT"; "judge accepted→rejected needs a new reviewed_at"; "human accepted→superseded allowed; accepted→rejected (withdraw) needs new reviewed_at"; "review fields without a status change → ABORT"; "DELETE while both interactions exist → ABORT"; "DELETE an interaction cascades its pairs"; "UPDATE llm_interactions.user_prompt resets prompt_key".
2. `prompt-key.test.ts` (new): "length prefix: ('ab','c') vs ('a','bc') differ"; "null system prompt and '' system prompt hash the same (documented)"; "tool_defs_json is part of the key"; "interaction-store writes prompt_key"; "backfill limit/remaining"; "samePrompt is byte equality, ignores the stored key".
3. `dpo-pairs.test.ts` (new, domain): candidates (eligibility, identical responses excluded, ≤10 members, judge path filters call types and carries no human/judge fields, suggestion rules incl. agent-present and judge badge); `createHumanPair` (each failure reason; supersede on reverse; never writes `interaction_annotations`, checked by a row snapshot); `withdrawHumanPair`; `insertPairProposals` (skip reasons, dedupe both directions, other principal untouched, batch duplicate, all-or-nothing daily limit, `judgeRowsToday + judgePairsToday` sum); `setPairStatus` / `revokePair` / dwell; `reviewWindowAgentPresent` shared core gives the same answers as the old `reviewAgentPresent` (table-driven).
4. `training-export.test.ts` (extend): rules 1-9 of §2.7, one case each; "dpoPairs equals the number of DPO lines" across fixtures; "legacy pairs still export" (existing `:195-196`, `:229` unchanged); "legacy cross-prompt pair excluded"; "a pair present both as legacy and dpo_pairs exports once"; "handoff rule applies to new pairs"; "line format byte-equal to the pre-P4b export for a legacy-only fixture".
5. `dpo-pair-routes.test.ts` (new, HTTP on port 0): every route's auth (viewer 403 on writes, admin ok), browser proof (headerless → 403 `origin_required`, `Sec-Fetch-Site: same-site` → 403), zod (unknown key → 400), 404s, 409s, rate limits (fake clock), agent-present provenance (live grant; revoked within window; kill-switch flip), audit rows with `agent_present`, no `prompt_key` in any body, `PairView` shape.
6. `dashboard-api.test.ts` (extend): annotate `pairId` rules (T45); `apiInteractionDetail.pairs`.
7. `judge-pair-tools.test.ts` (new): catalog limits (names ≤30, description ≤500, describes ≤150); `list_pair_candidates` ≤1,500 chars, cursor round-trip, blind (byte-equal output with/without human state), no 64-hex key, budget accounting, `untrustedContentHint`; `propose_pairs` strict schema (`status`/`source`/`pairId` keys → `invalid_args`), stale rubric → `rubric_changed` with `currentRubricVersion`, >5 pairs → `invalid_args`, rationale 19 chars → `invalid_args` and 20 ok, minRole admin, viewer grant refused, client token while auth off refused and hidden from `tools/list`, kill switch → 403, policy off → 403, Ask → `kind='proposal'` op with the server-written card and no rationale, approve inserts `proposed` only, reject inserts nothing, daily cap at call and at approve, shared 6/min bucket with `propose_judgments`, `created_via` ignores a client-reported `declarative` transport, output has ids/counts/reasons only.
8. `mcp-tool-catalog.test.ts` (extend): `EXPECTED_TOOL_NAMES` += `list_pair_candidates`, `propose_pairs`; hints match classification; `isWriteTool(propose_pairs)`.
9. `mcp-confirmation-card.test.ts` (extend): "propose_pairs card: label, summary, ids only, no rationale".
10. `judge-ui-core.test.ts` (extend): `withoutHumanLabels` strips `pairs`; `LabelForm` has no `pairId`; `annotateBody` sends `pairId: null` only on "Remove legacy pair"; `pairPickerModel` suggestion text and enable rule; pair rationale `[link]` replacement; bulk ≤10 expanded.
11. `mcp-rate-limit.test.ts`, `mcp-audit-log.test.ts` (extend): T44 cases; `propose_pairs` audit preview.
12. Source guards: "no dangerouslySetInnerHTML under ui/src/components/pairs"; "no `toolname` attribute under ui/src/components/pairs" (no declarative pair form).
13. `agent-access-model.test.ts` (extend): `list_pair_candidates` row shows its data warning; `propose_pairs` is a `PROPOSAL` row with Allow available, viewer-locked.
14. **Adversarial-review cases (AR-n)**, each written red first in the slice that owns the code: AR-1 (S1) secret row, HMAC, cross-DB difference; AR-2 (S1) projection guard + detail/run bodies have no `prompt_key` field; AR-3 (S2) interval-overlap table for `userHeldAgentSince` / `principalHeldGrantSince` / `reviewWindowAgentPresent` (grant created before window and revoked/expired inside it; client-token grant; other-session grant for the same user; kill-switch flip) plus the old P4a cases unchanged; AR-4 (S2/S4) shared daily cap in both inserts and both engine checks; AR-5 (S2) legacy shadowing and widened veto; AR-6 (S2/S4) terminal-status `duplicate`, `list_pair_candidates` byte-equal before/after a human accept or reject of the caller's proposal; AR-7/AR-8 (S5) `pairQueueRules`: Accept disabled until expanded and both sides shown; hidden mode while a judge grant is live, reveal only on `isTrusted`; AR-9 (S3) `suggestedBy` key → 400, stored `suggested_by` matches the server rule; AR-10 (S4) `criteria` key → `invalid_args`; AR-12 (S3/S5) withdraw/revoke record agent presence, hold control; AR-13 (S4) `list_pair_candidates` performs no UPDATE (statement counter or `total_changes()` before/after); AR-14 (S4) card approved after a rubric bump → `stale rubric_changed`, nothing inserted.

### §5.2 Per-file CI loop (run before every commit of every slice)

```sh
cd <repo>/.claude/worktrees/<p4b-worktree>
bun run typecheck
FAIL=0; for f in src/__tests__/*.test.ts; do bun test "$f" >/tmp/claude-501/p4b-$(basename "$f").log 2>&1 || { echo "FAIL $f"; FAIL=1; }; done; echo "FAIL=$FAIL"
(cd src/dashboard/ui && npm run build)        # S5 onward
```
Same shape as `.github/workflows/ci.yml` (each file in its own process; `mock.module` contamination otherwise). A slice is green only with `FAIL=0`, typecheck clean and, from S5, the UI built.

### §5.3 Seed delta (for the live check; written in S6)

`scripts/webmcp-live-seed.ts` gains a pairs section (same HOME guard and `security` shim; still refuses a non-scratch HOME):
- **Group A** (`call_type='agent'`, sequence 1): three interactions with byte-identical system prompt, `Query: …` user prompt and no tool defs, three different responses: a good one, one with a sign error, one with a made-up number. Human rating 5 on the good one, 2 on the sign error (gives a "Your ratings suggest" line).
- **Group B** (`call_type='demo-showdown'`): two interactions, same prompt, a local-model and a cloud-model answer, both unrated.
- **Negative control C**: two interactions with the same user prompt as group A but a different system prompt (must never group with A).
- **Identical control D**: two interactions with the same prompt and byte-identical responses (must never pair).
- **Handoff group E**: two interactions whose prompt contains the handoff header (flagged, export only with `includeHandoff`).
- **Unknown-format group F**: two `standalone` interactions with the same prompt (human picker shows them; `list_pair_candidates` does not).
- **Legacy pair**: two group-A-prompt interactions with human annotations `pair_id='legacy-1'`, preferences chosen/rejected (keeps exporting) and one legacy pair `legacy-x` across prompts (dropped by rule 7).
- The script prints the ids of each group.

---

## §6 Verification plan

### §6.1 Step 1: adversarial Opus review of the implementation
Run after S6 and before any squash. A fresh Opus subagent with **read and run** access to the P4b worktree only (no edits, no push, no GitHub, no `~/.openaccountant`, no `security` CLI), given this spec, `specs/webmcp-threat-model.md`, `specs/webmcp-security-judge.md` §P4a and the full diff against the base. Brief: *"Break it. You are ACT-7 with a granted `propose_pairs`, ACT-1 driving the page, ACT-6 as a viewer, ACT-9 with a client token, and ACT-4 forging headers on a no-auth profile. Find a way to: (1) get a judge pair, a flipped pair or a cross-prompt pair into a default or opt-in DPO export without a trusted human act; (2) learn a prompt key or any human label/pair through a tool, route, audit row or error message; (3) change any immutable `dpo_pairs` column or make an illegal transition; (4) make the default DPO export differ from what readiness reports; (5) bypass the shared judge bucket or daily cap (session rotation, `/mcp` vs WebMCP, Ask vs Allow, card approval after a limit change); (6) get a `dashboard` (not agent-present) human pair written while an agent had access in the window; (7) render agent text as markup. Prove each finding with a failing `bun test` in a scratch file under /private/tmp/claude-501/, cite file:line, rate severity (critical/high/medium/low), and say which invariant or T-ID it breaks."* Also asked to check SQL in triggers against bun:sqlite by running it, and to diff the DPO export of a legacy-only fixture before and after. **[AR]** The brief also lists, as targets to re-attack: (8) the grant-interval window rule (long-TTL grant revoked just before a click, other-session grants); (9) any `SELECT *` path that returns `prompt_key`; (10) a flipped judge pair displacing a legacy human pair; (11) daily-cap sum across `propose_judgments` + `propose_pairs` inside the insert transactions; (12) any judge-visible output that changes when a person reviews a proposal.
Output: a findings table `{id: R1.., severity, invariant/T-ID, file:line, repro test, proposed fix}`. Critical and high are fix-first; medium is fixed or written up as an explicit residual with Jd's agreement; low may be deferred to an issue Jd files.

### §6.2 Step 2: issue-scoped verification of each fix
For each accepted finding, on the P4b branch:
1. Copy the reviewer's repro into the right test file as a named case (`"R3: propose_pairs approve after judgeDailyLimit lowered → stale daily_limit"`), run it alone, confirm it **fails**.
2. Make the smallest fix. Run that test file alone (green), then the full per-file loop and typecheck (§5.2), plus the UI build if UI changed.
3. One commit per finding: `fix(p4b): R3 …` with the test and the fix together.
4. A second, separate Opus pass verifies **each fix in isolation**: it gets only the finding, the commit and the surrounding files, re-runs the repro, tries one variation of the attack (e.g. the other direction, the other transport, the bulk route), and checks the invariants named in the finding still hold. Verdict per finding: `verified` / `partial` (new finding R3a, back to 1) / `not fixed`.
5. A table of findings → commit → verdict goes into §9 of this spec (implementation notes) before the squash.

### §6.3 Step 3: live Chrome 154 WebMCP check
Throwaway environment only:

```sh
rm -rf /private/tmp/claude-501/webmcp-live-home && mkdir -p /private/tmp/claude-501/webmcp-live-home
HOME=/private/tmp/claude-501/webmcp-live-home bun run scripts/webmcp-live-seed.ts          # seeds P4a rows + the §5.3 pair groups
(cd src/dashboard/ui && bun run build)
HOME=/private/tmp/claude-501/webmcp-live-home PATH=/private/tmp/claude-501/webmcp-live-home/.webmcp-live-bin:$PATH \
  bun run src/index.tsx --dashboard --port 3141
```
One Chrome 154 tab with WebMCP on `http://localhost:3141`, dashboard auth off (so Approve is a 0.6 s hold and client tokens are read-only), the P4a helper (`window.__wlc4`, `scripts/webmcp-live-check.md` P4a.0) plus a `dpo()` line counter like `lines()` for `/api/export/training/dpo`.

**JD WATCHES**: claude-in-chrome tabs report `document.visibilityState === 'hidden'`, and the confirmation-card poller and pending count are visibility-gated (#160 "Operational notes"), so a card never draws in the automation tab. Every step that needs a card on screen, a trusted click, or a press-and-hold is done by Jd in a **foreground** tab, with the automation reading state through `GET /api/mcp/operations`, `/api/pairs` and the export endpoints. Record `document.visibilityState` beside every result.

| Step | Who | Action | PASS |
|---|---|---|---|
| P4b.0 | automation | Install helpers; read the seed's printed ids | helpers installed; group ids known |
| P4b.1 | automation | Grant `list_pair_candidates`, `propose_pairs` (+ P4a judge tools); `#overview` → `#llm` → `#overview` | both appear only on `#llm` |
| P4b.2 | automation | `list_pair_candidates {}` and pages | groups A, B (and E flagged `handoffNotes`); **no** C, D, F; ≤1,500 chars; no rating, preference, pair or 64-hex field; same output after Jd rates a member (re-run after P4b.7) |
| P4b.3 | automation then **JD WATCHES** | Policy `propose_pairs` = Ask; agent calls `propose_pairs` with 2 group-A pairs; automation confirms one `kind='proposal'` op via `w.pending()`. **JD WATCHES:** in a foreground tab the card reads "Confirm: Propose Preference Pairs", summary "Add 2 proposed preference pairs (not used for training until you accept)", ids only, declared model, rubric, **no rationale**; Jd presses **Reject** | agent's call resolves `rejected`; `/api/pairs?source=judge` unchanged |
| P4b.4 | automation then **JD WATCHES** | Repeat; **JD WATCHES:** Jd holds **Approve** | `outcome: committed`, `created: 2`; rows `proposed`; default DPO export line count unchanged |
| P4b.5 | automation | Policy Allow; `propose_pairs` with: one A pair, one A×C (cross-prompt), one D pair (identical), one F pair (unknown format), one repeated A pair | `created: 1`; skipped `prompt_mismatch`, `identical`, `unsupported_call_type`, `duplicate`; no skip reason mentions a human |
| P4b.6 | automation | Stale `rubricVersion`; 6 pairs; a `status` key | `rubric_changed` with `currentRubricVersion`; `invalid_args` twice (as results, not thrown) |
| P4b.7 | **JD WATCHES** | In the Pairs sub-tab (first confirm it opened in **hidden mode**, no ratings or suggestion lines, because the judge grant is live — AR-8 — then Jd clicks inside it to reveal), Jd **expands** a judge pair and confirms Accept stays disabled until both responses were shown (AR-7), accepts it (waits for enable, real click), rejects one, selects and **expands** two more and holds bulk Accept, then revokes one accepted pair | queue states match; `dpo()` default unchanged; `?includeJudge=true` grows by accepted pairs **only with `&includeAgentPresent=true`** (grant is live, so `review_agent_present=1`) |
| P4b.8 | **JD WATCHES** | Jd opens group A in the compare view, scrolls both responses, clicks "A is better", Save | a `source='human'` pair with `created_via='dashboard_agent_present'` (grant live), `AGENT PRESENT` chip; default `dpo()` unchanged; `?includeAgentPresent=true` +1. (The unflagged path needs 2 quiet hours; covered by `dpo-pair-routes.test.ts`) |
| P4b.9 | automation then **JD WATCHES** | Agent calls `open_interaction` on a paired group-A member; automation checks the panel holds no pair history and no "Pair with…" (`withoutHumanLabels`); a synthetic `pointerdown` does not reveal; **JD WATCHES:** Jd clicks inside the panel | before: no pairs in DOM or state; after Jd's trusted click: pair history appears |
| P4b.10 | automation | Page `fetch('/api/pairs',{method:'POST',body:{chosenId:A1,rejectedId:C1}})` → 400 `prompt_mismatch`; annotate `{pairId:'x'}` → 400; shell `curl -X POST http://localhost:3141/api/pairs` with no Origin → 403 `origin_required` | as stated; nothing written |
| P4b.11 | automation | Legacy: `dpo()` default includes `legacy-1`, not `legacy-x`; readiness `promptMismatchExcluded ≥ 1`; Training header shows it | as stated |
| P4b.12 | automation | Settings → Agent access → Activity (via `GET /api/mcp/audit`) | rows for both tools, pair routes with `agent_present=true`, DPO exports with provenance; no prompt key anywhere in the audit JSON |
| P4b.12a | automation | `GET /api/interactions/<group-A id>` and `GET /api/runs/<its run>`; `list_pair_candidates {filter:'all'}` compared byte-for-byte with its P4b.2 output | no `prompt_key` field in either body (AR-2); candidate output identical although P4b.7 reviewed some of this principal's proposals (AR-6) |
| P4b.13 | **JD WATCHES** for any card | Cleanup: policies back to Ask, revoke session grants, reject or let expire pending cards; console clean; screenshots (Pairs tab compare view, pair queue with badges, the Ask card, an `AGENT PRESENT` chip) | console has no errors or React key warnings |

Result template (appended to `scripts/webmcp-live-check.md` as "P4b result template"), one line per step with PASS/FAIL, `visibilityState`, and who acted (automation / Jd).

---

## §7 Slices and estimates

| Slice | Content | Tests (from §5.1) | Estimate |
|---|---|---|---|
| S0 | Recon refresh: re-check highest migration on `origin/*`, re-verify the §A lines, confirm Q1-Q3 answers | — | 0.25 d |
| S1 | v35 + `prompt-key.ts` + interaction-store write + backfill + sweep hook | 1, 2 | 1 d |
| S2 | `dpo-pairs.ts` domain + `qualifyingPairs` + export/readiness integration + `reviewWindowAgentPresent` extraction | 3, 4 | 1.5 d |
| S3 | Human routes + annotate `pairId` change + detail `pairs` + rate limits + audit | 5, 6, 11 (routes part) | 1 d |
| S4 | Judge tools: catalog, `listPairCandidatesRead`, `prepareProposal`/engine/commit branches, card label, rubric `pairRules`, access model | 7, 8, 9, 11, 13 | 1.5 d |
| S5 | UI: Pairs sub-tab, compare view, pair queue, detail panel button and history, `judge-ui-core` changes, free-text box removed | 10, 12; UI build | 2 d |
| S6 | Seed delta + P4b live-check section + result template; CHANGELOG | dry-run the seed in a scratch HOME | 0.5 d |
| V1 | §6.1 adversarial Opus review | — | 0.5 d |
| V2 | §6.2 fixes, one commit per finding, isolated re-verification | per finding | 1-2 d |
| V3 | §6.3 live Chrome 154 check (needs Jd for the JD WATCHES steps, about 30 min of his time) | — | 0.5 d |
| AR | Adversarial-review amendments spread over S1-S5 (AR-1..AR-14; AR-3 ideally lands first as its own P4a fix, Q16) | §5.1 item 14 | +1 d |
| | **Total** | | **≈ 10.5-11.5 days** |

S1-S4 can be reviewed and merged without the UI only if Q4's annotate change waits for S5 (otherwise the old free-text box would 400). Recommendation: ship S1-S6 together after V1-V3; the orchestrator squashes into local `release/0.10.0`, Jd pushes.

---

## §8 Open questions for Jd (each with a recommendation)

| # | Question | Recommendation |
|---|---|---|
| Q1 | #160 OQ22 deferred P4b "until P4a has run for a while". Build it now? | **Size it first.** Run Q11's count on your real profile (you, not an agent). If fewer than ~20 eligible groups exist, P4b mostly helps the showdown and categorization data; still worth it for closing T28, but S5's UI can be lighter. If yes, build all slices. |
| Q2 | v35 needs v34 (open-jev B1-b) merged first. Wait, or let P4b take v34 if B1-b stays parked? | **Wait** (a). If you park B1-b for good, say so and P4b takes v34; never an empty placeholder. |
| Q3 | Prompt match strictness: system + user + tool defs, byte-exact? | **Yes for P4b.** A "same user prompt, different system prompt" tier would raise recall but trains preferences across different contexts (memories, dates). Revisit with data. |
| Q4 | Refuse `pairId` strings on annotate (null-only) and remove the free-text box? | **Yes.** Legacy pairs keep exporting; "Remove legacy pair" clears one. |
| Q5 | Export auto-derived pairs (rating gap ≥2 on the same prompt) without an explicit pick? And filter picks that followed a judge suggestion by default? | **No and no.** Suggestions only; `suggested_by` is recorded so either can be added later. |
| Q6 | Judge pairs share `judgeDailyLimit` with judgements (one number), or a separate limit? | **Share.** One admin knob; a pair counts as one item. |
| Q7 | Add `pairRules` to the rubric (bumps `JUDGE_RUBRIC_VERSION`, one `rubric_changed` for running judges, including open-jev's client)? | **Yes.** The version exists for exactly this. |
| Q8 | A pair agreement metric (judge pair vs human pair direction, blind)? | **Defer.** Not needed for the export bar; add once there are enough human pairs. |
| Q9 | DPO line format: add assistant `tool_calls`, allow tool-call-only steps, stop putting the system prompt (memories, data context) in every exported line? | **Separate follow-up issue.** Format changes affect `browser-finetune` training; P4b keeps the format byte-identical. |
| Q10 | Allow a person to **withdraw** a human pair (accepted → rejected), unlike annotations which only supersede? | **Yes.** Un-pairing has no "next version". |
| Q11 | Sizing query for Q1 (run it yourself against your real profile; agents never open `~/.openaccountant`): `SELECT COUNT(*) FROM (SELECT system_prompt, user_prompt, tool_defs_json FROM llm_interactions WHERE status='ok' AND response_content <> '' GROUP BY 1,2,3 HAVING COUNT(*) >= 2);` plus `SELECT COUNT(*) FROM llm_interactions;` for the backfill size | — |
| Q12 | Rule 7 drops legacy free-text pairs whose two sides answer different prompts (they export today). Accept the behaviour change? | **Yes.** Those lines are wrong training data (T28); the header shows how many were dropped. |
| Q13 | Human picker shows unknown-format call types (`standalone`) while the judge never sees them. OK? | **Yes.** A person can read any prompt; the judge cannot page those prompts, so it must not learn they match. |
| Q14 | Should `list_pair_candidates` and `propose_pairs` be offered over `/mcp` (external clients, write tools only with auth on), like the P4a judge tools? | **Yes**, same rules as `propose_judgments`; the open-jev judge client then gets pairs for free. |
| Q15 | (AR-11) A judge-path group reveals that two calls had byte-identical hidden system prompts and tool lists (memories, data context), one bit the judge cannot otherwise read. Accept? | **Yes, as a documented residual.** The judge cannot choose either input, so it is an equality bit, not an oracle. The alternative (no judge pairs at all) gives up Goal 4. |
| Q16 | (AR-3) The grant-interval fix changes P4a's `annotateAgentPresent` / `reviewAgentPresent` too (more labels flagged agent-present). Land it as its own small P4a fix on release before P4b, or inside P4b S2? | **Separately, first** (`fix(webmcp): agent-present window counts grants live in the window, not just created in it`). It is a P4a hole on its own (a 4 h/12 h tab grant or a client-token grant revoked a minute before a click reads as "no agent") and should not wait for P4b's v35 gate. P4b S2 then only adds the user-level term to the pair review rule. |
| Q17 | (AR-14) Add the rubric re-check at card approval to `propose_judgments` as well? | **Yes**, in the same P4a follow-up as Q16; P4b does it for `propose_pairs` from the start. |

---

## §9 Implementation notes
Empty until built. V2's findings → commit → verdict table goes here.

---

## Adversarial review (2026-10-04)

Reviewer: adversarial Opus pass over revision 1 (design only, nothing built), with `specs/webmcp-threat-model.md` and the code the spec cites, read in this worktree (base `e8d0d0a`). The reviewer attacked the design as ACT-1 (page-driving agent), ACT-7 (judge), ACT-9 (client token), ACT-6 (viewer) and ACT-4 (forged headers, auth off). Claims checked in code are cited. Two SQL claims were run in bun:sqlite: the `min()/max()` partial unique index rejects a reversed second current human pair, and `randomblob(32)` works inside migration SQL (AR-1). Every finding below is fixed in the spec text above (search for its `[AR-n]` tag) unless the disposition says it is an open question.

| ID | Sev | Issue | Disposition |
|---|---|---|---|
| AR-1 | Medium | The prompt key was a plain sha256. Any leak (see AR-2) would hand out an offline confirmation oracle for one-row categorization and showdown prompts (T40). The control depended only on "never leaves the server". | **Fixed in spec**: HMAC-SHA256 under a per-profile 32-byte secret created by v35 (`prompt_key_secret`). Invariant 11 still holds; the secret is defence in depth. |
| AR-2 | **High** | **Invariant 11 is broken by existing code as soon as v35 adds the column.** `apiInteractionDetail` does `SELECT * FROM llm_interactions` (`api.ts:1092`) and `apiRunInteractions` does `SELECT i.*` (`api.ts:1123`). Both would return `prompt_key`. The detail object is what `open_interaction` puts into page state, and `withoutHumanLabels` keeps every interaction column (`judge-ui-core.ts:58-60`), so an in-page agent could read keys. The revision-1 tests scanned only new routes and tools. | **Fixed in spec**: explicit column lists in both readers (§2.1, §2.5); a source guard bans `SELECT *` / `i.*` over `llm_interactions` outside `export.ts`; the key-scan test now covers the old detail and run routes and the export bodies; live step P4b.12a. |
| AR-3 | **High** | **The agent-present window counts a grant only when it was created inside the window** (`principalHeldGrantSince` and `userHeldAgentSince`, `store.ts:473-500`, `dbTimeMs(created_at) >= sinceMs`). Tab grants can last 4 h or 12 h (`store.ts:92`) and client-token grants 30 days. A page agent whose grant was created 5 h ago can revoke it in the UI (or let it expire) and click "Save pair" or Accept a minute later. `isAgentPresent` is then false, nothing was created in the window and, with Allow-policy reads, no operation was raised, so the result is a clean `dashboard` human pair or a `review_agent_present=0` judge accept. T43's revision-1 test ("revoked within 2 h → still agent_present") passed only because its fixture grant was young. `reviewAgentPresent` also looked only at the proposing principal, not at other sessions of the same user. The same hole exists in P4a's annotate and judgement routes. | **Fixed in spec**: interval overlap (`created_at <= now` and `coalesce(revoked_at, expires_at) >= since`; rows are kept 7 days, `cleanExpiredGrants`), plus the user-level term in `pairReviewAgentPresent`; new test cases. **Open question for Jd (Q16)**: land it as a separate P4a fix first (recommended). The design hole is closed either way. |
| AR-4 | Medium | **The daily cap could be doubled.** `insertProposals` checks only `judgeRowsToday` inside its transaction (`annotations.ts:182-185`). Revision 1 added the pair count to the engine and the pair insert, but not to the judgement insert, and §2.8 did not touch `insertProposals`. So judgements and pairs could each reach `judgeDailyLimit`. | **Fixed in spec**: one `judgeItemsToday`, used in four places (both engine checks, both insert transactions, commit). |
| AR-5 | **High** (T41, A9) | **A flipped judge pair could displace a person's legacy pair.** Rule 5 de-duplicated legacy pairs against `dpo_pairs` with "the `dpo_pairs` row wins", including judge rows. So under `includeJudge`, an accepted judge A>B replaced a legacy human B>A. Rule 4's veto also fired only when both sides were rated, so a judge could pick a side the person rated 1 as "chosen" over an unrated side. | **Fixed in spec**: legacy human pairs shadow judge pairs (also when excluded); precedence is human `dpo_pairs` > legacy > judge; the veto is widened (chosen side rated ≤2, or rejected side rated ≥4 with the chosen side unrated, or rejected rated higher than chosen). |
| AR-6 | Medium | **Approval fatigue, and a review-state leak to the judge.** Dedupe superseded only *open* proposals, so a judge could re-propose a rejected flipped pair indefinitely (5 per call, 6 calls/min, until the daily cap) and a rotated session got a fresh principal. `filter:'open'` and `yourOpenProposals` counted only `proposed` rows. A group therefore reappeared, or the count dropped, the moment a person accepted or rejected, which told the judge "a human reviewed this" (T42). | **Fixed in spec**: the same principal's pair in any terminal status → `duplicate`; `yourProposals` counts every status; the queue puts proposals on already-decided pairs into a collapsed "Already decided" group with Reject only (a UI filter, invisible to the judge). The residual for rotated principals is the UI collapse plus the rate and daily caps. |
| AR-7 | Medium | Judge pair queue rows showed `#chosen > #rejected` and a rationale. Nothing required the reviewer to see the two responses before Accept, so a person could accept a flipped pair by reading the agent-written rationale alone. | **Fixed in spec**: expanding a row renders the compare view, and Accept is enabled only after both responses were shown; bulk follows the same rule for "expanded". |
| AR-8 | Medium | **Blind-rule gap in the DOM.** The new Pairs tab renders human ratings, suggestions and `pairedWith`. A Chrome built-in agent acting as judge on the same `#llm` tab (ACT-1 = ACT-7) reads them from the DOM, which defeats the tool-level blind rule for pairs (T42/T37). | **Fixed in spec**: hidden mode while any judge-tool grant is live, revealed by an `isTrusted` click. After the reveal, the T34 residual applies as before. |
| AR-9 | Low | `suggestedBy` was sent by the client, so a page agent could record `none` for a pick that followed a judge suggestion and undo Q5's later filter. | **Fixed in spec**: the server derives it; the key is refused. |
| AR-10 | Low | `propose_pairs` accepted `criteria` but `dpo_pairs` had no column for it. The input was either dropped silently or needed an unspecified store, and its keys were agent-chosen. | **Fixed in spec**: the input is removed (strict schema → `invalid_args`). |
| AR-11 | Low | The judge never sees `system_prompt` or `tool_defs_json` for any call type (`judge-reads.ts:10,170`). Revision 1 justified the call-type filter by "must not learn that two unreadable prompts are equal", but every judge-path group already reveals that two hidden system prompts and tool lists were equal. | **Rationale corrected in spec; open question for Jd (Q15)**, recommended to accept as a residual: one equality bit over inputs the judge cannot choose. |
| AR-12 | Low | Withdraw (new) and Revoke had no agent-presence record or hold control. A page agent could silently erase clean human pairs, or reverse them so that an agent-present version supersedes the clean one, and take them out of the default export. | **Fixed in spec**: `review_agent_present` recorded on withdraw, a hold plus `isTrusted` on the controls, a "changed while an agent had access" marker and **Re-pick**. Residual: the clean pair is out of the default export until the person re-picks (same as annotations). |
| AR-13 | Low | `list_pair_candidates` (a read) triggered the lazy backfill. That puts DB writes and hashing of large prompts on an agent's schedule (T44). | **Fixed in spec**: only the human path backfills; the judge path reports `indexing`. |
| AR-14 | Low | The rubric version is not re-checked when a card is approved (`commitProposalOperation`, `engine.ts:1094-1115`), so pairs approved after a rubric bump store a stale `rubric_version`. Pair op args reusing `items` could also reach `insertProposals`. | **Fixed in spec** for `propose_pairs` (`stale rubric_changed`; args key `pairs`; branch by tool name). **Open question for Jd (Q17)**: the same check for `propose_judgments` (P4a follow-up). |

Checked and found sound (no change): the insert guard and allow-list triggers (judge rows can only be born `proposed`; review fields change only with a status change); the `samePrompt` byte check at write and at export for every source; the `pair_uid` server generation; no hard deletes of `llm_interactions` anywhere in `src/` (so ids are never reused, and `foreign_keys = ON` is set in `src/db/database.ts:52` for the cascade); `created_via` taken from the tool and the server-derived transport; the card showing ids only; `isWriteTool` keeping `propose_pairs` off client tokens while auth is off; viewers 403 on every write.

Not addressed (accepted, already in §3.6 or #160 §7): with auth off, a local process can forge browser proof and write clean human pairs (ACT-4/ACT-9 shell). An agent can wait out 2 quiet hours. Preference cycles (A>B, B>C, C>A, all accepted) are possible and are deferred to the Q8 pair-metric work.

**Verdict after amendment:** no unresolved high findings. AR-2, AR-3 and AR-5 are fixed in the design. AR-3 carries the open sequencing question Q16, which decides where the fix lands, not whether it lands. Q15 and Q17 are low.
