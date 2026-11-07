# Chat workspace: a chat / files split for the dashboard

Date: 2026-10-28
Branch: `feat/chat-workspace` (worktree `.claude/worktrees/chat-workspace`). First cut off `release/0.10.0`; rebased onto `main` on 2026-11-07 after 0.10.0 shipped (D18)
Decisions: `specs/chat-workspace-DECISIONS.md` (binding; read first)
Background: `docs/research/2026-10-28-lfm3-webgpu-workspace-teardown.md`
Status: Phase 1 in build (D18). Later phases are plan only. Each phase has a gate, and the build waits for Jd's go.

## 1. Goal

Put a workspace next to the dashboard chat, the way coding desktops put files next to the conversation. The model can look at the user's data as files, compute over them, and write reports and notes the user can open, edit and export. Every change to the books still goes through the existing tools and approval cards.

One sentence for the docs: *the chat gets a desk; the ledger stays locked.*

## 2. Non-goals (v1)

- Writing back to the books from file edits (no CSV-diff → mutation mapping). See D1.
- The LFM3 GGUF runtime. Its license is unclear (teardown §2). The pane works with any model.
- Cross-Origin Storage. It goes behind a flag in a later phase (D12).
- Running Python, Node or the network inside the shell.
- New mutating tools.

## 3. Shape

```
Browser (dashboard)                                   Wilson server (same machine)
+------------------------+----------------------+     +-------------------------------+
| Chat                   | Files | Editor | Sh  |     | SQLite ~/.openaccountant      |
|  hybrid subagent  <----+--> just-bash VFS     |     |  workspace_files (v40)        |
|  or /api/chat          |   /data  (read-only, |     |  transactions, rules, ...     |
|                        |     in memory, built |     |                               |
|                        |     from the mirror) |     |  /api/workspace/*  (canWrite) |
|                        |   /workspace (rw) <--+-----+-> version checks (sha256)     |
+------------------------+----------------------+     |  server agent: same 4 tools   |
                                                      +-------------------------------+
```

- **`/data/`**: built when each run starts, from the wa-sqlite mirror (`src/dashboard/ui/src/store/`), with the current dashboard filter window (D19) and a row cap. Read-only, kept **in memory only**, never saved anywhere. The server agent doesn't need it because it queries the real database.
- **`/workspace/`**: reports, notes, what-if sheets. Saved **on the Wilson server** in SQLite and cached in the browser. The browser and server agents read the same files.
- **Tools:** `read`, `write`, `edit`, `bash`, with the Space's contracts: `edit` must match exactly once, a non-zero exit throws, and output is cut at 6,000 characters with a hint. Writing under `/data` returns "use the categorize/rules tools to change data".
- **Shell:** just-bash in `hardened` mode with the Space's limits (10 s, 3,000 commands, 16 MB, 256 KB output).

## 4. Phases

Each phase ends with a commit series on this branch and a gate. Phases 2–4 also get the content beats in `docs/journal/2026-10-28-chat-workspace-content-series.md`.

### Phase 0: Plan and decisions *(this commit series)*
- Teardown, plan, decisions and content outline committed.
- **Gate:** Jd reviews `specs/chat-workspace-DECISIONS.md` and overrides any defaults.

### Phase 1: Agent-loop hardening (no UI)
Reimplement teardown §3 patterns 1–4 in `src/dashboard/ui/src/hybrid/subagent-runner.ts` and `subagent-core.ts`. These are fresh implementations, not ports.
- Failed-call memory: the same `{tool,args}` failing twice gets the "already failed" message, and the memory clears after a success.
- Tool failure is an exception; the runner sets `is_error` on the result.
- Stopped partial replies are left out of the model history. Context overflow is a typed error, never a silent trim.
- Stable prefix: instructions and tool schemas are ordered so they stay the same across turns, and a test asserts it. (Real KV reuse depends on the engine. transformers.js support is measured, not assumed.)
- **Gate:** `bun test` and typecheck green. No change to the router bars from browser-subagent Round 4.
- **Ships alone (D18):** Phase 1 has no UI and no flag, so it goes to `main` on the 0.10.1 train ahead of the pane, not to `release/0.10.0`.

### Phase 2: Server workspace API *(server first)*
- Migration **v40** `create_workspace_files` (D9): `(user_id, path, content, sha256, size, updated_at, deleted_at)`, unique on `(user_id, path)`.
- Routes in `src/dashboard/api.ts`:
  - `GET /api/workspace` (manifest)
  - `GET /api/workspace/file?path=`
  - `PUT /api/workspace/file` with `If-Match: <sha256>` (returns 409 on mismatch, plus the current version)
  - `DELETE /api/workspace/file`
  - `POST /api/workspace/export` (zip or JSON, chat history excluded)
