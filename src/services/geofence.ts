/** Geofence rules for GPS check-in. */

const EARTH_RADIUS_METERS = 6_371_000;

/** A phone reporting a fix less precise than this is asked to try again. */
export const MAX_ACCURACY_METERS = 150;
/** At most this much of the phone's reported imprecision is forgiven at the edge of the geofence. */
export const ACCURACY_ALLOWANCE_METERS = 50;

export type Point = { latitude: number; longitude: number };

/** Great-circle (haversine) distance in metres. */
export const distanceMeters = (a: Point, b: Point) => {
  const rad = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = rad(b.latitude - a.latitude);
  const dLon = rad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
};

export type GeofenceCheck =
  | { ok: true; distance: number }
  | { ok: false; reason: "imprecise" | "outside"; distance: number };

export const checkGeofence = (input: { at: Point; accuracy: number; branch: Point; radius: number }): GeofenceCheck => {
  const distance = Math.round(distanceMeters(input.at, input.branch));
  if (input.accuracy > MAX_ACCURACY_METERS) return { ok: false, reason: "imprecise", distance };
  const allowance = Math.min(Math.max(input.accuracy, 0), ACCURACY_ALLOWANCE_METERS);
  return distance <= input.radius + allowance ? { ok: true, distance } : { ok: false, reason: "outside", distance };
};
