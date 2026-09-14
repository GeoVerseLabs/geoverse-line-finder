import type { Position } from '../../../../src';

export interface Projector {
  /** Data coordinate → SVG coordinate. */
  toSvg(p: Position): [number, number];
  viewBox: string;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function boundsOf(coordLists: Iterable<Position[]>): Bounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const coords of coordLists) {
    for (const [x, y] of coords) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return { minX, minY, maxX, maxY };
}

/**
 * Fits `bounds` into a `width` × `height` viewport with `padding`, preserving aspect ratio and flipping the
 * Y axis (data Y grows up or north; SVG Y grows down). `latScale` compresses X for geographic data so a
 * degree of longitude and a degree of latitude cover the same screen distance at the given reference latitude.
 */
export function fitProjector(
  bounds: Bounds,
  width: number,
  height: number,
  padding = 24,
  latScale = 1,
): Projector {
  const dataW = Math.max(bounds.maxX - bounds.minX, 1e-9) * latScale;
  const dataH = Math.max(bounds.maxY - bounds.minY, 1e-9);
  const scale = Math.min((width - 2 * padding) / dataW, (height - 2 * padding) / dataH);
  const offsetX = padding + (width - 2 * padding - dataW * scale) / 2;
  const offsetY = padding + (height - 2 * padding - dataH * scale) / 2;
  return {
    toSvg([x, y]) {
      const sx = offsetX + (x - bounds.minX) * latScale * scale;
      const sy = height - (offsetY + (y - bounds.minY) * scale);
      return [sx, sy];
    },
    viewBox: `0 0 ${width} ${height}`,
  };
}

/** Inverse of a `fitProjector` built from the same bounds/viewport, for turning clicks back into data space. */
export function inverseFitProjector(
  bounds: Bounds,
  width: number,
  height: number,
  padding = 24,
  latScale = 1,
): (svg: [number, number]) => Position {
  const dataW = Math.max(bounds.maxX - bounds.minX, 1e-9) * latScale;
  const dataH = Math.max(bounds.maxY - bounds.minY, 1e-9);
  const scale = Math.min((width - 2 * padding) / dataW, (height - 2 * padding) / dataH);
  const offsetX = padding + (width - 2 * padding - dataW * scale) / 2;
  const offsetY = padding + (height - 2 * padding - dataH * scale) / 2;
  return ([sx, sy]) => {
    const x = bounds.minX + (sx - offsetX) / (latScale * scale);
    const y = bounds.minY + (height - sy - offsetY) / scale;
    return [x, y];
  };
}
