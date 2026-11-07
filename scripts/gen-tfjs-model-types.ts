#!/usr/bin/env bun
/**
 * Regenerate src/model/tfjs-model-types.json from the installed transformers.js.
 * Run after every @huggingface/transformers bump (the staleness test says so).
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractCausalLmTypes, readInstalledTransformers } from '../src/model/tfjs-model-types.js';

const { version, dist } = readInstalledTransformers();
const causalLm = extractCausalLmTypes(dist);
const out = join(import.meta.dir, '..', 'src', 'model', 'tfjs-model-types.json');
writeFileSync(out, JSON.stringify({ version, causalLm }, null, 2) + '\n');
console.log(`tfjs-model-types.json: transformers.js ${version}, ${causalLm.length} causal-LM model types`);
