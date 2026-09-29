import 'maplibre-gl/dist/maplibre-gl.css';
import {
  AttributionControl,
  Map as MapLibreMap,
  NavigationControl,
  ScaleControl,
  setWorkerUrl,
  type GeoJSONSource,
  type StyleSpecification,
} from 'maplibre-gl';
// MapLibre 6 finds its worker next to its own module, which no longer exists once Vite has bundled it: hand it
// the worker Vite builds (with the shared chunk it imports) instead.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import type { NetworkCollection, Position } from '../../../../src';
import { boundsOf } from './project';
import { coordinateLists, type FeatureStyle, type MapView, type Overlay } from './view';

setWorkerUrl(workerUrl);

/** OpenFreeMap: free, keyless vector tiles built from OpenStreetMap. */
const STYLE_URL = 'https://tiles.openfreemap.org/styles/positron';
const FONT = ['Noto Sans Bold'];

// GeoJSON types as MapLibre's setData takes them (its `geojson` typings are not a direct dependency here).
type FeatureCollection = Extract<Parameters<GeoJSONSource['setData']>[0], { type: 'FeatureCollection' }>;
type Feature = FeatureCollection['features'][number];
type Geometry = Feature['geometry'];
const collection = (features: Feature[]): FeatureCollection => ({
  type: 'FeatureCollection',
  features,
});
const line = (coordinates: Position[], properties: Record<string, unknown> = {}): Feature => ({
  type: 'Feature',
  geometry: { type: 'LineString', coordinates },
  properties,
});
const point = (coordinates: Position, properties: Record<string, unknown> = {}): Feature => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates },
  properties,
});

/** The basemap, or a plain background when the tile server cannot be reached (the demo keeps working). */
async function loadStyle(): Promise<{ style: StyleSpecification | string; glyphs: boolean }> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(STYLE_URL, { signal: controller.signal });
    clearTimeout(timer);
    if (res.ok) return { style: (await res.json()) as StyleSpecification, glyphs: true };
  } catch {
    // fall through to the blank style
  }
  return {
    style: {
      version: 8,
      sources: {},
      layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#eef2f6' } }],
    },
    glyphs: false,
  };
}

const SOURCES = ['network', 'routes', 'links', 'candidates', 'waypoints', 'transitions', 'dangles'] as const;
type SourceId = (typeof SOURCES)[number];

/**
 * A MapLibre GL JS map on an OpenFreeMap basemap, for longitude / latitude scenarios. The network and every
 * overlay are GeoJSON sources drawn above the basemap; styling comes from feature properties, so the
 * scenario's `styleOf` works unchanged. Calls made before the map has loaded are replayed once it has.
 */
export class MapLibreView implements MapView {
  private map: MapLibreMap | null = null;
  private loaded = false;
  private glyphs = false;
  private pending: {
    network?: FeatureCollection;
    fit?: [number, number, number, number];
    overlay?: Overlay;
  } = {};
  private clickHandler: ((location: Position) => void) | null = null;

  constructor(
    private readonly container: HTMLElement,
    private readonly attribution: string,
  ) {}

  show(): void {
    this.container.hidden = false;
    if (!this.map) void this.create();
    else this.map.resize();
  }

  hide(): void {
    this.container.hidden = true;
  }

  setNetwork(
    network: NetworkCollection<unknown>,
    styleOf: (props: unknown, featureIndex: number) => FeatureStyle,
    fit: boolean,
  ): void {
    const features: Feature[] = [];
    network.features.forEach((f, i) => {
      const g = f.geometry as { type?: string; coordinates?: unknown } | null;
      if (!g || (g.type !== 'LineString' && g.type !== 'MultiLineString' && g.type !== 'Point')) return;
      const s = styleOf(f.properties, i);
      features.push({
        type: 'Feature',
        geometry: g as unknown as Geometry,
        properties: { stroke: s.stroke, width: s.width, opacity: s.opacity ?? 1, dashed: !!s.dash },
      });
    });
    this.pending.network = collection(features);
    if (fit) {
      const b = boundsOf(coordinateLists(network));
      this.pending.fit = [b.minX, b.minY, b.maxX, b.maxY];
    }
    this.pending.overlay = {};
    this.flush();
  }

