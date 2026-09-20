import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import path from 'path';

export default defineConfig({
  plugins: [react(), tailwindcss(), viteSingleFile()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // Browser-safe statement-import helpers shared with the CLI
      // (src/tools/import/client-import.ts + parsers it pulls in).
      '@import-tools': path.resolve(__dirname, '../../tools/import'),
    },
  },
  server: {
    proxy: {
      '/api': 'http://localhost:3141',
    },
  },
  build: {
    outDir: 'dist',
    target: 'esnext',
  },
});
