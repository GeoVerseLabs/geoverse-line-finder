import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { NetworkCollection } from '../src';

/**
 * Locates a file of geojson-path-finder's test data (e.g. `large-network.json`): `GLF_GPF_DATA`, then the
 * copy under item-gis-bam, then this repository's devDependency. `null` when none exists.
 */
export function findGpfData(name: string): string | null {
  const candidates = [
    process.env.GLF_GPF_DATA && join(process.env.GLF_GPF_DATA, name),
    `D:/workspace/item/gis-project/item-gis-bam/node_modules/geojson-path-finder/test/${name}`,
  ];
  try {
    const require = createRequire(import.meta.url);
    candidates.push(join(dirname(require.resolve('geojson-path-finder/package.json')), 'test', name));
  } catch {
    // geojson-path-finder not installed
  }
  return candidates.find((p): p is string => !!p && existsSync(p)) ?? null;
}

/** One of the small networks copied into `test/fixtures/gpf`. */
export function gpfFixture<P = Record<string, unknown>>(name: string): NetworkCollection<P> {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/gpf/${name}`, import.meta.url), 'utf8'),
  ) as NetworkCollection<P>;
}
