/**
 * Server-side render of ChatMarkdown to static HTML. Test seam only: nothing
 * in the app imports this, so it never reaches a bundle. It lives next to the
 * component so react / react-dom resolve from the UI's node_modules even when
 * the caller is a root-level bun test.
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatMarkdown, LocalChatMarkdown } from './chatMarkdown.js';

export function renderChatMarkdownHtml(markdown: string): string {
  return renderToStaticMarkup(createElement(ChatMarkdown, null, markdown));
}

export function renderLocalChatMarkdownHtml(markdown: string): string {
  return renderToStaticMarkup(createElement(LocalChatMarkdown, null, markdown));
}
