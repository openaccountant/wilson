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
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const testHome = join(realOs.tmpdir(), `wilson-test-home-${process.pid}`);
mkdirSync(testHome, { recursive: true });

const patched = { ...realOs, homedir: () => testHome };
mock.module('os', () => ({ ...patched, default: patched }));
mock.module('node:os', () => ({ ...patched, default: patched }));
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('node:os').homedir = () => testHome;
process.env.HOME = testHome;
