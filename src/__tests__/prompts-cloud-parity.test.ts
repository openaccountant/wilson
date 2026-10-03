import { afterAll, beforeAll, describe, expect, spyOn, test, setSystemTime } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildSystemPrompt } from '../agent/prompts.js';
import * as toolsRegistry from '../tools/registry.js';
import * as skillsIndex from '../skills/index.js';

// Local-model prompt trimming (design 2026-10-03, Phase 0) must not move a
// single byte of the cloud prompt. The golden file was captured from the
// pre-change prompt builder; regenerate deliberately with UPDATE_SNAPSHOT=1.
const GOLDEN = join(import.meta.dir, 'fixtures', 'cloud-system-prompt.golden.txt');

describe('cloud system prompt parity', () => {
  beforeAll(() => setSystemTime(new Date('2026-06-15T12:00:00Z')));
  afterAll(() => setSystemTime());

  test('cloud models get the same prompt as before the local-model trim', async () => {
    const tools = spyOn(toolsRegistry, 'buildToolDescriptions').mockResolvedValue('### mock_tool\nDescription.');
    const discover = spyOn(skillsIndex, 'discoverSkills').mockReturnValue([
      { name: 'month-end-close', description: 'Close the books.', tier: 'free' },
    ] as never);
    const meta = spyOn(skillsIndex, 'buildSkillMetadataSection').mockReturnValue(
      '- **month-end-close**: Close the books.\n- **tax-prep** *(paid)*: Prep taxes.',
    );
    try {
      const prompt = await buildSystemPrompt('claude-sonnet-4-5', 'You are Wilson.');
      if (process.env.UPDATE_SNAPSHOT === '1' || !existsSync(GOLDEN)) writeFileSync(GOLDEN, prompt);
      expect(prompt).toBe(readFileSync(GOLDEN, 'utf-8'));
      // The cloud prompt keeps the full table example and skill descriptions.
      expect(prompt).toContain('$842.50');
      expect(prompt).toContain('Close the books.');
    } finally {
      tools.mockRestore();
      discover.mockRestore();
      meta.mockRestore();
    }
  });
});
