/**
 * OpenStreetMap location services for FACHS.
 * Photon: city autocomplete/geocoding. Overpass: gyms and food places.
 * OSRM: route geometry, distance and duration.
 *
 * Public endpoints are community infrastructure, not unlimited production APIs.
 * Keep requests cached, bounded and server-side; always show OSM attribution.
 */
type JsonRecord = Record<string, any>;
const cache = new Map<string, { expiresAt: number; value: any }>();
const TTL_MS = 10 * 60 * 1000;
const USER_AGENT = "FACHS/1.0 (fitness location discovery; https://github.com/mehtahet619/FACHS)";
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];
const PHOTON_URL = process.env.PHOTON_BASE_URL || "https://photon.komoot.io";
const OSRM_URL = process.env.OSRM_BASE_URL || "https://router.project-osrm.org";
const PHOTON_TIMEOUT_MS = 8000;
const OVERPASS_TIMEOUT_MS = 12000;

function cached<T>(key: string): T | undefined {
  const hit = cache.get(key);
  if (!hit || hit.expiresAt < Date.now()) { cache.delete(key); return undefined; }
  return hit.value as T;
}
function remember<T>(key: string, value: T): T {
  cache.set(key, { value, expiresAt: Date.now() + TTL_MS });
  if (cache.size > 500) {
    const first = cache.keys().next().value;
    if (first) cache.delete(first);
  }
  return value;
}
async function getJson(url: string, timeoutMs = 10000): Promise<any> {
  const response = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`Location provider request failed (${response.status})`);
  return response.json();
}
async function photonSearch(q: string, limit = 10): Promise<JsonRecord[]> {
  const key = `photon:${q.toLowerCase()}:${limit}`;
  const hit = cached<JsonRecord[]>(key);
  if (hit) return hit;
  const url = new URL("/api/", PHOTON_URL);
  url.searchParams.set("q", q);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("lang", "en");
  const payload = await getJson(url.toString(), PHOTON_TIMEOUT_MS);
  return remember(key, Array.isArray(payload.features) ? payload.features : []);
}
export async function searchOsmCities(input: string): Promise<string[]> {
  const features = await photonSearch(input, 12);
  const names = features
    .filter((f) => ["city", "town", "village", "municipality", "district", "county"].includes(String(f.properties?.type || "").toLowerCase()) ||
      ["city", "town", "village", "municipality"].includes(String(f.properties?.osm_value || "").toLowerCase()))
    .map((f) => {
      const p = f.properties || {};
      return [p.name, p.state, p.country].filter(Boolean).join(", ");
    })
    .filter(Boolean);
  return [...new Set(names)].slice(0, 10);
}
export async function geocodeOsmPlace(query: string): Promise<{ latitude: number; longitude: number; label: string } | null> {
  const features = await photonSearch(query, 5);
  const feature = features.find((f) => Array.isArray(f.geometry?.coordinates) && f.geometry.coordinates.length >= 2);
  if (!feature) return null;
  const [longitude, latitude] = feature.geometry.coordinates.map(Number);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  const p = feature.properties || {};
  return { latitude, longitude, label: [p.name, p.state, p.country].filter(Boolean).join(", ") || query };
}
function tagsAddress(tags: JsonRecord): string {
  const street = [tags["addr:housenumber"], tags["addr:street"]].filter(Boolean).join(" ");
  return [street, tags["addr:suburb"], tags["addr:city"] || tags["addr:town"], tags["addr:state"], tags["addr:postcode"]].filter(Boolean).join(", ");
}
function featurePoint(element: JsonRecord): { lat: number; lon: number } | null {
  const point = element.type === "node" ? element : element.center;
  const lat = Number(point?.lat), lon = Number(point?.lon);
  return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
}
export function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = Math.PI / 180, dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
async function overpass(query: string): Promise<JsonRecord[]> {
  const key = `overpass:${query}`;
  const hit = cached<JsonRecord[]>(key);
  if (hit) return hit;
  let lastError: unknown;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8", Accept: "application/json", "User-Agent": USER_AGENT },
        body: new URLSearchParams({ data: query }).toString(),
        signal: AbortSignal.timeout(OVERPASS_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`Overpass request failed (${response.status})`);
      const payload = await response.json() as { elements?: JsonRecord[] };
      return remember(key, payload.elements || []);
    } catch (error) { lastError = error; }
  }
  throw lastError instanceof Error ? lastError : new Error("All Overpass public instances are unavailable.");
}
export type OsmPlace = {
  id: string; name: string; address: string; city: string;
  latitude: number; longitude: number; distanceKm: number;
  rating: number | null; ratingCount: number | null;
  openingHours: string | null; source: "openstreetmap";
  osmType: string; osmId: number; tags: JsonRecord;
};
function normalizeElements(elements: JsonRecord[], latitude: number, longitude: number, city: string): OsmPlace[] {
  return elements.flatMap((element) => {
    const tags = element.tags || {};
    const point = featurePoint(element);
    const name = String(tags.name || tags.brand || tags.operator || "").trim();
    if (!point || !name) return [];
    const d = distanceKm(latitude, longitude, point.lat, point.lon);
    return [{
      id: `osm:${element.type}:${element.id}`, name,
      address: tagsAddress(tags), city: tags["addr:city"] || tags["addr:town"] || city,
      latitude: point.lat, longitude: point.lon, distanceKm: Math.round(d * 100) / 100,
      rating: null, ratingCount: null, openingHours: tags.opening_hours || null,
      source: "openstreetmap" as const, osmType: element.type, osmId: Number(element.id), tags,
    }];
  }).sort((a, b) => a.distanceKm - b.distanceKm);
}
export async function searchOsmGyms(city: string, query = "gyms"): Promise<OsmPlace[]> {
  const center = await geocodeOsmPlace(`${city}, India`);
  if (!center) return [];
  const q = String(query || "gyms").toLowerCase();
  const filter = /yoga|pilates/.test(q)
    ? '["sport"~"yoga|pilates"]'
    : '["leisure"="fitness_centre"]';
  // Search a wider city catchment. Many gyms are mapped in neighbouring
  // localities rather than at the city-centre pin (e.g. Anand/Vallabh Vidyanagar).
  const radiusMeters = 20000;
  const overpassQuery = `[out:json][timeout:12];(nwr(around:${radiusMeters},${center.latitude},${center.longitude})${filter};nwr(around:${radiusMeters},${center.latitude},${center.longitude})["amenity"="gym"];nwr(around:${radiusMeters},${center.latitude},${center.longitude})["sport"="fitness"];nwr(around:${radiusMeters},${center.latitude},${center.longitude})["sport"="bodybuilding"];);out center tags 100;`;
  const elements = await overpass(overpassQuery);
  return normalizeElements(elements, center.latitude, center.longitude, city).slice(0, 30);
}
export async function searchOsmFood(latitude: number, longitude: number, radiusMeters = 10000): Promise<OsmPlace[]> {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
    throw new Error("Invalid latitude/longitude supplied to OpenStreetMap search.");
  }
  const query = `[out:json][timeout:8];(nwr(around:${Math.min(15000, Math.max(500, radiusMeters))},${latitude},${longitude})["amenity"~"restaurant|cafe|fast_food|food_court"];nwr(around:${Math.min(15000, Math.max(500, radiusMeters))},${latitude},${longitude})["shop"~"greengrocer|health_food"];);out center tags 100;`;
  return normalizeElements(await overpass(query), latitude, longitude, "");
}
export async function getOsmRoute(input: {
  fromLat: number; fromLng: number; toLat: number; toLng: number; profile?: "driving" | "walking" | "cycling";
}): Promise<{ distanceKm: number; durationMinutes: number; geometry: any; profile: string; source: string }> {
  const values = [input.fromLat, input.fromLng, input.toLat, input.toLng];
  if (!values.every(Number.isFinite) || Math.abs(input.fromLat) > 90 || Math.abs(input.toLat) > 90 || Math.abs(input.fromLng) > 180 || Math.abs(input.toLng) > 180) {
    throw new Error("Valid origin and destination coordinates are required.");
  }
  const profile = input.profile || "driving";
  const key = `route:${values.join(",")}:${profile}`;
  const hit = cached<any>(key);
  if (hit) return hit;
  const routeBase = profile === "walking"
    ? "https://routing.openstreetmap.de/routed-foot"
    : profile === "cycling"
      ? "https://routing.openstreetmap.de/routed-bike"
      : OSRM_URL;
  const url = `${routeBase}/route/v1/driving/${input.fromLng},${input.fromLat};${input.toLng},${input.toLat}?overview=full&geometries=geojson&steps=true`;
  const payload = await getJson(url, 15000);
  const route = payload.routes?.[0];
  if (!route) throw new Error("No route found between these locations.");
  return remember(key, {
    distanceKm: Math.round((Number(route.distance) / 1000) * 100) / 100,
    durationMinutes: Math.round(Number(route.duration) / 60),
    geometry: route.geometry, profile, source: "OSRM",
  });
}
