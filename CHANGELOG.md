# Changelog

## [v0.11.0] — 2026-11-08

### Features

- feat: restore wilson --version (kept on this branch per orchestrator) (763fe75)
- feat(docker): home-server image and compose file (67a0270)
- feat(dashboard): env-driven first boot for unattended servers (b9ee7a2)
- feat(release): single-file binaries with the dashboard embedded (3f3ed9f)
- feat(mcp): wilson mcp — stdio MCP server for Claude Desktop (ffa78dd)
- feat(keychain): Windows DPAPI and Linux secret-tool backends with loud file fallback (7fb83a0)

### Fixes

- fix(release): embed dashboard /_app assets in compiled binaries (3dc8991)
- fix(keychain): setSecret refuses db-encryption-* accounts (74246c2)
- fix(db): skip a SQLCipher dylib built for another architecture (d1baea6)
- fix(windows): run powershell, rundll32 and where by absolute System32 path (dcd787b)
- fix(keychain): never mint a DB key when the keychain read failed (data loss) (22b73fe)
- fix(mcp): re-check owner policy and kill switch on every call (717cebb)
- fix(dashboard): never log the generated admin password (0abd0f8)
- fix(mcp): contain import_file to the user's import folders (c7890b4)
- fix(mcp): fail closed when a change cannot be confirmed (b8380b4)
- fix(tools): resolve registry tools with literal requires (2d15b69)
- fix(mcp): start the stdio server with --mcp-server, not a positional 'mcp' (22e10b5)
- fix: Windows path, browser, fd lookup and cron assumptions (d81a600)
- fix(db): verify SQLCipher by probe; platform hints when running unencrypted (5cdc0c0)
- fix(webmcp): tools run when Chrome passes no options to execute (c148675)
- fix(mcp): identical retries join the pending operation instead of stacking cards (7688c31)
- fix(llm): Judge queue refreshes when an agent's card is decided (9486bb7)
- fix(security): recorded LLM interactions are admin-only with auth on; no store rebind on profile switch (bf56ea5)
- fix(dashboard): wilson --dashboard records Chat's LLM interactions (3b600af)
- fix(agent): "this month" reaches transaction_search for Ollama models too (2fb45cc)
- fix(dashboard): Ollama models in Settings -> Models say 'not installed — run ollama pull', not 'downloads on first use' (#196) (d1bd828)
- fix(dashboard): 400 instead of 500 for bad judgement cursor and malformed policy path (a1d2c1b)
- fix(review): queue shows only real decisions, honest empty state, clearer sign-in page (#191, #185, #193) (e388dda)
- fix(chat): keep first turn in new sessions (#183); title sessions with the person's question (#194) (3c4bf5b)
- fix(chat,settings): plain-language setup steps for a missing local model (#182, #189) (f6e5cf6)
- perf(dashboard): split the UI build and serve hashed /_app/ assets (mobile LCP 4.8s -> 0.92s, NN-10) (ff2f264)
- fix(import): generic CSV Debit/Credit — Amount fallback sign, 0.00 placeholders, blank rows (NN-07) (4a05e71)
- fix(dashboard): non-object JSON bodies are 400; strengthen error-hygiene tests, drop wrong NN-07 tag (1cc2808)
- fix(import): fall back to Amount column when split debit/credit cells are blank; update fixture expectations (57921f7)
- fix(embeddings): enforce no-download in the engine behind allowDownload (ddb68e8)
- fix(dashboard): compress assets and page off the event loop with async zlib; share in-flight jobs (9857d61)
- fix(import): cap top-level bank/filename, share field caps with agent tool validators, reuse isRealCalendarDate (b14fbdf)
- fix(dashboard): 400 for bad request bodies, generic 500 for unexpected errors (ae468f2)
- fix(embeddings): never download the model or block a write on embed-on-write (7dd2c0d)
- fix(dashboard): serve gzip/br for the inlined HTML and /assets/* (34de7c4)
- fix(import): validate calendar dates, field lengths and category markup on /api/import rows (0d2fced)
- fix(export): neutralise formula-leading date/amount cells in dashboard CSV export (b60e4f6)
- fix(import): don't negate signed generic CSVs that are mostly deposits (45e7f77)
- fix(import): split Debit/Credit CSV columns take precedence over amount detection (129c1da)
- fix(seed-guard): resolve HOME with realpath before requiring /private/tmp/ (4cf9d44)
- fix(dashboard): Escape dismisses a hover-opened tooltip (#208) (53d9b7d)
- fix(dashboard): tooltip tap-close, reposition on scroll/resize, flip+clamp, hoverable bubble (#208) (bb489d9)
- fix(llm): restore the Bun fetch-timeout opt-out for local calls (#209) (5b8fb75)
- fix(llm): don't retry a local call that failed slowly, whatever the error (#209) (38fac05)
- fix(llm): drop the Bun fetch-timeout workaround, it does nothing (#209) (fdf8e77)
- fix(prelabel): an offline open-jev load is a cache read, not a download (#206) (c404983)
- fix(llm): explicit local LLM timeout, no blind retry of local timeouts (#209) (cb09373)
- fix(dashboard): real tooltip on the JEV chip instead of native title (#208) (bb0df27)
- fix(prelabel): open-jev pin check works offline from the cached config.json (#207) (195900b)
- fix(prelabel): a cached open-jev load is not reported as a download (#206) (c48cb87)
- fix(categorize): fan out LLM batches with bounded concurrency (#202) (ecf4e86)

### Other

- Merge pull request #212 from openaccountant/release/0.10.1 (a3d12b8)
- Merge pull request #216 from openaccountant/integration/0.10.1-easy-install (bcdad2e)
- Merge feat/claude-desktop-extension into integration/0.10.1-easy-install (30ae3b5)
- Merge feat/release-binaries-docker into integration/0.10.1-easy-install (ba2850a)
- Merge feat/windows-support into integration/0.10.1-easy-install (a7131ce)
- Revert "test(webmcp): allow the documented fill_transaction_filters schema change (category_id 0 = Uncategorized, #200)" (dd57df4)
- Revert "test(dashboard): error-hygiene 500 case no longer relies on an unvalidated PATCH entity_id" (8301553)
- Merge branch 'fix/llm-local-timeout' into release/0.10.1 (37bfbde)
- Merge branch 'fix/jev-chip-tooltip' into release/0.10.1 (8245959)
- Merge branch 'fix/openjev-offline-load' into release/0.10.1 (1fa0766)
- Merge branch 'fix/categorize-fanout' into release/0.10.1 (5b79d2a)
- Merge pull request #179 from openaccountant/build/npm-files-allowlist (0e27bbf)


## [v0.10.0] — 2026-10-22

### Features

- feat(dashboard-ui): login view and central 401 handling in the React dashboard (5aed48d)
- feat(chat): run the in-tab model on Gemma 4 E2B (q4) (3ada45a)
- feat(import): full Quicken for Mac QIF exports (579efb8)
- feat: constrained decoding for local models via @huggingface/transformers-structured-output (#168) (57f2887)
- feat(webmcp): security-first WebMCP for the dashboard, with a trace judge (#160) (1e4bf43)
- feat(dashboard): live progress for /categorize in chat (68dcf94)
- feat(agent): fill named months and catch copied tool results in local runs (6a26980)
- feat(agent): local iteration prompt and tool-result echo check (433ab1e)
- feat(tools): let spending_summary report a named month for local runs (28d04c8)
- feat(agent): grow a local run's tool set across iterations and report it (77c569e)
- feat(agent): keep tools used in the last two turns selected for local models (460f31b)
- feat(agent): return the schema when an indexed tool is called with bad args (bdd05fb)
- feat(agent): select tools per request for local models (967d4cd)
- feat(agent): token-budget planner for local model prompts (e165c95)
- feat(agent): tool selector and tool cards for local models (ba29975)
- feat(local): names-only tool index for local models, callable by name (ddaef82)
- feat(review): open-jev second-opinion pre-labeler for the Review tab (B1-a, off by default) (40a9b7d)
- feat(dashboard): persist the active chat session in the URL (?session=<id>) (d3b4608)
- feat(dashboard): browser subagent infrastructure behind subagent.enabled (off) (88f03e3)
- feat(tax): Schedule C export (XLSX/CSV) from flagged deductions (0cbdcb4)
- feat(logger): OA_LOG_FILE moves the debug log (674ea53)
- feat(dashboard): inline approve/deny card for approval-gated chat tools (0c5929d)
- feat(dashboard): spending drill-down with URL depth state (b70be15)
- feat(dashboard): charting foundations — URL state, spend rules, chart kit (b11b5e9)
- feat(dashboard): styled / and @ typeahead in the chat composer (81b044a)
- feat(models): refresh the Transformers.js WebGPU catalog (27600e0)
- feat: Forecast tab — Monte Carlo net-worth fan chart with live what-if sliders (#42) (d742d89)
- feat(dashboard): give WebMCP Agent access a permanent home in Settings (47d2b15)
- feat(demos): add gif companions for dashboard scenes and hero composite (7b89609)
- feat(demos): add flow2-skill custom-skill creation+run clip (db5769e)
- feat(demos): render hero composite over new September boe-demo-v2 footage (de0f841)
- feat(demos): regenerate dashboard scenes for August 2026 hero month (432fe4d)
- feat(demos): add orchestration audit-chain clip (measured beats, gemma4:31b) (f7ddcf6)
- feat(demos): add sovereignty local-run + no-cloud-calls clip (77fa4a6)
- feat(demos): add flow-goal set-and-track savings goal clip (d27b9fc)
- feat(demos): add flow3-budget set-and-track budget clip (1c4b964)
- feat(demos): add flow1 help-and-import onboarding clip (5558c74)
- feat(demos): regenerate oa-* clips via Playwright recorder (Sept refresh) (9d88b37)
- feat(demos): Playwright+ttyd terminal recorder with idle-aware beat timing (dc96b34)
- feat(demos): refresh tapes for September — August hero month, gemma4:31b (5933833)
- feat(demos): roll demo fixtures forward to August 2026 hero month (af86ec0)
- feat(demos): add granite4.1:8b demo videos, fixtures, and ideation (ade0305)

### Fixes

- fix(agent): mark a turn failed only when no model call returned (#177) (a774ba7)
- fix(chat): mark a /categorize run nothing answered as failed (#177) (bd8fe2e)
- fix(chat): empty a user's session approvals in place so a revoke reaches the live run (#172) (304369e)
- fix(chat): no provenance badge on a failed turn (#177) (374b795)
- fix(chat): keep 'allow-session' approvals per user (#172) (514369d)
- fix(dashboard): wipe a pre-0.10 mirror with no recorded owner before the app opens (6531fa9)
- fix(mcp): a damaged agent-access.json also kills grants up to the moment it is read (57402b9)
- fix(chat): catch un-$ and k-suffixed figures in the in-tab answer check; allow echoed question figures (a3decb9)
- fix(chat): compute in-tab totals under the dashboard spend rules, and fit them without cutting (70bdedf)
- fix(chat): hand off an in-tab answer whose $ figure the app did not compute (48c0bc3)
- fix(chat): give the in-tab model computed month totals over a calendar window (d1b9ff4)
- fix(llm): let callLlm own retries so an unreachable model fails in seconds, not ~40 s (8630e87)
- fix(entity): stop an approved entity_classify once its run loses write rights, and drop session approvals on demotion (3d5bbba)
- fix(dashboard): re-check a chat run's write rights at every write, so a demotion mid-run takes them away (b8b9b49)
- fix(chat): say "on another machine" for a LAN Ollama instead of "cloud model" (d8e6bad)
- fix(chat): wait for the in-tab model while it downloads unless the server's model is local (58b985e)
- perf(chat): publish the in-tab model status only when its label changes (eafccd6)
- fix(webmcp): end the bridge session on a 401 from its state and operation polls (9af4fd8)
- fix: show why removing a dashboard user failed instead of swallowing it (9696792)
- fix: let a mirror wipe in flight finish before the pool can reopen (567c040)
- fix: wipe every mirror pool on disk when the session ends, not only the recorded ones (a693c79)
- fix: never unlock an offline mirror from a profile-less "auth off" answer (31b8a37)
- fix: wipe the offline mirror on a user switch even with another screen in between (1d3fcb6)
- fix: make the mirror wipe hold up against open access handles, and close the remaining offline-copy gaps (b801257)
- fix: resync WebMCP tools when the dashboard signs in again in place, and drop them at once on logout (f1fdf05)
- fix: wipe the dashboard's offline ledger copy when the session ends, and keep it locked without a login (118a1ce)
- fix: compare session expiry as instants and refuse to remove the last admin (3f599db)
- fix(chat): answer on the server while the in-tab model downloads (483ead6)
- fix(showdown): warm Qwen3 0.6B, not Gemma 4 E2B, in the server local arm (391b4ce)
- fix(chat): stop calling Ollama cloud models and remote Ollama "on your laptop" (3034f95)
- fix(webmcp): calls that reach the server after the kill switch get its message and a denied_kill_switch row (f54e5c2)
- fix(webmcp): the Transactions filter form is a page tool, fill_transaction_filters (#163) (cf976be)
- fix(webmcp): update_transaction refreshes the search embedding on a description change (#162) (bb5159f)
- fix(webmcp): get_spending_summary compares with the previous period by default (#161) (6a73f07)
- fix(dashboard): legacy dashboard stores its session under wilson_auth_token (59f5c8b)
- fix(chat): no provenance badge on a failed chat turn (f572d8d)
- fix(chat): count cloud task-model pins in the provenance badge (#167) (65f9ce1)
- fix(chat): make the provenance badge say where the server model runs (#167) (d0b4ea9)
- fix(models): stop offering Qwen3 1.7B as a WebGPU model (#154) (d09285a)
- fix(dashboard): stop doubling the origin in the React chat's hybrid client URLs (d3d9b42)
- fix(llm): reveal blind labels on click, not pointerdown (60017e0)
- fix(webmcp): show the agent's values in the propose_judgment form (40d70b3)
- fix(webmcp): draw the approval card above an open modal dialog (d763b4b)
- fix(llm): pass system prompt via instructions (AI SDK 7 rejects system messages; broke /categorize on Ollama) (423c5b2)
- fix(dashboard): close auth-switch and held-request races; approval hygiene (594ca73)
- fix(training): linear-time handoff scanning; never show an unverified handoff body to the judge (8ae6cc1)
- fix(training): HMAC-tag real handoff blocks so pasted or typed markers can't forge or hide one (a53ab18)
- fix(webmcp): run the live-seed HOME guard before any app module loads (b903db5)
- fix(dashboard): re-check auth after /api/chat reads its body (381d188)
- fix(export): quote CSV fields containing a carriage return (1141952)
- fix(deps): replace xlsx with write-excel-file for spreadsheet exports (2f7d227)
- fix(agent): drop a current-year year from local transaction_search queries (1d63163)
- fix(export): neutralise spreadsheet formula injection in CSV/XLSX exports (b26a9c4)
- fix(hybrid): detect bare and fenced JSON tool calls so they hand off instead of showing raw (35a9036)
- fix(agent): gate writes inside chains/teams, trust only user-listed read-only MCP tools, viewers can't approve writes (closes #156) (f607718)
- fix(agent): don't pack the keyword fallback under the tool budget (4a98685)
- fix(local): keep tool calls followed by text, map skill names to skill, trim local prompt (02c8fd2)
- fix(dashboard): coherent /categorize answer when only held rows remain, backlog note without a limit (0e17257)
- fix(dashboard): /categorize chunks skip transactions held for review (ff0b892)
- fix(agent): require approval for every mutating agent tool, fail closed (closes #152) (0f22b2d)
- fix(mcp): honour grant and operation expiry to the second (052b9de)
- fix(dashboard): stop webmcp-bridge polling constantly and double-showing chat approvals (f96b851)
- fix(dashboard): harden legacy renderMd against attribute injection and unsafe hrefs (4916a8a)
- fix(dashboard): /categorize on a local model works in chunks of 50 (43e4a8a)
- fix(test): run every test against a throwaway home dir (13d91c1)
- fix(categorize): local models categorize in small batches with room to answer (84cb35f)
- fix(dashboard): wilson --dashboard exits on SIGTERM and SIGINT (51e2cfa)
- fix(model): local models fail fast with a reason and get a prompt they can run (d3ac72e)
- fix(dashboard): /categorize always answers — direct tool path and a chat deadline (2fc9e32)
- fix: profile switching, dashboard add-profile, and Quicken CSV import (fe52234)
- fix: light bug sweep across the dashboard, reports and importers (cb83db7)
- fix(transformers): offline fallback, clear Hub and cache errors, sticky-failure fixes (2456442)
- fix(transformers): resolve ONNX dtype per repo instead of hardcoding fp16 (aca3af5)
- fix(chat): never show Qwen3 <think> reasoning as the local answer (e271c07)
- fix(dashboard): polyfill Buffer so the production bundle stops white-screening (f1f50ad)
- fix(demos): restore dithering for the 3 dashboard gifs (3688775)
- fix(demos): shrink all gif companions under 1.5MB (82cdfaf)
- fix(demos): trim broken lead-ins on 4 clips (fa6f69a)
- fix(demos): repair demo pipeline for repo move and broken beat timers (166bfdb)

### Other

- Merge pull request #178 from openaccountant/ci/release-ui-deps (3e80578)
- Merge pull request #142 from openaccountant/release/0.10.0 (75ffe03)
- Merge branch 'fix/0.10.0-issue-177' into release/0.10.0 (72f0cdb)
- Merge branch 'fix/0.10.0-issue-175' into release/0.10.0 (1ef33e2)
- Merge branch 'fix/0.10.0-issue-172' into release/0.10.0 (6474444)
- Merge branch 'fix/gemma-in-tab-totals' into release/0.10.0 (69ab931)
- refactor(dashboard): move the chat provenance labels server-side (826274d)
- refactor(webmcp): one naming convention for dashboard WebMCP tools (3d4a376)
- Merge pull request #143 from openaccountant/docs/readme-demos-logo (1bc5ae4)
- Merge remote-tracking branch 'origin/demos/granite-demo-videos' into docs/readme-demos-logo (9ae8c25)
- Merge PR #138 (927bcb5)
- Merge PR #139 (42cb567)
- Merge PR #137 (27fccaa)
- Merge PR #136 (5129c65)
- Merge PR #135 (67ca64c)
- refactor(demos): fold data/demo/ entirely into demos/, delete dead cruft (79e313b)


## Unreleased

### WebMCP tool names, one convention (BREAKING for `/mcp` clients)

**Fifteen of the 26 dashboard WebMCP tools were renamed to one `verb_object` convention.** Seven of them were in v0.9.x: `tax_flag` is now `set_tax_flag`, `edit_transaction` is `update_transaction`, `transaction_search` is `search_transactions`, `spending_summary` is `get_spending_summary`, `profit_loss` is `get_profit_loss`, `net_worth` is `get_net_worth` and `forecast` is `get_cash_forecast`. There is no alias: a call to an old name is refused with `unknown_tool` and a "renamed to" hint, and the hint grants nothing. 0.10.0 already requires every `/mcp` client to mint a new `wmcp_` client token, so mint one in Settings -> Agent access and use the new tool names in the same step. The other eight (`tax_summary`, `filter_transactions`, `review_action`, `set_forecast_inputs`, `navigate_to_tab`, `list_review_queue`, `propose_judgements`, `judge_interaction`) never shipped; the entries below use the new names.

- Nothing else about the tools changed: classification, roles, policy defaults, transports and schemas are the same (the schema digest is identical for every tool a client token can hold).
- Your settings carry over without a migration. At startup Wilson copies each Off/Ask/Allow choice to the new name (the stricter value wins) and keeps the old-name row as a mirror, so another build on the same data folder still enforces an Off. Live grants and client-token grants, and pending approval cards, move to the new names. The Activity log is never rewritten: old rows keep their name and show "(now <new name>)".
- Dashboard chat tools keep their names (`tax_flag`, `edit_transaction`, `transaction_search`, `spending_summary`, `profit_loss`, `net_worth`); no WebMCP name equals a chat tool name any more.

| Old name | New name |
|---|---|
| `tax_flag` | `set_tax_flag` |
| `edit_transaction` | `update_transaction` |
| `tax_summary` | `get_tax_summary` |
| `transaction_search` | `search_transactions` |
| `spending_summary` | `get_spending_summary` |
| `profit_loss` | `get_profit_loss` |
| `net_worth` | `get_net_worth` |
| `forecast` | `get_cash_forecast` |
| `filter_transactions` | `list_transactions` |
| `review_action` | `resolve_review_item` |
| `set_forecast_inputs` | `fill_forecast_inputs` |
| `navigate_to_tab` | `open_tab` |
| `list_review_queue` | `list_review_items` |
| `propose_judgements` | `propose_judgments` |
| `judge_interaction` | `propose_judgment` |

### WebMCP judge for LLM traces and training data (P4a)

**An agent can now propose ratings for your recorded model calls, and nothing it proposes is used until you accept it.** Grant the judge tools in Settings -> Agent access like the others; with no grant none is registered. They live on the LLM tab and the reads also work on `/mcp`.

- `list_interactions`, `get_interaction`, `get_judge_rubric` (read): list the calls to judge, read one in sections (an overview, or its prompt, response or tool calls in pages of up to 1,200 characters), and fetch the rubric and its version. The judge is blind: no output ever carries your rating, preference, notes or tags, or whether you rated the call. It never sees the system prompt (your memories and custom prompt), and tool results show only as an 80-character preview with their size. Text comes wrapped as `untrusted_text` with hidden characters stripped and digits, emails and phone numbers masked. The grant row says "Includes your chat history and financial data", and every page counts against the daily read budget.
- `propose_judgments` (proposal, Ask by default, admin only): up to 20 ratings per call with a 20-600 character rationale, a model name the agent declares, and the rubric version it judged by (an old version is a 409 `rubric_changed`). It writes only inert `proposed` rows. Limits: 6 calls a minute (shared with the form) and `judgeDailyLimit` items a day (default 300, set only in Settings -> admin, never by a tool).
- `propose_judgment` (proposal, a form in the Training detail panel, "Agent judgement"): the single-item version. An agent submits it; a person cannot, whatever the form was filled with.

**Judge queue** (LLM -> Judge queue): each proposal shows the declared model, the agent-written rationale as plain text with links removed, criteria and tags, and your own rating beside it (red border when it is two stars or more apart). Accept needs a real click after the row has been on screen for 0.8 s; Reject is one click; Revoke undoes an accepted one. Bulk Accept takes at most 10 rows you expanded, behind a confirm and a 0.6 s press-and-hold. The server refuses to accept a proposal younger than 1 s. The header shows agreement with your ratings and the number of **blind** proposals it is measured on (not counting the form, nor a call made after the agent opened that interaction's panel). Stats now read "SFT-ready runs", "Complete DPO pairs" and "Judge: proposed / accepted".

**Training export defaults changed.** The default SFT and DPO export is **human labels only**. Each of these is its own checkbox in the new Export options block, unchecked on load and reset after every export (checking one makes the download a press-and-hold; the file goes through `fetch` with your login, not a `?token=` URL):
- "Include accepted agent judgements" (`includeJudge=true`): adds accepted judge rows for interactions you did not rate yourself. A human rating always wins over a judge on the same interaction. Proposed, rejected, revoked and superseded rows are never exported.
- "Include ratings made while an agent had access" (`includeAgentPresent=true`): a rating you clicked while an agent held a live grant is marked `AGENT PRESENT` and left out by default, because the page cannot tell your click from an agent's.
- "Include prompts with on-device assistant notes" (`includeHandoff=true`): the browser subagent puts an untrusted notes block in the prompt it hands to the server agent. Runs and pairs whose prompt carries that block are left out unless you opt in; the judge sees it as a marked, shortened excerpt. The response header `X-Wilson-Export-Provenance` says what a file may contain (`human`, `human+judge`, ...).

**Annotation fixes.** Annotating is versioned: a new rating inserts a new version and supersedes the old one, and fields you do not send are kept (a rating-only save no longer wipes your notes). Rows are never deleted, and database triggers allow nothing but a status change (and the review stamp) on a row. `POST /api/interactions/:id/annotate` validates its body: a bad rating is a 400, an unknown interaction a 404 (it used to answer 200 `{success:false}`). "SFT ready" counted rows; it now counts the runs (SFT lines) an export would write, and "DPO pairs" counts complete pairs only (a pair id with just one side no longer counts).

**An agent-opened panel keeps your labels out.** When an agent opens an interaction with `open_interaction`, the Training detail panel does not load your rating, preference, notes or pair id until you click or type in it (a script-made event does not count; a real click by an agent driving the browser does, the residual in threat T34).

**Review fixes.** The judge can no longer rebuild a full tool result by paging an agent run's prompt (the recorded prompt of a second iteration embeds them; that block is now replaced by a one-line note). A rating written while an agent had access stays flagged through later edits of tags or notes, and the Training panel no longer prefills it as yours: rate it again yourself once 2 hours have passed with no agent access to take it over. An accepted judgement is left out of the judge export when an agent had live access at the time you clicked Accept, unless "ratings made while an agent had access" is ticked too. `includeJudge` never pulls in a run containing an interaction you rated below the minimum. Training exports are audited with what they may contain (`provenance=human+judge agent_present=false`), the agreement figure counts one proposal per agent and interaction, and the database refuses to insert an accepted judge row.

**Browser proof and the review window for labels.** `POST /api/interactions/:id/annotate` now needs the dashboard page's browser proof (an allowlisted `Origin` and `Sec-Fetch-Site: same-origin`), like the judge queue; a request without them is a 403 `origin_required`. Whether an agent was present is decided with the same 2-hour window as an accepted judgement: a label written while an agent had access, or when the user held any grant (live, expired or revoked), raised an agent operation or flipped the kill switch in the last 2 hours, is `dashboard_agent_present`, and re-sending every label field inside the window does not clear it. Such labels stay out of the default SFT export.

**Chain and team calls are recorded.** Calls made by chains and teams are stored as call types `chain` and `team`, each with its own run id (`chain-<uuid>`, `team-<uuid>`), so the judge can read them. The default SFT export (`agent` calls only) is unchanged.

**Category names.** A custom category name now also keeps `. , ( ) +` and the curly apostrophe (so "Dr. Visits", "Kids (Activities)", "Coffee, Tea", "Gas + Electric" and "Mom’s Gifts" show as written). A colon, quote, bracket or hidden character still makes it show as `#<id> (custom)`, and the 32-character cap stays.

New routes: `GET /api/judgements`, `POST /api/judgements/:id/accept|reject|revoke`, `POST /api/judgements/bulk` (admin, same-origin browser only), and judgement actions and annotations are recorded in Activity with whether an agent was present. Migrations v32 (annotation provenance) and v33 (integrity triggers). The grant schema digests changed for no existing tool, so existing grants stay valid.

### WebMCP imperative journeys (P3)

**Six new agent tools to find your way around the dashboard.** Grant them in Settings -> Agent access like the others; with no grant none is registered. All but `list_review_items` work inside the dashboard tab only (not on `/mcp`).

- `open_tab` (any tab): switch the dashboard to another tab, by the same route as a click. Not Settings: an agent cannot open the Agent Access Center, ask the user to. It also refuses while you are in Settings, so an agent cannot pull you away from unsaved edits there. It answers once the tab shows, with the tools available there.
- `get_page_context` (any tab): where you are: tab, date range, filters, the selected row and how many rows are listed. Ids, counts and filter values only, never a description or an amount.
- `open_transaction` (Transactions): scroll to and highlight one transaction by id and return its compact row. If a filter hides it, the tab drops its own filters (and says so); if the date range excludes it, the range moves to that month (a row inside the range never changes it); the answer says whether the row is really on screen.
- `list_review_items` (Review, also offered on `/mcp`): the pending review queue, compact and paged.
- `open_review_item` (Review): pre-select one pending review in the "Resolve a review" form. It resolves nothing.
- `open_interaction` (LLM): open one model call in the Training detail panel. The agent gets its model, call type and status, never prompts or ratings.

A tab's tools exist only while that tab shows. The bridge unregisters them when you switch tabs and registers the next tab's in one pass (about 50 ms), and a page tool is registered only while the dashboard has a handler mounted for it. A call that outlives its tab answers "The Transactions tab is not open. Call open_tab with tab='transactions' first." instead of acting on a screen that is gone. Grants, Off/Ask/Allow, the kill switch, rate limits, the daily read budget and the Activity log (transport `page`) all apply as for every other tool; `open_transaction` reads a row for the page, so it counts against the read budget. Tools that change what you see are not advertised as read-only.

**BREAKING (for callers of the old routes): `POST /api/mcp/read` and `POST /api/mcp/prepare` are removed** (404). Use `POST /api/mcp/call`, with the tab session in the `X-Wilson-Agent-Session` header and the grant id as a UUID; the server answers `{kind:'read'|'operation'|'page'}`. The dashboard's own callers (the Demo auto-book request) are moved.

Under the hood: the page tools' pure logic lives in `webmcp-page-tools-core.ts` and the text hygiene rules (hidden characters, PII masking) moved to `src/mcp/text-hygiene.ts` so browser code shares them. No migration.

### WebMCP declarative forms (P2)

**Five dashboard forms are now agent tools.** A browser agent can fill and submit them like any form, but only after you grant the tool; with no grant a form carries no `toolname` and is invisible to agents. Grant them in Settings -> Agent access like the other tools. They work inside the dashboard tab only: none of them is offered on `/mcp`, and a client token cannot carry one.

- `list_transactions` (Transactions): filter by text, category and date range. The filter bar is now a form with a category picker (every category, by id) and From/To dates; people keep filtering live as they type. An agent gets up to 10 compact rows, and the table shows the same filter.
- `resolve_review_item` (Review): a new "Resolve a review" form above the table, confirm or correct one pending review.
- `set_budget` (Goals): a new Budgets section that lists the limits and sets one category's monthly limit.
- `update_goal` (Goals): a new "Edit a goal" form for target amount, target date and status (every goal is pickable, including paused and completed ones). The goal cards get an Edit button.
- `fill_forecast_inputs` (Forecast, when there is under six months of history): the manual inputs are a form; the agent is told the projected 10th, 50th and 90th percentile once the forecast has run.

Changes still wait for you. A submit by an agent on `resolve_review_item`, `set_budget` or `update_goal` goes through the same approval card as every other change, and the agent hears the outcome only after you answered it. If an agent fills a change form and something else clicks Submit, the form is treated as the agent's and still goes through the card, with the result shown under the form and an amber "Agent filled this form" banner. No change form auto-submits; only the filter and forecast forms do. A form that an agent is working gets a dashed amber outline.

Forms that people use directly
- New admin-only routes: `PUT /api/budgets/:category` with `{monthlyLimit}` (0 to 10,000,000) and `PATCH /api/goals/:id` with `{targetAmount?, targetDate?, status?}`. Viewers get 403. `GET /api/goals?status=all` lists every goal.
- Budget, goal and review confirm/correct writes record a `rest_write` row in the Activity log saying whether an agent had live access at that moment (worked out by the server, so an agent cannot hide it).
- Resolving a review now bumps the transaction's revision, so a categorize or edit card prepared before it goes stale instead of overwriting your decision.
- Option labels in these forms hold only ids, dates, amounts and safe category names: never a merchant, description or goal title. A custom category with an unusual name shows as `#12 (custom)`.

The `propose_judgment` form shell is not part of P2: it ships with its catalog entry in P4a, and the forms table here lists only the five tools that exist.

Under the hood: tools have `surface`, `exposure` (imperative or declarative) and `autosubmit`, and a new `page` class for tools whose work happens in the page; the dashboard's tab ids are one list (`TAB_IDS`) shared by the tab bar, the router and the server. No migration.

### WebMCP user control center (P1)

**Grants last 1 hour by default** (was 12 hours). Pick 15 minutes, 1 hour, 4 hours or 12 hours per profile in Settings -> Agent access. It applies to new grants; existing ones keep their expiry. A change card is also refused if you approve it less than 1 second after it appeared.

**BREAKING for scripted approvals: an approval card's Approve must be held.** It is enabled after 0.8 s, ignores script-generated clicks and key presses, and needs a 0.6 s press-and-hold; the server also refuses an approval younger than 1 s. A script or demo harness that clicks Approve once no longer approves anything: hold the button (mouse down, wait at least 600 ms, mouse up) or approve through the API from the dashboard origin.

Settings -> Agent access is now the place to control agents
- A global kill switch ("Agent access (all profiles)", admin only). Off: no tool is exposed to any agent or MCP client in any profile, every grant is revoked and pending approvals are rejected. It lives in `~/.openaccountant/agent-access.json`, so a profile switch does not turn it back on, and grants made before it went off stay dead in other profiles even after you turn it on again. Turning it back on does not restore grants, and it also revokes every client token in the active profile (a token in another profile that was minted before the switch went off stops working too). If `agent-access.json` exists but cannot be parsed, access stays off until you flip the switch in Settings.
- Off, Ask or Allow for each tool, per user. Reads default to Allow, changes to Ask, and a change can never be Allow. A tool set to Off cannot be granted, is not registered with the browser, and answers 403 `policy_off` on `/mcp`. Viewers can only set policies on read tools.
- Ask on a read: the call waits behind an "Allow read" card that shows what will run (for transaction search, the filter Wilson parsed from the query, otherwise the full arguments). Only the agent that asked gets the data, once; it is dropped after 5 minutes (or at once when you turn the kill switch off). Over `/mcp` the call waits for you the same way.
- Pending approvals, a readable Activity log (filter by tool and decision, "client-reported" transport flagged, compaction notices shown as notices), per-grant revoke, and the external-client token panel with a new editor for a token's tools, all on one page.
- The floating "AGENT ACCESS" panel is restyled and shows the same state: status dot, kill switch, this tab's grants, pending approvals and the last five calls, with a link to Settings. Both surfaces refresh within 5 seconds and at once when either changes something, including across tabs.

Dashboard responses now carry `X-Frame-Options: DENY` and `Content-Security-Policy: frame-ancestors 'none'`, so another site cannot frame the dashboard and overlay its approval controls. Tools you set to Off or Ask before turning on dashboard auth keep that setting for each new account until the account chooses its own. With dashboard auth off, Ask on a read from an external MCP client is not a real approval (anyone on the machine can answer it); Settings says so.

Approval cards
- Approve is enabled after 0.8 s, ignores script-generated clicks and key presses, and must be held for 0.6 s. The server refuses an approval younger than 1 s (409 `approval_too_fast`) and the operation stays pending.
- A transaction's description now has its own quoted row on the card instead of sitting inside the summary sentence.
- Offline, nothing under `/api/mcp/` is served from the local mirror.
- A new card appears above the ones already showing, so the card you are reading never moves.

Migrations: v30 `mcp_tool_policies`; v31 adds `kind` and `bank_data` to `mcp_operations`.

### WebMCP network boundary and client tokens (P0b)

**BREAKING: `/mcp` needs a client token.** The tab's session id is no longer accepted as a bearer: it answers 401 with a message pointing here. Mint a token in Settings -> Agent access -> External MCP clients, shown once, then put it in your MCP client config as `Authorization: Bearer wmcp_...`. Tokens are per profile.

**BREAKING: while dashboard auth is off, `/mcp` client tokens are read-only.** A token can carry read tools only, and the write tools of an existing token are hidden and refused, so an external client can never approve its own change. To let an external agent write, turn on dashboard auth for the profile (auth on and at least one active admin), then mint a token with the write tools.

**BREAKING: the dashboard binds 127.0.0.1.** To serve it on a network, set `WILSON_DASHBOARD_HOST` (or `dashboardHost` in `~/.openaccountant/agent-access.json`), turn on dashboard auth for the profile first (auth on AND at least one active admin user: turning the flag on with no users does not count), and list the names you use in `WILSON_DASHBOARD_ALLOWED_HOSTS` and `WILSON_DASHBOARD_ALLOWED_ORIGINS`. With the dashboard on the network, startup refuses to run while the active profile has auth off or no active admin (the CLI prints the reason and keeps running without a dashboard), every request answers 503 `lan_auth_required` if that stops being true, `/api/auth/setup` only answers a loopback peer, and switching to a profile without auth and an admin answers 409. Only `localhost`, `::1` and literal 127.0.0.0/8 addresses count as loopback binds; a name like `127.example.com` is a network bind. Unauthenticated `/mcp` calls are audited by tool name only (their arguments are never previewed, and PII masking is linear-time and size-bounded), and the `/mcp` 4 MB body cap is enforced while streaming, so a chunked body cannot skip it.

**BREAKING: the dev UI needs `WILSON_DASHBOARD_DEV=1`.** Start the dashboard server with it when you use `npm run dev` in `src/dashboard/ui`; the dev UI now reaches the server through vite's proxy, same-origin.

Network boundary
- Every path checks `Host` (`localhost`, `127.0.0.1` or `[::1]` on the server's port, or an allowlisted name): anything else is a 421, which closes DNS rebinding.
- CORS reflects only allowlisted origins; the `Access-Control-Allow-Origin: *` is gone. A foreign `Origin` gets no CORS headers.
- A POST, PUT, PATCH or DELETE under `/api` is a 403 when its `Origin` is not allowlisted (`Origin: null` included) or `Sec-Fetch-Site` is not `same-origin`/`none`. This stops text/plain cross-site and other-localhost-port requests.
- Grant and tool routes no longer assume `http://localhost:<port>` when `Origin` is missing: a browser request must carry an allowlisted `Origin` or `Sec-Fetch-Site: same-origin`, else 403 `origin_required`. Approve, reject, grants and client-token routes need both headers, which stops a naive `curl` from an MCP client's shell tool. Only enabling dashboard auth closes the gap against deliberate header forgery.
- `?token=` is accepted only on `GET /api/export/*` downloads.
- The server's idle timeout is 255 s so a `/mcp` call waiting for your approval is not cut off.

Client tokens (migration v29)
- `wmcp_` plus 32 random bytes; only its sha256 is stored. Revoke or rotate any time, effective at once; mint and rotate are limited to 5 per hour per user. Choose 1, 7, 30 (default) or 90 days.
- A token carries only tools offered on `/mcp`. While dashboard auth is off a token can carry read tools only, so an external client can never approve its own change; viewers mint read tools only. Turning auth off later hides and refuses the write tools of existing tokens.
- Every use re-reads the owner: a deactivated user's token is a 401, a demoted user loses the write tools, and a profile switch makes the token unknown.
- A write call over `/mcp` waits up to 240 s for your answer, then returns `outcome: "unknown"` with the operation id. The new `get_operation_result` tool (only on `/mcp`, only for operations that token created) returns the outcome later. An approval card names the token that asked.
- `/mcp` failures: a request without a valid token is a 401 and, per address, 10 per minute before a 429 (a valid token is never limited by that). A foreign `Origin` on `/mcp` is a 403.
- An unauthenticated `/mcp` request reads at most 64 KB of body for at most 2 s (only to audit tool names), is not read at all when `Content-Length` is larger, and holds its connection 10 s rather than 255 s. A valid token's own refused calls (bad arguments, tools it does not hold) have a per-token bucket (20 per minute, 10 back to back) and then get a 429, without affecting other clients.
- Rotate is owner-only: an admin can still revoke another user's token but cannot rotate it (the new credential would be attributed to that user).
- An operation an external client raised while auth was on goes stale (`auth_disabled`) if auth is turned off before it is approved.

Network boundary hardening
- With `WILSON_DASHBOARD_DEV=1` the vite origins (`:5173`) are still accepted for state changes and browser proof, but never get CORS headers, so another app on that port cannot read your ledger. Only the server's own origins and `WILSON_DASHBOARD_ALLOWED_ORIGINS` do.
- A malformed `Host` is rejected (421/400, empty body) before the URL is parsed, and the server runs with Bun's development mode off and a generic 500 handler, so no error page can leak source paths.

### WebMCP core hardening (P0a)

**BREAKING: existing agent grants stop working.** Tool schemas are now strict and tightened, so every grant issued against the old schemas is invalid (`schema_changed`). Grant tools again from Settings -> Agent access or the bridge panel. The `sessionGeneration` query/body parameter is deprecated and must now be a UUID v4; the tab session id travels in the `X-Wilson-Agent-Session` header.

Agent tool calls
- One server path for every tool call, `POST /api/mcp/call` (the older `/api/mcp/read` and `/api/mcp/prepare` wrappers were removed again in P3). The server, not the client, decides read versus change.
- Arguments are validated on the server: unknown arguments, bad types and invisible, control or bidi characters get an actionable 400.
- `set_tax_flag` only flags and unflags; reading tax data moved to the new `get_tax_summary` tool. The MCP `get_cash_forecast` tool allows horizons up to 60 months; every other caller stays at 24.

Reads and privacy
- Read tools return compact, paged, PII-masked output (at most 1,500 characters per call, `limit` 1-25, `nextCursor`) from the request's own database.
- Card and account numbers are masked when split by spaces, tabs, newlines, dots or slashes, and when written with fullwidth digits.
- Per-session and per-user rate limits and a daily read budget (2,000 rows / 300,000 characters) apply. The budget is reserved before a read runs, so parallel calls cannot overshoot it.
- What an agent gets back about a change it proposed carries no row text: no description, notes, before/after or summary, and the result after approval is sanitized the same way as a read. Only the confirmation card shows the full change.

Approvals and ownership
- A change is never written until a human approves it. An operation past its window answers 409 `expired` and never commits; approving a change needs the admin role (with auth on, a viewer can approve only the read-ask cards of their own grants, from P1); only the owner can act on an operation when auth is on; a deactivated or demoted owner makes it stale.
- Every call re-checks the granting user, so a deactivated or demoted user is refused on every transport and deactivating a user revokes their grants.
- A chat change belongs to the user who started the chat run. If no owner is known the approval is refused and the agent is told no. Unanswered chat approvals expire and leave the queue.
- The operations API no longer returns `session_generation` or `grant_id`, and "Requested by" on the card is worked out by the server.

Audit and abuse limits
- Every agent tool call is audited in the new `mcp_audit_log` table (migration v28), reads and refused calls included, with 90-day retention by default. Refused and rate-limited calls fold into per-minute rows.
- CSV, XLSX, P&L, net-worth and training exports are GET-only and audited under a fixed route label; other methods get 405.
- `/mcp`: bodies over 4 MiB get a 413. Refusals inside a batch are audited even when another call in it ran.

Fixes
- `categorize_transaction` without `entityId` no longer clears the transaction's entity.
- A grant or operation that expired earlier the same day no longer counts as live until midnight.

The `{ kind: 'page' }` response of `POST /api/mcp/call` arrived with the declarative forms (P2) and the page tools (P3).

## [v0.9.1] — 2026-09-25

### Fixes

- fix: don't auto-approve major-version dependabot bumps (#133) (2062d91)

### Other

- Add Privacy Validator: live provider ledger + fixture-only would-be-cloud payload exhibit (#95) (#117) (21d2f34)
- Add auto-book through the visible confirmation gate (#94) (#116) (6195886)


## [v0.9.0] — 2026-09-21

### Features

- feat: offline overview — the eight approved overview cards compute from the local mirror without a server (#76) (#115) (ef450d8)

### Other

- Add dashboard Review tab to confirm or correct queued categorizations (#86) (#113) (3061c95)
- Embed on write: keep the semantic index fresh across import, sync, edit, and delete paths (#63) (#110) (be12b5b)
- Add per-response chat provenance indicator (local · server fallback · unavailable) to both dashboard UIs (#69) (#108) (8852470)
- Add statement-to-dashboard agent trace — drop a CSV and watch the offline chain run with per-step timing (#93) (#107) (ec75bff)
- Add Speed Showdown demo: race local vs cloud categorization with real trace-sourced timers (#92) (#106) (1365e1e)


## [v0.8.0] — 2026-09-21

### Features

- feat: offline dashboard transactions — sync-fed local mirror serves the transactions tab without a server (#105) (4ff32f3)

### Other

- Add what-if controls to the Cash Forecast card: 6/12/24-month horizon and ±50% income/expense assumption sliders (#81) (#114) (c834456)


## [Unreleased]

### Features

- feat: Speed Showdown demo — pick an in-repo synthetic sample transaction (incl. the Harborview $318 Health row) in a new `#demo` dashboard tab and race side-by-side real, trace-store-sourced timers for the identical categorization decision: local via the hybrid routing (browser WebGPU with separately measured load time, else the server-side transformers path, always labeled with its actual source) against a live OpenRouter round-trip when key + network probe pass, otherwise a clearly-labeled simulated round-trip whose traces carry provider `simulated` markers so they are never misattributed; the exact prompt exhibit ("what leaves your machine") contains synthetic sample rows only, the verdict line names the ms/× delta, and the caption honestly contrasts jev-ultrafast (~178 ms median request, not privacy-preserving) (#92)

- feat: statement-to-dashboard agent trace — the Demo tab gains a drop-a-statement flow that runs Wilson's offline chain as a live four-node diagram (import → local embedding lookup → category prediction → reconciliation hint), each node lit by its real server-measured duration; import reuses the /api/import substrate with file-hash dedup (re-drop skips cleanly), embeddings run the local MiniLM engine against a known-merchant/category reference, predictions are strictly display-only (nothing written), and reconciliation surfaces duplicate/spike hints over the freshly imported rows — vendored ground-truth fixture at demos/fixtures/august-2026-chase.csv (#93)

- feat: per-response provenance indicator in both dashboard chat UIs — each live answer is badged `answered locally · on-device`, `server fallback`, or a neutral `server agent` when the hybrid layer is absent; derived at send time from the exchange's actual path (never from message text), not persisted, so history-loaded messages show no badge (#69)

- feat: embed-on-write — every import (CSV/OFX/QIF, Monarch, Firefly, dashboard /api/import), sync (Plaid insert/update/remove, Coinbase), description edit (agent tool + dashboard PATCH), and delete keeps the semantic index fresh immediately, so search reflects changes without ever running `wilson --index`; embedding failures degrade to a logged warning and leave rows for the next backfill instead of failing the import or edit, and `--index` now also sweeps orphaned vectors whose transaction is gone (#63)

- feat: dashboard Review tab for the categorization queue — lists every pending review with the transaction's date, amount, description, the suggested category and its confidence (plus the currently applied category for backfilled historical rows); Confirm applies the suggested category and Correct applies a user-picked one from the existing category list, and either action atomically applies the category, marks the transaction user-verified, and resolves the queue entry (`GET /api/reviews` readable by any authenticated user, `POST /api/reviews/:id/confirm|correct` admin-only; `PATCH /api/transactions/:id` can now also carry `user_verified`) (#86)

- feat: offline overview — the eight approved overview cards (heatmap, streak, weekly summary, budget countdown, savings, donut, P&L, budget bars) compute from the sync-fed local mirror without a server; the mirror now also carries budgets + categories, and out-of-scope cards (alerts, net worth, cash forecast) show an explicit unavailable-offline state (#76)

- feat: auto-book through the visible confirmation gate — the Demo tab's agent trace gains an explicit "Auto-book this" action on a predicted transaction; tapping it requires opting the tab's agent session in via the Agent access panel (zero tools exposed by default, revocable any time), then a confirmation card names the exact change (which transaction, from/to category, server-computed delta) and the booking write — the same updateTransaction path as the transactions editor — lands only on explicit approval; denying leaves the data untouched and says so (#94)

- feat: privacy validator — the Demo tab's stretch panel renders a live provider ledger proving every model/agent request during a demo run stayed on localhost: it arms a server-side watermark over the trace store, classifies each row through the provider registry's isLocal (with #92's `simulated` / `transformers-browser` markers in their own honest buckets — a simulated timer can never read as a cloud call, and an unrecognized provider is never silently counted as local), and says so plainly when a real cloud call does occur; side-by-side, the exhibit shows the exact request a cloud-based agent would have sent for the same decision step — the production categorization prompt built only from the in-repo synthetic sample fixtures, never attendee-imported data (#95)

### Other

- Add what-if controls to the Cash Forecast card: 6/12/24-month horizon selector and ±50% income/expense assumption sliders that re-run the seeded in-browser simulation in place (#81)


## [v0.7.0] — 2026-09-21

### Features

- feat(plaid): dedup Items by institution_id; fix cross-file test mock pollution (#59) (013cc8b)

### Other

- Add client-side Monte Carlo cash forecast fan chart to Overview (#80) (#111) (15b6c0e)
- Render markdown in dashboard chat replies via react-markdown + remark-gfm (#47) (747e36c)
- Add admin per-task model overrides applied live via POST /api/models and the controllable Settings Models panel (#89) (#112) (a3d1a4d)
- WebMCP bridge: browser-native + Streamable-HTTP tool access with prepare/commit confirmation (#99) (cc74c17)
- Gate below-threshold categorization suggestions into a persistent review queue instead of auto-applying (#100) (6e2e7ca)
- Add Transactions-tab statement importer: client-side parse preview with confirm-to-commit (#72) (#102) (5fd38ff)
- Add dashboard Transactions semantic search endpoint and zero-match UI fallback (#62) (#101) (13c14a8)


## [v0.6.0] — 2026-09-21

### Features

- feat: dashboard Settings Models panel — per-task model rows with local/server badges and tool call-type tagging (#88) (#104) (c39981c)

### Fixes

- fix: align dashboard UI account types with the real wire format so Accounts and Liabilities render real balances (#79) (#103) (83fa52b)

### Other

- Show model confidence badge in dashboard transaction list Category cell (#109) (ccb545c)
- Add local-first WebGPU hybrid chat to the dashboard with silent server fallback (#68) (#98) (d29e69e)
- Add dashboard POST /api/import endpoint with CLI-shared external_id dedup and imports ledger (#96) (35b0783)
- Validate tool-call arguments against each tool's zod schema in defineTool (#66) (#90) (c840e7f)
- Add local embedding engine, embeddings store, and batched backfill (#82) (64a4763)
- Validate structured LLM output in callLlm with one repair re-prompt and typed rejection (#65) (#77) (72d40eb)
- Add percentage-of-income targets to goal_manage financial goals (#46) (7b34ab3)
- Route SPF roster through gertie's Ollama Cloud (ebe2dd6)
- Add SPF quality/protected_files/watch config (4a3d645)


## [Unreleased]

### Features

- feat: client-side Monte Carlo cash forecast card on Overview, beside Savings Rate — a new read-only `GET /api/cashflow/monthly` series classified exactly like the P&L (transfers between accounts excluded so card payments aren't double-counted, complete calendar months only so the partial current month never skews sampling), a seeded in-browser bootstrap of 500 twelve-month paths over the user's own history (mulberry32 PRNG, deterministic under test), a recharts fan chart of translucent p10–p90 bands around the median liquid-cash line starting from checking/savings/cash balances, a plain-language takeaway naming the median cash at the horizon (and roughly when the pessimistic path runs low, if it does), and an empty state until a couple of months of history exist (#80)

- feat: admin per-task model overrides, applied live — the Settings Models panel becomes controllable: an admin-gated `POST /api/models` pins a model from the catalog to categorization or entity classification (or resets it to follow the chat model), and the panel's Chat row is the global model setting itself; tool call sites resolve their pinned model per call and the dashboard chat applies chat-model changes through the same live-update path the TUI's `/model` switch uses (agent runner + background summarize/relevance), so every change lands on the next run with no restart; the dropdown lists friendly names, offers no WebGPU model the capability probe says can't run on this machine, and marks uncached local models with their download size (#89)

- feat: below-threshold AI categorization suggestions are routed to a persistent review queue instead of being auto-applied — the categorize tool now applies a suggestion only at or above the confidence threshold (default 0.7, per-profile via "categorizationConfidenceThreshold"); lower-confidence suggestions leave the transaction uncategorized and land as pending rows in the new categorization_reviews table (migration v24 also backfills historical low-confidence model categorizations into the queue while keeping their applied category) (#84)

- feat: dashboard statement importer — the Transactions tab gains a drag-and-drop/file-picker importer that reads CSV/OFX/QIF statements entirely in the browser (shared parse + WebCrypto-hash modules bundle with the UI via the @import-tools alias), previews detected bank/format, row count, date range and first rows in a dialog, and only POSTs to /api/import on explicit confirm; commit is admin-gated following the settings tab's auth-status pattern and re-imports surface the duplicates-skipped result (#72)

- feat: semantic search in the dashboard Transactions view — a new `GET /api/transactions/search` embeds the query with the local on-device engine, prefilters candidates with the same SQL filters the transactions endpoint accepts (date range, account, category, entity), ranks by dot product, and returns full transaction rows with similarity scores plus indexed/total coverage counts; the Transactions tab keeps today's instant substring matching whenever it produces results and only falls back to semantic matches on a zero-match query (score chips, `semantic` marker, and a one-line hint naming `wilson --index` when vectors lag the transaction count); query and transaction text are embedded in-process — nothing but the one-time model download ever leaves the machine (#62)

- feat: dashboard Settings "Models" panel — a read endpoint (`GET /api/models`) and Settings section showing which model handles each AI task (chat, categorization, entity classification) with friendly model names, "runs on this device" vs "runs on a cloud server" badges derived from a new `isLocal` flag on the provider registry, the server-side WebGPU capability probe, and an embeddings row marked "Not in use — no embeddings task in this build"; categorization and entity-classification LLM calls are also tagged with their own call types so the Training per-task view groups them truthfully instead of lumping them into `standalone` (#88)

- feat: offline dashboard transactions — a sync-fed, per-profile local mirror (wa-sqlite@1.0.0 + AccessHandlePoolVFS in an inline worker, wasm base64-inlined into the single-file build, no COOP/COEP or static-asset routes) seeds/refreshes on full pulls keyed by external_id, reconciles server-side deletions, and re-seeds on schema-version change; the fetch seam goes network-first with mirror fallback so browsing/search/filtering work offline with server-identical results (parity pinned by tests), and offline entity assignment shows an explicit requires-connection state instead of failing silently (#75)

- feat: local-first hybrid dashboard chat — WebGPU-capable browsers answer from a pre-fetched transaction bundle via transformers.js (Qwen3-0.6B, fastModel-driven) with silent server fallback, bundle framing/hand-off classification, and browser-originated history recording (#68)

- docs: record dashboard offline-store comparison spike (IndexedDB-direct vs OPFS-backed sqlite-wasm, measured against the real read contract) and commit wa-sqlite@1.0.0 + AccessHandlePoolVFS as the store technology, incl. the accepted unencrypted-at-rest tradeoff — `docs/plans/2026-09-20-003-dashboard-offline-store-comparison.md` (#74)

- feat: percentage-of-income targets for goal_manage — financial goals accept an optional `targetPercent` (plus `incomePeriod`, default month) alongside the fixed `targetAmount`; the dollar target is resolved from actual period income via profit-loss totals, progress defaults to the period's net savings, and goal snapshots record the resolved target (#34)

- feat: dashboard import endpoint — POST /api/import commits client-parsed statement rows into the active profile with file-hash + per-row external_id dedup (sharing the CLI's id derivation, so one statement dedups across both paths) and an imports-ledger record; admin-gated like other dashboard writes (#71)

- feat: local semantic index — `wilson --index` backfills a locally-computed embedding for every existing transaction (migration 23 `embeddings` table, L2-normalized vectors keyed by source + model) using a `feature-extraction` pipeline over the pinned transformers.js (all-MiniLM-L6-v2-ONNX, 384-dim, CPU/WASM); batched, resumable, with model-download and per-batch progress; top-k search ranks SQL-prefiltered candidates by dot product; nothing but the one-time model download ever leaves the machine (#61)

### Fixes

- fix: validate structured LLM output at the `callLlm` boundary — a response violating its `outputSchema` gets exactly one schema-aware repair re-prompt, then the call rejects with a typed `LlmValidationError` instead of returning unvalidated data; categorization and entity-classification batches land in their errors channel with nothing written (no more NaN confidences or junk categories from malformed local-model JSON), chat-history relevance degrades to no injected history, and team dispatch falls back to the dispatcher's direct answer; both tool schemas now constrain `confidence` to [0, 1] (#65)

- fix: validate every tool invocation against its own zod schema in `defineTool` — malformed model tool-call arguments are rejected with a field-naming error before the tool function runs, and the failure is fed back to the model as a tool error so it can correct its arguments (#66)

- fix: correct the dashboard UI's drifted account wire-format types — `Account`, `NetWorthResponse`, and `NetWorthTrendPoint` now declare the shape the API actually sends (`account_type`/`account_subtype`/`current_balance`, the `*BySubtype` arrays, and `date`/`totalAssets`/`totalLiabilities` trend rows) so the Accounts tab groups by real type with real balances (no more "Other" catch-all or NaN), the trend chart shows date labels, and the Liabilities card's per-account breakdown renders again; the wire contract is pinned by seeded-API field-name tests (#79)


## [v0.5.0] — 2026-07-05

### Features

- feat: upgrade @huggingface/transformers to 4.0.1 (#26) (12c1550)


## [v0.4.3] — 2026-07-05

### Fixes

- fix: drop ./ prefix from bin path so npm 11 keeps it (#30) (9071216)


## [v0.4.2] — 2026-07-04

### Fixes

- fix: restore installable wilson bin under npm 11 (#29) (5c56f64)


## [v0.4.1] — 2026-07-04

### Fixes

- fix: wire agent tools to database in dashboard chat (#25) (ecb22ea)


## [v0.4.0] — 2026-07-04

### Features

- feat: SQLCipher encryption at rest via bun:sqlite setCustomSQLite (#24) (4771db9)


## [v0.3.0] — 2026-04-09

### Features

- feat: auto-version releases, recursive skill discovery, OSS best practices (fbae552)


## [v0.2.0] — 2026-04-08

- feat: merge npm publish into release-on-merge workflow (182bb85)
- fix: resolve all CI test failures (d2d4da4)
- fix: pin CI to Bun 1.2.22 and fix orchestration spyOn compatibility (e102c49)
- fix: regenerate lockfile with correct package name @openaccountant/wilson (c245a7a)
- fix: convert LongTermChatHistory from class to factory function (063cbfd)
- fix: resolve CI test failures — pin Bun 1.3.10, break circular import, fix dashboard test (adeaecf)
- fix: pin Bun to 1.2.x in CI — tests break on 1.3 due to class/mock changes (fc84092)
- fix: use relative dates in test seed data so tests don't rot over time (c9c8edf)
- chore: update CHANGELOG for v0.2.0 (9759434)
- chore: rename to @openaccountant/wilson and bump to v0.2.0 (bd369aa)
- feat: Plaid production readiness — sync correctness, security, and compliance (be7926b)
- feat: add WebGPU support, model switch fix, entity system, coinbase sync, and dashboard enhancements (fab7ec3)
- fix: resolve sync UI flickering and add profile awareness to system prompt (ce528a8)
- fix: resolve remaining TypeScript typecheck errors for CI (2aeec36)
- test: improve coverage for utils - env, logger, trace-store (3a73792)
- feat: add custom category system with hierarchical budgets, goals, memories, and dashboard UI (aa18c9a)
- chore: add test:coverage script, gitignore debug dir, remove stale data file (3642680)
- feat: expand test suite with 30+ new test files (c7dd01f)
- feat: add /upgrade command, improve /help, proxy license validation (b2dbd57)
- feat: add spending-by-institution dashboard card and db-manager init fix (cb9bd28)
- feat: pass active model through tool executor to chains and teams (22caa9d)
- feat: add Plaid API proxy mode and debug dump support (7f5aaaa)
- feat: support directory import and refactor csv-import to single-file fn (3e69248)
- feat: add browser open utility and Pro upsell module (0525436)
- feat: extend --sync to all integrations, add MCP SSE transport and --mcp diagnostic (212fe9a)
- feat: add LLM interaction capture & fine-tuning data pipeline (1b734f1)
- feat: rotating, time-aware, data-driven context hints (a193580)
- feat: add context-aware hints line below TUI input (23713c4)
- feat: auto-sync Plaid balances to accounts, auto-link transactions, add --sync flag (fc858d4)
- fix: persist logs and traces to SQLite, fix chat session fragmentation (1698620)
- feat: add net worth and balance sheet tracking (cc49ef8)
- feat: add tests and fixture for Firefly III import integration (fd382cf)
- feat: add Winston logging, LLM trace store, dashboard enhancements, and comprehensive test suite (9f84d22)
- feat: add multi-profile support with separate databases (4422c36)
- (chore):readme (a02d834)
- Update GitHub URLs from open-accountant/open-accountant to openaccountant/wilson (1f15cdd)
- Add 40 paid skill stubs for expanded x402 catalog (73b4236)
- Rename Agent Wilson → Open Accountant (cf68cfc)


## [v0.2.0] — 2026-04-08

- chore: rename to @openaccountant/wilson and bump to v0.2.0 (bd369aa)
- feat: Plaid production readiness — sync correctness, security, and compliance (be7926b)
- feat: add WebGPU support, model switch fix, entity system, coinbase sync, and dashboard enhancements (fab7ec3)
- fix: resolve sync UI flickering and add profile awareness to system prompt (ce528a8)
- fix: resolve remaining TypeScript typecheck errors for CI (2aeec36)
- test: improve coverage for utils - env, logger, trace-store (3a73792)
- feat: add custom category system with hierarchical budgets, goals, memories, and dashboard UI (aa18c9a)
- chore: add test:coverage script, gitignore debug dir, remove stale data file (3642680)
- feat: expand test suite with 30+ new test files (c7dd01f)
- feat: add /upgrade command, improve /help, proxy license validation (b2dbd57)
- feat: add spending-by-institution dashboard card and db-manager init fix (cb9bd28)
- feat: pass active model through tool executor to chains and teams (22caa9d)
- feat: add Plaid API proxy mode and debug dump support (7f5aaaa)
- feat: support directory import and refactor csv-import to single-file fn (3e69248)
- feat: add browser open utility and Pro upsell module (0525436)
- feat: extend --sync to all integrations, add MCP SSE transport and --mcp diagnostic (212fe9a)
- feat: add LLM interaction capture & fine-tuning data pipeline (1b734f1)
- feat: rotating, time-aware, data-driven context hints (a193580)
- feat: add context-aware hints line below TUI input (23713c4)
- feat: auto-sync Plaid balances to accounts, auto-link transactions, add --sync flag (fc858d4)
- fix: persist logs and traces to SQLite, fix chat session fragmentation (1698620)
- feat: add net worth and balance sheet tracking (cc49ef8)
- feat: add tests and fixture for Firefly III import integration (fd382cf)
- feat: add Winston logging, LLM trace store, dashboard enhancements, and comprehensive test suite (9f84d22)
- feat: add multi-profile support with separate databases (4422c36)
- (chore):readme (a02d834)
- Update GitHub URLs from open-accountant/open-accountant to openaccountant/wilson (1f15cdd)
- Add 40 paid skill stubs for expanded x402 catalog (73b4236)
- Rename Agent Wilson → Open Accountant (cf68cfc)


## [v0.1.0] — 2026-03-01

- Rename to Agent Wilson, add Plaid balance/recurring tools, bank-sync skill (e104f4e)
- Add brand guide (f5588f9)
- Wire budget context into agent system prompt (17cbb51)
- Add headless mode for scheduled and non-interactive execution (c010724)
- Add paid chain orchestration with license gating (b390ebc)
- Add paid skill definitions for Pro workflows (020bc60)
- Add paid skill tier with license gating and server-side content (03e6619)
- Add content fetcher for paid skill and chain delivery (f04ffd2)
- Add scheduled task system with crontab sync (8e3cc28)
- Add Plaid integration for bank account linking and transaction sync (d8daf0e)
- Add budget set and budget check tools (fc322d8)
- Add budgets table, Plaid columns, and budget queries (9b97225)
- Add license validation system with Polar.sh integration (b140617)
- Gate Plaid and Monarch as Pro features with cross-sell messaging (d6542f4)
- feat: add open source infrastructure (README, LICENSE, CI, templates) (e7d1c41)
- fix: update recommended Ollama models with current-gen tool-calling SLMs (69af2f5)
- feat: Wilson CLI with MCP client, model tags, /pull, and export (791fa53)


## [v0.1.0] — 2026-03-01

- Initial release
- Agent loop with 9 LLM providers (Anthropic, OpenAI, Ollama, etc.)
- Bank statement import: Chase, Amex, BofA, generic CSV, OFX, QIF
- Smart categorization with rules engine
- P&L reports, profit diffs, savings rate tracking
- Tax deduction tracker with IRS categories
- Spending alerts and budget monitoring
- Markdown report export and browser dashboard
- Plaid integration for bank sync (Pro)
- Skills system for multi-step workflows
- Privacy-first: all data in local SQLite, no telemetry
