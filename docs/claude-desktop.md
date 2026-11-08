# Use Open Accountant in Claude Desktop

This is the simplest way to use Open Accountant. You don't need a terminal, an API key or any setup. Claude does the thinking. Open Accountant (we call it Wilson) keeps your transactions in a private file on your own computer.

## What you need

- **Claude Desktop** for Windows or Mac. Download it from [claude.ai/download](https://claude.ai/download) and sign in.
- A **bank export**: the file your bank lets you download from its website, usually under *Statements* or *Download transactions*. CSV works with Chase, Amex, Bank of America and most other banks. OFX, QFX and QIF files (from Quicken and many banks) work too.

## Install (about one minute)

1. Go to the latest release: **[github.com/openaccountant/wilson/releases/latest](https://github.com/openaccountant/wilson/releases/latest)**.
2. Under **Assets**, click **`wilson.mcpb`** to download it.
3. Open your **Downloads** folder and **double-click `wilson.mcpb`**. Claude Desktop opens and shows *Open Accountant (Wilson)*.
4. Click **Install**. If Claude asks about settings, the defaults are fine. Click **Save** or **Enable**.

That's it. You can check it under **Settings → Extensions** in Claude Desktop.

### Windows: "Windows protected your PC"

The first time Claude starts Wilson, Windows might show a blue SmartScreen box. It shows this for any new program that isn't from a big publisher yet. To allow it:

1. Click **More info**.
2. Click **Run anyway**.

You only need to do this once. If your company's IT controls your PC, they might need to allow it for you.

### Mac: "cannot be opened"

If macOS says Wilson can't be opened, go to **System Settings → Privacy & Security**, scroll down and click **Open Anyway** next to the message about Wilson. Then try again in Claude.

## Try it

Start a new chat in Claude Desktop and type:

> Import ~/Downloads/chase.csv and tell me where my money went.

Use the name of the file you actually downloaded. On Windows you can also write the full path, for example `C:\Users\you\Downloads\chase.csv`.

Claude asks your permission before it imports or changes anything. Click **Allow** when you are happy with what it says it will do. To skip the question for reading-only tools (like summaries), choose **Always allow** for those.

More things to ask:

- "What did I spend the most on last month? Compare it with the month before."
- "Categorize my uncategorized transactions." (Claude suggests a category for each one and asks you before saving.)
- "Set a $600 monthly budget for Dining and tell me how I'm doing."
- "Which transactions look tax-deductible for my business?"
- "Open my dashboard." (This opens charts and tables in your web browser. They stay on your computer.)

## Settings

Open **Settings → Extensions → Open Accountant (Wilson) → Configure** in Claude Desktop.

| Setting | What it does |
|---|---|
| **Profile** | Which set of books to open. Use different names to keep things apart, for example `household` and `business`. The default is `default`. |
| **Data folder** | Where your books are stored. Leave the default (`.openaccountant` in your home folder) unless you moved it. If you also use the Wilson command-line app, the default means both see the same books. |
| **Allow imports and changes** | Turn it off if you want Claude to read only. Claude then can't import files or change categories, budgets or goals. |

## Privacy

- Your transactions are kept in a database file in your data folder, on your computer. Wilson doesn't upload them anywhere.
- Claude sees the results of the questions you ask, the same as anything else you share in a chat. Claude Desktop sends them to Anthropic to answer you. If you don't want a transaction in a chat, don't ask about it.
- The dashboard only listens on your own computer (`127.0.0.1`). Other machines can't reach it.

## Troubleshooting

- **"No file or folder at …"**: check the file name and where it is. Downloads usually go to your Downloads folder. A path that starts with `~/` means "in my home folder".
- **"This file was already imported"**: Wilson skips files and transactions it has seen before, so importing twice doesn't double-count.
- **Claude says the tools aren't available**: in **Settings → Extensions**, make sure Open Accountant is turned on, then start a new chat.
- **Agent access is turned off**: someone switched off agent access in the dashboard. Open the dashboard and go to **Settings → Agent access** to turn it back on.

## For developers

The extension runs `wilson --mcp-server`, an MCP server on stdio. See `src/mcp/stdio-server.ts`. It reuses the dashboard's MCP tool catalog, argument checks and audit log. Changes are confirmed through MCP elicitation when the host supports it. Otherwise the host's own tool-approval prompt does that job. The bundle is built with `bun run build:mcpb` from the binaries in `dist/bin` (`scripts/build-mcpb.ts`, manifest in `mcpb/manifest.json`, MCPB `manifest_version` 0.3). Environment variables: `WILSON_PROFILE`, `WILSON_HOME` (data folder), `WILSON_MCP_ALLOW_CHANGES`, `WILSON_DASHBOARD_PORT` (default 3141), `WILSON_MCP_EMBED=1` (keep on-device embedding on import; off by default, so run `wilson --index` later).
