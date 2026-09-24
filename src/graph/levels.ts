import type { Position } from '../types';
import type { GroupKey } from './topology';

/**
 * What one connectivity group is, vertically. `ordinal` is what the routing engine reasons about (the
 * A* level bound and `levelChanges` both count ordinals); `elevation` is the physical height that
 * `WeightContext.rise`, `verticalDistance` and `output: { z: 'elevation' }` use.
 */
export interface LevelInfo {
  /** Storey number: negative underground, adjacent floors differ by 1 (a mezzanine may be 1.5). */
  ordinal: number;
  /** Height in metric units. Optional; without it there is no `rise`, `verticalDistance` or z output. */
  elevation?: number;
  /** Display name ("B1", "L3"). */
  name?: string;
}

/**
 * Level metadata per connectivity group: a record keyed by `String(groupKey)`, or a function (which also
 * receives `undefined` for the default group, so an outdoor level can be given an ordinal too).
 */
export type LevelsOption =
  Record<string, LevelInfo> | ((group: GroupKey | undefined) => LevelInfo | null | undefined);

/** Level metadata by group index (see {@link RoutingGraph.groupKeys}). */
export interface LevelTable {
  /** Storey number per group; `NaN` when the group has none. */
  readonly ordinal: Float64Array;
  /** Height per group; `NaN` when unknown. */
  readonly elevation: Float64Array;
  readonly name: readonly (string | undefined)[];
  /**
   * Groups that hold live vertices but no `ordinal`. They switch the level bound off for the whole graph
   * (a level change through them would look free, which would make the bound inadmissible).
   */
  readonly missing: readonly number[];
  /** At least one group has a finite elevation. */
  readonly hasElevation: boolean;
}

function readInfo(value: LevelInfo | null | undefined, key: GroupKey | undefined): LevelInfo | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object') {
    throw new TypeError(`Option "levels" must return { ordinal, elevation?, name? }, got ${String(value)}.`);
  }
  const { ordinal, elevation } = value;
  if (!Number.isFinite(ordinal)) {
    throw new RangeError(`Level of group ${String(key)} has a non-finite ordinal ${String(ordinal)}.`);
  }
  if (elevation !== undefined && !Number.isFinite(elevation)) {
    throw new RangeError(`Level of group ${String(key)} has a non-finite elevation ${String(elevation)}.`);
  }
  return value;
}

/** Resolves {@link LevelsOption} against the graph's group keys. `missing` is filled in by the builder. */
export function resolveLevels(
  groupKeys: readonly (GroupKey | undefined)[],
  lookup: (key: GroupKey | undefined) => LevelInfo | null | undefined,
): { ordinal: Float64Array; elevation: Float64Array; name: (string | undefined)[]; hasElevation: boolean } {
  const G = groupKeys.length;
  const ordinal = new Float64Array(G).fill(NaN);
  const elevation = new Float64Array(G).fill(NaN);
  const name: (string | undefined)[] = new Array(G).fill(undefined);
  let hasElevation = false;
  for (let g = 0; g < G; g++) {
    const info = readInfo(lookup(groupKeys[g]), groupKeys[g]);
    if (!info) continue;
    ordinal[g] = info.ordinal;
    if (info.elevation !== undefined) {
      elevation[g] = info.elevation;
      hasElevation = true;
    }
    name[g] = info.name;
  }
  return { ordinal, elevation, name, hasElevation };
}

/** Travel allowed through a {@link VerticalConnector}: both ways, or only up / only down (escalators). */
export type ConnectorDirection = 'both' | 'up' | 'down';

/**
 * A lift shaft, staircase or escalator declared by its stops instead of by geometry. Every pair of stops
 * becomes one connection, so a ride costs `boardCost + |ordinal difference| * perLevelCost` however many
 * floors it spans — unlike floor-by-floor connector features, which charge the boarding cost per hop.
 */
export interface VerticalConnector<P = unknown> {
  id?: string | number;
  /** Free-form; carried to `sections[].properties.kind` through the synthesised feature. */
  kind?: string;
  /** Where the connector touches each level. A lift repeats one position; stairs give each landing. */
  stops: readonly { group: GroupKey; position: Position }[];
  /** One-off cost of a ride (waiting, getting in and out). Default `0`. */
  boardCost?: number;
  /** Cost per level crossed, by `|ordinal difference|`. Default `0`. */
  perLevelCost?: number;
  /** `'up'` / `'down'` restrict travel to rising / falling ordinals (escalators). Default `'both'`. */
  direction?: ConnectorDirection;
  properties?: P;
}
