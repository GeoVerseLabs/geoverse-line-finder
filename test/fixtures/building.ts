import type {
  GraphOptions,
  GroupFunction,
  GroupKey,
  LevelInfo,
  NetworkCollection,
  NetworkFeature,
  Position,
  VerticalConnector,
  WeightFunction,
} from '../../src';
import { fc, line } from '../helpers';

/**
 * Synthetic multi-storey buildings for the level tests.
 *
 * Every floor is a corridor grid at the same plan coordinates as the others, so the floors overlap exactly
 * and only `group` keeps them apart. Connectors come in the shapes that break naive implementations:
 * zero-length lifts (no plan length at all), staircases with a landing in between (interior coordinates in
 * no group), one-way escalators, an express lift that skips floors, a free lift (which drives the
 * per-level bound to 0) and an outdoor area with no ordinal (which must switch the bound off entirely).
 */
export interface BuildingProps {
  kind: 'corridor' | 'elevator' | 'stairs' | 'escalator';
  /** Corridors only. */
  floor?: number | string;
  /** Connectors only. */
  from?: number | string;
  to?: number | string;
  factor?: number;
  cost?: number;
}

export interface BuildingOptions {
  floors?: number;
  /** Lattice points per side. */
  size?: number;
  spacing?: number;
  /** Probability that a corridor line exists at all. */
  keep?: number;
  elevators?: number;
  stairs?: number;
  escalators?: number;
  /** Add an express lift (a `verticalConnector` with a stop on every floor). */
  express?: boolean;
  /** Add an outdoor area without an ordinal, linked to two floors. */
  outdoor?: boolean;
  /** Make the first lift free, which is what drives `heuristic.perLevel` to 0. */
  freeElevator?: boolean;
  /** Give the levels elevations (4 m per floor). */
  elevation?: boolean;
  /** Keep only the perimeter of the top floor, so its snap candidates are sparse. */
  sparseTop?: boolean;
  /** All corridors cost their length, so the metric scale is tight (for bound-strength tests). */
  uniform?: boolean;
}

export interface Building {
  network: NetworkCollection<BuildingProps>;
  graphOptions: GraphOptions<BuildingProps>;
  floors: number[];
  spacing: number;
  size: number;
  /** Lattice point `(i, j)` in plan coordinates. */
  at(i: number, j: number): Position;
}

export const FLOOR_HEIGHT = 4;

/** Cost model: corridors by length, connectors by a fixed price per hop. */
export const buildingWeight: WeightFunction<BuildingProps> = (_a, _b, p, ctx) => {
  if (p.kind === 'corridor') return ctx.distance * (p.factor ?? 1);
  if (p.kind === 'escalator') return { forward: p.cost ?? 6 };
  return p.cost ?? 5;
};

export const buildingGroup: GroupFunction<BuildingProps> = (p) =>
  p.kind === 'corridor' ? (p.floor as GroupKey) : ([p.from as GroupKey, p.to as GroupKey] as const);

export function randomBuilding(rand: () => number, options: BuildingOptions = {}): Building {
  const floors = options.floors ?? 4;
  const size = options.size ?? 5;
  const spacing = options.spacing ?? 5;
  const keep = options.keep ?? 0.9;
  const at = (i: number, j: number): Position => [i * spacing, j * spacing];
  const features: NetworkFeature<BuildingProps>[] = [];
  const floorKeys: number[] = [];

  for (let f = 1; f <= floors; f++) {
    floorKeys.push(f);
    const sparse = options.sparseTop === true && f === floors;
    const factor = () => (options.uniform === true ? 1 : 0.5 + rand() * 2);
    for (let j = 0; j < size; j++) {
      const edge = j === 0 || j === size - 1;
      if (!sparse || edge) {
        if (rand() < keep || edge) {
          features.push(
            line(
              [at(0, j), at(size - 1, j)],
              { kind: 'corridor', floor: f, factor: factor() },
              `h${j}-F${f}`,
            ),
          );
        }
      }
    }
    for (let i = 0; i < size; i++) {
      const edge = i === 0 || i === size - 1;
      if (!sparse || edge) {
        if (rand() < keep || edge) {
          features.push(
            line(
              [at(i, 0), at(i, size - 1)],
              { kind: 'corridor', floor: f, factor: factor() },
              `v${i}-F${f}`,
            ),
          );
        }
      }
    }
  }

  const lattice = (): [number, number] => [
    Math.floor(rand() * size),
    Math.floor(rand() * size),
  ];
  let lifts = 0;
  for (let e = 0; e < (options.elevators ?? 2); e++) {
    const [i, j] = lattice();
    for (let f = 1; f < floors; f++) {
      const free = options.freeElevator === true && lifts === 0;
      features.push(
        line([at(i, j), at(i, j)], { kind: 'elevator', from: f, to: f + 1, cost: free ? 0 : 4 }, `E${e}:${f}-${f + 1}`),
      );
    }
    lifts++;
  }
  for (let s = 0; s < (options.stairs ?? 1); s++) {
    const i = Math.floor(rand() * (size - 1));
    const j = Math.floor(rand() * size);
    for (let f = 1; f < floors; f++) {
      const a = at(i, j);
      const b = at(i + 1, j);
      features.push(
        line(
          [a, [(a[0] + b[0]) / 2, a[1] + spacing / 2], b],
          { kind: 'stairs', from: f, to: f + 1, cost: 7 },
          `S${s}:${f}-${f + 1}`,
        ),
      );
    }
  }
  for (let s = 0; s < (options.escalators ?? 0); s++) {
    const i = Math.floor(rand() * (size - 1));
    const j = Math.floor(rand() * size);
    for (let f = 1; f < floors; f++) {
      features.push(
        line([at(i, j), at(i + 1, j)], { kind: 'escalator', from: f, to: f + 1, cost: 6 }, `X${s}:${f}-${f + 1}`),
      );
    }
  }
  if (options.outdoor === true) {
    features.push(
      line([at(0, 0), [-spacing, 0]], { kind: 'corridor', floor: 'outdoor', factor: 1 }, 'outdoor'),
      line([[-spacing, 0], at(0, 0)], { kind: 'stairs', from: 'outdoor', to: 1, cost: 2 }, 'out-1'),
      line([[-spacing, 0], at(0, size - 1)], { kind: 'stairs', from: 'outdoor', to: floors, cost: 2 }, 'out-top'),
    );
  }

  const verticalConnectors: VerticalConnector<BuildingProps>[] | undefined = options.express
    ? [
        {
          id: 'express',
          kind: 'elevator',
          stops: floorKeys.map((f) => ({ group: f, position: at(size - 1, size - 1) })),
          boardCost: 5,
          perLevelCost: 1,
          properties: { kind: 'elevator', cost: 0 },
        },
      ]
    : undefined;

  const levels = (group: number | string | undefined): LevelInfo | undefined => {
    if (typeof group !== 'number') return undefined; // 'outdoor' and the default group have no ordinal
    return {
      ordinal: group,
      elevation: options.elevation === true ? (group - 1) * FLOOR_HEIGHT : undefined,
      name: `F${group}`,
    };
  };

  return {
    network: fc(features),
    graphOptions: {
      metric: 'euclidean',
      // Rows and columns cross without sharing coordinates: node them (inside each floor only).
      splitIntersections: true,
      weight: buildingWeight,
      group: buildingGroup,
      levels,
      zeroWeight: 'free',
      verticalConnectors,
    },
    floors: floorKeys,
    spacing,
    size,
    at,
  };
}

