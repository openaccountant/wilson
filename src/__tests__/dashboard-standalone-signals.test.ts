import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * `wilson --dashboard` must exit on SIGTERM/SIGINT. It used to close the DBs
 * but leave Bun.serve running, so the process (and the port) stayed up and
 * only kill -9 stopped it — process managers and restarts could not work.
 */
describe('wilson --dashboard signals', () => {
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    test(`exits on ${signal}`, async () => {
      const home = mkdtempSync(join(tmpdir(), 'wilson-signal-'));
      // A `security` that fails fast: the real one can block on the keychain.
      const bin = join(home, 'bin');
      mkdirSync(bin);
      writeFileSync(join(bin, 'security'), '#!/bin/sh\nexit 1\n');
      chmodSync(join(bin, 'security'), 0o755);
      const port = 4700 + Math.floor(Math.random() * 200);

      const proc = Bun.spawn(['bun', 'run', join(import.meta.dir, '..', 'index.tsx'), '--dashboard', '--port', String(port)], {
        env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` },
        stdout: 'pipe',
        stderr: 'pipe',
      });

      try {
        // Wait until it serves.
        const deadline = Date.now() + 20_000;
        let up = false;
        while (Date.now() < deadline && !up) {
          try {
            up = (await fetch(`http://localhost:${port}/`)).ok;
          } catch {
            await Bun.sleep(200);
          }
        }
        expect(up).toBe(true);

        proc.kill(signal);
        const exited = await Promise.race([proc.exited.then(() => true), Bun.sleep(5_000).then(() => false)]);
        expect(exited).toBe(true);
        expect(proc.exitCode).toBe(0);
      } finally {
        proc.kill('SIGKILL');
      }
    }, 30_000);
  }
});
