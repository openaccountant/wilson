/**
 * Test preload (bunfig.toml): every test runs against a throwaway home dir.
 *
 * Wilson keeps all state under ~/.openaccountant — profiles, settings, the
 * agent log, model cache. Without this, `bun test` wrote into the developer's
 * real home: it deleted a running dashboard's logs/agent.log
 * (logger.test.ts unlinks LOG_FILE) and left settings and scratchpad files
 * behind in real profiles.
 *
 * Bun's os.homedir() ignores a runtime change to process.env.HOME, so the os
 * module itself is replaced: mock.module covers `import … from 'os'` and
 * 'node:os', the object patch covers require('os'), and HOME covers code that
 * reads the variable directly.
 */
import { mock } from 'bun:test';
import * as realOs from 'node:os';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const testHome = join(realOs.tmpdir(), `wilson-test-home-${process.pid}`);
mkdirSync(testHome, { recursive: true });

const patched = { ...realOs, homedir: () => testHome };
mock.module('os', () => ({ ...patched, default: patched }));
mock.module('node:os', () => ({ ...patched, default: patched }));
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('node:os').homedir = () => testHome;
process.env.HOME = testHome;

// The macOS keychain is not scoped by HOME: with SQLCipher installed, initDatabase() on a real file reaches the
// developer's login keychain through the `security` CLI (src/utils/keychain.ts), can block on a prompt, and can
// leave a key behind. Tests that need keys mock '../utils/keychain.js'; this shim makes any test that forgets fail
// closed (no key, so a plaintext DB) instead of touching the real keychain.
const shimDir = join(testHome, '.test-bin');
mkdirSync(shimDir, { recursive: true });
writeFileSync(join(shimDir, 'security'), '#!/bin/sh\necho "test preload: real keychain access is blocked in tests" >&2\nexit 44\n');
chmodSync(join(shimDir, 'security'), 0o755);
process.env.PATH = `${shimDir}:${process.env.PATH ?? ''}`;
