# Plan: Render markdown in dashboard chat (Ask Wilson) assistant replies

## Goal

Assistant replies in the dashboard's "Ask Wilson" tab currently render as plain text
inside a `whitespace-pre-wrap` div, so markdown the model emits (`**bold**`, lists,
headings, GFM tables, fenced code) shows as literal source. Render **assistant**
messages through a markdown renderer (react-markdown + remark-gfm); keep **user**
messages as verbatim plain text.

## Current state (verified)

- `src/dashboard/ui/src/tabs/ChatTab.tsx` — both roles render `{msg.content}` inside:
  ```tsx
  <div className={`max-w-[75%] rounded-lg px-4 py-2.5 text-sm whitespace-pre-wrap ${...}`}>
    {msg.content}
  </div>
  ```
  Error messages are pushed as `role: 'assistant'` with content `` `Error: ${errMsg}` ``
  (plain text — they'll render fine as a single paragraph through markdown; no special case).
- `src/dashboard/ui/package.json` deps: `react@^19.1.0`, `react-dom`, `recharts`. No markdown lib.
- Styling: Tailwind **v4** via `@tailwindcss/vite`; theme tokens in
  `src/dashboard/ui/src/styles/app.css` (`--color-surface: #1a1d27`, `--color-border: #2a2d37`,
  `--color-green: #22c55e`, `--font-mono: 'JetBrains Mono', ui-monospace, monospace`).
- Build: `vite-plugin-singlefile` inlines everything into `src/dashboard/ui/dist/index.html`;
  the backend serves that file at `src/dashboard/server.ts:57`.
- Package manager for the UI dir is **npm** (it has its own `package-lock.json`; the repo root
  uses bun, but that's irrelevant to `src/dashboard/ui/`).
- Chat is non-streaming (one `res.answer` per send) and `loadSession()` history reuses the
  same render path — historical answers get formatting for free. No incremental parsing concerns.

## Decisions (locked — don't re-litigate)

1. **Styling approach: component mapping**, not `@tailwindcss/typography`.
   Rationale: prose defaults assume an article layout with wide margins, which fights the
   compact `max-w-[75%]` chat bubble; the mapping gives precise control with existing theme
   tokens and adds zero config changes (the Typography route would need `@plugin` in app.css
   + a dev dep).
2. **Dependencies:** `react-markdown@^10` + `remark-gfm@^4` (React 19 compatible).
3. **Security:** react-markdown escapes raw HTML by default and its default `urlTransform`
   strips `javascript:` URLs. Do **NOT** add `rehype-raw` / `rehype-dangerous-html`. This is
   the XSS boundary — no sanitizer needed as long as nothing re-enables raw HTML.
4. Keep the components map **inside `ChatTab.tsx`** (module-level const) — self-contained
   render concern for this tab, keeps the diff to two files.

## Changes

### 1. `src/dashboard/ui/package.json`

Add to `dependencies`:

```json
"react-markdown": "^10.1.0",
"remark-gfm": "^4.0.1"
```

Then run `npm install` inside `src/dashboard/ui/` (updates `package-lock.json`).

### 2. `src/dashboard/ui/src/tabs/ChatTab.tsx`

Add imports:

```tsx
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
```

Add a module-level components map (before `ChatTab`), tailored to the Forensic Noir theme:

```tsx
const markdownComponents = {
  // Headings — modest scale so they don't dominate the bubble
  h1: (p) => <h1 {...p} className="text-base font-bold mt-3 mb-1.5 first:mt-0" />,
  h2: (p) => <h2 {...p} className="text-[0.95rem] font-semibold mt-3 mb-1.5 first:mt-0" />,
  h3: (p) => <h3 {...p} className="text-sm font-semibold mt-2.5 mb-1 first:mt-0" />,

  p: (p) => <p {...p} className="my-2 first:mt-0 last:mb-0 leading-relaxed" />,

  ul: (p) => <ul {...p} className="list-disc pl-5 my-2 space-y-1" />,
  ol: (p) => <ol {...p} className="list-decimal pl-5 my-2 space-y-1" />,
  li: (p) => <li {...p} className="marker:text-green" />,   // money-green markers

  strong: (p) => <strong {...p} className="font-semibold" />,
  em: (p) => <em {...p} className="italic" />,
  del: (p) => <del {...p} className="text-text-muted line-through" />,

  blockquote: (p) => (
    <blockquote {...p} className="border-l-2 border-green/50 pl-3 my-2 text-text-secondary italic" />
  ),
  hr: (p) => <hr {...p} className="border-border my-3" />,

  // Links: new tab + noopener (security requirement)
  a: ({ children, href }) => (
    <a href={href} target="_blank" rel="noopener noreferrer"
       className="text-green underline underline-offset-2 hover:text-green/80">
      {children}
    </a>
  ),

  // Code: block detection via language- class or embedded newlines
  pre: ({ children }) => (
    <pre className="bg-bg border border-border-muted rounded-lg p-3 my-2 overflow-x-auto
                    font-mono text-xs leading-relaxed">
      {children}
    </pre>
  ),
  code: ({ className, children }) => {
    const isBlock = /language-/.test(className ?? '') || String(children).includes('\n');
    if (isBlock) return <code className={className}>{children}</code>; // inherits pre styling
    return (
      <code className="font-mono text-[0.85em] bg-surface-raised border border-border-muted
                       rounded px-1 py-0.5">
        {children}
      </code>
    );
  },

  // GFM tables: horizontal scroll wrapper, hairline grid
  table: ({ children }) => (
    <div className="overflow-x-auto my-2">
      <table className="w-full text-xs border-collapse">{children}</table>
    </div>
  ),
  thead: (p) => <thead {...p} className="bg-surface-raised" />,
  th: (p) => <th {...p} className="border border-border px-2 py-1.5 text-left font-semibold text-text" />,
  td: (p) => <td {...p} className="border border-border px-2 py-1 text-text" />,

  // GFM task-list checkboxes
  input: (p) => <input {...p} className="mr-1.5 align-middle accent-green" disabled={true} />,
};
```

Split the message bubble render by role (in the `messages.map(...)` body):

```tsx
{msg.role === 'user' ? (
  <div className="max-w-[75%] rounded-lg px-4 py-2.5 text-sm whitespace-pre-wrap
                  bg-green-900/40 border border-green-700/50 text-text">
    {msg.content}
  </div>
) : (
  <div className="max-w-[75%] rounded-lg px-4 py-2.5 text-sm bg-surface border border-border text-text">
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
      {msg.content}
    </ReactMarkdown>
  </div>
)}
```

Notes:
- Drop `whitespace-pre-wrap` on the assistant branch — markdown emits block elements;
  keeping it adds stray spacing.
- The ReactMarkdown wrapper needs a bit of breathing room against the bubble's `px-4`:
  the `first:mt-0` / `last:mb-0` guards on `p` handle it; if headings/lists butt against the
  top edge, add `first:*` equivalents or a `-mt-0.5` nudge — tune visually during verification.
- Keep the `type` import block unchanged; `DisplayMessage` already carries `role`.
- If TS complains about the loose component signatures, type the map as
  `Components` from `react-markdown` (exported) instead of leaving it untyped.

## Out of scope / explicitly not doing

- No `rehype-raw` (XSS boundary — see Decisions).
- No syntax highlighting (shiki/highlight.js bloats the inlined single-file bundle; can follow up later).
- No change to user-message rendering, the input bar, session sidebar, or any other tab.
- No backend changes (`src/dashboard/chat.ts` / `server.ts` untouched).

## Verification

1. `cd src/dashboard/ui && npm install && npm run build` — must exit 0 (`tsc -b && vite build`).
   Confirm `dist/index.html` exists and is still a single self-contained file (no missing asset refs).
2. Serve the dashboard (it serves `ui/dist/index.html` via `src/dashboard/server.ts:57`) and:
   - Ask a question that returns a **bulleted/numbered list, a table, and a fenced code block** —
     all three must render formatted (list markers green, table with hairline grid in a scroll
     wrapper, code on dark surface in mono).
   - Send a message containing literal `**stars**` and `<b>html</b>` as the **user** — it must
     display verbatim, unformatted (plain-text path intact).
   - Ask something that returns a link; inspect the DOM: `target="_blank"` and
     `rel="noopener noreferrer"` present.
   - Load an old session from the sidebar — historical answers render formatted too.
   - Trigger an error reply (e.g. with the LLM disabled) — the `Error: ...` line renders as plain text.
3. Sanity-check bundle size: `ls -la dist/index.html` before/after; expect roughly +30–40KB
   gzipped from react-markdown/remark-gfm — acceptable, just confirm the page still loads snappily.
4. Repo-level checks unaffected: `bun run typecheck` at repo root still passes (UI has its own
   tsconfig; `npm run build` already type-checked the UI).

## Files touched

- `src/dashboard/ui/package.json` (+ `package-lock.json` via npm install)
- `src/dashboard/ui/src/tabs/ChatTab.tsx` (render path + components map)