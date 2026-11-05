/**
 * Location/places provider abstraction. Swap this for a real food discovery
 * implementation by implementing the same interface and changing
 * MAPS_PROVIDER in .env.
 *
 * Supported providers:
 * - "mock" (default) — returns empty results
 * - "apify_swiggy" — scrapes Swiggy restaurants via Apify
 * - "osm" (default) — OpenStreetMap Overpass discovery; menu details are not supplied
 *
 * IMPORTANT: per product requirements, restaurant data must never be
 * invented by the app. MockMapsProvider below returns an EMPTY result set
 * with an explicit "not configured" flag rather than fabricating
 * restaurants — the frontend renders an honest empty state ("connect a
 * places API to see nearby options") instead of fake listings.
 */

import { ApifySwiggyMapsProvider } from "./apifySwiggyProvider";
import { searchOsmFood } from "./osmProvider";

export interface NearbyPlace {
  id: string;
  name: string;
  distanceKm: number;
  rating: number | null;
  priceRange: string;
  isOpenNow: boolean | null;
  /** Coordinates are optional because the Swiggy actor returns distance but not geocoded restaurant coordinates. */
  latitude?: number;
  longitude?: number;
  dishes: {
    id?: string;
    restaurantId?: string;
    name: string;
    estPriceInr: number;
    description?: string;
    category?: string;
    isVeg?: boolean;
    inStock?: boolean;
    imageUrl?: string;
    estCalories?: number;
    estProteinG?: number;
    estCarbsG?: number;
    estFatG?: number;
  }[];
  source: string;
  locality?: string;
  cuisines?: string;
  deliveryTime?: string | number;
  costForTwo?: string | number;
  restaurantUrl?: string;
}

export interface FoodPipelineDiagnostics {
  success: boolean;
  stage: "restaurant_search" | "identifier_extraction" | "menu_extraction" | "dish_normalization" | "complete";
  restaurantsFound: number;
  restaurantIdentifiersFound: number;
  rawMenuRecordsFound: number;
  normalizedDishesFound: number;
  error?: string;
  menuSourceAvailable?: boolean;
  reason?: string;
}

export interface MapsProvider {
  findNearbyFood(input: {
    latitude: number;
    longitude: number;
    query: string;
  }): Promise<{ configured: boolean; places: NearbyPlace[]; diagnostics?: FoodPipelineDiagnostics }>;
}

export class MockMapsProvider implements MapsProvider {
  async findNearbyFood(): Promise<{ configured: boolean; places: NearbyPlace[] }> {
    // No real places API is wired up in this MVP. Returning an empty,
    // clearly-flagged result instead of inventing restaurant names/prices.
    return { configured: false, places: [] };
  }
}

export function getMapsProvider(): MapsProvider {
  const configuredProvider = (process.env.MAPS_PROVIDER || "osm").toLowerCase();
  const apiKey = process.env.APIFY_API_KEY;
  // OSM is the default free discovery source. If a Swiggy menu scraper is
  // explicitly configured and credentials exist, retain it for verified menus.
  if (configuredProvider === "apify_swiggy" && apiKey) return new ApifySwiggyProvider(apiKey);
  if (configuredProvider === "mock") return new MockMapsProvider();
  if (configuredProvider !== "osm" && configuredProvider !== "openstreetmap" && configuredProvider !== "apify_swiggy") {
    console.warn(`Unsupported MAPS_PROVIDER="${configuredProvider}"; using OpenStreetMap.`);
  }
  return new OpenStreetMapFoodProvider();
}

class OpenStreetMapFoodProvider implements MapsProvider {
  async findNearbyFood(input: { latitude: number; longitude: number; query: string }): Promise<{ configured: boolean; places: NearbyPlace[] }> {
    const found = await searchOsmFood(input.latitude, input.longitude);
    const places: NearbyPlace[] = found.map((place) => ({
      id: place.id,
      name: place.name,
      distanceKm: place.distanceKm,
      rating: null,
      priceRange: "Unknown",
      isOpenNow: null,
      latitude: place.latitude,
      longitude: place.longitude,
      dishes: [],
      source: "openstreetmap",
      locality: place.address || place.city || undefined,
      cuisines: String(place.tags.cuisine || place.tags.amenity || "Food"),
    }));
    return { configured: true, places };
  }
}

/**
 * Wrapper class to implement MapsProvider interface with ApifySwiggyMapsProvider.
 */
class ApifySwiggyProvider implements MapsProvider {
  private swiggy: ApifySwiggyMapsProvider;

  constructor(apiKey: string) {
    this.swiggy = new ApifySwiggyMapsProvider(apiKey);
  }

  async findNearbyFood(input: {
    latitude: number;
    longitude: number;
    query: string;
  }): Promise<{ configured: boolean; places: NearbyPlace[]; diagnostics?: FoodPipelineDiagnostics }> {
    try {
      const places = await this.swiggy.findNearbyFood(input);
      return { configured: true, places, diagnostics: this.swiggy.lastDiagnostics };
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      console.error("Apify Swiggy provider error:", message);
      const diagnostics = {
        ...this.swiggy.lastDiagnostics,
        success: false,
        error: message,
      };
      this.swiggy.lastDiagnostics = diagnostics;
      return { configured: true, places: [], diagnostics };
    }
  }
}
