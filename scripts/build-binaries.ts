#!/usr/bin/env bun
/**
 * Build single-file `wilson` executables with `bun build --compile`.
 *
 *   bun run build:binaries                         # all five targets
 *   bun run build:binaries --target darwin-arm64   # one target (repeatable)
 *   bun run build:binaries --skip-ui               # reuse src/dashboard/ui/dist as built
 *   bun run build:binaries --with-hybrid           # also embed the in-tab WebGPU chat (+~85 MB each)
 *
 * Output (a fixed contract other release steps depend on):
 *   dist/bin/wilson-windows-x64.exe
 *   dist/bin/wilson-darwin-arm64
 *   dist/bin/wilson-darwin-x64
 *   dist/bin/wilson-linux-x64
 *   dist/bin/wilson-linux-arm64
 *
 * Every target cross-compiles from any host (Bun downloads the target runtime).
 *
 * A compiled binary has no source tree on disk, so every file the app reads
 * from next to its own source is embedded instead: the generated entry
 * imports each one `with { type: "file" }` and publishes the resulting
 * `/$bunfs/...` paths as globalThis.__WILSON_EMBEDDED__ before it loads
 * src/index.tsx. See src/utils/embedded-assets.ts for the consumers.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');
const UI_DIR = join(ROOT, 'src/dashboard/ui');
const WORK_DIR = join(ROOT, 'dist/.compile');
const OUT_DIR = join(ROOT, 'dist/bin');

export const TARGETS = ['windows-x64', 'darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64'] as const;
export type Target = (typeof TARGETS)[number];

/**
 * Native addons a single-file binary cannot carry: each needs a shared
 * library next to its `.node` file (libonnxruntime, libvips), and
 * onnxruntime-node has no darwin-x64 build at all. They are swapped for a stub
 * that throws when first loaded. transformers.js is only ever loaded lazily
 * (`await import(...)`), so the on-device features built on it (local
 * embeddings / semantic search, the `transformers:` model provider) fail the
 * way they do when a model is missing, and degrade; everything else works.
 * Run from source (npm/bun install, or the Docker image) to keep them.
 *
 * Not `--external`: an external becomes a top-level import of the whole
 * binary and kills it at startup.
 */
const NATIVE_STUBS = ['onnxruntime-node', 'sharp'];

export const nativeStubPlugin: import('bun').BunPlugin = {
  name: 'wilson-native-stubs',
  setup(build) {
    const filter = new RegExp(`^(${NATIVE_STUBS.join('|')})$`);
    build.onResolve({ filter }, (args) => ({ path: args.path, namespace: 'wilson-native-stub' }));
    build.onLoad({ filter: /.*/, namespace: 'wilson-native-stub' }, (args) => ({
      // CommonJS, so any named import still links; the throw runs only when the module is first evaluated.
      contents: `throw new Error(${JSON.stringify(
        `${args.path} is not available in the single-file wilson binary, so on-device transformers.js models ` +
          '(local embeddings, semantic search, transformers: models) are off. Install with npm/bun or use the Docker image to use them.',
      )});\nmodule.exports = {};\n`,
      loader: 'js',
    }));
  },
};

export function binaryName(target: Target): string {
  return `wilson-${target}${target.startsWith('windows') ? '.exe' : ''}`;
}

function parseArgs(argv: string[]) {
  const targets: Target[] = [];
  let skipUi = false;
  let withHybrid = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--target') {
      const t = argv[++i] as Target;
      if (!TARGETS.includes(t)) throw new Error(`Unknown --target ${t}. One of: ${TARGETS.join(', ')}`);
      targets.push(t);
    } else if (a === '--skip-ui') skipUi = true;
    else if (a === '--with-hybrid') withHybrid = true;
    else throw new Error(`Unknown argument ${a}`);
  }
  return { targets: targets.length ? targets : [...TARGETS], skipUi, withHybrid };
}

function run(cmd: string[], cwd: string): void {
  console.log(`$ ${cmd.join(' ')}   (in ${relative(ROOT, cwd) || '.'})`);
  const res = Bun.spawnSync(cmd, { cwd, stdout: 'inherit', stderr: 'inherit' });
  if (res.exitCode !== 0) throw new Error(`${cmd.join(' ')} failed with exit code ${res.exitCode}`);
}

/** Every file under `dir` (repo-relative, forward slashes), optionally filtered. */
function walk(dir: string, keep: (rel: string) => boolean = () => true): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, keep));
    else {
      const rel = relative(ROOT, full).split(sep).join('/');
      if (keep(rel)) out.push(rel);
    }
  }
  return out.sort();
}

async function buildUi(withHybrid: boolean): Promise<void> {
  if (!existsSync(join(UI_DIR, 'node_modules'))) run(['npm', 'ci'], UI_DIR);
  run(['npm', 'run', 'build'], UI_DIR);
  if (withHybrid) run(['npm', 'run', 'build:hybrid'], UI_DIR);
}

