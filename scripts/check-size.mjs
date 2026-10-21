// Bundle-size gate. Measures what users actually ship: a minified, tree-shaken bundle of
// `import { LineFinder }` (esbuild) and the minified IIFE, both gzipped. The readable ESM/CJS files are not
// measured — they keep comments on purpose. Also checks that optional modules tree-shake away from that bundle
// with both esbuild and Rollup (through Vite): Rollup keeps top-level code it cannot prove pure, which
// esbuild drops, so passing one says nothing about the other.
import { build } from 'esbuild';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { build as viteBuild } from 'vite';

// Ratchet: set just above the 0.3.0 sizes (33.8 KB / 36.0 KB gzip): the multi-level layer (+4.1 KB consumer /
// +4.5 KB IIFE over 0.2.0), then the faster graph build and node ids / point connectors (+2.0 KB / +2.0 KB).
// Unreleased: binary graph files (+0.3 KB consumer for the lazy vertex index and on-demand positions of
// deserialised graphs; the encoder / decoder / inspector, +2.0 KB, tree-shake away unless imported — checked
// below — so only the IIFE carries them: 39.3 KB).
// Raise only with a reason in the CHANGELOG.
const LIMITS = { consumer: 35_500, iife: 39_500 };

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

// Strings found only in the binary-file module (graphToBinary / graphFromBinary / inspectBinaryGraph).
const OPTIONAL = { 'binary graph files': ['GVLFGRPH', '$gvlfNumber', 'Uint16Array([1])'] };
const dir = mkdtempSync(join(tmpdir(), 'glf-treeshake-'));
const entry = join(dir, 'entry.js');
writeFileSync(entry, `export { LineFinder } from '${join(root, 'dist/index.js').split('\\').join('/')}';`);
const rolled = await viteBuild({
  configFile: false,
  logLevel: 'silent',
  root: dir,
  build: { write: false, minify: 'esbuild', lib: { entry, formats: ['es'], fileName: 'out' } },
});
rmSync(dir, { recursive: true, force: true });
const consumers = {
  esbuild: bundled.outputFiles[0].text,
  rollup: (Array.isArray(rolled) ? rolled[0] : rolled).output[0].code,
};
for (const [bundler, code] of Object.entries(consumers)) {
  for (const [module, markers] of Object.entries(OPTIONAL)) {
    const left = markers.filter((m) => code.includes(m));
    failed ||= left.length > 0;
    console.log(
      `${left.length ? 'FAIL' : 'ok  '} ${bundler.padEnd(8)} LineFinder-only bundle drops ${module}${left.length ? ` (found ${left.join(', ')})` : ''}`,
    );
  }
}
if (failed) process.exit(1);
