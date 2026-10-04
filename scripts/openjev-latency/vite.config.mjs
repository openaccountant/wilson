import { resolve } from 'node:path';
const HERE = import.meta.dirname;
// Builds the harness page into .build/ (gitignored). The production worker is built separately
// by run.mjs with the repo's own src/dashboard/ui/vite.prelabel.config.ts.
export default ({
  root: HERE,
  resolve: { conditions: ['onnxruntime-web-use-extern-wasm'] },
  build: {
    outDir: resolve(HERE, '.build/page'),
    emptyOutDir: true,
    target: 'esnext',
    minify: false,
    rollupOptions: { input: { page: resolve(HERE, 'page.ts') }, output: { entryFileNames: 'page.js', inlineDynamicImports: true } },
  },
  worker: { format: 'es' },
});
