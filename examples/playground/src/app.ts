import {
  LineFinder,
  toLevelFeatures,
  type CandidateInfo,
  type GroupKey,
  type NetworkCollection,
  type Position,
  type RouteFailure,
  type RouteOptions,
  type RouteResult,
  type RouteSuccess,
  type SnapCostMode,
  type SnapMode,
  type SnappedWaypoint,
} from '../../../src';
import { SvgView } from './lib/svg-view';
import type { CandidateMark, MapView, Overlay, RouteLine } from './lib/view';
import { scenarios, type Scenario, type ScenarioProfile } from './scenarios';

interface UiState {
  algorithm: 'astar' | 'dijkstra';
  mode: SnapMode;
  selection: 'nearest' | 'optimal';
  costMode: SnapCostMode;
  onFailure: 'fail' | 'skip' | 'straight';
  featureConstraint: boolean;
  /** Multi-level scenarios: the floor shown on the map, which new waypoints are placed on. */
  floor?: GroupKey;
  /** Scenarios with profiles: the one whose graph is built. */
  profile?: string;
}

const state: UiState = {
  algorithm: 'astar',
  mode: 'edge',
  selection: 'nearest',
  costMode: 'ends',
  onFailure: 'fail',
  featureConstraint: false,
};

let scenario: Scenario<unknown> = scenarios[0];
let network: NetworkCollection<unknown> | null = null;
let finder: LineFinder<unknown> | null = null;
let waypoints: Position[] = [];
let waypointFeatureIds: (string[] | undefined)[] = [];
let waypointLevels: (GroupKey | undefined)[] = [];
/** The overlay last drawn, so that the diagnostics can add their markers to it. */
let overlay: Overlay = {};

const $ = <T extends Element>(id: string): T => document.getElementById(id) as unknown as T;

// --------------------------------------------------------------------------------------------- views

const svgView = new SvgView($<SVGSVGElement>('map'));
svgView.onClick(addWaypoint);
let mapView: Promise<MapView> | null = null;

/** MapLibre (and its styles) load only when a map scenario is opened. */
function loadMapView(): Promise<MapView> {
  mapView ??= import('./lib/maplibre-view').then(({ MapLibreView }) => {
    const view = new MapLibreView(
      $<HTMLElement>('mapgl'),
      '路网数据 © <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> 贡献者（ODbL）',
    );
    view.onClick(addWaypoint);
    return view;
  });
  return mapView;
}

let view: MapView = svgView;

async function useView(kind: 'svg' | 'map'): Promise<void> {
  const next = kind === 'map' ? await loadMapView() : svgView;
  if (next !== view) view.hide();
  view = next;
  view.show();
}

// ---------------------------------------------------------------------------------------------- tabs

function renderTabs(): void {
  const tabs = $<HTMLElement>('tabs');
  tabs.innerHTML = '';
  for (const s of scenarios) {
    const btn = document.createElement('button');
    btn.textContent = s.title;
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', String(s.id === scenario.id));
    btn.addEventListener('click', () => void loadScenario(s));
    tabs.appendChild(btn);
  }
}

// --------------------------------------------------------------------------------------------- floors

function renderFloors(): void {
  const el = $<HTMLElement>('floors');
  el.innerHTML = '';
  if (!scenario.levels) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  // Top floor first, the way a lift panel reads.
  for (const floor of [...scenario.levels.floors].reverse()) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = floor.label;
    btn.setAttribute('aria-pressed', String(floor.key === state.floor));
    btn.addEventListener('click', () => {
      state.floor = floor.key;
      renderFloors();
      drawNetwork(false);
      void recompute();
    });
    el.appendChild(btn);
  }
  const hint = document.createElement('span');
  hint.className = 'hint';
  hint.textContent = '当前楼层 · 新途经点落在这一层（snap.group）';
  el.appendChild(hint);
}

// -------------------------------------------------------------------------------------------- options

function currentProfile(): ScenarioProfile<unknown> | undefined {
  return scenario.profiles?.find((p) => p.id === state.profile) ?? scenario.profiles?.[0];
}

