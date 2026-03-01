import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { clearContentCache } from '../content/fetcher.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface LicenseCache {
  key: string;
  email: string;
  /** Product/skill names this license unlocks */
  products: string[];
  /** ISO date — license expiry */
  validUntil: string;
  /** ISO date — last successful online validation */
  validatedAt: string;
}

// ── Constants ────────────────────────────────────────────────────────────────

const LICENSE_DIR = join(homedir(), '.openspend');
const LICENSE_FILE = join(LICENSE_DIR, 'license.json');
/** Re-validate online after this many milliseconds (24 hours) */
const REVALIDATION_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Allow offline use for up to this many milliseconds (30 days) */
const OFFLINE_GRACE_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;
const POLAR_VALIDATE_URL = 'https://api.polar.sh/v1/licenses/validate';

// ── Cache I/O ────────────────────────────────────────────────────────────────

function readCache(): LicenseCache | null {
  if (!existsSync(LICENSE_FILE)) return null;
  try {
    return JSON.parse(readFileSync(LICENSE_FILE, 'utf-8')) as LicenseCache;
  } catch {
    return null;
  }
}

function writeCache(cache: LicenseCache): void {
  if (!existsSync(LICENSE_DIR)) {
    mkdirSync(LICENSE_DIR, { recursive: true });
  }
  writeFileSync(LICENSE_FILE, JSON.stringify(cache, null, 2));
}

function removeCache(): void {
  if (existsSync(LICENSE_FILE)) {
    unlinkSync(LICENSE_FILE);
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Validate a license key with Polar.sh and cache the result locally.
 * @throws Error if validation fails or the key is invalid.
 */
export async function validateLicense(key: string): Promise<LicenseCache> {
  const res = await fetch(POLAR_VALIDATE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`License validation failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as {
    valid: boolean;
    license?: {
      email?: string;
      expires_at?: string;
      product?: { name?: string };
    };
    products?: Array<{ name: string }>;
  };

  if (!data.valid) {
    throw new Error('License key is invalid or expired.');
  }

  const products: string[] = [];
  if (data.products) {
    for (const p of data.products) {
      if (p.name) products.push(p.name);
    }
  } else if (data.license?.product?.name) {
    products.push(data.license.product.name);
  }

  const cache: LicenseCache = {
    key,
    email: data.license?.email ?? '',
    products,
    validUntil: data.license?.expires_at ?? new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
    validatedAt: new Date().toISOString(),
  };

  writeCache(cache);
  clearContentCache();
  return cache;
}

/**
 * Check whether the user has a valid license for a given skill/product.
 * Uses cached validation — re-validates online if cache is >24h old.
 * Allows offline use for up to 30 days from last validation.
 */
export function hasLicense(skillName: string): boolean {
  const cache = readCache();
  if (!cache) return false;

  // Check if this skill is covered by the license
  const isProductCovered =
    cache.products.length === 0 || // all-access license (no product restrictions)
    cache.products.includes(skillName);

  if (!isProductCovered) return false;

  // Check if license has expired
  const expiresAt = new Date(cache.validUntil).getTime();
  if (Date.now() > expiresAt) return false;

  // Check if offline grace period has passed
  const lastValidated = new Date(cache.validatedAt).getTime();
  if (Date.now() - lastValidated > OFFLINE_GRACE_PERIOD_MS) return false;

  // Trigger background re-validation if stale (>24h), but don't block
  if (Date.now() - lastValidated > REVALIDATION_INTERVAL_MS) {
    validateLicense(cache.key).catch(() => {
      // Silently fail — cached validation is still valid within grace period
    });
  }

  return true;
}

/**
 * Get cached license info (if any).
 */
export function getLicenseInfo(): LicenseCache | null {
  return readCache();
}

/**
 * Remove the cached license (deactivate).
 */
export function deactivateLicense(): void {
  clearContentCache();
  removeCache();
}
