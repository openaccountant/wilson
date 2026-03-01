import { execFileSync } from 'child_process';
import { join } from 'path';
import { homedir } from 'os';
import { getSchedules } from './store.js';

const CRON_TAG = '# wilson-managed';
const LOG_FILE = join(homedir(), '.openspend', 'schedule.log');

/**
 * Get the absolute path to the wilson binary.
 */
function getWilsonPath(): string {
  return process.argv[0];
}

/**
 * Read the current crontab contents (returns empty string if none exists).
 */
function readCrontab(): string {
  try {
    return execFileSync('crontab', ['-l'], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
  } catch {
    return '';
  }
}

/**
 * Write new contents to the crontab via stdin.
 */
function writeCrontab(content: string): void {
  execFileSync('crontab', ['-'], { input: content, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
}

/**
 * Sync enabled schedules to the system crontab.
 * Removes all previous wilson-managed entries and writes current ones.
 */
export function syncCrontab(): void {
  const existing = readCrontab();

  // Remove all wilson-managed lines
  const lines = existing.split('\n').filter((line) => !line.includes(CRON_TAG));

  // Add entries for enabled schedules
  const schedules = getSchedules().filter((s) => s.enabled);
  const wilsonPath = getWilsonPath();

  for (const schedule of schedules) {
    const entry = `${schedule.cron} ${wilsonPath} --run "${schedule.query.replace(/"/g, '\\"')}" >> ${LOG_FILE} 2>&1 ${CRON_TAG}`;
    lines.push(entry);
  }

  // Write back (filter out trailing empty lines, ensure final newline)
  const newCrontab = lines.filter((l, i) => l !== '' || i < lines.length - 1).join('\n') + '\n';

  try {
    writeCrontab(newCrontab);
  } catch (err) {
    throw new Error(`Failed to update crontab: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Remove all Wilson-managed entries from the crontab.
 */
export function clearCrontab(): void {
  const existing = readCrontab();
  if (!existing) return;

  const lines = existing.split('\n').filter((line) => !line.includes(CRON_TAG));
  const newCrontab = lines.join('\n') + '\n';

  try {
    writeCrontab(newCrontab);
  } catch {
    // Silently fail if crontab can't be written
  }
}
