import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    clean: true,
    target: 'es2020',
    treeshake: true,
  },
  {
    entry: { 'geoverse-line-finder': 'src/index.ts' },
    format: ['iife'],
    globalName: 'GeoVerseLineFinder',
    minify: true,
    sourcemap: true,
    target: 'es2020',
  },
]);
