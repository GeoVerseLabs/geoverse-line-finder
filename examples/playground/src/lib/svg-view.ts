import type { NetworkCollection, Position } from '../../../../src';
import { boundsOf, fitProjector, inverseFitProjector, type Projector } from './project';
import {
  clearSvg,
  renderCandidates,
  renderDangles,
  renderNetwork,
  renderRoutes,
  renderTransitions,
  renderWaypoints,
  svgEl,
} from './svg';
import { coordinateLists, type FeatureStyle, type MapView, type Overlay } from './view';

const VIEW_W = 900;
const VIEW_H = 620;
const PADDING = 30;

/**
 * The plain SVG canvas: no map library, no basemap. Used for planar data (a warehouse, a floor plan, a
 * synthetic grid), where a basemap would only mislead. The network lives in one group and the overlay in
 * another, so a recompute redraws only the overlay.
 */
export class SvgView implements MapView {
  private projector: Projector | null = null;
  private toData: ((svg: [number, number]) => Position) | null = null;
  private readonly networkLayer: SVGGElement;
  private readonly overlayLayer: SVGGElement;

  /** `latScale` compresses longitudes for geographic data (`cos` of the reference latitude); 1 for planar. */
  constructor(
    private readonly svg: SVGSVGElement,
    private latScale = 1,
  ) {
    clearSvg(svg);
    this.networkLayer = svg.appendChild(svgEl('g', { class: 'network-layer' }));
    this.overlayLayer = svg.appendChild(svgEl('g', { class: 'overlay-layer' }));
  }

  setLatScale(latScale: number): void {
    this.latScale = latScale;
  }

  show(): void {
    this.svg.style.display = '';
  }

  hide(): void {
    this.svg.style.display = 'none';
  }

  setNetwork(
    network: NetworkCollection<unknown>,
    styleOf: (props: unknown, featureIndex: number) => FeatureStyle,
    fit: boolean,
  ): void {
    if (fit || !this.projector) {
      const bounds = boundsOf(coordinateLists(network));
      this.projector = fitProjector(bounds, VIEW_W, VIEW_H, PADDING, this.latScale);
      this.toData = inverseFitProjector(bounds, VIEW_W, VIEW_H, PADDING, this.latScale);
      this.svg.setAttribute('viewBox', this.projector.viewBox);
    }
    clearSvg(this.networkLayer);
    renderNetwork(this.networkLayer, network, this.projector, styleOf);
    this.setOverlay({});
  }

  setOverlay(overlay: Overlay): void {
    const layer = this.overlayLayer;
    clearSvg(layer);
    const p = this.projector;
    if (!p) return;
    if (overlay.routes?.length) renderRoutes(layer, overlay.routes, p);
    if (overlay.transitions?.length) renderTransitions(layer, overlay.transitions, p);
    if (overlay.waypoints?.length) renderWaypoints(layer, overlay.waypoints, p);
    if (overlay.candidates?.length) renderCandidates(layer, overlay.candidates, p);
    if (overlay.dangles?.length) renderDangles(layer, overlay.dangles, p);
  }

  onClick(handler: (location: Position) => void): void {
    this.svg.addEventListener('click', (ev) => {
      if (!this.toData) return;
      const pt = this.svg.createSVGPoint();
      pt.x = ev.clientX;
      pt.y = ev.clientY;
      const ctm = this.svg.getScreenCTM();
      if (!ctm) return;
      const local = pt.matrixTransform(ctm.inverse());
      handler(this.toData([local.x, local.y]));
    });
  }
}
