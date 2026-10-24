/**
 * Release guard for the npm tarball (run by scripts/check-npm-pack.ts before publish): it must ship
 * the built dashboard and nothing heavy it doesn't need. ui/dist and ui/dist-hybrid are gitignored,
 * so a publish without the UI build silently falls back to the legacy html.ts dashboard.
 */
const UI = 'src/dashboard/ui/';

/**
 * Max unpacked size. The full build is ~91 MB, ~82 MB of it the four same-origin onnxruntime-web
 * .wasm variants in dist-hybrid/ort/ (NN-01: never load them from the CDN); a stray
 * ui/node_modules would add ~96 MB more.
 */
export const MAX_UNPACKED_BYTES = 120 * 1024 * 1024;

export function checkPackFiles(paths: string[], unpackedSize: number): string[] {
  const has = (p: string) => paths.includes(p);
  const problems: string[] = [];
  if (!has(`${UI}dist/index.html`)) problems.push(`missing ${UI}dist/index.html (run npm run build in ${UI})`);
  if (!paths.some((p) => p.startsWith(`${UI}dist/_app/`))) problems.push(`missing ${UI}dist/_app/ chunks`);
  if (!has(`${UI}dist-hybrid/hybrid-chat.js`)) problems.push(`missing ${UI}dist-hybrid/hybrid-chat.js (run npm run build:hybrid)`);
  const stray = paths.filter((p) => p.startsWith(`${UI}node_modules/`) || p.includes('/__tests__/'));
  if (stray.length > 0) problems.push(`${stray.length} files that must not ship, e.g. ${stray[0]}`);
  if (unpackedSize > MAX_UNPACKED_BYTES) {
    problems.push(`unpacked size ${(unpackedSize / 1048576).toFixed(1)} MB exceeds ${MAX_UNPACKED_BYTES / 1048576} MB`);
  }
  return problems;
}
