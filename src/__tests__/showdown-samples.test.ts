import { describe, expect, test } from 'bun:test';
import { SAMPLE_TRANSACTIONS, getSampleBySlug } from '../demo/samples.js';
import {
  getShowdownSamples,
  buildShowdownUserPrompt,
  SHOWDOWN_SYSTEM_PROMPT,
} from '../demo/showdown.js';
import { CATEGORIZER_SYSTEM_PROMPT } from '../tools/categorize/categorize.js';
import { CATEGORIES } from '../tools/categorize/categories.js';
import { getProviderById } from '../providers.js';
import { getLocalChatModelConfig } from '../model/local-chat.js';

describe('sample fixtures', () => {
  test('exactly 8 rows with unique ids and slugs', () => {
    expect(SAMPLE_TRANSACTIONS).toHaveLength(8);
    const ids = new Set(SAMPLE_TRANSACTIONS.map((s) => s.id));
    const slugs = new Set(SAMPLE_TRANSACTIONS.map((s) => s.slug));
    expect(ids.size).toBe(8);
    expect(slugs.size).toBe(8);
  });

  test('every expectedCategory is a member of CATEGORIES', () => {
    for (const s of SAMPLE_TRANSACTIONS) {
      expect(CATEGORIES).toContain(s.expectedCategory);
    }
  });

  test('the Harborview $318 demo pick is present with ground truth Health', () => {
    const row = SAMPLE_TRANSACTIONS.find((s) => s.slug === 'harborview-dental');
    expect(row).toBeDefined();
    expect(row!.id).toBe(2);
    expect(row!.description).toBe('HARBORVIEW DENTAL GROUP');
    expect(row!.amount).toBe(-318);
    expect(row!.expectedCategory).toBe('Health');
    expect(row!.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('getSampleBySlug resolves known slugs and throws on unknown ids', () => {
    expect(getSampleBySlug('corner-market').id).toBe(1);
    expect(() => getSampleBySlug('nope')).toThrow('Unknown sample slug');
  });
});

describe('buildShowdownUserPrompt', () => {
  test('is the production categorization prompt with the hardcoded category list', () => {
    const prompt = buildShowdownUserPrompt(getSampleBySlug('harborview-dental'));
    expect(prompt).toContain('Groceries');
    expect(prompt).toContain('RULES');
    expect(prompt).toContain('0.9-1.0');
    expect(prompt).toContain('HARBORVIEW DENTAL GROUP');
    expect(prompt).toContain('-318');
    expect(prompt).toContain('"date": "2026-09-14"');
  });

  test('carries exactly one transaction row (single-row decision task)', () => {
    const prompt = buildShowdownUserPrompt(getSampleBySlug('netflix'));
    // The response-format template also mentions "id", so count description
    // fields — one row means exactly one.
    const rowFields = prompt.match(/"description":/g) ?? [];
    expect(rowFields.length).toBe(1);
    expect(prompt).toContain('NETFLIX.COM');
    expect(prompt).toContain('"id": 3');
  });
});

describe('getShowdownSamples', () => {
  const response = getShowdownSamples();

  test('serves every fixture with its rendered userPrompt', () => {
    expect(response.samples).toHaveLength(SAMPLE_TRANSACTIONS.length);
    for (const sample of response.samples) {
      const fixture = SAMPLE_TRANSACTIONS.find((s) => s.slug === sample.slug)!;
      expect(sample.userPrompt).toBe(buildShowdownUserPrompt(fixture));
    }
  });

  test('shares one system prompt with the production categorize tool', () => {
    expect(SHOWDOWN_SYSTEM_PROMPT).toBe(CATEGORIZER_SYSTEM_PROMPT);
    expect(response.systemPrompt).toBe(CATEGORIZER_SYSTEM_PROMPT);
    expect(response.systemPrompt).toBe(
      'You are a precise financial transaction categorizer. Respond only with valid JSON.',
    );
  });

  test('model config is derived from the registries, never duplicated', () => {
    expect(response.config.cloudModel).toBe(getProviderById('openrouter')!.fastModel as string);
    const local = getLocalChatModelConfig();
    expect(response.config.localModel).toBe(local.id);
    expect(response.config.localRepo).toBe(local.repo);
  });
});