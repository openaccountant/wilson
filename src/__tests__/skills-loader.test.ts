import { describe, expect, test, afterEach } from 'bun:test';
import { writeFileSync, unlinkSync } from 'fs';
import { makeTmpPath } from './helpers.js';

// Bun shares one module registry across all test files in a `bun test` run, so
// mock.module('../skills/index.js') in other files (agent.test.ts,
// skill-tool.test.ts) leaks into this file's import — index.ts re-exports
// ./loader.js and the mock replaces the loader record too. A cache-busted
// specifier forces a fresh, unmocked module record (the same isolation CI gets
// by running each test file in its own process — see .github/workflows/ci.yml).
const loaderModule: string = '../skills/loader.js?victim';
const loader = (await import(loaderModule)) as typeof import('../skills/loader.js');
const { parseSkillFile, loadSkillFromPath, extractSkillMetadata } = loader;

const VALID_SKILL = `---
name: monthly-report
description: Generate a monthly financial report
tier: paid
---

## Instructions

Run the spending summary for the given month.
`;

const SKILL_NO_TIER = `---
name: basic-skill
description: A basic skill without tier
---

Do something useful.
`;

describe('skills/loader', () => {
  const tmpFiles: string[] = [];

  afterEach(() => {
    for (const f of tmpFiles) {
      try { unlinkSync(f); } catch {}
    }
    tmpFiles.length = 0;
  });

  describe('parseSkillFile', () => {
    test('parses valid skill file', () => {
      const skill = parseSkillFile(VALID_SKILL, '/path/to/SKILL.md', 'builtin');
      expect(skill.name).toBe('monthly-report');
      expect(skill.description).toBe('Generate a monthly financial report');
      expect(skill.tier).toBe('paid');
      expect(skill.source).toBe('builtin');
      expect(skill.path).toBe('/path/to/SKILL.md');
      expect(skill.instructions).toContain('spending summary');
    });

    test('tier defaults to free when not specified', () => {
      const skill = parseSkillFile(SKILL_NO_TIER, '/path/SKILL.md', 'user');
      expect(skill.tier).toBe('free');
    });

    test('throws on missing name', () => {
      const content = `---
description: No name field
---
Body text.`;
      expect(() => parseSkillFile(content, '/test.md', 'builtin')).toThrow('missing required \'name\'');
    });

    test('throws on missing description', () => {
      const content = `---
name: no-desc
---
Body text.`;
      expect(() => parseSkillFile(content, '/test.md', 'builtin')).toThrow('missing required \'description\'');
    });

    test('trims instruction whitespace', () => {
      const skill = parseSkillFile(VALID_SKILL, '/test.md', 'builtin');
      expect(skill.instructions.startsWith('\n')).toBe(false);
      expect(skill.instructions.endsWith('\n')).toBe(false);
    });

    test('handles empty body', () => {
      const content = `---
name: empty-body
description: No body
---`;
      const skill = parseSkillFile(content, '/test.md', 'builtin');
      expect(skill.instructions).toBe('');
    });
  });

  describe('loadSkillFromPath', () => {
    test('loads skill from tmp file', () => {
      const fp = makeTmpPath('.md');
      tmpFiles.push(fp);
      writeFileSync(fp, VALID_SKILL);

      const skill = loadSkillFromPath(fp, 'user');
      expect(skill.name).toBe('monthly-report');
      expect(skill.description).toBe('Generate a monthly financial report');
      expect(skill.path).toBe(fp);
      expect(skill.source).toBe('user');
    });

    test('throws on nonexistent file', () => {
      expect(() => loadSkillFromPath('/nonexistent/SKILL.md', 'builtin')).toThrow();
    });
  });

  describe('extractSkillMetadata', () => {
    test('extracts metadata from valid SKILL.md', () => {
      const fp = makeTmpPath('.md');
      tmpFiles.push(fp);
      writeFileSync(fp, VALID_SKILL);

      const meta = extractSkillMetadata(fp, 'builtin');
      expect(meta.name).toBe('monthly-report');
      expect(meta.description).toBe('Generate a monthly financial report');
      expect(meta.tier).toBe('paid');
      expect(meta.source).toBe('builtin');
      expect(meta.path).toBe(fp);
    });

    test('defaults tier to free when not specified', () => {
      const fp = makeTmpPath('.md');
      tmpFiles.push(fp);
      writeFileSync(fp, SKILL_NO_TIER);

      const meta = extractSkillMetadata(fp, 'user');
      expect(meta.tier).toBe('free');
    });

    test('throws on missing name field', () => {
      const fp = makeTmpPath('.md');
      tmpFiles.push(fp);
      writeFileSync(fp, `---\ndescription: No name\n---\nBody.`);

      expect(() => extractSkillMetadata(fp, 'builtin')).toThrow("missing required 'name'");
    });

    test('throws on missing description field', () => {
      const fp = makeTmpPath('.md');
      tmpFiles.push(fp);
      writeFileSync(fp, `---\nname: no-desc\n---\nBody.`);

      expect(() => extractSkillMetadata(fp, 'builtin')).toThrow("missing required 'description'");
    });
  });
});
