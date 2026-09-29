import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// Relative base so the build works unmodified from GitHub Pages (a project subpath), a custom domain, or a
// plain static preview. Imports the library straight from `../../src` — no pre-build needed, so the demo
// always reflects the current source.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // MapLibre (about 1 MB, 280 kB gzip) is its own chunk, loaded only when a map scenario is opened.
    chunkSizeWarningLimit: 1100,
  },
  // MapLibre's worker is an ES module importing a shared chunk; bundle it as one (see lib/maplibre-view.ts).
  worker: { format: 'es' },
});
