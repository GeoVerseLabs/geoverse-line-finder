import {
  LineFinder,
  type CandidateInfo,
  type NetworkCollection,
  type Position,
  type RouteFailure,
  type RouteOptions,
  type RouteResult,
  type SnapCostMode,
  type SnapMode,
  type SnappedWaypoint,
} from '../../../src';
import { boundsOf, fitProjector, inverseFitProjector, type Projector } from './lib/project';
import {
  clearSvg,
  renderCandidates,
  renderDangles,
  renderNetwork,
  renderRoutes,
  renderWaypoints,
} from './lib/svg';
import { scenarios, type Scenario } from './scenarios';

const VIEW_W = 900;
const VIEW_H = 620;
const PADDING = 30;

interface UiState {
  algorithm: 'astar' | 'dijkstra';
  mode: SnapMode;
  selection: 'nearest' | 'optimal';
  costMode: SnapCostMode;
  onFailure: 'fail' | 'skip' | 'straight';
  featureConstraint: boolean;
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
let projector: Projector | null = null;
let toData: ((svg: [number, number]) => Position) | null = null;
let waypoints: Position[] = [];
let waypointFeatureIds: (string[] | undefined)[] = [];

const $ = <T extends Element>(id: string): T => document.getElementById(id) as unknown as T;
const svg = $<SVGSVGElement>('map');

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

// -------------------------------------------------------------------------------------------- options

function renderOptions(): void {
  const el = $<HTMLElement>('options');
  const f = scenario.features;
  const parts: string[] = [];
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
      void recompute();
    });
    el.appendChild(btn);
  }
}

// ------------------------------------------------------------------------------------------- scenario

async function loadScenario(next: Scenario<unknown>): Promise<void> {
  scenario = next;
  waypoints = [];
  waypointFeatureIds = [];
  state.selection = next.defaultRouteOptions.snap?.selection === 'optimal' ? 'optimal' : 'nearest';
  state.costMode = (next.defaultRouteOptions.snap?.costMode as SnapCostMode) ?? 'ends';
  state.onFailure = 'fail';
  state.featureConstraint = false;
  renderTabs();
  $<HTMLElement>('blurb').textContent = next.blurb;
  $<HTMLElement>('summary').innerHTML = '<p class="hint">加载中 · loading…</p>';
  clearSvg(svg);

  network = typeof next.network === 'function' ? await next.network() : next.network;
  finder = new LineFinder(network, next.graphOptions);

  const coordLists = network.features
    .map((f) => f.geometry as { type?: string; coordinates?: unknown } | null)
    .flatMap((g) =>
      g?.type === 'LineString'
        ? [g.coordinates as Position[]]
        : g?.type === 'MultiLineString'
          ? (g.coordinates as Position[][])
          : [],
    );
  const bounds = boundsOf(coordLists);
  const latScale = next.latScale ?? 1;
  projector = fitProjector(bounds, VIEW_W, VIEW_H, PADDING, latScale);
  toData = inverseFitProjector(bounds, VIEW_W, VIEW_H, PADDING, latScale);
  svg.setAttribute('viewBox', projector.viewBox);

  renderOptions();
  renderPresets();
  renderNetworkOnly();
  renderSummaryHint();
  $<HTMLElement>('extra').innerHTML = '';
  if (scenario.features.diagnostics) renderDiagnosticsButton();
}

function renderNetworkOnly(): void {
  if (!network || !projector) return;
  clearSvg(svg);
  renderNetwork(svg, network, projector, scenario.styleOf);
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
    const diag = finder.graph.diagnostics({ limit: 200 });
    if (projector)
      renderDangles(
        svg,
        diag.dangles.items.map((d) => d.location),
        projector,
      );
    el.querySelector('.diag-result')?.remove();
    const box = document.createElement('div');
    box.className = 'diag-result';
    box.innerHTML = `<p class="hint">悬挂端点 ${diag.dangles.total}（图中已标红 ×，截断 ${diag.dangles.truncated}）·
      连通分量 ${diag.components.total} · 非法坐标 ${diag.invalidCoordinates?.total ?? 0} ·
      共线重叠 ${diag.overlaps.total}</p>`;
    el.appendChild(box);
  });
  el.appendChild(btn);
}

