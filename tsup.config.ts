import { defineConfig } from 'tsup';

// No sourcemaps in the published package: ESM/CJS ship as readable code and the maps would triple the size.
export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: false,
    clean: true,
    target: 'es2020',
    treeshake: true,
  },
  {
    entry: { 'geoverse-line-finder': 'src/index.ts' },
    format: ['iife'],
    globalName: 'GeoVerseLineFinder',
    minify: true,
    sourcemap: false,
    target: 'es2020',
  },
]);
