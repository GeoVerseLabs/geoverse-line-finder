import { METERS_PER_DEGREE } from '../geo/metric';
import type { Position } from '../types';

const RAD = Math.PI / 180;

export interface VertexStoreOptions {
  /** Merge distance in metric units (meters for geographic metrics). `0` = exact coordinate identity. */
  tolerance: number;
  geographic: boolean;
  /** Largest |latitude| in the network; sizes the longitude cells so no neighbour is ever missed. */
  maxAbsLat: number;
}

type ExactIndex = Map<number, Map<number, number>>;
type GridIndex = Map<number, Map<number, number[]>>;

/**
 * Group index of vertices that belong to no connectivity group: the interior coordinates of connector
 * features (the steps of a staircase between two floors). They are never merged, looked up or repaired.
 */
export const NO_GROUP = -1;

/**
 * Deduplicates network coordinates into vertex ids.
 *
 * Exact mode uses a nested `Map<x, Map<y, id>>` (no string keys — the trick that makes terra-route's
 * build fast). Tolerance mode uses a uniform grid whose cells are at least `tolerance` wide and checks the
 * 3×3 neighbourhood with a real distance, unlike geojson-path-finder's coordinate rounding, which fails to
 * merge two points that straddle a rounding boundary however close they are.
 *
 * Vertices live in connectivity groups (`0` unless the graph uses `group`): only vertices of the same group
 * ever merge, so stacked floors or a bridge above a road stay apart.
 */
export class VertexStore {
  readonly x: number[] = [];
  readonly y: number[] = [];
  /** Original coordinate objects, kept for faithful output (including any z value). */
  readonly positions: Position[] = [];
  /** Group index of every vertex. */
  readonly group: number[] = [];
  /** Number of coordinates that were merged into an already known vertex. */
  merged = 0;
  /** Distance to the vertex matched by the last successful {@link find} (`0` for identical coordinates). */
  lastDistance = 0;

  private readonly tolerance: number;
  private readonly geographic: boolean;
  private readonly exact: ExactIndex[] | null = null;
  private readonly grid: GridIndex[] | null = null;
  private readonly cellX: number = 1;
  private readonly cellY: number = 1;

  constructor(options: VertexStoreOptions) {
    this.tolerance = options.tolerance > 0 ? options.tolerance : 0;
    this.geographic = options.geographic;
    if (this.tolerance === 0) {
      this.exact = [new Map()];
    } else {
      this.grid = [new Map()];
      if (this.geographic) {
        const minCos = Math.max(Math.cos(Math.min(options.maxAbsLat, 89.9) * RAD), 1e-6);
        this.cellX = this.tolerance / (METERS_PER_DEGREE * minCos);
        this.cellY = this.tolerance / METERS_PER_DEGREE;
      } else {
        this.cellX = this.tolerance;
        this.cellY = this.tolerance;
      }
    }
  }

  get size(): number {
    return this.x.length;
  }

  /** Returns the id of the vertex at (or within tolerance of) `position`, creating it when absent. */
  getOrAdd(position: Position, group = 0): number {
    const px = position[0];
    const py = position[1];
    const found = this.find(px, py, group);
    if (found !== -1) {
      this.merged++;
      return found;
    }
    return this.append(px, py, position, group);
  }

  /** Looks a coordinate up without inserting; `-1` when no vertex of `group` matches. */
  find(px: number, py: number, group = 0): number {
    if (this.exact) {
      const index = this.exact[group];
      if (index === undefined) return -1;
      const column = index.get(px);
      if (column === undefined) return -1;
      const id = column.get(py);
      if (id === undefined) return -1;
      this.lastDistance = 0;
      return id;
    }
    const grid = this.grid![group];
    if (grid === undefined) return -1;
    const cx = Math.floor(px / this.cellX);
    const cy = Math.floor(py / this.cellY);
    const sy = this.geographic ? METERS_PER_DEGREE : 1;
    const sx = this.geographic ? METERS_PER_DEGREE * Math.max(Math.cos(py * RAD), 1e-6) : 1;
    const tol2 = this.tolerance * this.tolerance;
    let best = -1;
    let bestD2 = Infinity;
    for (let gx = cx - 1; gx <= cx + 1; gx++) {
      const column = grid.get(gx);
      if (column === undefined) continue;
      for (let gy = cy - 1; gy <= cy + 1; gy++) {
        const cell = column.get(gy);
        if (cell === undefined) continue;
        for (let k = 0; k < cell.length; k++) {
          const id = cell[k];
          const dx = (px - this.x[id]) * sx;
          const dy = (py - this.y[id]) * sy;
          const d2 = dx * dx + dy * dy;
          if (d2 <= tol2 && (d2 < bestD2 || (d2 === bestD2 && id < best))) {
            best = id;
            bestD2 = d2;
          }
        }
      }
    }
    if (best !== -1) this.lastDistance = Math.sqrt(bestD2);
    return best;
  }

  /**
   * Adds a vertex unconditionally (split points computed during connectivity repair). A {@link NO_GROUP}
   * vertex is not indexed, so {@link find} never returns it and nothing merges into it.
   */
  append(px: number, py: number, position: Position, group = 0): number {
    const id = this.x.length;
    this.x.push(px);
    this.y.push(py);
    this.positions.push(position);
    this.group.push(group);
    if (group < 0) return id;
    if (this.exact) {
      const index = (this.exact[group] ??= new Map());
      let column = index.get(px);
      if (column === undefined) {
        column = new Map();
        index.set(px, column);
      }
      if (!column.has(py)) column.set(py, id);
    } else {
      const grid = (this.grid![group] ??= new Map());
      const cx = Math.floor(px / this.cellX);
      const cy = Math.floor(py / this.cellY);
      let column = grid.get(cx);
      if (column === undefined) {
        column = new Map();
        grid.set(cx, column);
      }
      const cell = column.get(cy);
      if (cell === undefined) column.set(cy, [id]);
      else cell.push(id);
    }
    return id;
  }
}
