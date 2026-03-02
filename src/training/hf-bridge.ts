/**
 * Helpers to format training data for HuggingFace skills.
 * Prepares data and configs for the hugging-face-dataset-creator and model-trainer skills.
 * Does NOT call HF skills directly — produces the inputs the user/agent passes to them.
 */

import type { Database } from '../db/compat-sqlite.js';
import { exportSftJsonl, type SftExportOptions } from './export.js';

export interface HfDatasetResult {
  format: 'chat';
  data: object[];
  metadata: { source: string; model: string; interactions: number };
}

/**
 * Export interactions as HF dataset format (TRL chat format with "messages" field).
 * Each entry is a parsed JSONL line from the SFT export.
 */
export function prepareHfDataset(db: Database, options: SftExportOptions = {}): HfDatasetResult {
  const jsonl = exportSftJsonl(db, options);
  const lines = jsonl.split('\n').filter(Boolean);
  const data = lines.map(line => JSON.parse(line));

  return {
    format: 'chat',
    data,
    metadata: {
      source: 'wilson-interactions',
      model: options.model ?? 'all',
      interactions: data.length,
    },
  };
}

export interface TrainingConfig {
  baseModel: string;
  datasetId: string;
  trainingMethod: 'sft' | 'dpo';
  loraConfig: { r: number; alpha: number; targetModules: string[] };
  trainingArgs: { epochs: number; batchSize: number; learningRate: number; warmupSteps: number };
  outputDir: string;
}

/**
 * Generate training config compatible with the model-trainer skill.
 */
export function generateTrainingConfig(options: {
  baseModel: string;
  datasetId: string;
  trainingMethod: 'sft' | 'dpo';
  loraR?: number;
  loraAlpha?: number;
  epochs?: number;
}): TrainingConfig {
  const { baseModel, datasetId, trainingMethod, loraR = 16, loraAlpha = 32, epochs = 3 } = options;

  return {
    baseModel,
    datasetId,
    trainingMethod,
    loraConfig: {
      r: loraR,
      alpha: loraAlpha,
      targetModules: ['q_proj', 'k_proj', 'v_proj', 'o_proj'],
    },
    trainingArgs: {
      epochs,
      batchSize: 4,
      learningRate: 2e-4,
      warmupSteps: 10,
    },
    outputDir: `./wilson-${trainingMethod}-adapter`,
  };
}

/**
 * Generate an Ollama Modelfile for deploying a fine-tuned adapter locally.
 */
export function generateOllamaModelfile(options: {
  baseModel: string;
  adapterPath: string;
  modelName: string;
}): string {
  return `FROM ${options.baseModel}
ADAPTER ${options.adapterPath}

PARAMETER temperature 0.7
PARAMETER top_p 0.9
PARAMETER stop "<|im_end|>"

SYSTEM """You are Wilson, an AI bookkeeper from Open Accountant. You help users manage their personal finances with precision and care. You have access to tools for importing transactions, categorizing spending, analyzing budgets, and generating reports."""
`;
}
