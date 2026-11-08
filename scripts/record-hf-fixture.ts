#!/usr/bin/env bun
/**
 * Re-record src/__tests__/fixtures/hf-onnx-repos.json from the Hugging Face Hub.
 *
 * Every repo is recorded at ONE commit sha. A repo whose `revision` is already
 * pinned in the transformers catalog (src/utils/model.ts) is recorded at that
 * revision; otherwise at the current `main` sha, which is then the value to pin.
 * Per repo:
 *   sha                    the commit the record was taken at
 *   siblings               onnx/ file paths (what the dtype resolver reads)
 *   files                  onnx/ path -> { size, sha256? } (sha256 = LFS oid; the model cache keys COS by it)
 *   model_type             config.json model_type
 *   transformers.js_config config.json transformers.js_config (or null)
 *   license, pipeline_tag  card metadata, for the validate route's tests
 *
 * Usage:
 *   bun run scripts/record-hf-fixture.ts                 # every catalog repo (+ repos already in the fixture)
 *   bun run scripts/record-hf-fixture.ts owner/repo ...  # also add these
 *   bun run scripts/record-hf-fixture.ts --latest        # ignore catalog pins, record main (to propose an update)
 *
 * Network only; it never touches the user's cache. Review the diff before committing.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getModelsForProvider } from '../src/utils/model.js';

const HUB = 'https://huggingface.co';
const FIXTURE = join(import.meta.dir, '..', 'src', '__tests__', 'fixtures', 'hf-onnx-repos.json');

interface TreeEntry {
  type: string;
  path: string;
  size?: number;
  lfs?: { oid?: string; size?: number };
}

export interface RecordedRepo {
  sha: string;
  siblings: string[];
  files: Record<string, { size: number; sha256?: string }>;
  model_type: string | null;
  'transformers.js_config': unknown;
  license: string | null;
  pipeline_tag: string | null;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

export async function recordRepo(repo: string, revision?: string): Promise<RecordedRepo> {
  const info = await getJson<{ sha: string; pipeline_tag?: string; cardData?: { license?: string } }>(
    `${HUB}/api/models/${repo}/revision/${revision ?? 'main'}`,
  );
  const sha = info.sha;
  const tree = await getJson<TreeEntry[]>(`${HUB}/api/models/${repo}/tree/${sha}/onnx?recursive=1`);
  const files: RecordedRepo['files'] = {};
  for (const e of tree) {
    if (e.type !== 'file') continue;
    const size = e.lfs?.size ?? e.size ?? 0;
    files[e.path] = e.lfs?.oid ? { size, sha256: e.lfs.oid } : { size };
  }
  const config = await getJson<{ model_type?: string; 'transformers.js_config'?: unknown }>(
    `${HUB}/${repo}/resolve/${sha}/config.json`,
  );
  return {
    sha,
    siblings: Object.keys(files).sort(),
    files,
    model_type: typeof config.model_type === 'string' ? config.model_type : null,
    'transformers.js_config': config['transformers.js_config'] ?? null,
    license: info.cardData?.license ?? null,
    pipeline_tag: info.pipeline_tag ?? null,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const latest = args.includes('--latest');
  const extra = args.filter((a) => !a.startsWith('--'));

  const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as { _recorded: string; repos: Record<string, unknown> };
  const pins = new Map<string, string | undefined>();
  for (const m of getModelsForProvider('transformers')) pins.set(m.id.replace(/^transformers:/, ''), m.revision);
  for (const repo of Object.keys(fixture.repos)) if (!pins.has(repo)) pins.set(repo, undefined);
  for (const repo of extra) if (!pins.has(repo)) pins.set(repo, undefined);

  const repos: Record<string, RecordedRepo> = {};
  for (const [repo, pin] of [...pins].sort(([a], [b]) => a.localeCompare(b))) {
    const rec = await recordRepo(repo, latest ? undefined : pin);
    repos[repo] = rec;
    const note = pin && pin !== rec.sha ? ` (pinned ${pin.slice(0, 7)})` : '';
    console.log(`${repo} @ ${rec.sha}${note}: ${rec.siblings.length} onnx files, model_type=${rec.model_type}`);
  }

  const today = new Date().toISOString().slice(0, 10);
  writeFileSync(
    FIXTURE,
    JSON.stringify(
      {
        _recorded: `${today} by scripts/record-hf-fixture.ts from ${HUB}/api/models/<repo>/revision/<sha>, /tree/<sha>/onnx and /resolve/<sha>/config.json`,
        repos,
      },
      null,
      2,
    ) + '\n',
  );
}

if (import.meta.main) await main();
