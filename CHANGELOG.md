# Changelog

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
