# demos/live: the live WebMCP segment

The "Outside" beat of the Web AI Summit talk, run live. An outside agent (agent-browser 0.38.2, attached over CDP) calls
the dashboard's real WebMCP tools, then Agent access goes OFF and the agent's next call fails with
`webmcp_tool_not_found`. Synthetic seed data in a scratch HOME (`scripts/webmcp-live-seed.ts`), with a failing `security`
shim, so the real keychain and profiles are never touched. No LLM, no network beyond localhost.

```bash
cd demos/live && npm install && cd ../..        # once: pins agent-browser 0.38.2 (kept out of the product package)

node demos/live/webmcp-live.mjs check           # preflight, ~5 s: scripted human + asserts, then shuts down (exit 0/1)

node demos/live/webmcp-live.mjs up              # terminal 1: seed (first run), dashboard :3141, Chrome with WebMCP + CDP 9333
node demos/live/webmcp-live.mjs stage           # terminal 2, on stage: ⏎ advances each step
node demos/live/webmcp-live.mjs reset           # between runs: access back ON, 0 grants, same Chrome (no restart)
```

`--fresh` on `up`/`check` reseeds the scratch HOME. Override with `WILSON_LIVE_DIR`, `WILSON_LIVE_PORT`, `WILSON_LIVE_CDP`.

## A fresh show machine

```bash
curl -fsSLO https://raw.githubusercontent.com/openaccountant/wilson/feat/webmcp-live-test/demos/live/setup-show-machine.sh
bash setup-show-machine.sh --macos             # toolchain, clone to ~/dev/wilson, deps, UI build, then check --fresh
bash setup-show-machine.sh --status            # what is there and what is missing, changes nothing
```

It installs Xcode CLT, Homebrew, git, gh, node 22, bun 1.4.2 and Chrome 156+ when they are missing, then clones wilson and builds the UI
(npm installs ship none, #195). `--with-models` adds Ollama with gemma4:12b and granite4.1:3b, which only recording needs;
pull them days ahead. Re-running it is safe. Do Not Disturb, the monitor resolution and the fallback clips stay manual.

## The stage run

1. `webmcp list`: no tools. Grants are per tab, so nothing is exposed until the human grants it.
2. In the page: **AGENT ACCESS** → tick `get_spending_summary` and `search_transactions` → **Apply**. `stage` waits for it.
3. `webmcp invoke get_spending_summary`: this month vs last month by category, matching the Overview tab.
4. In the page: **ON** → **Turn off**. `stage` waits until the tools are gone.
5. The same invoke now fails: `webmcp_tool_not_found`. `webmcp list` shows 0 tools.

Narration (matches slide 17): the tool is gone from the page, so the next call is `webmcp_tool_not_found`. A call that
is already in flight gets the kill-switch message and is audited `denied_kill_switch`. Don't claim rollback. A refused
call never reaches the page, so it adds no audit row.

## Notes

- Verified on Chrome 156 (system Chrome, `--enable-features=WebMCPTesting`) with 0.10.0, Oct 22 2026.
- Turning access back ON needs no confirmation, but every grant was revoked: re-grant before a second run. `reset` does
  OFF → ON for you (also clearing grants left by a half-finished run), so the next `stage` starts from 0 tools.
- Ctrl-C on `up` stops the dashboard and Chrome and frees :3141 and :9333.
- Never run `agent-browser close` against the `wilson-live` session: it closes the shared Chrome.
- Keep the Chrome window visible on stage; the confirmation-card poller only runs while the tab is visible.
