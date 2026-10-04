#!/usr/bin/env node
// reset: reseed a scratch HOME with the founder seed, point the profile at a LOCAL Ollama model, and prove Ollama
// is serving it. Fails loudly (non-zero exit) on any problem.
//
//   node demos/rig/reset.mjs [--name p1] [--model ollama:gemma4:12b] [--with-injection] [--short-history]
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs, workspace, assertScratch, fail, pidfileLive, REPO, DEFAULT_MODEL } from './lib/common.mjs';

const { flags } = parseArgs(process.argv.slice(2));
const ws = workspace(flags.name ?? 'p1');
const model = flags.model ?? DEFAULT_MODEL;
const ollamaHost = process.env.OLLAMA_HOST_URL ?? 'http://127.0.0.1:11434';

if (/cloud/i.test(model)) fail(`model ${model} looks like an Ollama cloud model; the books must stay on this machine`);
if (!model.startsWith('ollama:')) fail(`model id must be ollama:<tag>, got ${model}`);
const tag = model.slice('ollama:'.length);

for (const kind of ['host', 'dashboard']) {
  if (pidfileLive(ws, kind)) fail(`${kind} for workspace ${ws.name} is still running; run stop.mjs first`);
}

assertScratch(ws.home); assertScratch(ws.out);
fs.mkdirSync(ws.home, { recursive: true }); fs.mkdirSync(ws.out, { recursive: true });

// 1. Seed (flags passthrough: anything other than the rig's own flags goes to the seed).
const own = new Set(['name', 'model']);
const passthrough = [];
for (const [k, v] of Object.entries(flags)) {
  if (own.has(k)) continue;
  passthrough.push(`--${k}`); if (v !== true) passthrough.push(String(v));
}
console.log(`[reset] seeding ${ws.home}`);
const seed = spawnSync('bun', ['run', 'demos/seed/seed-founder.ts', '--home', ws.home, '--out', ws.out, ...passthrough], { cwd: REPO, stdio: 'inherit' });
if (seed.status !== 0) fail('seed failed');
// The kill switch is process-global (~/.openaccountant/agent-access.json, outside every profile), so reseeding the
// profile leaves a previous take's OFF in place. Absent means on, the state a fresh install starts in.
fs.rmSync(assertScratch(path.join(ws.home, '.openaccountant', 'agent-access.json')), { force: true });

// 2. Profile model -> local Ollama.
const profilesDir = path.join(ws.home, '.openaccountant', 'profiles');
const profiles = fs.readdirSync(profilesDir).filter((p) => fs.statSync(path.join(profilesDir, p)).isDirectory());
if (profiles.length !== 1) fail(`expected exactly one seeded profile, found ${profiles.join(', ') || 'none'}`);
const settingsPath = path.join(profilesDir, profiles[0], 'settings.json');
const settings = fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath, 'utf8')) : {};
settings.provider = 'ollama';
settings.modelId = model;
fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
console.log(`[reset] ${settingsPath}: provider=ollama modelId=${model}`);

// 3. Ollama serves it (installed, local, and answers a 1-token generate).
const list = spawnSync('ollama', ['list'], { encoding: 'utf8' });
if (list.status !== 0) fail(`\`ollama list\` failed: ${list.stderr || list.stdout}`);
const row = list.stdout.split('\n').find((l) => l.split(/\s+/)[0] === tag);
if (!row) fail(`ollama has no model ${tag}. Installed:\n${list.stdout}`);
if (/cloud/i.test(row) || /\s-\s/.test(row)) fail(`ollama model ${tag} has no local weights (cloud model): ${row}`);
console.log(`[reset] ollama list: ${row.trim().replace(/\s+/g, ' ')}`);

let res;
try {
  res = await fetch(`${ollamaHost}/api/generate`, {
    method: 'POST',
    body: JSON.stringify({ model: tag, prompt: 'Reply with one word: ok', stream: false, keep_alive: '3h', options: { num_predict: 1 } }),
    signal: AbortSignal.timeout(180000),
  });
} catch (e) { fail(`ollama is not serving at ${ollamaHost}: ${e.message}`); }
if (!res.ok) fail(`ollama generate -> ${res.status} ${await res.text()}`);
const gen = await res.json();
if (!gen.done || typeof gen.response !== 'string') fail(`unexpected generate reply: ${JSON.stringify(gen).slice(0, 300)}`);
console.log(`[reset] ollama generate ok: model=${gen.model} eval_count=${gen.eval_count} load_ms=${Math.round((gen.load_duration ?? 0) / 1e6)} (kept warm 3h)`);
console.log(`[reset] done. workspace=${ws.work}`);
