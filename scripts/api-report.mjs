// Public API report: the built declarations must match the committed etc/geoverse-line-finder.api.d.ts, so
// every change to the published types is deliberate and visible in review.
//   node scripts/api-report.mjs            check (after `pnpm build`)
//   node scripts/api-report.mjs --update   accept the current declarations
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const built = new URL('../dist/index.d.ts', import.meta.url);
const report = new URL('../etc/geoverse-line-finder.api.d.ts', import.meta.url);
const normalise = (text) => text.replace(/\r\n/g, '\n').trimEnd() + '\n';

if (!existsSync(built)) {
  console.error('dist/index.d.ts not found: run `pnpm build` first.');
  process.exit(1);
}
const current = normalise(readFileSync(built, 'utf8'));

if (process.argv.includes('--update')) {
  mkdirSync(new URL('../etc/', import.meta.url), { recursive: true });
  writeFileSync(report, current);
  console.log('API report updated: etc/geoverse-line-finder.api.d.ts');
  process.exit(0);
}
if (!existsSync(report)) {
  console.error('No API report yet: run `pnpm api:update` and commit etc/geoverse-line-finder.api.d.ts.');
  process.exit(1);
}
const expected = normalise(readFileSync(report, 'utf8'));
if (current === expected) {
  console.log('ok   public API matches etc/geoverse-line-finder.api.d.ts');
  process.exit(0);
}
const before = new Set(expected.split('\n'));
const after = new Set(current.split('\n'));
const removed = [...before].filter((line) => !after.has(line) && line.trim());
const added = [...after].filter((line) => !before.has(line) && line.trim());
console.error('FAIL public API changed (review, then `pnpm api:update`):');
for (const line of removed.slice(0, 40)) console.error(`  - ${line}`);
for (const line of added.slice(0, 40)) console.error(`  + ${line}`);
process.exit(1);
