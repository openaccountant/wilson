import type { EditorTheme, MarkdownTheme, SelectListTheme } from '@mariozechner/pi-tui';
import chalk from 'chalk';

const palette = {
  primary: '#22c55e',
  primaryLight: '#86efac',
  success: '#22c55e',
  error: '#ef4444',
  warning: '#f59e0b',
  muted: '#6b7280',
  mutedDark: '#374151',
  accent: '#06b6d4',
  white: '#e5e7eb',
  info: '#6CB6FF',
  queryBg: '#1f2937',
  border: '#374151',
};

const fg = (color: string) => (text: string) => chalk.hex(color)(text);
const bg = (color: string) => (text: string) => chalk.bgHex(color)(text);

export const theme = {
  primary: fg(palette.primary),
  primaryLight: fg(palette.primaryLight),
  success: fg(palette.success),
  error: fg(palette.error),
  warning: fg(palette.warning),
  muted: fg(palette.muted),
  mutedDark: fg(palette.mutedDark),
  accent: fg(palette.accent),
  white: fg(palette.white),
  info: fg(palette.info),
  queryBg: bg(palette.queryBg),
  border: fg(palette.border),
  dim: (text: string) => chalk.dim(text),
  bold: (text: string) => chalk.bold(text),
  separator: (width?: number) => fg(palette.mutedDark)('\u2500'.repeat(width ?? 80)),
};

export const markdownTheme: MarkdownTheme = {
  heading: (text) => theme.bold(theme.primary(text)),
  link: (text) => theme.primaryLight(text),
  linkUrl: (text) => theme.dim(text),
  code: (text) => theme.primaryLight(text),
  codeBlock: (text) => theme.primaryLight(text),
  codeBlockBorder: (text) => theme.mutedDark(text),
  quote: (text) => theme.info(text),
  quoteBorder: (text) => theme.mutedDark(text),
  hr: (text) => theme.mutedDark(text),
  listBullet: (text) => theme.primary(text),
  bold: (text) => theme.bold(text),
  italic: (text) => chalk.italic(text),
  strikethrough: (text) => chalk.strikethrough(text),
  underline: (text) => chalk.underline(text),
};

export const selectListTheme: SelectListTheme = {
  selectedPrefix: (text) => theme.primaryLight(text),
  selectedText: (text) => theme.bold(theme.primaryLight(text)),
  description: (text) => theme.muted(text),
  scrollInfo: (text) => theme.muted(text),
  noMatch: (text) => theme.muted(text),
};

export const editorTheme: EditorTheme = {
  borderColor: (text) => theme.primary(text),
  selectList: selectListTheme,
};
