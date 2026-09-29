import type { NetworkCollection, Position } from '../../../../src';
import type { Projector } from './project';
import type { CandidateMark, FeatureStyle, RouteLine, TransitionMark, WaypointMark } from './view';

export type { FeatureStyle } from './view';

const SVG_NS = 'http://www.w3.org/2000/svg';

export function clearSvg(svg: SVGElement): void {
  while (svg.firstChild) svg.removeChild(svg.firstChild);
}

export function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

function pointsAttr(coords: Position[], projector: Projector): string {
  return coords.map((c) => projector.toSvg(c).join(',')).join(' ');
}

/**
 * Draws every LineString/MultiLineString feature as a polyline and every Point feature (a lift mapped as a
 * point, say) as a small square, styled per feature via `styleOf`.
 */
export function renderNetwork<P>(
  svg: SVGElement,
  network: NetworkCollection<P>,
  projector: Projector,
  styleOf: (props: P, featureIndex: number) => FeatureStyle,
  group = 'network',
): void {
  const g = svgEl('g', { class: group });
  network.features.forEach((feature, i) => {
    const geometry = feature.geometry as { type?: string; coordinates?: unknown } | null;
    if (!geometry) return;
    const parts: Position[][] =
      geometry.type === 'LineString'
        ? [geometry.coordinates as Position[]]
        : geometry.type === 'MultiLineString'
          ? (geometry.coordinates as Position[][])
          : [];
    const style = styleOf(feature.properties as P, i);
    if (geometry.type === 'Point') {
      const [x, y] = projector.toSvg(geometry.coordinates as Position);
      g.appendChild(
        svgEl('rect', {
          x: x - 6,
          y: y - 6,
          width: 12,
          height: 12,
          rx: 2,
          fill: style.stroke,
          stroke: '#fff',
          'stroke-width': 2,
          ...(style.opacity !== undefined ? { opacity: style.opacity } : {}),
        }),
      );
      return;
    }
    for (const part of parts) {
      g.appendChild(
        svgEl('polyline', {
          points: pointsAttr(part, projector),
          fill: 'none',
          stroke: style.stroke,
          'stroke-width': style.width,
          'stroke-linecap': 'round',
          'stroke-linejoin': 'round',
          ...(style.dash ? { 'stroke-dasharray': style.dash } : {}),
          ...(style.opacity !== undefined ? { opacity: style.opacity } : {}),
        }),
      );
    }
  });
  svg.appendChild(g);
}

/** Draws one or more route paths (e.g. nearest vs optimal, overlaid for comparison). */
export function renderRoutes(svg: SVGElement, routes: RouteLine[], projector: Projector): void {
  const g = svgEl('g', { class: 'routes' });
  for (const r of routes) {
    if (r.path.length < 2) continue;
    g.appendChild(
      svgEl('polyline', {
        points: pointsAttr(r.path, projector),
        fill: 'none',
        stroke: r.color,
        'stroke-width': r.width ?? 4,
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
        ...(r.dash ? { 'stroke-dasharray': r.dash } : {}),
      }),
    );
  }
  svg.appendChild(g);
}

/** Draws the raw click (small ring) and, when snapped, the network location (filled dot) joined by a thin line. */
export function renderWaypoints(svg: SVGElement, waypoints: WaypointMark[], projector: Projector): void {
  const g = svgEl('g', { class: 'waypoints' });
  for (const w of waypoints) {
    const [ix, iy] = projector.toSvg(w.input);
    if (w.location) {
      const [lx, ly] = projector.toSvg(w.location);
      if (Math.hypot(lx - ix, ly - iy) > 1) {
        g.appendChild(
          svgEl('line', {
            x1: ix,
            y1: iy,
            x2: lx,
            y2: ly,
            stroke: '#94a3b8',
            'stroke-width': 1,
            'stroke-dasharray': '2,2',
          }),
        );
      }
      g.appendChild(
        svgEl('circle', {
          cx: lx,
          cy: ly,
          r: 5,
          fill: w.ok ? '#2563eb' : '#dc2626',
          stroke: '#fff',
          'stroke-width': 1.5,
        }),
      );
      g.appendChild(
        svgEl('text', {
          x: lx + 8,
          y: ly - 8,
          'font-size': 11,
          fill: '#1e293b',
          'font-family': 'ui-monospace, monospace',
        }),
      ).textContent = String(w.index + 1);
    }
    g.appendChild(
      svgEl('circle', {
        cx: ix,
        cy: iy,
        r: 4,
        fill: 'none',
        stroke: w.ok ? '#2563eb' : '#dc2626',
        'stroke-width': 1.5,
      }),
    );
  }
  svg.appendChild(g);
}

/**
 * Small hollow dots for every candidate a waypoint could have used; the chosen one drawn solid. They are
 * decoration only: `pointer-events: none` keeps them from swallowing clicks meant for the map or for a
 * level-transition marker underneath.
 */
export function renderCandidates(svg: SVGElement, candidates: CandidateMark[], projector: Projector): void {
  const g = svgEl('g', { class: 'candidates' });
  for (const c of candidates) {
    const [x, y] = projector.toSvg(c.location);
    g.appendChild(
      svgEl('circle', {
        cx: x,
        cy: y,
        r: c.selected ? 4 : 3,
        fill: c.selected ? '#f59e0b' : '#fff',
        stroke: '#f59e0b',
        'stroke-width': 1.5,
        'pointer-events': 'none',
      }),
    );
  }
  svg.appendChild(g);
}

/** Marks where a route changes level; clicking one switches the map to the floor it leads to. */
export function renderTransitions(svg: SVGElement, marks: TransitionMark[], projector: Projector): void {
  const g = svgEl('g', { class: 'transitions' });
  for (const m of marks) {
    const [x, y] = projector.toSvg(m.location);
    const box = svgEl('rect', {
      x: x - 7,
      y: y - 7,
      width: 14,
      height: 14,
      rx: 3,
      fill: '#f59e0b',
      stroke: '#fff',
      'stroke-width': 2,
      cursor: m.onClick ? 'pointer' : 'default',
    });
    if (m.onClick) {
      box.addEventListener('click', (event) => {
        event.stopPropagation();
        m.onClick!();
      });
    }
    g.appendChild(box);
    const label = svgEl('text', {
      x: x + 11,
      y: y + 4,
      'font-size': 11,
      fill: '#b45309',
      'font-family': 'ui-monospace, monospace',
      'pointer-events': 'none',
    });
    label.textContent = m.label;
    g.appendChild(label);
  }
  svg.appendChild(g);
}

/** Marks dangling ends (red ×) from `graph.diagnostics()`. */
export function renderDangles(svg: SVGElement, points: Position[], projector: Projector): void {
  const g = svgEl('g', { class: 'dangles' });
  for (const p of points) {
    const [x, y] = projector.toSvg(p);
    g.appendChild(
      svgEl('line', { x1: x - 5, y1: y - 5, x2: x + 5, y2: y + 5, stroke: '#dc2626', 'stroke-width': 2 }),
    );
    g.appendChild(
      svgEl('line', { x1: x - 5, y1: y + 5, x2: x + 5, y2: y - 5, stroke: '#dc2626', 'stroke-width': 2 }),
    );
  }
  svg.appendChild(g);
}