/** The WebMCP bridge is bundled from source at server start; a binary needs it prebuilt. */
async function buildBridge(): Promise<string> {
  const result = await Bun.build({
    entrypoints: [join(ROOT, 'src/dashboard/webmcp-bridge.ts')],
    target: 'browser',
    minify: false, // same options as buildWebMcpBridgeScript() in src/dashboard/server.ts
  });
  if (!result.success || !result.outputs[0]) {
    for (const log of result.logs) console.error(log);
    throw new Error('Failed to bundle src/dashboard/webmcp-bridge.ts');
  }
  const outPath = join(WORK_DIR, 'webmcp-bridge.js');
  writeFileSync(outPath, await result.outputs[0].text());
  return outPath;
}

/** Repo-relative path -> absolute source file, for everything the binary embeds. */
function collectEmbeds(bridgePath: string, withHybrid: boolean): Map<string, string> {
  const files = new Map<string, string>();
  const add = (rel: string) => files.set(rel, join(ROOT, rel));

  const uiHtml = 'src/dashboard/ui/dist/index.html';
  if (!existsSync(join(ROOT, uiHtml))) {
    throw new Error(`${uiHtml} is missing. Build the dashboard UI first (drop --skip-ui).`);
  }
  add(uiHtml);
  files.set('src/dashboard/webmcp-bridge.js', bridgePath);

  // Builtin skills: every non-code file in each skill directory.
  for (const rel of walk(join(ROOT, 'src/skills'), (r) => !/\.(ts|tsx|js)$/.test(r))) add(rel);
  // Builtin chains and teams.
  for (const kind of ['chains', 'teams']) {
    for (const rel of walk(join(ROOT, 'src/orchestration', kind), (r) => /\.ya?ml$/.test(r))) add(rel);
  }
  if (existsSync(join(ROOT, 'SOUL.md'))) add('SOUL.md');

  if (withHybrid) {
    const hybrid = walk(join(UI_DIR, 'dist-hybrid'));
    if (hybrid.length === 0) throw new Error('--with-hybrid: src/dashboard/ui/dist-hybrid is empty');
    for (const rel of hybrid) add(rel);
  }
  return files;
}

function writeEntry(files: Map<string, string>, version: string): string {
  const hash = createHash('sha256').update(version);
  const imports: string[] = [];
  const entries: string[] = [];
  let i = 0;
  for (const [rel, abs] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    hash.update(rel).update('\0').update(readFileSync(abs));
    const spec = relative(WORK_DIR, abs).split(sep).join('/');
    imports.push(`import f${i} from ${JSON.stringify(spec.startsWith('.') ? spec : `./${spec}`)} with { type: "file" };`);
    entries.push(`  ${JSON.stringify(rel)}: f${i},`);
    i++;
  }
  const buildId = `${version}-${hash.digest('hex').slice(0, 12)}`;

  // The manifest lives in its own module, imported first: ES modules evaluate
  // in import order, so it is set before any app module runs. (A dynamic
  // `await import()` of the app from the entry deadlocks the app's own
  // dynamic imports in a compiled binary.)
  writeFileSync(join(WORK_DIR, 'manifest.ts'), `// GENERATED by scripts/build-binaries.ts. Do not edit.
${imports.join('\n')}

globalThis.__WILSON_EMBEDDED__ = {
  buildId: ${JSON.stringify(buildId)},
  files: {
${entries.join('\n')}
  },
};
`);
  const entryPath = join(WORK_DIR, 'entry.ts');
  writeFileSync(entryPath, `// GENERATED by scripts/build-binaries.ts. Do not edit.
import "./manifest.ts";
import "../../src/index.tsx";
`);
  console.log(`Embedded ${files.size} files (build ${buildId})`);
  return entryPath;
}

async function main(): Promise<void> {
  const { targets, skipUi, withHybrid } = parseArgs(process.argv.slice(2));
  const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version as string;

  rmSync(WORK_DIR, { recursive: true, force: true });
  mkdirSync(WORK_DIR, { recursive: true });
  mkdirSync(OUT_DIR, { recursive: true });

  if (!skipUi) await buildUi(withHybrid);
  const bridge = await buildBridge();
  const entry = writeEntry(collectEmbeds(bridge, withHybrid), version);

  for (const target of targets) {
    const outfile = join(OUT_DIR, binaryName(target));
    console.log(`Compiling bun-${target} ...`);
    const result = await Bun.build({
      entrypoints: [entry],
      plugins: [nativeStubPlugin],
      compile: {
        target: `bun-${target}` as Bun.Build.CompileTarget,
        outfile,
        // A bunfig.toml in whatever directory the user runs wilson from is not ours to load.
        autoloadBunfig: false,
      },
    });
    if (!result.success) {
      for (const log of result.logs) console.error(log);
      throw new Error(`Compile failed for ${target}`);
    }
    const mb = (statSync(outfile).size / 1024 / 1024).toFixed(1);
    console.log(`  -> ${relative(ROOT, outfile)} (${mb} MB)`);
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