  setOverlay(overlay: Overlay): void {
    this.pending.overlay = overlay;
    this.flush();
  }

  onClick(handler: (location: Position) => void): void {
    this.clickHandler = handler;
  }

  focus(locations: Position[]): void {
    if (locations.length === 0) return;
    const b = boundsOf([locations]);
    this.pending.fit = [b.minX, b.minY, b.maxX, b.maxY];
    this.flush();
  }

  private async create(): Promise<void> {
    const { style, glyphs } = await loadStyle();
    this.glyphs = glyphs;
    const map = new MapLibreMap({
      container: this.container,
      style,
      center: [0, 0],
      zoom: 1,
      attributionControl: false,
    });
    this.map = map;
    map.addControl(new NavigationControl({ showCompass: false }), 'top-right');
    map.addControl(new ScaleControl({ unit: 'metric' }), 'bottom-left');
    map.addControl(
      new AttributionControl({ compact: true, customAttribution: this.attribution }),
      'bottom-right',
    );
    map.on('load', () => {
      this.addLayers(map);
      this.loaded = true;
      this.flush();
    });
    map.on('click', (e) => {
      // A click on a level-change marker is for the marker, not a new waypoint.
      const hit = map.queryRenderedFeatures(e.point, { layers: ['transitions'] });
      if (hit.length > 0) {
        const index = Number(hit[0].properties?.index);
        this.transitionClicks[index]?.();
        return;
      }
      this.clickHandler?.([e.lngLat.lng, e.lngLat.lat]);
    });
  }

  private transitionClicks: ((() => void) | undefined)[] = [];

  private addLayers(map: MapLibreMap): void {
    for (const id of SOURCES) map.addSource(id, { type: 'geojson', data: collection([]) });
    const stroke = ['get', 'stroke'] as unknown as string;
    const width = ['get', 'width'] as unknown as number;
    map.addLayer({
      id: 'network',
      type: 'line',
      source: 'network',
      filter: ['all', ['!=', ['geometry-type'], 'Point'], ['!', ['get', 'dashed']]],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': stroke, 'line-width': width, 'line-opacity': ['get', 'opacity'] },
    });
    map.addLayer({
      id: 'network-dashed',
      type: 'line',
      source: 'network',
      filter: ['all', ['!=', ['geometry-type'], 'Point'], ['get', 'dashed']],
      paint: {
        'line-color': stroke,
        'line-width': width,
        'line-opacity': ['get', 'opacity'],
        'line-dasharray': [2, 2],
      },
    });
    map.addLayer({
      id: 'network-points',
      type: 'circle',
      source: 'network',
      filter: ['==', ['geometry-type'], 'Point'],
      paint: {
        'circle-radius': 6,
        'circle-color': stroke,
        'circle-stroke-color': '#fff',
        'circle-stroke-width': 2,
      },
    });
    // Routes get a white casing so they stay readable over any basemap.
    map.addLayer({
      id: 'routes-casing',
      type: 'line',
      source: 'routes',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#fff', 'line-width': ['+', width, 3], 'line-opacity': 0.9 },
    });
    map.addLayer({
      id: 'routes',
      type: 'line',
      source: 'routes',
      filter: ['!', ['get', 'dashed']],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': stroke, 'line-width': width },
    });
    map.addLayer({
      id: 'routes-dashed',
      type: 'line',
      source: 'routes',
      filter: ['get', 'dashed'],
      paint: { 'line-color': stroke, 'line-width': width, 'line-dasharray': [1.5, 1.5] },
    });
    map.addLayer({
      id: 'links',
      type: 'line',
      source: 'links',
      paint: { 'line-color': '#64748b', 'line-width': 1.2, 'line-dasharray': [2, 2] },
    });
    map.addLayer({
      id: 'candidates',
      type: 'circle',
      source: 'candidates',
      paint: {
        'circle-radius': ['case', ['get', 'selected'], 4.5, 3.5],
        'circle-color': ['case', ['get', 'selected'], '#f59e0b', '#fff'],
        'circle-stroke-color': '#f59e0b',
        'circle-stroke-width': 1.5,
      },
    });
    map.addLayer({
      id: 'waypoints-input',
      type: 'circle',
      source: 'waypoints',
      filter: ['==', ['get', 'role'], 'input'],
      paint: {
        'circle-radius': 5,
        'circle-color': 'rgba(255,255,255,0.6)',
        'circle-stroke-color': ['case', ['get', 'ok'], '#2563eb', '#dc2626'],
        'circle-stroke-width': 2,
      },
    });
    map.addLayer({
      id: 'waypoints',
      type: 'circle',
      source: 'waypoints',
      filter: ['==', ['get', 'role'], 'snapped'],
      paint: {
        'circle-radius': 7,
        'circle-color': ['case', ['get', 'ok'], '#2563eb', '#dc2626'],
        'circle-stroke-color': '#fff',
        'circle-stroke-width': 2,
      },
    });
    map.addLayer({
      id: 'transitions',
      type: 'circle',
      source: 'transitions',
      paint: {
        'circle-radius': 8,
        'circle-color': '#f59e0b',
        'circle-stroke-color': '#fff',
        'circle-stroke-width': 2,
      },
    });
    map.addLayer({
      id: 'dangles',
      type: 'circle',
      source: 'dangles',
      paint: {
        'circle-radius': 5,
        'circle-color': 'rgba(220,38,38,0.15)',
        'circle-stroke-color': '#dc2626',
        'circle-stroke-width': 2,
      },
    });
    if (this.glyphs) {
      map.addLayer({
        id: 'waypoint-labels',
        type: 'symbol',
        source: 'waypoints',
        filter: ['==', ['get', 'role'], 'snapped'],
        layout: {
          'text-field': ['get', 'label'],
          'text-font': FONT,
          'text-size': 12,
          'text-offset': [0, -1.5],
          'text-allow-overlap': true,
        },
        paint: { 'text-color': '#1e293b', 'text-halo-color': '#fff', 'text-halo-width': 1.5 },
      });
    }
  }

