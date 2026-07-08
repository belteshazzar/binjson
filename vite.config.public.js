import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  worker: {
    format: 'es'
  },
  build: {
    outDir: 'site',
    rollupOptions: {
      input: {
        worker: resolve(__dirname, 'public/worker.js'),
      },
      output: {
        entryFileNames: '[name].js',
        format: 'es',
        // Inline all dynamic imports to avoid preload helpers
        inlineDynamicImports: true
      }
    },
    target: 'esnext',
    // Disable module preload polyfill
    modulePreload: false
  }
});
