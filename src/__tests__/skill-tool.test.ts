import { describe, expect, test, beforeEach, afterAll, mock, spyOn } from 'bun:test';
import { ensureTestProfile } from './helpers.js';
import * as skillsIndex from '../skills/index.js';
import * as licenseModule from '../licensing/license.js';

// Spy on the real modules instead of mock.module: bun's module mocks cannot be
// undone and leak into other test files (module registries are shared across
// files within a single `bun test` run), which would poison test files that
// exercise the real skills/loader and licensing/license modules.
const mockGetSkill = mock((): Promise<any> => Promise.resolve(null as any));
const mockDiscoverSkills = mock((): any[] => []);
const mockHasLicense = mock(() => false);

const getSkillSpy = spyOn(skillsIndex, 'getSkill').mockImplementation(mockGetSkill as any);
const discoverSkillsSpy = spyOn(skillsIndex, 'discoverSkills').mockImplementation(mockDiscoverSkills as any);
const hasLicenseSpy = spyOn(licenseModule, 'hasLicense').mockImplementation(mockHasLicense as any);

// Import after spies are set up
const { skillTool } = await import('../tools/skill.js');

afterAll(() => {
  getSkillSpy.mockRestore();
  discoverSkillsSpy.mockRestore();
  hasLicenseSpy.mockRestore();
});

describe('skillTool', () => {
  beforeEach(() => {
    ensureTestProfile();
    mockGetSkill.mockReset();
    mockDiscoverSkills.mockReset();
    mockHasLicense.mockReset();
  });

  test('has correct name and description', () => {
    expect(skillTool.name).toBe('skill');
    expect(skillTool.description).toBeTruthy();
  });

  test('valid skill returns formatted instructions', async () => {
    mockGetSkill.mockResolvedValue({
      name: 'budget-audit',
      description: 'Audit your budget',
      path: '/tmp/skills/budget-audit/SKILL.md',
      source: 'builtin',
      tier: 'free',
      instructions: 'Step 1: Review all categories\nStep 2: Check limits',
    });
    mockDiscoverSkills.mockReturnValue([
      { name: 'budget-audit', description: 'Audit', path: '/tmp', source: 'builtin', tier: 'free' },
    ]);

    const result = await skillTool.func({ skill: 'budget-audit' });
    expect(result).toContain('## Skill: budget-audit');
    expect(result).toContain('Step 1: Review all categories');
    expect(result).toContain('Step 2: Check limits');
  });

  test('invalid skill returns error with available skills', async () => {
    mockGetSkill.mockResolvedValue(null);
    mockDiscoverSkills.mockReturnValue([
      { name: 'budget-audit', description: 'Audit', path: '/tmp', source: 'builtin', tier: 'free' },
      { name: 'tax-prep', description: 'Tax', path: '/tmp', source: 'builtin', tier: 'paid' },
    ]);

    const result = await skillTool.func({ skill: 'nonexistent' });
    expect(result).toContain('Error');
    expect(result).toContain('nonexistent');
    expect(result).toContain('budget-audit');
    expect(result).toContain('tax-prep');
  });

  test('skill with args includes arguments in result', async () => {
    mockGetSkill.mockResolvedValue({
      name: 'subscription-audit',
      description: 'Audit subs',
      path: '/tmp/skills/sub-audit/SKILL.md',
      source: 'builtin',
      tier: 'free',
      instructions: 'Review subscriptions for the given period.',
    });
    mockDiscoverSkills.mockReturnValue([
      { name: 'subscription-audit', description: 'Audit', path: '/tmp', source: 'builtin', tier: 'free' },
    ]);

    const result = await skillTool.func({ skill: 'subscription-audit', args: 'January 2026' });
    expect(result).toContain('**Arguments provided:** January 2026');
  });

  test('paid skill without license returns license message', async () => {
    mockGetSkill.mockResolvedValue({
      name: 'tax-prep',
      description: 'Tax prep',
      path: '/tmp/skills/tax-prep/SKILL.md',
      source: 'builtin',
      tier: 'paid',
      instructions: 'Secret paid instructions',
    });
    mockDiscoverSkills.mockReturnValue([
      { name: 'tax-prep', description: 'Tax', path: '/tmp', source: 'builtin', tier: 'paid' },
    ]);
    mockHasLicense.mockReturnValue(false);

    const result = await skillTool.func({ skill: 'tax-prep' });
    expect(result).toContain('Pro feature');
    expect(result).not.toContain('Secret paid instructions');
  });

  test('paid skill with license returns instructions', async () => {
    mockGetSkill.mockResolvedValue({
      name: 'tax-prep',
      description: 'Tax prep',
      path: '/tmp/skills/tax-prep/SKILL.md',
      source: 'builtin',
      tier: 'paid',
      instructions: 'Paid instructions for tax prep.',
    });
    mockDiscoverSkills.mockReturnValue([
      { name: 'tax-prep', description: 'Tax', path: '/tmp', source: 'builtin', tier: 'paid' },
    ]);
    mockHasLicense.mockReturnValue(true);

    const result = await skillTool.func({ skill: 'tax-prep' });
    expect(result).toContain('Paid instructions for tax prep.');
  });

  test('relative markdown links are resolved to absolute paths', async () => {
    mockGetSkill.mockResolvedValue({
      name: 'categorize-guide',
      description: 'Guide',
      path: '/home/user/skills/categorize/SKILL.md',
      source: 'builtin',
      tier: 'free',
      instructions: 'See [taxonomy](./category-taxonomy.md) for details.',
    });
    mockDiscoverSkills.mockReturnValue([
      { name: 'categorize-guide', description: 'Guide', path: '/home/user/skills/categorize/SKILL.md', source: 'builtin', tier: 'free' },
    ]);

    const result = await skillTool.func({ skill: 'categorize-guide' });
    expect(result).toContain('/home/user/skills/categorize/category-taxonomy.md');
    expect(result).not.toContain('./category-taxonomy.md');
  });

  test('absolute and http links are not modified', async () => {
    mockGetSkill.mockResolvedValue({
      name: 'link-test',
      description: 'Test',
      path: '/tmp/skills/test/SKILL.md',
      source: 'builtin',
      tier: 'free',
      instructions: 'See [docs](https://example.com/docs.md) and [file](/absolute/path.md).',
    });
    mockDiscoverSkills.mockReturnValue([
      { name: 'link-test', description: 'Test', path: '/tmp', source: 'builtin', tier: 'free' },
    ]);

    const result = await skillTool.func({ skill: 'link-test' });
    expect(result).toContain('https://example.com/docs.md');
    expect(result).toContain('/absolute/path.md');
  });
});
