/**
 * The OSM travel-time weight from geojson-path-finder's own test-suite (`test/osm-weight.js`), with turf's
 * distance inlined so both libraries can be fed the *same* function. Semantics are kept verbatim,
 * including its quirks: any truthy `oneway` other than "no" is forward-only (even "-1"), and highway types
 * missing from the speed table yield NaN, which both libraries treat as impassable.
 */
const RAD = Math.PI / 180;
const TURF_EARTH_RADIUS_M = 6371008.8;

function turfDistanceMeters(a: number[], b: number[]): number {
  const dLat = (b[1] - a[1]) * RAD;
  const dLon = (b[0] - a[0]) * RAD;
  const lat1 = a[1] * RAD;
  const lat2 = b[1] * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h)) * TURF_EARTH_RADIUS_M;
}

export const highwaySpeeds: Record<string, number> = {
  motorway: 110,
  trunk: 90,
  primary: 80,
  secondary: 70,
  tertiary: 50,
  unclassified: 50,
  road: 50,
  residential: 30,
  service: 30,
  living_street: 20,
};

export interface OsmProps {
  highway: string;
  maxspeed?: string | number;
  oneway?: string;
  junction?: string;
}

export function osmWeight(a: number[], b: number[], props: OsmProps): { forward: number; backward: number } {
  const d = turfDistanceMeters(a, b);
  let factor = 0.9;
  let type = props.highway;
  let forwardSpeed: number | null;
  let backwardSpeed: number | null;

  if (props.maxspeed) {
    forwardSpeed = backwardSpeed = Number(props.maxspeed);
  } else {
    const linkIndex = type.indexOf('_link');
    if (linkIndex >= 0) {
      type = type.substring(0, linkIndex);
      factor *= 0.7;
    }
    forwardSpeed = backwardSpeed = highwaySpeeds[type] * factor;
  }

  if ((props.oneway && props.oneway !== 'no') || (props.junction && props.junction === 'roundabout')) {
    backwardSpeed = null;
  }

  return {
    forward: (forwardSpeed && d / (forwardSpeed / 3.6)) as number,
    backward: (backwardSpeed && d / (backwardSpeed / 3.6)) as number,
  };
}