function renderOptions(): void {
  const el = $<HTMLElement>('options');
  const f = scenario.features;
  const parts: string[] = [];
  if (scenario.profiles) {
    parts.push(
      optionSelect(
        'profile',
        '出行方式 · 一个剖面一张图',
        currentProfile()!.id,
        scenario.profiles.map((p) => [p.id, p.label]),
      ),
    );
  }
  parts.push(
    optionSelect('algorithm', '引擎 · algorithm', state.algorithm, [
      ['astar', 'A*'],
      ['dijkstra', 'Dijkstra'],
    ]),
  );
  parts.push(
    optionSelect('mode', '吸附模式 · snap.mode', state.mode, [
      ['edge', 'edge（默认，线段任意点）'],
      ['vertex', 'vertex（最近顶点）'],
      ['node', 'node（最近路口）'],
      ['exact', 'exact（必须是顶点）'],
    ]),
  );
  if (!f.compareSelection) {
    parts.push(
      optionSelect('selection', '择优 · snap.selection', state.selection, [
        ['nearest', 'nearest（默认，最近点）'],
        ['optimal', 'optimal（全程代价择优）'],
      ]),
    );
  }
  if (f.compareSelection || state.selection === 'optimal') {
    parts.push(
      optionSelect('costMode', '吸附代价 · snap.costMode', state.costMode, [
        ['none', 'none（免费，可能"抄近路"）'],
        ['ends', 'ends（默认展示，仅首尾计）'],
        ['arrive-depart', 'arrive-depart（途经点也计）'],
      ]),
    );
  }
  if (f.failurePolicy) {
    parts.push(
      optionSelect('onFailure', '失败策略 · onFailure', state.onFailure, [
        ['fail', 'fail（默认，整体失败）'],
        ['skip', 'skip（跳过，锚点不动）'],
        ['straight', 'straight（补一段直线）'],
      ]),
    );
  }
  if (f.featureConstraint) {
    parts.push(
      `<label class="checkbox"><input type="checkbox" id="featureConstraint" ${state.featureConstraint ? 'checked' : ''}/>
        仅使用点击时最近的那条通道 · snap.featureIds（硬约束，不是偏好）</label>`,
    );
  }
  el.innerHTML = parts.join('');

  bind<HTMLSelectElement>('profile', (v) => {
    state.profile = v;
    buildFinder();
    drawNetwork(false);
    void recompute();
  });
  bind<HTMLSelectElement>('algorithm', (v) => (state.algorithm = v as UiState['algorithm']));
  bind<HTMLSelectElement>('mode', (v) => (state.mode = v as SnapMode));
  bind<HTMLSelectElement>('selection', (v) => {
    state.selection = v as UiState['selection'];
    renderOptions();
    void recompute();
  });
  bind<HTMLSelectElement>('costMode', (v) => (state.costMode = v as SnapCostMode));
  bind<HTMLSelectElement>('onFailure', (v) => (state.onFailure = v as UiState['onFailure']));
  const constraint = document.getElementById('featureConstraint') as HTMLInputElement | null;
  constraint?.addEventListener('change', () => {
    state.featureConstraint = constraint.checked;
    if (!state.featureConstraint) waypointFeatureIds = waypointFeatureIds.map(() => undefined);
    void recompute();
  });

  for (const id of ['algorithm', 'mode', 'costMode', 'onFailure'] as const) {
    document.getElementById(id)?.addEventListener('change', () => void recompute());
  }
}

function optionSelect(id: string, label: string, value: string, options: [string, string][]): string {
  const opts = options
    .map(([v, l]) => `<option value="${v}" ${v === value ? 'selected' : ''}>${l}</option>`)
    .join('');
  return `<label>${label}<select id="${id}">${opts}</select></label>`;
}

function bind<T extends HTMLSelectElement | HTMLInputElement>(
  id: string,
  set: (value: string) => void,
): void {
  const el = document.getElementById(id) as T | null;
  el?.addEventListener('change', () => set(el.value));
}

