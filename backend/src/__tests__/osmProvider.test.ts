import { afterEach, describe, expect, it, vi } from "vitest";
import { distanceKm, getOsmRoute, searchOsmGyms } from "../maps/osmProvider";

afterEach(() => vi.unstubAllGlobals());

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

  it("falls back to the second Overpass instance when the first is unavailable", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          features: [{
            geometry: { coordinates: [72.9959, 21.7051] },
            properties: { name: "Bharuch", state: "Gujarat", country: "India", type: "city" },
          }],
        }),
      })
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          elements: [{
            type: "node", id: 123, lat: 21.7052, lon: 72.996,
            tags: { name: "Fit Gym", amenity: "gym" },
          }],
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const gyms = await searchOsmGyms("Bharuch", "gyms");

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(gyms).toHaveLength(1);
    expect(gyms[0].name).toBe("Fit Gym");
    expect(gyms[0].source).toBe("openstreetmap");
  });
});