/**
 * A plain, deterministic tower: every floor carries the same full corridor grid and the lifts stop at
 * every floor. Used to measure what the level-aware bound is worth without any randomness.
 */
export function gridTower(
  floors: number,
  size = 7,
  spacing = 5,
  lifts: readonly [number, number][] = [[1, 1]],
): { network: NetworkCollection<BuildingProps>; graphOptions: GraphOptions<BuildingProps>; at: Building['at'] } {
  const at = (i: number, j: number): Position => [i * spacing, j * spacing];
  const features: NetworkFeature<BuildingProps>[] = [];
  for (let f = 1; f <= floors; f++) {
    for (let j = 0; j < size; j++) {
      features.push(
        line([at(0, j), at(size - 1, j)], { kind: 'corridor', floor: f, factor: 1 }, `h${j}-F${f}`),
      );
    }
    for (let i = 0; i < size; i++) {
      features.push(
        line([at(i, 0), at(i, size - 1)], { kind: 'corridor', floor: f, factor: 1 }, `v${i}-F${f}`),
      );
    }
  }
  lifts.forEach(([i, j], e) => {
    for (let f = 1; f < floors; f++) {
      features.push(
        line([at(i, j), at(i, j)], { kind: 'elevator', from: f, to: f + 1, cost: 4 }, `E${e}:${f}-${f + 1}`),
      );
    }
  });
  return {
    network: fc(features),
    graphOptions: {
      metric: 'euclidean',
      splitIntersections: true,
      weight: buildingWeight,
      group: buildingGroup,
      zeroWeight: 'free',
      levels: (g) =>
        typeof g === 'number' ? { ordinal: g, elevation: (g - 1) * FLOOR_HEIGHT, name: `F${g}` } : undefined,
    },
    at,
  };
}

/**
 * The counterexample that rules out deriving the per-level bound from compacted chains: chain compaction
 * merges the very expensive F1 corridor, the staircase and the F2 corridor into one chain. Taken per
 * chain the bound would be about 995 per level; the real cost of stepping off the stairs onto the F1
 * corridor is about 20, so A* would prune the true shortest path.
 */
export function expensiveCorridorBuilding(): {
  network: NetworkCollection<BuildingProps>;
  graphOptions: GraphOptions<BuildingProps>;
} {
  const features: NetworkFeature<BuildingProps>[] = [
    // F1: one very expensive dead-end corridor (10 m long, factor 100) plus a cheap loop.
    line([[0, 0], [10, 0]], { kind: 'corridor', floor: 1, factor: 100 }, 'expensive-F1'),
    line([[0, 0], [0, 20]], { kind: 'corridor', floor: 1, factor: 1 }, 'cheap-F1'),
    line([[0, 20], [10, 20]], { kind: 'corridor', floor: 1, factor: 1 }, 'top-F1'),
    // F2: a corridor above it, with a branch so that the stair head is a real junction.
    line([[10, 0], [10, 20]], { kind: 'corridor', floor: 2, factor: 1 }, 'v-F2'),
    line([[10, 0], [20, 0]], { kind: 'corridor', floor: 2, factor: 1 }, 'branch-F2'),
    // The staircase joins the end of the expensive corridor to F2.
    line([[10, 0], [12, 2], [10, 0]], { kind: 'stairs', from: 1, to: 2, cost: 5 }, 'stairs'),
  ];
  return {
    network: fc(features),
    graphOptions: {
      metric: 'euclidean',
      weight: buildingWeight,
      group: buildingGroup,
      levels: (g) => (typeof g === 'number' ? { ordinal: g, elevation: (g - 1) * FLOOR_HEIGHT } : undefined),
      zeroWeight: 'free',
    },
  };
}
