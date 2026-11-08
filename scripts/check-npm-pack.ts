/**
 * Release guard: the npm tarball must ship the built dashboard and nothing heavy it doesn't need.
 * The server reads ui/dist/index.html (+ hashed ui/dist/_app/ chunks) and ui/dist-hybrid/; both are
 * gitignored, so a publish from a clean checkout without `npm run build && npm run build:hybrid`
 * silently falls back to the legacy html.ts dashboard (0.10.0 shipped that way). Run after the build:
 *   bun run scripts/check-npm-pack.ts
 */
import { spawnSync } from 'node:child_process';
import { checkPackFiles } from '../src/utils/npm-pack-guard.js';

if (import.meta.main) {
  const run = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { encoding: 'utf8' });
  if (run.status !== 0) {
    console.error(`check-npm-pack: npm pack failed\n${run.stderr}`);
    process.exit(1);
  }
  type PackResult = { files: { path: string }[]; unpackedSize: number; entryCount: number };
  // npm <= 11 prints an array of results; npm 12 prints an object keyed by package name.
  const parsed = JSON.parse(run.stdout) as PackResult[] | Record<string, PackResult>;
  const pack = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
  if (!pack?.files) {
    console.error(`check-npm-pack: unexpected npm pack --json output\n${run.stdout.slice(0, 500)}`);
    process.exit(1);
  }
  const problems = checkPackFiles(pack.files.map((f) => f.path), pack.unpackedSize);
  if (problems.length > 0) {
    console.error(`check-npm-pack: FAILED\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    process.exit(1);
  }
  console.log(`check-npm-pack: ok (${pack.entryCount} files, ${(pack.unpackedSize / 1048576).toFixed(1)} MB unpacked)`);
}
