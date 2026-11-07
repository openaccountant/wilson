/**
 * Which Hub `config.json` `model_type`s the installed transformers.js can run as
 * a text-generation pipeline (specs/model-manager.md M5 validate). The list is
 * generated from the installed package by scripts/gen-tfjs-model-types.ts into
 * tfjs-model-types.json; src/__tests__/model-manager-validate.test.ts fails when
 * the JSON is stale, so a transformers.js bump forces a regeneration.
 */

import { readFileSync } from 'node:fs';
import data from './tfjs-model-types.json';

export interface TfjsModelTypes {
  /** transformers.js version the list was generated from. */
  version: string;
  /** model_types in MODEL_FOR_CAUSAL_LM_MAPPING_NAMES (what `pipeline('text-generation')` loads). */
  causalLm: string[];
}

export const TFJS_MODEL_TYPES: TfjsModelTypes = data as TfjsModelTypes;

const CAUSAL_SET = new Set(TFJS_MODEL_TYPES.causalLm);

export function isSupportedCausalLmType(modelType: string | null | undefined): boolean {
  return typeof modelType === 'string' && CAUSAL_SET.has(modelType);
}

/**
 * Read MODEL_FOR_CAUSAL_LM_MAPPING_NAMES out of a transformers.js dist bundle.
 * Only the generator script and the staleness test call this.
 */
export function extractCausalLmTypes(distSource: string): string[] {
  const start = distSource.indexOf('var MODEL_FOR_CAUSAL_LM_MAPPING_NAMES = ');
  if (start < 0) throw new Error('MODEL_FOR_CAUSAL_LM_MAPPING_NAMES not found in the transformers.js bundle');
  const end = distSource.indexOf(']);', start);
  const body = distSource.slice(start, end);
  const types = [...body.matchAll(/\[\s*"([a-z0-9_]+)"\s*,/g)].map((m) => m[1]);
  return [...new Set(types)].sort();
}

/** The installed package's dist bundle and version (node_modules resolution). */
export function readInstalledTransformers(): { version: string; dist: string } {
  const pkgUrl = new URL('../../node_modules/@huggingface/transformers/package.json', import.meta.url);
  const version = (JSON.parse(readFileSync(pkgUrl, 'utf8')) as { version: string }).version;
  const dist = readFileSync(new URL('../../node_modules/@huggingface/transformers/dist/transformers.node.mjs', import.meta.url), 'utf8');
  return { version, dist };
}
