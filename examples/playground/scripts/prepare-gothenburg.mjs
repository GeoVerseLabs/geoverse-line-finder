// Derives public/data/gothenburg.json from geojson-path-finder's large-network.json (a devDependency):
// line features only, and only the tags the demo's weights read. Run from the repository root:
//   node examples/playground/scripts/prepare-gothenburg.mjs
// The data is OpenStreetMap's (© OpenStreetMap contributors, ODbL 1.0); keep the attribution with it.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const source = join(
  dirname(require.resolve('geojson-path-finder/package.json')),
  'test',
  'large-network.json',
);
const input = JSON.parse(readFileSync(source, 'utf8'));

const KEEP = ['highway', 'oneway', 'junction', 'maxspeed', 'name'];
const features = [];
for (const f of input.features) {
  if (f.geometry?.type !== 'LineString') continue;
  const properties = {};
  for (const k of KEEP) if (f.properties?.[k] !== undefined) properties[k] = f.properties[k];
  features.push({ type: 'Feature', id: f.properties?.['@id'] ?? f.id, properties, geometry: f.geometry });
}
const output = {
  type: 'FeatureCollection',
  copyright: 'Data © OpenStreetMap contributors, ODbL 1.0 (https://www.openstreetmap.org/copyright)',
  timestamp: input.timestamp,
  features,
};
const target = join(here, '..', 'public', 'data', 'gothenburg.json');
writeFileSync(target, JSON.stringify(output));
console.log(`${features.length} lines → ${target}`);
