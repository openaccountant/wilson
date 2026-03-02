import { describe, expect, test, beforeAll, afterAll, beforeEach } from 'bun:test';
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { hasLicense, getLicenseInfo, deactivateLicense, type LicenseCache } from '../licensing/license.js';

const LICENSE_DIR = join(homedir(), '.openaccountant');
const LICENSE_FILE = join(LICENSE_DIR, 'license.json');

function writeLicenseCache(cache: LicenseCache): void {
  if (!existsSync(LICENSE_DIR)) mkdirSync(LICENSE_DIR, { recursive: true });
  writeFileSync(LICENSE_FILE, JSON.stringify(cache, null, 2));
}

function removeLicenseFile(): void {
  if (existsSync(LICENSE_FILE)) unlinkSync(LICENSE_FILE);
}

describe('licensing/license', () => {
  let originalContent: string | null = null;
  let originalFetch: typeof globalThis.fetch;

  beforeAll(() => {
    // Save original license file
    try {
      originalContent = readFileSync(LICENSE_FILE, 'utf-8');
    } catch {
      originalContent = null;
    }
    // Mock fetch to prevent real HTTP calls from background re-validation
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ valid: true, license: { email: 'test@test.com' }, products: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof globalThis.fetch;
  });

  afterAll(() => {
    // Restore original state
    globalThis.fetch = originalFetch;
    if (originalContent) {
      writeFileSync(LICENSE_FILE, originalContent);
    } else {
      removeLicenseFile();
    }
  });

  beforeEach(() => {
    removeLicenseFile();
  });

  test('hasLicense returns false when no cache file exists', () => {
    expect(hasLicense('pro')).toBe(false);
  });

  test('hasLicense returns true for valid cache', () => {
    writeLicenseCache({
      key: 'test-key',
      email: 'test@test.com',
      products: [], // all-access
      validUntil: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      validatedAt: new Date().toISOString(),
    });
    expect(hasLicense('pro')).toBe(true);
  });

  test('hasLicense returns false for expired license', () => {
    writeLicenseCache({
      key: 'test-key',
      email: 'test@test.com',
      products: [],
      validUntil: new Date(Date.now() - 1000).toISOString(), // expired
      validatedAt: new Date().toISOString(),
    });
    expect(hasLicense('pro')).toBe(false);
  });

  test('hasLicense returns false when offline grace period exceeded', () => {
    writeLicenseCache({
      key: 'test-key',
      email: 'test@test.com',
      products: [],
      validUntil: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      validatedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString(), // 31 days ago
    });
    expect(hasLicense('pro')).toBe(false);
  });

  test('hasLicense returns true for stale but within grace period', () => {
    writeLicenseCache({
      key: 'test-key',
      email: 'test@test.com',
      products: [],
      validUntil: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      validatedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(), // 2 days ago (stale but within 30-day grace)
    });
    expect(hasLicense('pro')).toBe(true);
  });

  test('hasLicense checks product coverage', () => {
    writeLicenseCache({
      key: 'test-key',
      email: 'test@test.com',
      products: ['pro', 'tax'],
      validUntil: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      validatedAt: new Date().toISOString(),
    });
    expect(hasLicense('pro')).toBe(true);
    expect(hasLicense('other-product')).toBe(false);
  });

  test('getLicenseInfo returns cached info', () => {
    const cache: LicenseCache = {
      key: 'info-test-key',
      email: 'info@test.com',
      products: ['pro'],
      validUntil: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      validatedAt: new Date().toISOString(),
    };
    writeLicenseCache(cache);
    const info = getLicenseInfo();
    expect(info).not.toBeNull();
    expect(info!.email).toBe('info@test.com');
    expect(info!.key).toBe('info-test-key');
  });

  test('getLicenseInfo returns null when no cache', () => {
    expect(getLicenseInfo()).toBeNull();
  });

  test('deactivateLicense removes cache file', () => {
    writeLicenseCache({
      key: 'deactivate-key',
      email: 'deactivate@test.com',
      products: [],
      validUntil: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      validatedAt: new Date().toISOString(),
    });
    expect(existsSync(LICENSE_FILE)).toBe(true);
    deactivateLicense();
    expect(existsSync(LICENSE_FILE)).toBe(false);
  });
});
