import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, rmSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getLicenseInfo } from '../licensing/license.js';
import type { ChainStep } from '../orchestration/types.js';

const CONTENT_API = process.env.OPENSPEND_API_URL ?? 'https://us-central1-openspend.cloudfunctions.net';
const CACHE_DIR = join(homedir(), '.openspend', 'content-cache');
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function getCachePath(type: 'skills' | 'chains', name: string): string {
  const ext = type === 'skills' ? '.md' : '.json';
  return join(CACHE_DIR, type, `${name}${ext}`);
}

function readCache(type: 'skills' | 'chains', name: string): string | null {
  const path = getCachePath(type, name);
  if (!existsSync(path)) return null;

  try {
    const stat = statSync(path);
    const age = Date.now() - stat.mtimeMs;
    if (age > CACHE_TTL_MS) return null; // Expired

    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

function writeCache(type: 'skills' | 'chains', name: string, content: string): void {
  const path = getCachePath(type, name);
  const dir = join(CACHE_DIR, type);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, content);
}

/**
 * Fetch paid skill instructions from the content server.
 * Returns the SKILL.md instructions body, or null if unauthorized/unavailable.
 */
export async function fetchPaidSkillContent(skillName: string): Promise<string | null> {
  const license = getLicenseInfo();
  if (!license) return null;

  try {
    const res = await fetch(`${CONTENT_API}/content/skills/${skillName}`, {
      headers: { Authorization: `Bearer ${license.key}` },
    });

    if (res.status === 401 || res.status === 403) {
      return null;
    }

    if (!res.ok) {
      // Network/server error — fall back to cache
      return readCache('skills', skillName);
    }

    const content = await res.text();
    writeCache('skills', skillName, content);
    return content;
  } catch {
    // Network error — fall back to cache
    return readCache('skills', skillName);
  }
}

/**
 * Fetch paid chain steps from the content server.
 * Returns the chain steps array, or null if unauthorized/unavailable.
 */
export async function fetchPaidChainSteps(chainName: string): Promise<ChainStep[] | null> {
  const license = getLicenseInfo();
  if (!license) return null;

  try {
    const res = await fetch(`${CONTENT_API}/content/chains/${chainName}`, {
      headers: { Authorization: `Bearer ${license.key}` },
    });

    if (res.status === 401 || res.status === 403) {
      return null;
    }

    if (!res.ok) {
      // Network/server error — fall back to cache
      const cached = readCache('chains', chainName);
      if (cached) {
        try {
          const parsed = JSON.parse(cached);
          return parsed.steps ?? parsed;
        } catch {
          return null;
        }
      }
      return null;
    }

    const data = await res.json() as { steps: ChainStep[] };
    writeCache('chains', chainName, JSON.stringify(data.steps));
    return data.steps;
  } catch {
    // Network error — fall back to cache
    const cached = readCache('chains', chainName);
    if (cached) {
      try {
        const parsed = JSON.parse(cached);
        return parsed.steps ?? parsed;
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * Clear the entire content cache directory.
 * Called when license changes (activation or deactivation).
 */
export function clearContentCache(): void {
  if (existsSync(CACHE_DIR)) {
    rmSync(CACHE_DIR, { recursive: true, force: true });
  }
}