function renderPresets(): void {
  const el = $<HTMLElement>('presets');
  el.innerHTML = '';
  for (const preset of scenario.presets) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = preset.label;
    btn.addEventListener('click', () => {
      waypoints = preset.waypoints.map((p) => [...p]);
      waypointFeatureIds = waypoints.map(() => undefined);
      waypointLevels = preset.levels
        ? [...preset.levels]
        : waypoints.map(() => (scenario.levels ? state.floor : undefined));
      if (preset.levels?.length) {
        state.floor = preset.levels[preset.levels.length - 1];
        renderFloors();
        drawNetwork(false);
      }
      void recompute().then(() =>
        // On a map, zoom to the preset's route (clicks by hand keep the view where it is).
        view.focus?.([...waypoints, ...(overlay.routes ?? []).flatMap((r) => r.path)]),
      );
    });
    el.appendChild(btn);
  }
}

// ------------------------------------------------------------------------------------------- scenario

let loading = 0;

async function loadScenario(next: Scenario<unknown>): Promise<void> {
  const ticket = ++loading;
  scenario = next;
  network = null;
  finder = null;
  waypoints = [];
  waypointFeatureIds = [];
  waypointLevels = [];
  state.floor = next.levels ? next.levels.floors[0].key : undefined;
  state.profile = next.profiles?.[0]?.id;
  state.selection = next.defaultRouteOptions.snap?.selection === 'optimal' ? 'optimal' : 'nearest';
  state.costMode = (next.defaultRouteOptions.snap?.costMode as SnapCostMode) ?? 'ends';
  state.onFailure = 'fail';
  state.featureConstraint = false;
  renderTabs();
  $<HTMLElement>('blurb').textContent = next.blurb;
  $<HTMLElement>('build-info').textContent = '';
  $<HTMLElement>('summary').innerHTML = '<p class="hint">加载中 · loading…</p>';
  $<HTMLElement>('extra').innerHTML = '';
  svgView.setLatScale(next.latScale ?? 1);

  const [loaded] = await Promise.all([
    typeof next.network === 'function' ? next.network() : Promise.resolve(next.network),
    useView(next.view ?? 'svg'),
  ]);
  if (ticket !== loading) return; // another tab was picked meanwhile
  network = loaded;
  buildFinder();

  renderFloors();
  renderOptions();
  renderPresets();
  drawNetwork(true);
  renderSummaryHint();
  if (scenario.features.diagnostics) renderDiagnosticsButton();
}

/** Builds the graph for the current scenario and profile, and says how long that took. */
function buildFinder(): void {
  if (!network) return;
  const profile = currentProfile();
  const t0 = performance.now();
  finder = new LineFinder(network, profile?.graphOptions ?? scenario.graphOptions);
  const ms = performance.now() - t0;
  const s = finder.graph.stats;
  const fmt = (n: number) => n.toLocaleString('en-US');
  $<HTMLElement>('build-info').innerHTML =
    `建图 <b>${ms.toFixed(ms < 10 ? 1 : 0)} ms</b> · ${fmt(s.coordinates)} 坐标 · ${fmt(s.nodes)} 节点 · ` +
    `${fmt(s.edges)} 有向边 · ${fmt(s.components)} 个连通分量`;
}

function styleOf(props: unknown, index: number) {
  const byProfile = currentProfile()?.styleOf;
  return (byProfile ?? scenario.styleOf)(props, index, { level: state.floor });
}

function drawNetwork(fit: boolean): void {
  if (!network) return;
  view.setNetwork(network, styleOf, fit);
  overlay = {};
}

function renderSummaryHint(): void {
  $<HTMLElement>('summary').innerHTML = `<p class="hint">点击地图放置途经点（至少 2 个）。</p>`;
  $<HTMLElement>('waypoints-table').innerHTML = '';
  $<HTMLElement>('measures').innerHTML = '';
  $<HTMLElement>('json-output').textContent = '';
}

