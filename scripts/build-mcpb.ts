#!/usr/bin/env bun
/**
 * Build the Claude Desktop extension: dist/wilson.mcpb.
 *
 *   bun run build:mcpb            # uses the binaries already in dist/bin
 *   bun run build:mcpb --linux    # also ship the Linux binaries (Claude Desktop itself is macOS/Windows)
 *
 * Inputs: the compiled binaries in dist/bin (scripts/build-binaries.ts makes them:
 * wilson-darwin-arm64, wilson-darwin-x64, wilson-windows-x64.exe, wilson-linux-x64,
 * wilson-linux-arm64), plus mcpb/manifest.json, mcpb/launch.sh and mcpb/icon.png.
 * A platform is listed in the manifest's `compatibility.platforms` only when at least
 * one of its binaries is present; with none at all the build fails.
 *
 * Layout inside the bundle:
 *   manifest.json, icon.png
 *   server/launch.sh                 macOS/Linux: picks wilson-<os>-<arch> by `uname -m`
 *   server/wilson-darwin-arm64 …     the binaries, unchanged
 *   server/wilson-windows-x64.exe    Windows runs this directly (platform_overrides.win32)
 *
 * The manifest's version is the package.json version. Validation and packing use the
 * official CLI (@anthropic-ai/mcpb, pinned below), so the output is exactly what
 * `mcpb pack` produces and the manifest is checked against the published schema.
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const MCPB_CLI = '@anthropic-ai/mcpb@2.1.2';

const root = join(import.meta.dir, '..');
const binDir = join(root, 'dist', 'bin');
const stageDir = join(root, 'dist', 'mcpb');
const outFile = join(root, 'dist', 'wilson.mcpb');
const withLinux = process.argv.includes('--linux');

type Platform = 'darwin' | 'win32' | 'linux';
const BINARIES: Array<{ file: string; platform: Platform }> = [
  { file: 'wilson-darwin-arm64', platform: 'darwin' },
  { file: 'wilson-darwin-x64', platform: 'darwin' },
  { file: 'wilson-windows-x64.exe', platform: 'win32' },
  ...(withLinux
    ? ([
        { file: 'wilson-linux-x64', platform: 'linux' },
        { file: 'wilson-linux-arm64', platform: 'linux' },
      ] as const)
    : []),
];

function run(cmd: string[]): void {
  const res = Bun.spawnSync(cmd, { cwd: root, stdout: 'inherit', stderr: 'inherit' });
  if (res.exitCode !== 0) {
    console.error(`build:mcpb: "${cmd.join(' ')}" failed (exit ${res.exitCode})`);
    process.exit(res.exitCode ?? 1);
  }
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')) as { version: string };
const manifest = JSON.parse(readFileSync(join(root, 'mcpb', 'manifest.json'), 'utf-8')) as Record<string, any>;

rmSync(stageDir, { recursive: true, force: true });
mkdirSync(join(stageDir, 'server'), { recursive: true });

const platforms = new Set<Platform>();
const shipped: string[] = [];
for (const { file, platform } of BINARIES) {
  const src = join(binDir, file);
  if (!existsSync(src)) continue;
  const dest = join(stageDir, 'server', file);
  copyFileSync(src, dest);
  if (platform !== 'win32') chmodSync(dest, 0o755);
  platforms.add(platform);
  shipped.push(`${file} (${(statSync(src).size / 1_048_576).toFixed(0)} MB)`);
}

if (shipped.length === 0) {
  console.error(
    `build:mcpb: no binaries in ${binDir}. Build them first (scripts/build-binaries.ts), e.g.\n` +
      '  bun build --compile --target=bun-darwin-arm64 src/index.tsx --outfile dist/bin/wilson-darwin-arm64'
  );
  process.exit(1);
}
for (const { file, platform } of BINARIES) {
  if (!existsSync(join(binDir, file))) console.warn(`build:mcpb: ${file} missing; ${platform} users on that CPU will see "no build for" this machine.`);
}

copyFileSync(join(root, 'mcpb', 'launch.sh'), join(stageDir, 'server', 'launch.sh'));
chmodSync(join(stageDir, 'server', 'launch.sh'), 0o755);
copyFileSync(join(root, 'mcpb', 'icon.png'), join(stageDir, 'icon.png'));

manifest.version = pkg.version;
manifest.compatibility = { ...(manifest.compatibility ?? {}), platforms: (['darwin', 'win32', 'linux'] as const).filter((p) => platforms.has(p)) };
writeFileSync(join(stageDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

run(['bunx', MCPB_CLI, 'validate', join(stageDir, 'manifest.json')]);
rmSync(outFile, { force: true });
run(['bunx', MCPB_CLI, 'pack', stageDir, outFile]);

console.log(`\nbuild:mcpb: ${outFile}`);
console.log(`  version ${pkg.version}, platforms ${manifest.compatibility.platforms.join(', ')}`);
for (const s of shipped) console.log(`  server/${s}`);
