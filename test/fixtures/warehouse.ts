import type { NetworkCollection, NetworkFeature, Position } from '../../src';

/**
 * The synthetic warehouse from the item-gis-bam requirements (appendix A), generated deterministically:
 * 66 side aisles every 3.6 m, three main aisles (y = 5, 60, 115) and two sub aisles framing a 240 × 120 m
 * floor, with pick locations 1.5 m beside a side aisle (the back aisle is 2.1 m away).
 */

export type RoadLevel = 'Side' | 'Sub' | 'Main';

export interface AisleProps {
  /** Aisle id shared by all pieces of one aisle (what `featureIds` matches against). */
  id: string;
  roadLevel: RoadLevel;
}

export interface WarehouseWaypoint {
  coordinates: Position;
  /** Aisle the location faces. */
  aisle: string;
  /** Aisle behind the location. */
  back: string;
}

export const LEVEL_FACTOR: Record<RoadLevel, number> = { Side: 0.8, Sub: 1.0, Main: 1.5 };

const SIDES = 66;
const SPACING = 3.6;
const WIDTH = 240;
const MAIN_Y = [5, 60, 115];

// cheap-ruler scale at the reference latitude, re-implemented here so the fixture shares no code with src/.
const RAD = Math.PI / 180;
const REF_LAT = 34;
const RE = 6378137;
const FE = 1 / 298.257223563;
const E2 = FE * (2 - FE);
const COS = Math.cos(REF_LAT * RAD);
const W2 = 1 / (1 - E2 * (1 - COS * COS));
const KX = RAD * RE * Math.sqrt(W2) * COS;
const KY = RAD * RE * Math.sqrt(W2) * W2 * (1 - E2);

/** Local metres → `[lng, lat]` around the origin `[-118, 34]`. */
export function toLngLat(x: number, y: number): Position {
  return [-118 + x / KX, REF_LAT + y / KY];
}

function aisle(
  featureId: string,
  id: string,
  roadLevel: RoadLevel,
  points: [number, number][],
): NetworkFeature<AisleProps> {
  return {
    type: 'Feature',
    id: featureId,
    properties: { id, roadLevel },
    geometry: { type: 'LineString', coordinates: points.map(([x, y]) => toLngLat(x, y)) },
  };
}

const sideX = (i: number) => i * SPACING;

/**
 * `normalized` (default): every junction is a shared vertex and side aisles are split at the middle main
 * aisle. Otherwise main aisles keep only their end points and each side aisle is one line from y = 5 to 115.
 */
export function warehouseNetwork(normalized = true): NetworkCollection<AisleProps> {
  const features: NetworkFeature<AisleProps>[] = [];
  for (let i = 1; i <= SIDES; i++) {
    const x = sideX(i);
    const id = `side-${i}`;
    if (normalized) {
      features.push(
        aisle(`${id}-s`, id, 'Side', [
          [x, 5],
          [x, 60],
        ]),
      );
      features.push(
        aisle(`${id}-n`, id, 'Side', [
          [x, 60],
          [x, 115],
        ]),
      );
    } else {
      features.push(
        aisle(id, id, 'Side', [
          [x, 5],
          [x, 115],
        ]),
      );
    }
  }
  for (const y of MAIN_Y) {
    const xs = normalized ? [0, ...Array.from({ length: SIDES }, (_, k) => sideX(k + 1)), WIDTH] : [0, WIDTH];
    features.push(
      aisle(
        `main-${y}`,
        `main-${y}`,
        'Main',
        xs.map((x) => [x, y]),
      ),
    );
  }
  for (const x of [0, WIDTH]) {
    const ys = normalized ? MAIN_Y : [5, 115];
    features.push(
      aisle(
        `sub-${x}`,
        `sub-${x}`,
        'Sub',
        ys.map((y) => [x, y]),
      ),
    );
  }
  return { type: 'FeatureCollection', features };
}

/** Pick tasks: `count` tasks of `perTask` locations from a linear congruential generator (seed 7). */
export function warehouseTasks(count = 292, perTask = 8, seed = 7): WarehouseWaypoint[][] {
  let s = seed >>> 0;
  const rnd = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const tasks: WarehouseWaypoint[][] = [];
  for (let t = 0; t < count; t++) {
    const task: WarehouseWaypoint[] = [];
    for (let k = 0; k < perTask; k++) {
      const i = 1 + Math.floor(rnd() * SIDES);
      const dir = rnd() < 0.5 ? -1 : 1;
      const y = 10 + rnd() * 100;
      const j = i + dir;
      task.push({
        coordinates: toLngLat(sideX(i) + dir * 1.5, y),
        aisle: `side-${i}`,
        back: j === 0 ? 'sub-0' : j > SIDES ? `sub-${WIDTH}` : `side-${j}`,
      });
    }
    tasks.push(task);
  }
  return tasks;
}