  private flush(): void {
    const map = this.map;
    if (!map || !this.loaded) return;
    const set = (id: SourceId, features: Feature[]) =>
      (map.getSource(id) as GeoJSONSource).setData(collection(features));
    const { network, fit, overlay } = this.pending;
    if (network) {
      (map.getSource('network') as GeoJSONSource).setData(network);
      this.pending.network = undefined;
    }
    if (fit) {
      map.fitBounds(
        [
          [fit[0], fit[1]],
          [fit[2], fit[3]],
        ],
        { padding: 40, duration: 0, maxZoom: 17 },
      );
      this.pending.fit = undefined;
    }
    if (!overlay) return;
    this.pending.overlay = undefined;
    set(
      'routes',
      (overlay.routes ?? [])
        .filter((r) => r.path.length > 1)
        .map((r) => line(r.path, { stroke: r.color, width: r.width ?? 4, dashed: !!r.dash })),
    );
    const waypoints: Feature[] = [];
    const links: Feature[] = [];
    for (const w of overlay.waypoints ?? []) {
      waypoints.push(point(w.input, { role: 'input', ok: w.ok }));
      if (w.location) {
        waypoints.push(point(w.location, { role: 'snapped', ok: w.ok, label: String(w.index + 1) }));
        links.push(line([w.input, w.location]));
      }
    }
    set('waypoints', waypoints);
    set('links', links);
    set(
      'candidates',
      (overlay.candidates ?? []).map((c) => point(c.location, { selected: c.selected })),
    );
    this.transitionClicks = (overlay.transitions ?? []).map((t) => t.onClick);
    set(
      'transitions',
      (overlay.transitions ?? []).map((t, index) => point(t.location, { index, label: t.label })),
    );
    set(
      'dangles',
      (overlay.dangles ?? []).map((p) => point(p)),
    );
  }
}
