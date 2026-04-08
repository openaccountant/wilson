# Changelog

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
