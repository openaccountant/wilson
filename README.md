<p align="center">
  <img src=".github/assets/oa-hero.png" alt="Open Accountant CLI" width="600">
</p>

<h1 align="center">Open Accountant</h1>

<p align="center">
  <strong>Your AI bookkeeper. Follow the money.</strong><br>
  Privacy-first financial assistant for your terminal.
</p>

<p align="center">
  <a href="https://github.com/openaccountant/wilson/actions/workflows/ci.yml"><img src="https://github.com/openaccountant/wilson/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT"></a>
</p>

---

Import bank statements, categorize transactions with AI, surface spending anomalies, and get actionable advice — all without your financial data leaving your machine.

Named after [Frank J. Wilson](https://en.wikipedia.org/wiki/Frank_J._Wilson), the forensic accountant who followed the money to convict Al Capone.

## Features

- **Bank CSV import** — Auto-detects Chase, American Express, and generic CSV formats
- **Monarch Money sync** — Pull transactions directly from your Monarch Money account
- **AI categorization** — Classifies transactions into 18 spending categories using your choice of LLM
- **Spending summaries** — Breakdowns by category, merchant, or time period with comparisons
- **Anomaly detection** — Flags duplicate charges, unusual spikes, and forgotten subscriptions
- **Export** — Save filtered transactions to CSV or XLSX
- **Web search** — Research merchants and financial questions (Exa, Perplexity, Tavily, Brave)
- **MCP extensibility** — Add tools via Model Context Protocol servers
- **Orchestration** — Chain tools sequentially or run parallel teams for complex workflows
- **Skills** — Multi-step workflows like subscription audits, extensible with custom skills
- **9 LLM providers** — OpenAI, Anthropic, Google, xAI, Moonshot, DeepSeek, OpenRouter, LiteLLM, and Ollama (local)

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) v1.1+
- An LLM provider: either [Ollama](https://ollama.com) running locally **or** an API key for a cloud provider

### Install & Run

```bash
git clone https://github.com/openaccountant/wilson.git
cd open-accountant
bun install
cp env.example .env   # edit with your API key(s)
bun start
```

### First Steps

1. **Import transactions** — Drop a CSV into the chat: `Import my transactions from ~/Downloads/chase.csv`
2. **Categorize** — `Categorize my uncategorized transactions`
3. **Explore** — `What did I spend on dining last month?`
4. **Audit** — `Find any unusual charges or forgotten subscriptions`

## LLM Providers

| Provider | Prefix | API Key Env Var |
|---|---|---|
| OpenAI | `gpt-` | `OPENAI_API_KEY` |
| Anthropic | `claude-` | `ANTHROPIC_API_KEY` |
| Google | `gemini-` | `GOOGLE_API_KEY` |
| xAI | `grok-` | `XAI_API_KEY` |
| Moonshot | `kimi-` | `MOONSHOT_API_KEY` |
| DeepSeek | `deepseek-` | `DEEPSEEK_API_KEY` |
| OpenRouter | `openrouter:` | `OPENROUTER_API_KEY` |
| LiteLLM | `litellm:` | `LITELLM_API_KEY` |
| Ollama | `ollama:` | None (local) |

Switch providers at any time with `/model`.

## CLI Commands

| Command | Description |
|---|---|
| `/model` | Switch LLM provider and model |
| `/pull <model>` | Download an Ollama model |
| `/skill <name>` | Run a skill (e.g. `/skill subscription-audit`) |
| `/help` | Show available commands |

Type `exit` or `quit` to close. Press `Esc` to cancel a running operation.

## Configuration

### Environment Variables

Copy `env.example` to `.env` and set at least one provider API key. See the file for all options including web search keys and Ollama base URL.

### MCP Servers

Add external tool servers in `~/.openaccountant/mcp.json`:

```json
{
  "servers": {
    "my-server": {
      "command": "npx",
      "args": ["-y", "my-mcp-server"],
      "env": {}
    }
  }
}
```

MCP tools appear automatically in Open Accountant's tool registry.

### Custom Skills

Drop a folder with a `SKILL.md` file into any of these directories:

| Location | Purpose |
|---|---|
| `src/skills/` | Built-in skills |
| `~/.openaccountant/skills/` | User-wide skills |
| `.openaccountant/skills/` | Project-specific skills |

Skills defined later in this list override earlier ones with the same name.

## Architecture

```
src/
  agent/          # Core agent loop, tool execution, context management
  components/     # TUI components (chat log, editor, prompts)
  controllers/    # Agent runner, model selection, input history
  db/             # SQLite schema, queries, database init
  mcp/            # MCP client, adapter, config
  model/          # LLM abstraction and provider implementations
  orchestration/  # Chains (sequential) and Teams (parallel) workflows
  skills/         # Skill discovery, loading, and built-in skills
  tools/          # All tool implementations
    categorize/   # AI transaction categorization
    export/       # CSV/XLSX export
    import/       # CSV import with bank parsers, Monarch sync
    query/        # Transaction search, spending summary, anomaly detection
    search/       # Web search providers (Exa, Perplexity, Tavily, Brave)
  utils/          # Shared utilities
```

All data is stored locally in `~/.openaccountant/data.db` (SQLite).

## Contributing

Contributions are welcome! Please open an issue first to discuss what you'd like to change.

See the [issue templates](.github/ISSUE_TEMPLATE) for bug reports and feature requests.

## License

[MIT](LICENSE)
