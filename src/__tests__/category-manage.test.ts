import { describe, test, expect } from 'bun:test';
import { createTestDb } from './helpers.js';
import {
  getCategories,
  getCategoryTree,
  getCategoryByName,
  addCategory,
  deleteCategory,
  getCategoryDescendantNames,
  resolveCategory,
  toSlug,
} from '../db/queries.js';

describe('toSlug', () => {
  test('converts name to lowercase hyphenated slug', () => {
    expect(toSlug('Fees & Interest')).toBe('fees-interest');
    expect(toSlug('Personal Care')).toBe('personal-care');
    expect(toSlug('Dining')).toBe('dining');
    expect(toSlug('My Custom Category')).toBe('my-custom-category');
  });
});

describe('getCategories', () => {
  test('returns 18 seeded system categories', () => {
    const db = createTestDb();
    const cats = getCategories(db);
    expect(cats.length).toBe(18);
    expect(cats[0].name).toBe('Dining');
    expect(cats[0].is_system).toBe(1);
    expect(cats[17].name).toBe('Other');
  });
});

describe('getCategoryTree', () => {
  test('returns flat tree for system categories (no children)', () => {
    const db = createTestDb();
    const tree = getCategoryTree(db);
    expect(tree.length).toBe(18);
    for (const node of tree) {
      expect(node.children.length).toBe(0);
    }
  });

  test('nests child categories under parent', () => {
    const db = createTestDb();
    const parent = getCategoryByName(db, 'Dining')!;
    addCategory(db, 'Coffee', parent.id, 'Coffee shops');
    addCategory(db, 'Fast Food', parent.id, 'Fast food joints');

    const tree = getCategoryTree(db);
    const diningNode = tree.find(n => n.name === 'Dining')!;
    expect(diningNode.children.length).toBe(2);
    expect(diningNode.children.map(c => c.name).sort()).toEqual(['Coffee', 'Fast Food']);
  });
});

describe('getCategoryByName', () => {
  test('finds category case-insensitively', () => {
    const db = createTestDb();
    expect(getCategoryByName(db, 'dining')?.name).toBe('Dining');
    expect(getCategoryByName(db, 'DINING')?.name).toBe('Dining');
    expect(getCategoryByName(db, 'Dining')?.name).toBe('Dining');
  });

  test('returns null/undefined for non-existent category', () => {
    const db = createTestDb();
    expect(getCategoryByName(db, 'NonExistent')).toBeFalsy();
  });
});

describe('addCategory', () => {
  test('adds a top-level custom category', () => {
    const db = createTestDb();
    const id = addCategory(db, 'Pet Supplies', undefined, 'Pet food and supplies');
    expect(id).toBeGreaterThan(0);

    const cat = getCategoryByName(db, 'Pet Supplies')!;
    expect(cat.name).toBe('Pet Supplies');
    expect(cat.slug).toBe('pet-supplies');
    expect(cat.is_system).toBe(0);
    expect(cat.parent_id).toBeNull();
    expect(cat.description).toBe('Pet food and supplies');
  });

  test('adds a sub-category under a parent', () => {
    const db = createTestDb();
    const parent = getCategoryByName(db, 'Dining')!;
    const id = addCategory(db, 'Coffee', parent.id, 'Coffee shops');

    const cat = getCategoryByName(db, 'Coffee')!;
    expect(cat.parent_id).toBe(parent.id);
    expect(cat.is_system).toBe(0);
  });

  test('rejects duplicate slug', () => {
    const db = createTestDb();
    addCategory(db, 'Snacks');
    expect(() => addCategory(db, 'Snacks')).toThrow(); // UNIQUE constraint on slug
  });
});

describe('deleteCategory', () => {
  test('deletes a custom category', () => {
    const db = createTestDb();
    const id = addCategory(db, 'Temporary');
    const result = deleteCategory(db, id);
    expect(result.ok).toBe(true);
    expect(getCategoryByName(db, 'Temporary')).toBeFalsy();
  });

  test('blocks deletion of system categories', () => {
    const db = createTestDb();
    const dining = getCategoryByName(db, 'Dining')!;
    const result = deleteCategory(db, dining.id);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('system');
  });

  test('blocks deletion of category with children', () => {
    const db = createTestDb();
    const parentId = addCategory(db, 'CustomParent');
    addCategory(db, 'CustomChild', parentId);

    const result = deleteCategory(db, parentId);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('children');
  });

  test('returns error for non-existent category', () => {
    const db = createTestDb();
    const result = deleteCategory(db, 99999);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('not found');
  });
});

describe('getCategoryDescendantNames', () => {
  test('returns just the category itself when no children', () => {
    const db = createTestDb();
    const names = getCategoryDescendantNames(db, 'Dining');
    expect(names).toEqual(['Dining']);
  });

  test('returns category + all descendants', () => {
    const db = createTestDb();
    const dining = getCategoryByName(db, 'Dining')!;
    addCategory(db, 'Coffee', dining.id);
    addCategory(db, 'Fast Food', dining.id);

    const coffeeId = getCategoryByName(db, 'Coffee')!.id;
    addCategory(db, 'Espresso', coffeeId);

    const names = getCategoryDescendantNames(db, 'Dining');
    expect(names.sort()).toEqual(['Coffee', 'Dining', 'Espresso', 'Fast Food']);
  });

  test('is case-insensitive', () => {
    const db = createTestDb();
    const names = getCategoryDescendantNames(db, 'dining');
    expect(names).toEqual(['Dining']);
  });

  test('returns empty array for non-existent category', () => {
    const db = createTestDb();
    const names = getCategoryDescendantNames(db, 'NonExistent');
    expect(names).toEqual([]);
  });
});

describe('resolveCategory', () => {
  test('returns canonical name for case-insensitive match', () => {
    const db = createTestDb();
    expect(resolveCategory(db, 'dining')).toBe('Dining');
    expect(resolveCategory(db, 'GROCERIES')).toBe('Groceries');
    expect(resolveCategory(db, 'fees & interest')).toBe('Fees & Interest');
  });

  test('returns null for non-existent category', () => {
    const db = createTestDb();
    expect(resolveCategory(db, 'NotACategory')).toBeNull();
  });

  test('resolves custom categories', () => {
    const db = createTestDb();
    addCategory(db, 'Pet Supplies');
    expect(resolveCategory(db, 'pet supplies')).toBe('Pet Supplies');
  });
});
