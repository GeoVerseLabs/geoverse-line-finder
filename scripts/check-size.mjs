// Bundle-size gate. Measures what users actually ship: a minified, tree-shaken bundle of
// `import { LineFinder }` (esbuild) and the minified IIFE, both gzipped. The readable ESM/CJS files are not
// measured — they keep comments on purpose.
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

// Ratchet: set just above the multi-level release sizes (31.8 KB / 34.0 KB gzip), which include the multi-level layer
// (+4.1 KB consumer / +4.5 KB IIFE over 0.2.0). Raise only with a reason in the CHANGELOG.
const LIMITS = { consumer: 33_500, iife: 36_000 };

const root = fileURLToPath(new URL('..', import.meta.url));
const bundled = await build({
  stdin: {
    contents: "export { LineFinder } from './dist/index.js';",
    resolveDir: root,
    loader: 'js',
  },
  bundle: true,
  minify: true,
  format: 'esm',
  write: false,
  logLevel: 'silent',
});
const sizes = {
  consumer: gzipSync(bundled.outputFiles[0].contents).length,
  iife: gzipSync(readFileSync(new URL('../dist/geoverse-line-finder.global.js', import.meta.url))).length,
};

let failed = false;
for (const [name, size] of Object.entries(sizes)) {
  const ok = size <= LIMITS[name];
  failed ||= !ok;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(8)} ${size} B gzip (limit ${LIMITS[name]} B)`);
}
if (failed) process.exit(1);
