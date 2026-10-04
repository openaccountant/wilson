/**
 * Per-profile agent-access settings, kept in the profile's settings.json:
 *  - `webmcpGrantTtlMinutes`: how long a NEW grant lasts (15 min, 1 h, 4 h, 12 h; default 1 h).
 *    Existing grants keep the expiry they were made with.
 *  - `judgeDailyLimit`: admin-only cap for the trace judge (read by a later phase; set only from Settings).
 *
 * These need an active profile. Anything that must work without one (the kill
 * switch) lives in global-state.ts instead, so every read here tolerates its absence.
 */
import { getSetting, setSetting } from '../utils/config.js';

export const GRANT_TTL_OPTIONS = [15, 60, 240, 720] as const;
export const DEFAULT_GRANT_TTL_MINUTES = 60;
export const GRANT_TTL_KEY = 'webmcpGrantTtlMinutes';

export const DEFAULT_JUDGE_DAILY_LIMIT = 300;
export const JUDGE_DAILY_LIMIT_KEY = 'judgeDailyLimit';

export function getGrantTtlMinutes(): number {
  try {
    const value = getSetting<number>(GRANT_TTL_KEY, DEFAULT_GRANT_TTL_MINUTES);
    return (GRANT_TTL_OPTIONS as readonly number[]).includes(value) ? value : DEFAULT_GRANT_TTL_MINUTES;
  } catch {
    return DEFAULT_GRANT_TTL_MINUTES;
  }
}

export function setGrantTtlMinutes(minutes: number): boolean {
  if (!(GRANT_TTL_OPTIONS as readonly number[]).includes(minutes)) return false;
  return setSetting(GRANT_TTL_KEY, minutes);
}

export function getJudgeDailyLimit(): number {
  try {
    const value = getSetting<number>(JUDGE_DAILY_LIMIT_KEY, DEFAULT_JUDGE_DAILY_LIMIT);
    return Number.isInteger(value) && value >= 1 && value <= 2000 ? value : DEFAULT_JUDGE_DAILY_LIMIT;
  } catch {
    return DEFAULT_JUDGE_DAILY_LIMIT;
  }
}

export function setJudgeDailyLimit(limit: number): boolean {
  if (!Number.isInteger(limit) || limit < 1 || limit > 2000) return false;
  return setSetting(JUDGE_DAILY_LIMIT_KEY, limit);
}
