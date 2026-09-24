import type { GroupKey } from '../graph/topology';
import type { Position } from '../types';
import type { LevelKey } from './assemble';
import type { RouteLeg, RouteResult } from './types';

/**
 * What a piece of the route is: a stretch on one level, a passage between levels, or the point where a
 * passage starts.
 */
export type LevelFeatureKind = 'path' | 'connector' | 'transition';

export interface LevelFeatureProperties {
  kind: LevelFeatureKind;
  legIndex: number;
  legKind: 'network' | 'straight';
  /** First and last index (inclusive) into the leg's `path`. */
  start: number;
  end: number;
  /** `'path'`: the level it runs on. `'connector'` / `'transition'`: `null`. */
  level: GroupKey | null | undefined;
  /** `'connector'` / `'transition'` only. */
  fromLevel?: GroupKey;
  toLevel?: GroupKey;
  levelChange?: number;
  featureIndices?: number[];
  weight?: number;
  distance?: number;
}

export interface LevelFeature {
  type: 'Feature';
  geometry: { type: 'LineString'; coordinates: Position[] } | { type: 'Point'; coordinates: Position };
  properties: LevelFeatureProperties;
}

export interface LevelFeatureCollection {
  type: 'FeatureCollection';
  features: LevelFeature[];
}

function lineFeature(coordinates: Position[], properties: LevelFeatureProperties): LevelFeature {
  return { type: 'Feature', geometry: { type: 'LineString', coordinates }, properties };
}

/**
 * Splits a route into pieces an indoor map can draw one level at a time: one `LineString` per stretch
 * that stays on a level, one per passage between levels (draw it dashed, it is not on either level), and
 * a `Point` where each passage starts, carrying the same fields as the leg's `transitions`.
 *
 * Returns an empty collection for a failed route, or for one whose graph was built without `levels`.
 */
export function toLevelFeatures<P>(result: RouteResult<P>): LevelFeatureCollection {
  const features: LevelFeature[] = [];
  if (!result.ok) return { type: 'FeatureCollection', features };
  result.legs.forEach((leg: RouteLeg<P>, legIndex) => {
    const levels = leg.levels;
    if (!levels) return;
    const path = leg.path;
    const n = path.length;
    const transitions = leg.transitions ?? [];
    // Which transition (if any) every path segment belongs to.
    const cover: number[] = new Array(Math.max(0, n - 1)).fill(-1);
    transitions.forEach((t, ti) => {
      for (let i = Math.max(0, t.start); i < Math.min(t.end, n - 1); i++) cover[i] = ti;
    });
    const base = (start: number, end: number, kind: LevelFeatureKind): LevelFeatureProperties => ({
      kind,
      legIndex,
      legKind: leg.kind,
      start,
      end,
      level: null,
    });

    let i = 0;
    while (i < n - 1) {
      const ti = cover[i];
      let j = i + 1;
      while (j < n - 1 && cover[j] === ti && (ti >= 0 || levels[j] === levels[i])) j++;
      const coordinates = path.slice(i, j + 1);
      if (ti >= 0) {
        const t = transitions[ti];
        features.push(
          lineFeature(coordinates, {
            ...base(i, j, 'connector'),
            fromLevel: t.fromLevel,
            toLevel: t.toLevel,
            levelChange: t.levelChange,
            featureIndices: t.featureIndices,
            weight: t.weight,
            distance: t.distance,
          }),
        );
      } else {
        const level: LevelKey = levels[i];
        features.push(lineFeature(coordinates, { ...base(i, j, 'path'), level }));
      }
      i = j;
    }

    for (const t of transitions) {
      const at = path[Math.min(Math.max(t.start, 0), n - 1)];
      if (!at) continue;
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: at },
        properties: {
          ...base(t.start, t.end, 'transition'),
          fromLevel: t.fromLevel,
          toLevel: t.toLevel,
          levelChange: t.levelChange,
          featureIndices: t.featureIndices,
          weight: t.weight,
          distance: t.distance,
        },
      });
    }
  });
  return { type: 'FeatureCollection', features };
}