// -------------------------------------------------------------------------------------------- clicking

svg.addEventListener('click', (ev) => {
  if (!toData) return;
  const pt = svg.createSVGPoint();
  pt.x = ev.clientX;
  pt.y = ev.clientY;
  const ctm = svg.getScreenCTM();
  if (!ctm) return;
  const local = pt.matrixTransform(ctm.inverse());
  const data = toData([local.x, local.y]);
  waypoints.push(data);
  waypointFeatureIds.push(undefined);
  if (state.featureConstraint && finder) {
    const candidates = finder.candidates(data, { candidates: 1 });
    const id = candidates[0]?.featureId;
    if (id !== undefined) waypointFeatureIds[waypointFeatureIds.length - 1] = [String(id)];
  }
  void recompute();
});

$('clear').addEventListener('click', () => {
  waypoints = [];
  waypointFeatureIds = [];
  void recompute();
});

$('undo').addEventListener('click', () => {
  waypoints.pop();
  waypointFeatureIds.pop();
  void recompute();
});

// ------------------------------------------------------------------------------------------- compute

function waypointInputs(
  featureIds: (string[] | undefined)[],
): (Position | { coordinates: Position; snap?: { featureIds: string[] } })[] {
  return waypoints.map((p, i) => {
    const ids = featureIds[i];
    return ids ? { coordinates: p, snap: { featureIds: ids } } : p;
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
  if (!finder || !projector) return;
  renderNetworkOnly();
  if (waypoints.length < 2) {
    renderWaypoints(
      svg,
      waypoints.map((p, i) => ({ input: p, index: i, ok: true })),
      projector,
    );
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
    renderRoutes(
      svg,
      [
        ...(nearest.ok
          ? [{ path: nearest.path, color: '#2563eb', width: 6, dash: '3,5', label: 'nearest' }]
          : []),
        ...(optimal.ok ? [{ path: optimal.path, color: '#f59e0b', width: 4, label: 'optimal' }] : []),
      ],
      projector,
    );
    renderCompareSummary(nearest, optimal);
  } else {
    const result = finder.route(inputs, {
      ...opts,
      snap: { ...opts.snap, selection: state.selection, costMode: state.costMode },
      onFailure: scenario.features.failurePolicy ? state.onFailure : opts.onFailure,
    });
    if (result.ok) {
      renderRoutes(svg, [{ path: result.path, color: '#2563eb', width: 5 }], projector);
    }
    renderSummary(result);
  }

  const featureConstraintOn = state.featureConstraint;
  const marks = waypoints.map((p, i) => {
    const used = featureConstraintOn && waypointFeatureIds[i];
    const c = finder!.candidates(p, {
      candidates: 1,
      mode: state.mode,
      ...(used ? { featureIds: used } : {}),
    });
    return { input: p, location: c[0]?.location, index: i, ok: c.length > 0 };
  });
  renderWaypoints(svg, marks, projector);

  if (waypoints.length > 0) renderCandidateHint(waypoints[waypoints.length - 1]);
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
  summary.innerHTML =
    summaryHeader(true, '') +
    dl([
      ['weight', result.weight.toFixed(2)],
      ['distance', result.distance.toFixed(2)],
      ['networkWeight', result.networkWeight.toFixed(2)],
      ['snapWeight', result.snapWeight.toFixed(2)],
      ['algorithm', result.algorithm],
      ['complete', String(result.complete)],
      ['skipped', String(result.skipped.length)],
    ]);
  $<HTMLElement>('waypoints-table').innerHTML = waypointsTable(result.waypoints);
  renderMeasures(result);
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

// --------------------------------------------------------------------------------------------- start

/** Shows every candidate location the most recently placed waypoint could have used, nearest highlighted. */
function renderCandidateHint(point: Position): void {
  if (!finder || !projector) return;
  const list: CandidateInfo[] = finder.candidates(point, { candidates: 6, mode: state.mode });
  renderCandidates(
    svg,
    list.map((c, i) => ({ location: c.location, selected: i === 0 })),
    projector,
  );
}

void loadScenario(scenarios[0]);
window.addEventListener('resize', () => void recompute());
