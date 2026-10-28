# Decisions for docs/plans/2026-10-28-004-chat-workspace-plan.md (2026-10-28)

Binding for implementation.
- "Jd" = Jd accepted it in the 2026-10-28 planning conversation ("fold all this in").
- "default" = orchestrator default that Jd may override before Phase 1 starts.

| # | Question | Decision | By |
|---|---|---|---|
| D1 | Can file edits write back to the books? | **No, not in v1.** `/data` is read-only. Changes to the books go only through the existing mutating tools and approval cards. A `/proposals/*.json` path comes later, behind a flag. | Jd |
| D2 | Where does `/data` live? | In browser memory only, rebuilt from the mirror at the start of each run. Never saved in the browser or on the server. | Jd |
| D3 | Where does `/workspace` live? | **On the Wilson server** (same machine, SQLite), cached in the browser. Folded into v1, not added later. | Jd |
| D4 | Who can write? | `canWrite` roles. Viewers read only. Ownerless writes denied when auth is on (matches #159). Grant checked at write time. Writes in flight cancelled through `onWriteRevoked`. | Jd |
| D5 | Wipe | Deactivating or deleting a user removes their `workspace_files`. Logout or auth switch clears the browser cache along with the mirror. | Jd |
| D6 | Path rules | Normalized, under `/workspace`, no `..`, absolute paths, null or control characters, or names over 255. No server-side symlinks. | default |
| D7 | Caps | 1 MiB per file, 16 MiB and 2,000 files per user, enforced on the server. Tool output cut at 6,000 characters. | default |
| D8 | Model-computed totals | Labelled "model-computed" until the Phase 5 eval reaches ≥ 95% exact against SQL with 0 unapproved mutations. Two-round stop rule. Deterministic tools stay the source of totals in chat answers. | default |
| D9 | Migration number | **v40** `create_workspace_files`. v34–v39 stay free for open-jev. | default |
| D10 | Static demo build | `/workspace` saved to IndexedDB (no server), under the demo/persona rules. No Demo tab (standing rule). | default |
| D11 | Phone layout | Under 768 px: Chat \| Files tabs. | default |
| D12 | Weight caching | `navigator.storage.persist()` at model load in v1. Cross-Origin Storage check later, behind a flag. COS is never used for user data. | Jd |
| D13 | Model / runtime | The pane works with any model and uses the current hybrid engine plus `/api/chat`. The LFM3 GGUF runtime is not vendored until upstream publishes source and a license. Benchmark in scratch only. | Jd |
| D14 | Conflicts | Version checks on the server (`If-Match` sha256 → 409). The UI offers keep mine / take theirs / save as copy. Replaces the browser-only Web Locks idea. | default |
| D15 | Export | Workspace files only. Chat history is opt-in. | default |
| D16 | Server-side shell | just-bash inside the server process with the same limits. Never a host shell. | default |
| D17 | Server to server handoff | The browser sends workspace paths only. The server reads the files itself. | default |

## Open, to ask before the build

1. Phase 1 (agent-loop hardening) can ship to `release/0.10.0` alone, before the pane. OK to split it out?
2. Default `/data` window: the current dashboard filter, or always the last 12 months?
3. Should workspace files appear in `wilson` TUI commands in v1 (`wilson workspace ls|cat|export`), or only in the server agent's tools?
4. Feature flag name and default: `workspace.enabled`, off until Phase 6?
