/**
 * Server-side label set for the open-jev pre-labeler (specs/open-jev-labeler.md §4.2).
 *
 * Same two-source rule as categorize.ts and api.ts: the `categories` table in
 * `sort_order`, falling back to the static CATEGORIES list when the table is
 * empty (or unreadable). `Other` stays in: the residual class is required.
 *
 * `label_set_version` is the label-policy extractor's exact algorithm
 * (browser-finetune/scripts/extract_wilson_labels.py): `cat-<n>-<sha256 of the
 * sorted slugs joined by "\n", first 12 hex>`. JS default sort and Python
 * `sorted` agree for ASCII slugs.
 */

import { createHash } from 'node:crypto';
import type { Database } from '../db/compat-sqlite.js';
import { getCategories, toSlug } from '../db/queries.js';
import { CATEGORIES } from '../tools/categorize/categories.js';

export interface PrelabelLabelSet {
  /** Category names in `sort_order`; these are the options sent to the model. */
  labels: string[];
  /** One slug per label, same order; the input of `labelSetVersion`. */
  slugs: string[];
  labelSetVersion: string;
}

export function labelSetVersion(slugs: readonly string[]): string {
  const digest = createHash('sha256').update([...slugs].sort().join('\n')).digest('hex').slice(0, 12);
  return `cat-${slugs.length}-${digest}`;
}

export function getPrelabelLabels(db: Database): PrelabelLabelSet {
  let rows: { name: string; slug: string }[] = [];
  try {
    rows = getCategories(db);
  } catch {
    rows = [];
  }
  const labels = rows.length > 0 ? rows.map((r) => r.name) : [...CATEGORIES];
  const slugs = rows.length > 0 ? rows.map((r) => r.slug) : CATEGORIES.map(toSlug);
  return { labels, slugs, labelSetVersion: labelSetVersion(slugs) };
}