function renderDiagnosticsButton(): void {
  const el = $<HTMLElement>('extra');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = '运行诊断 · graph.diagnostics()';
  btn.style.marginTop = '10px';
  btn.addEventListener('click', () => {
    if (!finder) return;
    const diag = finder.graph.diagnostics({ limit: 500 });
    overlay = { ...overlay, dangles: diag.dangles.items.map((d) => d.location) };
    view.setOverlay(overlay);
    el.querySelector('.diag-result')?.remove();
    const box = document.createElement('div');
    box.className = 'diag-result';
    box.innerHTML = `<p class="hint">悬挂端点 ${diag.dangles.total}（图中已标红，最多画 500 个，截断 ${diag.dangles.truncated}）·
      连通分量 ${diag.components.total} · 非法坐标 ${diag.invalidCoordinates?.total ?? 0} ·
      共线重叠 ${diag.overlaps.total}</p>`;
    el.appendChild(box);
  });
  el.appendChild(btn);
}

// -------------------------------------------------------------------------------------------- clicking

function addWaypoint(data: Position): void {
  if (!finder) return;
  waypoints.push(data);
  waypointFeatureIds.push(undefined);
  waypointLevels.push(scenario.levels ? state.floor : undefined);
  if (state.featureConstraint) {
    const candidates = finder.candidates(data, { candidates: 1 });
    const id = candidates[0]?.featureId;
    if (id !== undefined) waypointFeatureIds[waypointFeatureIds.length - 1] = [String(id)];
  }
  void recompute();
}

$('clear').addEventListener('click', () => {
  waypoints = [];
  waypointFeatureIds = [];
  waypointLevels = [];
  void recompute();
});

$('undo').addEventListener('click', () => {
  waypoints.pop();
  waypointFeatureIds.pop();
  waypointLevels.pop();
  void recompute();
});

// ------------------------------------------------------------------------------------------- compute

interface WaypointSnap {
  featureIds?: string[];
  group?: GroupKey;
}

function waypointInputs(
  featureIds: (string[] | undefined)[],
): (Position | { coordinates: Position; snap: WaypointSnap })[] {
  return waypoints.map((p, i) => {
    const snap: WaypointSnap = {};
    if (featureIds[i]) snap.featureIds = featureIds[i];
    if (waypointLevels[i] !== undefined) snap.group = waypointLevels[i];
    return Object.keys(snap).length > 0 ? { coordinates: p, snap } : p;
  });
}

function baseOptions(): RouteOptions {
  return {
    ...scenario.defaultRouteOptions,
    algorithm: state.algorithm,
    snap: { ...scenario.defaultRouteOptions.snap, mode: state.mode },
  };
}

async function recompute(): Promise<void> {
  if (!finder) return;
  const next: Overlay = {};
  if (waypoints.length < 2) {
    next.waypoints = waypoints.map((p, i) => ({ input: p, index: i, ok: true }));
    if (waypoints.length > 0) next.candidates = candidateHint(waypoints[waypoints.length - 1]);
    overlay = next;
    view.setOverlay(next);
    renderSummaryHint();
    return;
  }

  const inputs = waypointInputs(waypointFeatureIds);
  const opts = baseOptions();

  if (scenario.features.compareSelection) {
    const nearest = finder.route(inputs, {
      ...opts,
      snap: { ...opts.snap, selection: 'nearest', costMode: state.costMode },
    });
    const optimal = finder.route(inputs, {
      ...opts,
      snap: { ...opts.snap, selection: 'optimal', costMode: state.costMode, candidates: 4 },
    });
    next.routes = [
      ...(nearest.ok
        ? [{ path: nearest.path, color: '#2563eb', width: 6, dash: '3,5', label: 'nearest' }]
        : []),
      ...(optimal.ok ? [{ path: optimal.path, color: '#f59e0b', width: 4, label: 'optimal' }] : []),
    ];
    renderCompareSummary(nearest, optimal);
  } else {
    const result = finder.route(inputs, {
      ...opts,
      snap: { ...opts.snap, selection: state.selection, costMode: state.costMode },
      onFailure: scenario.features.failurePolicy ? state.onFailure : opts.onFailure,
    });
    if (result.ok) {
      if (scenario.features.levels) Object.assign(next, levelRoute(result));
      else next.routes = [{ path: result.path, color: '#2563eb', width: 5 }];
    }
    renderSummary(result);
  }

  const featureConstraintOn = state.featureConstraint;
  next.waypoints = waypoints.map((p, i) => {
    const used = featureConstraintOn && waypointFeatureIds[i];
    const c = finder!.candidates(p, {
      candidates: 1,
      mode: state.mode,
      ...(used ? { featureIds: used } : {}),
      ...(waypointLevels[i] !== undefined ? { group: waypointLevels[i] } : {}),
    });
    return { input: p, location: c[0]?.location, index: i, ok: c.length > 0 };
  });
  next.candidates = candidateHint(waypoints[waypoints.length - 1]);
  overlay = next;
  view.setOverlay(next);
}