- Rules, per the hardening rounds (D4–D7):
  - Writes need `canWrite`. Viewers can read only.
  - Ownerless writes are denied when auth is on (#159).
  - The grant is checked at write time.
  - `onWriteRevoked` cancels writes in flight.
  - Deactivating or deleting a user removes their workspace.
- Path rules (D6): normalize, stay under `/workspace`, and reject `..`, absolute paths, null bytes, control characters and names over 255. There are no symlinks server-side.
- Caps (D7): 1 MiB per file, 16 MiB and 2,000 files per user, all enforced on the server.
- Routes are origin-gated the same way as the sync routes (#160).
- **Gate:** route tests copied from the hardening suites (role matrix, ownerless, revoke mid-write, path fuzz, quota, 409 conflicts). Plain `bun test` at 0 failures.

### Phase 3: The pane
- Split layout in the React dashboard: chat on the left, a resizer, then file tree, editor and shell on the right. Under 768 px it becomes **Chat | Files** tabs (D11). The resizer gets keyboard support and aria attributes.
- just-bash runs in the hybrid worker. `/data` is built from the mirror when a run starts, and the file tree shows "generated HH:MM · window · N rows".
- `/workspace` cache: in-memory or IndexedDB, synced with the server's version checks. Stale writes get a conflict banner with a choice: keep mine, take theirs, or save as a copy.
- Import (text only, 1 MiB) and export.
- The static demo build has no server, so it saves `/workspace` to IndexedDB under the existing demo/persona rules (D10).
- Add `navigator.storage.persist()` at model load (D12).
- **Gate:** Playwright run (load, run a file task, edit, conflict across two tabs, phone width, axe pass). The recording is reused for the video (content beat 3).

### Phase 4: Server-agent parity and handoff
- The same four tools in the CLI agent (`src/agent/`) over `workspace_files`. On the server, `bash` also runs just-bash under the same limits; no host shell is ever involved.
- Handoff from the browser subagent to `/api/chat` carries the workspace paths only. The server reads the files itself.
- **Gate:** a handoff test where the browser writes `report.md` and the server agent reads and edits it, with the version check honored.

### Phase 5: File-task eval and gate
- About 30 graded file tasks, written by an agent that never sees the implementation. Expected answers come from SQL against persona data, not from the model.
- Measure:
  - model-computed totals that match SQL exactly
  - `edit` exactly-once failure rate
  - tasks finished within the round limit
  - prompt-injection probes in file contents (must never trigger a mutating call without a card)
- **Bars (D8):** 0 mutations without approval, and ≥ 95% exact totals before the UI drops the "model-computed" label. Below that bar the label stays, and the feature can still ship flag-on as an analysis tool.
- **Stop rule:** two rounds. If the bar isn't met, the label stays permanently and tuning stops.

### Phase 6: Review and merge
- Opus security review (auth, paths, injection, wipe) and fix rounds as needed.
- Squash into a **local** candidate branch off `main` for the next release train (0.10.0 has shipped; D18). **Jd pushes.**
- The pane ships behind `workspace.enabled`, default off (D21). No `wilson workspace` TUI commands in v1 (D20).

### Later, flag-gated
- `/proposals/*.json` checked against the mutating-tool argument schemas, applied as one batched approval card.
- A Cross-Origin Storage check before the weight fetch (teardown §6).
- A LFM3 GGUF runtime arm, if the license clears and the scratch benchmark (tok/s, load time, tool accuracy on dev sets) beats the current engine.

## 5. Risks

| Risk | Mitigation |
|---|---|
| A new write endpoint in the area the hardening rounds kept breaking | Server phase first, tests copied from the hardening suites, Opus review before merge |
| Model-written totals are wrong but look official | "Model-computed" label plus the Phase 5 gate. Deterministic tools stay the source for totals in chat answers |
| Injection through file contents | No new mutating tools, the approval card stays the defence, injection probes in the eval |
| just-bash sandbox claims | Audit before Phase 3 merges. Hardened profile, no network or host access |
| Migration number clash with open-jev (v34+) | v40 claimed in D9 and recorded in `src/db/migrations.ts` comments when built |
| Bundle size (+1.2 MB for just-bash) | Lazy-load in the worker only when the pane opens. Measure in the Phase 3 gate |

## 6. Done means

- A user opens Files, asks "make a monthly dining report", and gets `/workspace/dining-2026.md`, saved on their own machine, editable, and readable by the CLI agent.
- No path exists from a file edit to a changed transaction without an approval card.
- Logging out, deactivating or deleting a user leaves no copy of their workspace or data behind in the browser.
