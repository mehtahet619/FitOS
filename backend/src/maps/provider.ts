/**
 * Location/places provider abstraction. Swap this for a real food discovery
 * implementation by implementing the same interface and changing
 * MAPS_PROVIDER in .env.
 *
 * Supported providers:
 * - "mock" (default) — returns empty results
 * - "apify_swiggy" — scrapes Swiggy restaurants via Apify
 * - "google_places" — Google Places API (not yet implemented)
 *
 * IMPORTANT: per product requirements, restaurant data must never be
 * invented by the app. MockMapsProvider below returns an EMPTY result set
 * with an explicit "not configured" flag rather than fabricating
 * restaurants — the frontend renders an honest empty state ("connect a
 * places API to see nearby options") instead of fake listings.
 */

import { ApifySwiggyMapsProvider } from "./apifySwiggyProvider";

export interface NearbyPlace {
  id: string;
  name: string;
  distanceKm: number;
  rating: number;
  priceRange: string;
  isOpenNow: boolean;
  latitude: number;
  longitude: number;
  dishes: { name: string; estPriceInr: number; estCalories?: number; estProteinG?: number }[];
  source: string;
  locality?: string;
  cuisines?: string;
  deliveryTime?: string | number;
  costForTwo?: string | number;
  restaurantUrl?: string;
}

export interface MapsProvider {
  findNearbyFood(input: {
    latitude: number;
    longitude: number;
    query: string;
  }): Promise<{ configured: boolean; places: NearbyPlace[] }>;
}

export class MockMapsProvider implements MapsProvider {
  async findNearbyFood(): Promise<{ configured: boolean; places: NearbyPlace[] }> {
    // No real places API is wired up in this MVP. Returning an empty,
    // clearly-flagged result instead of inventing restaurant names/prices.
    return { configured: false, places: [] };
  }
}

export function getMapsProvider(): MapsProvider {
  const provider = process.env.MAPS_PROVIDER || "mock";

  if (provider === "apify_swiggy") {
    const apiKey = process.env.APIFY_API_KEY;
    if (!apiKey) {
      console.warn("MAPS_PROVIDER=apify_swiggy but APIFY_API_KEY not set — falling back to mock");
      return new MockMapsProvider();
    }
    return new ApifySwiggyProvider(apiKey);
  }

  // if (provider === "google_places") {
  //   const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  //   if (!apiKey) return new MockMapsProvider();
  //   return new GooglePlacesProvider(apiKey);
  // }

  // Default to mock
  return new MockMapsProvider();
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
  }): Promise<{ configured: boolean; places: NearbyPlace[] }> {
    try {
      const places = await this.swiggy.findNearbyFood(input);
      return { configured: true, places };
    } catch (e: any) {
      console.error("Apify Swiggy provider error:", e.message);
      // Return empty configured result instead of error
      return { configured: true, places: [] };
    }
  }
}
