import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';

// ── Types ────────────────────────────────────────────────────────────────────

export interface Schedule {
  id: string;
  query: string;
  cron: string;
  label: string;
  enabled: boolean;
  createdAt: string;
  lastRunAt: string | null;
}

interface ScheduleStore {
  schedules: Schedule[];
}

// ── Constants ────────────────────────────────────────────────────────────────

const STORE_DIR = join(homedir(), '.agentwilson');
const STORE_FILE = join(STORE_DIR, 'schedules.json');

// ── Store I/O ────────────────────────────────────────────────────────────────

function readStore(): ScheduleStore {
  if (!existsSync(STORE_FILE)) return { schedules: [] };
  try {
    return JSON.parse(readFileSync(STORE_FILE, 'utf-8')) as ScheduleStore;
  } catch {
    return { schedules: [] };
  }
}

function writeStore(store: ScheduleStore): void {
  if (!existsSync(STORE_DIR)) {
    mkdirSync(STORE_DIR, { recursive: true });
  }
  writeFileSync(STORE_FILE, JSON.stringify(store, null, 2));
  chmodSync(STORE_FILE, 0o600);
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Get all schedules.
 */
export function getSchedules(): Schedule[] {
  return readStore().schedules;
}

/**
 * Add a new schedule. Returns the created schedule with generated ID.
 */
export function addSchedule(schedule: Omit<Schedule, 'id' | 'createdAt' | 'lastRunAt'>): Schedule {
  const store = readStore();
  const newSchedule: Schedule = {
    ...schedule,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    lastRunAt: null,
  };
  store.schedules.push(newSchedule);
  writeStore(store);
  return newSchedule;
}

/**
 * Remove a schedule by ID. Returns true if found and removed.
 */
export function removeSchedule(id: string): boolean {
  const store = readStore();
  const before = store.schedules.length;
  store.schedules = store.schedules.filter((s) => s.id !== id);
  if (store.schedules.length < before) {
    writeStore(store);
    return true;
  }
  return false;
}

/**
 * Toggle a schedule's enabled state. Returns true if found.
 */
export function toggleSchedule(id: string): boolean {
  const store = readStore();
  const schedule = store.schedules.find((s) => s.id === id);
  if (!schedule) return false;
  schedule.enabled = !schedule.enabled;
  writeStore(store);
  return true;
}

/**
 * Update the lastRunAt timestamp for a schedule.
 */
export function updateLastRun(id: string): void {
  const store = readStore();
  const schedule = store.schedules.find((s) => s.id === id);
  if (schedule) {
    schedule.lastRunAt = new Date().toISOString();
    writeStore(store);
  }
}
