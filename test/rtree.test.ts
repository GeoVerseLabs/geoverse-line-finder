import { describe, expect, it } from 'vitest';
import { projectToSegment } from '../src/geo/segment';
import { PackedRTree } from '../src/spatial/rtree';
import { mulberry32 } from './helpers';

function randomSegments(rand: () => number, count: number): number[][] {
  const segs: number[][] = [];
  for (let i = 0; i < count; i++) {
    const x = rand() * 1000;
    const y = rand() * 1000;
    segs.push([x, y, x + (rand() - 0.5) * 60, y + (rand() - 0.5) * 60]);
  }
  return segs;
}

function treeOf(segs: number[][], nodeSize?: number): PackedRTree {
  const tree = new PackedRTree(segs.length, nodeSize);
  for (const [ax, ay, bx, by] of segs)
    tree.add(Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by));
  tree.finish();
  return tree;
}

describe('PackedRTree', () => {
  it('window search matches brute force', () => {
    const rand = mulberry32(7);
    const segs = randomSegments(rand, 800);
    const tree = treeOf(segs);
    for (let q = 0; q < 60; q++) {
      const x = rand() * 1000;
      const y = rand() * 1000;
      const w = rand() * 150;
      const found: number[] = [];
      tree.search(x, y, x + w, y + w, (i) => found.push(i));
      const expected = segs
        .map((s, i) => ({ s, i }))
        .filter(
          ({ s }) =>
            !(
              x + w < Math.min(s[0], s[2]) ||
              y + w < Math.min(s[1], s[3]) ||
              x > Math.max(s[0], s[2]) ||
              y > Math.max(s[1], s[3])
            ),
        )
        .map(({ i }) => i);
      expect(found.sort((a, b) => a - b)).toEqual(expected);
    }
  });

  it('nearest visits items in exact ascending distance, with anisotropic scaling', () => {
    const rand = mulberry32(11);
    const segs = randomSegments(rand, 500);
    const tree = treeOf(segs, 8);
    const proj = { t: 0, x: 0, y: 0 };
    const sx = 0.55;
    const sy = 1;
    for (let q = 0; q < 25; q++) {
      const x = rand() * 1000;
      const y = rand() * 1000;
      const dist = (i: number) =>
        projectToSegment(x, y, segs[i][0], segs[i][1], segs[i][2], segs[i][3], sx, sy, proj);
      const visited: number[] = [];
      tree.nearest(x, y, sx, sy, dist, (_i, d) => {
        visited.push(d);
        return visited.length < 40;
      });
      const expected = segs
        .map((_, i) => dist(i))
        .sort((a, b) => a - b)
        .slice(0, 40);
      expect(visited).toHaveLength(40);
      visited.forEach((d, k) => expect(d).toBeCloseTo(expected[k], 9));
    }
  });

  it('honours maxDistance', () => {
    const rand = mulberry32(3);
    const segs = randomSegments(rand, 300);
    const tree = treeOf(segs);
    const proj = { t: 0, x: 0, y: 0 };
    const dist = (i: number) =>
      projectToSegment(500, 500, segs[i][0], segs[i][1], segs[i][2], segs[i][3], 1, 1, proj);
    const within: number[] = [];
    tree.nearest(500, 500, 1, 1, dist, (i) => (within.push(i), true), 50);
    const expected = segs.map((_, i) => i).filter((i) => dist(i) <= 50);
    expect(within.sort((a, b) => a - b)).toEqual(expected);
  });

  it('handles empty and single-node trees', () => {
    const empty = new PackedRTree(0);
    empty.finish();
    const hits: number[] = [];
    empty.search(-1, -1, 1, 1, (i) => hits.push(i));
    empty.nearest(
      0,
      0,
      1,
      1,
      () => 0,
      (i) => (hits.push(i), true),
    );
    expect(hits).toEqual([]);

    const tiny = treeOf([
      [0, 0, 1, 0],
      [5, 5, 6, 6],
      [2, 2, 2, 3],
    ]);
    const all: number[] = [];
    tiny.search(-10, -10, 10, 10, (i) => all.push(i));
    expect(all.sort()).toEqual([0, 1, 2]);
    let first = -1;
    tiny.nearest(
      5.2,
      5.1,
      1,
      1,
      (i) => (i === 1 ? 0.1 : 10),
      (i) => ((first = i), false),
    );
    expect(first).toBe(1);
  });

  it('rejects finishing with a wrong item count', () => {
    const tree = new PackedRTree(2);
    tree.add(0, 0, 1, 1);
    expect(() => tree.finish()).toThrow(/expected 2/);
  });
});