/**
 * The route the way an indoor map draws it: the current floor solid, the other floors ghosted, every passage
 * between floors dashed, and a clickable marker where the route changes level.
 */
function levelRoute(result: RouteSuccess<unknown>): Overlay {
  const { features } = toLevelFeatures(result);
  const routes: RouteLine[] = [];
  for (const f of features) {
    if (f.geometry.type !== 'LineString') continue;
    const path = f.geometry.coordinates;
    if (f.properties.kind === 'connector') {
      routes.push({ path, color: '#f59e0b', width: 6, dash: '5,4' });
    } else {
      const active = f.properties.level === state.floor;
      routes.push({ path, color: active ? '#2563eb' : '#bfdbfe', width: active ? 5 : 3 });
    }
  }
  return {
    routes,
    transitions: features
      .filter((f) => f.properties.kind === 'transition' && f.geometry.type === 'Point')
      .map((f) => ({
        location: f.geometry.coordinates as Position,
        label: `${String(f.properties.fromLevel ?? '?')} → ${String(f.properties.toLevel ?? '?')}`,
        onClick: () => {
          if (f.properties.toLevel === undefined) return;
          state.floor = f.properties.toLevel;
          renderFloors();
          drawNetwork(false);
          void recompute();
        },
      })),
  };
}

function renderTransitionTable(result: RouteResult<unknown>): void {
  const el = $<HTMLElement>('measures');
  if (!scenario.features.levels || !result.ok) return;
  const rows = result.legs
    .flatMap((leg, legIndex) => (leg.transitions ?? []).map((t) => ({ legIndex, t })))
    .map(
      ({ legIndex, t }) =>
        `<tr><td>#${legIndex}</td><td>${String(t.fromLevel ?? '—')} → ${String(t.toLevel ?? '—')}</td>` +
        `<td>${t.levelChange > 0 ? '+' : ''}${t.levelChange}</td><td>${t.weight.toFixed(1)}</td>` +
        `<td>${t.featureIndices.map((i) => String(finder?.graph.featureId(i) ?? i)).join(', ')}</td></tr>`,
    )
    .join('');
  el.innerHTML = rows
    ? `<p class="hint">换层 · transitions（点地图上的橙色方块可跳层）</p>` +
      `<table class="wp"><thead><tr><th>leg</th><th>from → to</th><th>Δ</th><th>weight</th><th>features</th></tr></thead><tbody>${rows}</tbody></table>`
    : '<p class="hint">这条路线没有换层 · no level change</p>';
}

function summaryHeader(ok: boolean, reasonLine: string): string {
  return `<p class="status ${ok ? 'ok' : 'fail'}">${ok ? '✓ 成功 · ok' : '✗ ' + reasonLine}</p>`;
}

