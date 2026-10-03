/** S3: server-side label set and label_set_version (specs/open-jev-labeler.md §4.2). */
import { describe, test, expect } from 'bun:test';
import { createHash } from 'node:crypto';
import { createTestDb } from './helpers.js';
import { CATEGORIES } from '../tools/categorize/categories.js';
import { getPrelabelLabels, labelSetVersion } from '../prelabel/label-set.js';

describe('prelabel label set', () => {
  test('the v16 seed gives the 18 labels in CATEGORIES order', () => {
    const db = createTestDb();
    const { labels } = getPrelabelLabels(db);
    expect(labels).toEqual(CATEGORIES);
    expect(labels).toHaveLength(18);
  });

  test('the seed yields the extractor-computed label_set_version', () => {
    const db = createTestDb();
    expect(getPrelabelLabels(db).labelSetVersion).toBe('cat-18-0f7b02225108');
  });

  test('labelSetVersion is cat-<n>-<sha256(sorted slugs joined by newline)[:12]> and order independent', () => {
    const slugs = ['b-cat', 'a-cat', 'other'];
    const digest = createHash('sha256').update([...slugs].sort().join('\n')).digest('hex').slice(0, 12);
    expect(labelSetVersion(slugs)).toBe(`cat-3-${digest}`);
    expect(labelSetVersion([...slugs].reverse())).toBe(labelSetVersion(slugs));
  });

  test('labelSetVersion does not mutate its input', () => {
    const slugs = ['z', 'a'];
    labelSetVersion(slugs);
    expect(slugs).toEqual(['z', 'a']);
  });

  test('a user-added category changes the version and appears in the labels', () => {
    const db = createTestDb();
    const before = getPrelabelLabels(db);
    db.prepare(`INSERT INTO categories (name, slug, is_system, sort_order) VALUES ('Pets', 'pets', 0, 19)`).run();
    const after = getPrelabelLabels(db);
    expect(after.labels).toHaveLength(19);
    expect(after.labels[18]).toBe('Pets');
    expect(after.labelSetVersion).not.toBe(before.labelSetVersion);
    expect(after.labelSetVersion.startsWith('cat-19-')).toBe(true);
  });

  test('an empty categories table falls back to CATEGORIES with toSlug slugs', () => {
    const db = createTestDb();
    db.prepare('DELETE FROM categories').run();
    const fallback = getPrelabelLabels(db);
    expect(fallback.labels).toEqual(CATEGORIES);
    // "Fees & Interest" -> fees-interest, matching the seed's slug.
    expect(fallback.slugs).toContain('fees-interest');
    expect(fallback.labelSetVersion).toBe('cat-18-0f7b02225108');
  });

  test('Other stays in the label set (the residual class is required)', () => {
    const db = createTestDb();
    expect(getPrelabelLabels(db).labels).toContain('Other');
  });
});
