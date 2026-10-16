import { describe, expect, test } from "bun:test";

import { checkGeofence, distanceMeters } from "@/services/geofence";

// Gateway of India, Mumbai.
const office = { latitude: 18.921984, longitude: 72.834654 };

describe("geofence", () => {
  test("distance: 0.001 degree of latitude is about 111 metres", () => {
    expect(Math.round(distanceMeters(office, { ...office, latitude: office.latitude + 0.001 }))).toBe(111);
  });

  test("inside the radius passes", () => {
    const result = checkGeofence({ at: { ...office, latitude: office.latitude + 0.001 }, accuracy: 10, branch: office, radius: 200 });
    expect(result).toEqual({ ok: true, distance: 111 });
  });

  test("just outside passes only within the accuracy allowance", () => {
    const at = { ...office, latitude: office.latitude + 0.002 }; // ~222 m
    expect(checkGeofence({ at, accuracy: 30, branch: office, radius: 200 }).ok).toBe(true);
    expect(checkGeofence({ at, accuracy: 5, branch: office, radius: 200 }).ok).toBe(false);
  });

  test("a huge reported accuracy does not stretch the fence", () => {
    const at = { ...office, latitude: office.latitude + 0.003 }; // ~334 m
    expect(checkGeofence({ at, accuracy: 140, branch: office, radius: 200 })).toMatchObject({ ok: false, reason: "outside" });
  });

  test("an imprecise fix is refused even at the office", () => {
    expect(checkGeofence({ at: office, accuracy: 500, branch: office, radius: 200 })).toMatchObject({ ok: false, reason: "imprecise" });
  });
});
