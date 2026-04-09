import { describe, test, expect, spyOn, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as license from '../licensing/license.js';
import * as fetcher from '../content/fetcher.js';
import * as skillLoader from '../skills/loader.js';
import { discoverSkills, getSkill, buildSkillMetadataSection, clearSkillCache } from '../skills/registry.js';

describe('skills/registry', () => {
  let licenseSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    clearSkillCache();
    licenseSpy = spyOn(license, 'hasLicense').mockReturnValue(false);
  });

  afterEach(() => {
    licenseSpy?.mockRestore();
  });

  describe('discoverSkills', () => {
    test('returns array of skills', () => {
      const skills = discoverSkills();
      expect(Array.isArray(skills)).toBe(true);
    });

    test('caches results on second call', () => {
      const first = discoverSkills();
      const second = discoverSkills();
      expect(first).toEqual(second);
    });

    test('clearSkillCache forces re-scan', () => {
      discoverSkills();
      clearSkillCache();
      const after = discoverSkills();
      expect(Array.isArray(after)).toBe(true);
    });
  });

  describe('getSkill', () => {
    test('returns undefined for unknown skill', async () => {
      discoverSkills();
      const skill = await getSkill('totally-nonexistent-skill-xyz');
      expect(skill).toBeUndefined();
    });

    test('calls discoverSkills if cache is empty', async () => {
      const skill = await getSkill('totally-nonexistent-skill-xyz');
      expect(skill).toBeUndefined();
    });
  });

  describe('buildSkillMetadataSection', () => {
    test('returns formatted string', () => {
      const section = buildSkillMetadataSection();
      expect(typeof section).toBe('string');
    });

    test('returns non-empty result', () => {
      const section = buildSkillMetadataSection();
      expect(section.length).toBeGreaterThan(0);
    });
  });

  describe('clearSkillCache', () => {
    test('clears the cache', () => {
      discoverSkills();
      clearSkillCache();
      const skills = discoverSkills();
      expect(Array.isArray(skills)).toBe(true);
    });
  });

  describe('nested skill directories', () => {
    let existsSpy: ReturnType<typeof spyOn>;
    let readdirSpy: ReturnType<typeof spyOn>;
    let metadataSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
      clearSkillCache();
      existsSpy = spyOn(fs, 'existsSync');
      readdirSpy = spyOn(fs, 'readdirSync');
      metadataSpy = spyOn(skillLoader, 'extractSkillMetadata');

      existsSpy.mockImplementation((p: any) => {
        const pathStr = String(p);
        // The user skills directory exists
        if (pathStr.endsWith('.openaccountant/skills')) return true;
        // The category subdirectory exists (for recursion)
        if (pathStr.endsWith('/personal')) return true;
        // The nested skill file exists
        if (pathStr.includes('personal/subscription-audit/SKILL.md')) return true;
        // The category dir "personal" does NOT have a SKILL.md directly
        if (pathStr.endsWith('personal/SKILL.md')) return false;
        return false;
      });

      readdirSpy.mockImplementation((dirPath: any, _opts?: any) => {
        const pathStr = String(dirPath);
        if (pathStr.endsWith('.openaccountant/skills')) {
          return [{ name: 'personal', isDirectory: () => true, isFile: () => false }];
        }
        if (pathStr.endsWith('/personal')) {
          return [{ name: 'subscription-audit', isDirectory: () => true, isFile: () => false }];
        }
        return [];
      });

      metadataSpy.mockImplementation((path: string, source: any) => {
        if (path.includes('subscription-audit')) {
          return { name: 'subscription-audit', description: 'Find unused subscriptions', path, source, tier: 'free' };
        }
        throw new Error(`Unknown skill: ${path}`);
      });
    });

    afterEach(() => {
      existsSpy?.mockRestore();
      readdirSpy?.mockRestore();
      metadataSpy?.mockRestore();
      clearSkillCache();
    });

    test('discovers skills in nested category directories', () => {
      const skills = discoverSkills();
      const found = skills.find((s) => s.name === 'subscription-audit');
      expect(found).toBeDefined();
      expect(found!.description).toBe('Find unused subscriptions');
    });
  });

  describe('getSkill (paid skill paths)', () => {
    let fetchSpy: ReturnType<typeof spyOn>;
    let existsSpy: ReturnType<typeof spyOn>;
    let readdirSpy: ReturnType<typeof spyOn>;
    let metadataSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
      clearSkillCache();
      fetchSpy = spyOn(fetcher, 'fetchPaidSkillContent').mockResolvedValue(null);
      // Mock filesystem to simulate a paid skill directory
      existsSpy = spyOn(fs, 'existsSync');
      readdirSpy = spyOn(fs, 'readdirSync');
      metadataSpy = spyOn(skillLoader, 'extractSkillMetadata');

      const origExists = existsSpy.getMockImplementation() ?? fs.existsSync;
      existsSpy.mockImplementation((p: any) => {
        const pathStr = String(p);
        if (pathStr.includes('paid-test-skill') && pathStr.endsWith('SKILL.md')) return true;
        // For skills directories, ensure the project skills dir "exists"
        if (pathStr.endsWith('.openaccountant/skills')) return true;
        // @ts-ignore
        return Bun.originalFunctions?.existsSync?.(p) ?? true;
      });

      // When scanning the project skills directory, return our fake paid skill dir entry
      readdirSpy.mockImplementation((dirPath: any, opts?: any) => {
        const pathStr = String(dirPath);
        if (pathStr.endsWith('.openaccountant/skills')) {
          return [{ name: 'paid-test-skill', isDirectory: () => true, isFile: () => false }];
        }
        // Other dirs return empty
        return [];
      });

      metadataSpy.mockImplementation((path: string, source: any) => {
        if (path.includes('paid-test-skill')) {
          return { name: 'paid-test-skill', description: 'A paid test skill', path, source, tier: 'paid' };
        }
        throw new Error(`Unknown skill: ${path}`);
      });
    });

    afterEach(() => {
      fetchSpy?.mockRestore();
      existsSpy?.mockRestore();
      readdirSpy?.mockRestore();
      metadataSpy?.mockRestore();
      clearSkillCache();
    });

    test('returns stub for paid skill without license', async () => {
      licenseSpy.mockReturnValue(false);
      discoverSkills();
      const skill = await getSkill('paid-test-skill');
      expect(skill).toBeDefined();
      expect(skill!.instructions).toContain('Pro feature');
      expect(skill!.instructions).toContain('/upgrade');
    });

    test('returns fetched content for paid skill with license', async () => {
      licenseSpy.mockReturnValue(true);
      fetchSpy.mockResolvedValue('# Server-provided instructions\nDo advanced stuff');
      discoverSkills();
      const skill = await getSkill('paid-test-skill');
      expect(skill).toBeDefined();
      expect(skill!.instructions).toBe('# Server-provided instructions\nDo advanced stuff');
    });

    test('returns stub when paid skill with license but fetch fails', async () => {
      licenseSpy.mockReturnValue(true);
      fetchSpy.mockResolvedValue(null);
      discoverSkills();
      const skill = await getSkill('paid-test-skill');
      expect(skill).toBeDefined();
      expect(skill!.instructions).toContain('Pro feature');
    });
  });
});
