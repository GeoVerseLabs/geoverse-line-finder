// Compiles a consumer against the published declarations with several TypeScript versions and
// `skipLibCheck: false`, so no declaration needs a newer compiler than the documented minimum (5.0).
//   node scripts/check-types.mjs [versions…]     default: 5.0 5.4 5.7 5.9 (needs `pnpm build` first)
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
if (!existsSync(new URL('../dist/index.d.ts', import.meta.url))) {
  console.error('dist/index.d.ts not found: run `pnpm build` first.');
  process.exit(1);
}
const versions = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ['5.0', '5.4', '5.7', '5.9'];
let failed = false;
for (const version of versions) {
  const result = spawnSync(`npx -y -p typescript@${version} tsc -p test-types/tsconfig.json`, {
    cwd: root,
    shell: true,
    encoding: 'utf8',
  });
  const ok = result.status === 0;
  failed ||= !ok;
  console.log(`${ok ? 'ok  ' : 'FAIL'} TypeScript ${version}`);
  if (!ok) console.log(`${result.stdout}${result.stderr}`.trim());
}
if (failed) process.exit(1);
