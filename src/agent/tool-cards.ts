/**
 * Tool and skill "cards" for local tool selection (design 2026-10-03 §5.2):
 * the short text each tool is embedded by, and a content-hash cache so the
 * cards are embedded once per process.
 *
 * Card text: `${name with spaces}: ${tool.description} ${When-to-Use bullets}`.
 * The bullets come from the rich registry description that local models no
 * longer see in their prompt; they carry the trigger phrases.
 */

import { createHash } from 'node:crypto';
import type { ToolDef } from '../model/types.js';
import { compactToolSchema } from '../model/providers/transformers.js';

export type EmbedFn = (texts: string[]) => Promise<Float32Array[]>;

/** The bullet lines under `## When to Use` in a rich tool description (markdown). */
export function whenToUseBullets(rich: string): string[] {
  const section = rich.match(/## When to Use\s*\n([\s\S]*?)(?:\n## |$)/);
  if (!section) return [];
  return section[1]
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).trim());
}

/** The text a registered tool is embedded by. */
export function toolCardText(entry: { name: string; tool: { description: string }; description: string }): string {
  const bullets = whenToUseBullets(entry.description);
  return [`${entry.name.replace(/_/g, ' ')}: ${entry.tool.description}`, ...bullets].join(' ').trim();
}

/** The text a skill is embedded by. */
export function skillCardText(skill: { name: string; description: string }): string {
  return `${skill.name.replace(/-/g, ' ')}: ${skill.description}`;
}

/** Prompt tokens one tool's schema costs, as the local adapter injects it. */
export function toolSchemaTokens(tool: ToolDef, countTokens: (text: string) => number): number {
  return countTokens(JSON.stringify(compactToolSchema(tool)));
}

/**
 * Wrap `embed` with an in-memory cache keyed by sha1(text): each distinct text
 * is embedded once; repeated texts (tool cards on every turn) are free.
 */
export function createCachedEmbedder(embed: EmbedFn): EmbedFn {
  const cache = new Map<string, Float32Array>();
  const key = (text: string) => createHash('sha1').update(text).digest('hex');
  return async (texts: string[]) => {
    const missing = [...new Set(texts.filter((t) => !cache.has(key(t))))];
    if (missing.length > 0) {
      const vectors = await embed(missing);
      missing.forEach((text, i) => cache.set(key(text), vectors[i]));
    }
    return texts.map((t) => cache.get(key(t))!);
  };
}

let defaultEmbedder: EmbedFn | null = null;

/**
 * The process-wide card embedder: local MiniLM through `embedTexts` (CPU/WASM,
 * so it never competes with a WebGPU chat model), cached by content hash.
 */
export function getCardEmbedder(): EmbedFn {
  defaultEmbedder ??= createCachedEmbedder(async (texts) => {
    const { embedTexts } = await import('../utils/embeddings.js');
    return embedTexts(texts);
  });
  return defaultEmbedder;
}
