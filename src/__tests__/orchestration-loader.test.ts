import { describe, test, expect, spyOn, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import * as fetcher from '../content/fetcher.js';
import { discoverChains, discoverTeams, loadPaidChainSteps } from '../orchestration/loader.js';

describe('orchestration/loader', () => {
  // Use project-level .openaccountant directory (cwd-based search path)
  const projectChainsDir = join(process.cwd(), '.openaccountant', 'chains');
  const projectTeamsDir = join(process.cwd(), '.openaccountant', 'teams');
  const createdDirs: string[] = [];
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    fetchSpy = spyOn(fetcher, 'fetchPaidChainSteps').mockImplementation(async (name: string) => {
      if (name === 'test-paid') return [{ id: 'paid-step-1' }] as any;
      return null;
    });
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
    for (const dir of createdDirs) {
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    createdDirs.length = 0;
  });

  describe('discoverChains', () => {
    test('returns an array', () => {
      const chains = discoverChains();
      expect(Array.isArray(chains)).toBe(true);
    });

    test('loads chain YAML from project dir', () => {
      mkdirSync(projectChainsDir, { recursive: true });
      createdDirs.push(projectChainsDir);
      writeFileSync(
        join(projectChainsDir, 'loader-test-chain.yaml'),
        'name: loader-test-chain\ndescription: A test chain for loader test\nsteps:\n  - id: step1\n',
      );

      const chains = discoverChains();
      const chain = chains.find((c) => c.name === 'loader-test-chain');
      expect(chain).toBeDefined();
      expect(chain!.description).toBe('A test chain for loader test');
    });

    test('skips malformed YAML', () => {
      mkdirSync(projectChainsDir, { recursive: true });
      createdDirs.push(projectChainsDir);
      writeFileSync(join(projectChainsDir, 'bad-chain.yaml'), '}{{{not yaml');
      expect(() => discoverChains()).not.toThrow();
    });
  });

  describe('discoverTeams', () => {
    test('returns an array', () => {
      const teams = discoverTeams();
      expect(Array.isArray(teams)).toBe(true);
    });

    test('loads team YAML from project dir', () => {
      mkdirSync(projectTeamsDir, { recursive: true });
      createdDirs.push(projectTeamsDir);
      writeFileSync(
        join(projectTeamsDir, 'loader-test-team.yaml'),
        'name: loader-test-team\ndescription: A test team\ndispatcher:\n  systemPrompt: dispatch\nmembers:\n  - id: analyst\n',
      );

      const teams = discoverTeams();
      const team = teams.find((t) => t.name === 'loader-test-team');
      expect(team).toBeDefined();
      expect(team!.description).toBe('A test team');
    });
  });

  describe('loadPaidChainSteps', () => {
    test('returns steps for known paid chain', async () => {
      const steps = await loadPaidChainSteps('test-paid');
      expect(steps).toEqual([{ id: 'paid-step-1' }]);
    });

    test('returns null for unknown chain', async () => {
      const steps = await loadPaidChainSteps('nonexistent');
      expect(steps).toBeNull();
    });
  });
});
