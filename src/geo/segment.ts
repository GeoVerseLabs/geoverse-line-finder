/** Mutable result holder for {@link projectToSegment}, reused to avoid allocations in hot loops. */
export interface SegmentProjection {
  t: number;
  x: number;
  y: number;
}

/**
 * Projects point `p` onto segment `a→b` in a locally scaled plane (`sx`, `sy` convert coordinate deltas
 * into metric units). Writes the clamped parameter `t ∈ [0, 1]` and the closest point into `out`, and
 * returns the scaled distance from `p` to that point.
 */
export function projectToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  sx: number,
  sy: number,
  out: SegmentProjection,
): number {
  const dx = (bx - ax) * sx;
  const dy = (by - ay) * sy;
  const len2 = dx * dx + dy * dy;
  let t = 0;
  if (len2 > 0) {
    t = ((px - ax) * sx * dx + (py - ay) * sy * dy) / len2;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
  }
  const x = ax + (bx - ax) * t;
  const y = ay + (by - ay) * t;
  out.t = t;
  out.x = x;
  out.y = y;
  const ex = (px - x) * sx;
  const ey = (py - y) * sy;
  return Math.sqrt(ex * ex + ey * ey);
}

/** Mutable result holder for {@link intersectSegments}. */
export interface SegmentIntersection {
  /** Parameter along the first segment. */
  t: number;
  /** Parameter along the second segment. */
  u: number;
}

/**
 * Intersects segments `p1→p2` and `q1→q2`. Returns `false` for disjoint, parallel or collinear pairs
 * (collinear overlaps are not split). On success `out.t`/`out.u` hold the parameters in `[0, 1]`.
 */
export function intersectSegments(
  p1x: number,
  p1y: number,
  p2x: number,
  p2y: number,
  q1x: number,
  q1y: number,
  q2x: number,
  q2y: number,
  out: SegmentIntersection,
): boolean {
  const rx = p2x - p1x;
  const ry = p2y - p1y;
  const sx = q2x - q1x;
  const sy = q2y - q1y;
  const denom = rx * sy - ry * sx;
  const scale = Math.abs(rx * sy) + Math.abs(ry * sx);
  if (denom === 0 || Math.abs(denom) <= 1e-14 * scale) return false;
  const qpx = q1x - p1x;
  const qpy = q1y - p1y;
  const t = (qpx * sy - qpy * sx) / denom;
  const u = (qpx * ry - qpy * rx) / denom;
  if (t < 0 || t > 1 || u < 0 || u > 1) return false;
  out.t = t;
  out.u = u;
  return true;
}
