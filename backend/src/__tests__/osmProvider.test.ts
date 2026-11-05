import { describe, expect, it } from "vitest";
import { distanceKm, getOsmRoute } from "../maps/osmProvider";

describe("OpenStreetMap location helpers", () => {
  it("calculates zero distance for identical coordinates", () => {
    expect(distanceKm(23.0225, 72.5714, 23.0225, 72.5714)).toBe(0);
  });

  it("calculates a plausible distance between Ahmedabad and Vadodara", () => {
    const distance = distanceKm(23.0225, 72.5714, 22.3072, 73.1812);
    expect(distance).toBeGreaterThan(90);
    expect(distance).toBeLessThan(110);
  });

  it("rejects invalid route coordinates before making a network request", async () => {
    await expect(getOsmRoute({
      fromLat: 120, fromLng: 72.5, toLat: 22.3, toLng: 73.1, profile: "driving",
    })).rejects.toThrow("Valid origin and destination coordinates are required.");
  });
});
