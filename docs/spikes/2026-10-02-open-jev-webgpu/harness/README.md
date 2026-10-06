Harness for docs/spikes/2026-10-02-open-jev-webgpu.md. Not part of the wilson build.
Install and run (scratch dir, not in the repo tree):
  npm i @huggingface/transformers@4.3.0 open-jev@0.1.2 playwright@1.63.0 vite@^8.3.0
  node build-gold.mjs && node build-lists.mjs   # persona fixtures: $OA_PERSONAS_DIR (default <repo>/scripts/demos/personas); cli source: $OA_CLI_SRC (default <repo>/src)
  node run.mjs --model open-jev --dtype q4f16 --device webgpu
  node analyze.mjs
Gold data is derived from the SYNTHETIC demo personas only (fictional merchants). No ~/.openaccountant data.