function renderSummary(result: RouteResult<unknown>): void {
  const summary = $<HTMLElement>('summary');
  if (!result.ok) {
    const r = result as RouteFailure;
    summary.innerHTML =
      summaryHeader(false, `${r.reason}${r.detail ? ' / ' + r.detail : ''}`) +
      `<p class="hint">${r.message}</p>`;
    $<HTMLElement>('waypoints-table').innerHTML = '';
    $<HTMLElement>('json-output').textContent = JSON.stringify(r, null, 2);
    return;
  }
  const unit = currentProfile()?.unit;
  summary.innerHTML =
    summaryHeader(true, '') +
    dl([
      [`weight${unit ? `（${unit}）` : ''}`, result.weight.toFixed(2)],
      ['distance', result.distance.toFixed(2)],
      ['networkWeight', result.networkWeight.toFixed(2)],
      ['snapWeight', result.snapWeight.toFixed(2)],
      ['algorithm', result.algorithm],
      ['settled', String(result.legs.reduce((n, leg) => n + leg.settled, 0))],
      ['complete', String(result.complete)],
      ['skipped', String(result.skipped.length)],
      ...(result.levelChanges !== undefined
        ? ([['levelChanges', String(result.levelChanges)]] as [string, string][])
        : []),
      ...(result.verticalDistance !== undefined
        ? ([['verticalDistance', result.verticalDistance.toFixed(2)]] as [string, string][])
        : []),
    ]);
  $<HTMLElement>('waypoints-table').innerHTML = waypointsTable(result.waypoints);
  renderMeasures(result);
  renderTransitionTable(result);
  $<HTMLElement>('json-output').textContent = JSON.stringify(result, null, 2);
}

function renderCompareSummary(nearest: RouteResult<unknown>, optimal: RouteResult<unknown>): void {
  const summary = $<HTMLElement>('summary');
  const gain =
    nearest.ok && optimal.ok && nearest.weight > 0
      ? ((nearest.weight - optimal.weight) / nearest.weight) * 100
      : null;
  summary.innerHTML =
    `<div class="legend"><span><i style="background:#2563eb"></i>nearest</span><span><i style="background:#f59e0b"></i>optimal</span></div>` +
    dl([
      ['nearest.weight', nearest.ok ? nearest.weight.toFixed(2) : nearest.reason],
      ['optimal.weight', optimal.ok ? optimal.weight.toFixed(2) : optimal.reason],
      ['优化收益 · gain', gain === null ? '—' : `${gain.toFixed(1)}%`],
    ]);
  $<HTMLElement>('waypoints-table').innerHTML = optimal.ok ? waypointsTable(optimal.waypoints) : '';
  renderMeasures(optimal);
  $<HTMLElement>('json-output').textContent = JSON.stringify({ nearest, optimal }, null, 2);
}

function dl(rows: [string, string][]): string {
  return `<dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`;
}

function waypointsTable(waypoints: readonly SnappedWaypoint[]): string {
  const rows = waypoints
    .map(
      (w, i) => `<tr>
      <td>#${i}</td>
      <td>${w.featureId ?? '—'}</td>
      <td>${typeof w.distance === 'number' ? w.distance.toFixed(2) : '—'}</td>
      <td>${w.candidateRank ?? '—'}</td>
      <td>${w.relocated ? '<span class="badge relocated">relocated</span>' : ''}</td>
    </tr>`,
    )
    .join('');
  return `<table class="wp"><thead><tr><th>#</th><th>feature</th><th>dist</th><th>rank</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderMeasures(result: RouteResult<unknown>): void {
  const el = $<HTMLElement>('measures');
  if (!scenario.features.measures || !result.ok) {
    el.innerHTML = '';
    return;
  }
  const rows = result.legs
    .flatMap((leg) => leg.sections)
    .map(
      (s) =>
        `<tr><td>${s.id ?? s.featureIndex}</td><td>${s.fromMeasure.toFixed(1)}</td><td>${s.toMeasure.toFixed(1)}</td><td>${s.distance.toFixed(1)}</td></tr>`,
    )
    .join('');
  el.innerHTML = rows
    ? `<p class="hint">sections（R5 线性参照）</p><table class="wp"><thead><tr><th>feature</th><th>from</th><th>to</th><th>len</th></tr></thead><tbody>${rows}</tbody></table>`
    : '';
}

/** Every candidate location the most recently placed waypoint could have used, the nearest highlighted. */
function candidateHint(point: Position): CandidateMark[] {
  if (!finder) return [];
  const list: CandidateInfo[] = finder.candidates(point, {
    candidates: 6,
    mode: state.mode,
    ...(scenario.levels && state.floor !== undefined ? { group: state.floor } : {}),
  });
  return list.map((c, i) => ({ location: c.location, selected: i === 0 }));
}

// --------------------------------------------------------------------------------------------- start

void loadScenario(scenarios[0]);
