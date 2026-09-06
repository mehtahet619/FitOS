/**
 * Apify Swiggy scraper integration for food discovery.
 * Uses the Apify platform to scrape restaurant data from Swiggy.
 *
 * Setup:
 * 1. Sign up at https://apify.com (free tier available)
 * 2. Create an API token from your Account Settings
 * 3. Add to .env: APIFY_API_KEY="your_token"
 * 4. Set MAPS_PROVIDER="apify_swiggy" in .env
 *
 * This provider searches for restaurants by location and cuisine type,
 * then fetches menu items to estimate prices and nutritional content.
 */

import type { NearbyPlace } from "./provider";

interface ApifyRun {
  id: string;
  status: "SUCCEEDED" | "FAILED" | "RUNNING" | "READY";
  defaultDatasetId?: string;
}

interface ApifyRestaurant {
  name?: string;
  restaurantName?: string;
  rating?: number;
  avgRating?: number;
  deliveryPrice?: number;
  deliveryTime?: number;
  latitude?: number;
  longitude?: number;
  address?: string;
  url?: string;
  menus?: ApifyMenuItem[];
  menuItems?: ApifyMenuItem[];
  dishes?: ApifyMenuItem[];
}

interface ApifyMenuItem {
  name?: string;
  itemName?: string;
  price?: number;
  priceInr?: number;
  category?: string;
  description?: string;
}

/**
 * Apify Swiggy scraper provider.
 * Transforms Swiggy restaurant data into our NearbyPlace format.
 */
export class ApifySwiggyMapsProvider {
  private readonly apifyApiUrl = "https://api.apify.com/v2";
  private readonly actorId = "PAPknIT75qTicSSUI";
  private readonly timeoutMs = 60000; // 1 minute timeout for scraper runs
  private readonly maxRetries = 2;

  constructor(private apiKey: string) {}

  /**
   * Find nearby food on Swiggy using Apify scraper.
   * Calls the Apify actor to scrape Swiggy data for a location.
   *
   * @param latitude user latitude
   * @param longitude user longitude
   * @param query search query (e.g., "pizza", "north indian")
   * @returns list of restaurants with dishes and pricing
   */
  async findNearbyFood(input: {
    latitude: number;
    longitude: number;
    query: string;
  }): Promise<NearbyPlace[]> {
    const { latitude, longitude, query } = input;

    // Validate coordinates
    if (!isValidLatLng(latitude, longitude)) {
      throw new Error("Invalid latitude/longitude provided");
    }

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        // Call Apify actor to scrape Swiggy
        const runId = await this.startActorRun(latitude, longitude, query);
        const runData = await this.waitForActorRun(runId);

        if (!runData.defaultDatasetId) {
          return [];
        }

        const restaurants = await this.getDatasetItems(runData.defaultDatasetId);
        const places = this.transformToNearbyPlaces(
          restaurants,
          latitude,
          longitude
        );

        return places;
      } catch (e: any) {
        lastError = e;
        if (attempt < this.maxRetries) {
          await new Promise((resolve) =>
            setTimeout(resolve, 500 * Math.pow(2, attempt))
          );
        }
      }
    }

    throw lastError || new Error("Swiggy scraping failed: unknown error");
  }

  /**
   * Start an Apify actor run to scrape Swiggy.
   */
  private async startActorRun(
    latitude: number,
    longitude: number,
    query: string
  ): Promise<string> {
    const url = `${this.apifyApiUrl}/acts/${this.actorId}/runs?token=${this.apiKey}`;

    const input = {
      latitude,
      longitude,
      searchQuery: query,
      maxRestaurants: 20,
      includeMenus: true,
    };

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Apify actor start failed (${response.status}): ${text.slice(0, 200)}`);
    }

    const data = (await response.json()) as { data?: { id?: string } };
    const runId = data.data?.id;
    if (!runId) {
      throw new Error("Apify actor run started but no run ID returned");
    }

    return runId;
  }

  /**
   * Poll for Apify actor run completion.
   */
  private async waitForActorRun(runId: string): Promise<ApifyRun> {
    const startTime = Date.now();
    const pollIntervalMs = 1000; // Poll every second

    while (Date.now() - startTime < this.timeoutMs) {
      const url = `${this.apifyApiUrl}/actor-runs/${runId}?token=${this.apiKey}`;

      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Apify run status check failed (${response.status})`);
      }

      const data = (await response.json()) as { data?: ApifyRun };
      const run = data.data;

      if (!run) {
        throw new Error("No run data returned from Apify");
      }

      if (run.status === "SUCCEEDED") {
        return run;
      }

      if (run.status === "FAILED") {
        throw new Error(`Apify actor run failed`);
      }

      // Still running, wait and retry
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    throw new Error(
      `Apify actor run timed out after ${this.timeoutMs}ms`
    );
  }

  private async getDatasetItems(datasetId: string): Promise<ApifyRestaurant[]> {
    const url = `${this.apifyApiUrl}/datasets/${datasetId}/items?clean=true&token=${this.apiKey}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Apify dataset read failed (${response.status})`);
    }
    const data = (await response.json()) as unknown;
    return Array.isArray(data) ? (data as ApifyRestaurant[]) : [];
  }

  /**
   * Transform Apify restaurant data to our NearbyPlace format.
   */
  private transformToNearbyPlaces(
    restaurants: ApifyRestaurant[],
    userLat: number,
    userLng: number
  ): NearbyPlace[] {
    return restaurants
      .map((restaurant) => ({
        ...restaurant,
        name: restaurant.name || restaurant.restaurantName,
        rating: restaurant.rating ?? restaurant.avgRating,
        menus: restaurant.menus || restaurant.menuItems || restaurant.dishes,
      }))
      .filter((r) => r.latitude != null && r.longitude != null && r.name)
      .map((r) => {
        const restaurantName = r.name as string;
        const distance = this.calculateDistance(
          userLat,
          userLng,
          r.latitude!,
          r.longitude!
        );

        // Extract common dishes from menu
        const dishes = (r.menus || [])
          .slice(0, 5) // Top 5 items
          .map((item) => ({
            name: item.name || item.itemName || "Menu item",
            estPriceInr: item.price ?? item.priceInr ?? 0,
            estCalories: this.estimateCalories(item),
            estProteinG: this.estimateProtein(item),
          }));

        return {
          id: r.url || `swiggy-${restaurantName.replace(/\s+/g, "-")}`,
          name: restaurantName,
          distanceKm: distance,
          rating: r.rating || 4.0,
          priceRange: this.estimatePriceRange(r.deliveryPrice),
          isOpenNow: true, // Assume open; could enhance with real hours
          latitude: r.latitude!,
          longitude: r.longitude!,
          dishes,
          source: "Swiggy",
        };
      })
      .sort((a, b) => a.distanceKm - b.distanceKm)
      .slice(0, 10); // Return top 10 closest restaurants
  }

  /**
   * Calculate distance between two lat/lng points (Haversine formula).
   */
  private calculateDistance(
    lat1: number,
    lng1: number,
    lat2: number,
    lng2: number
  ): number {
    const R = 6371; // Earth radius in km
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLng = ((lng2 - lng1) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos((lat1 * Math.PI) / 180) *
        Math.cos((lat2 * Math.PI) / 180) *
        Math.sin(dLng / 2) *
        Math.sin(dLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  /**
   * Estimate calorie content based on menu item name/category.
   * This is a rough heuristic — real data would come from a nutrition API.
   */
  private estimateCalories(item: ApifyMenuItem): number | undefined {
    const name = `${item.name || item.itemName || ""} ${item.category || ""}`.toLowerCase();

    // Simple heuristics based on common categories
    if (
      name.includes("salad") ||
      name.includes("juice") ||
      name.includes("smoothie")
    ) {
      return 150;
    }
    if (name.includes("rice") || name.includes("biryani")) {
      return 400;
    }
    if (name.includes("thali") || name.includes("combo")) {
      return 600;
    }
    if (
      name.includes("pizza") ||
      name.includes("burger") ||
      name.includes("sandwich")
    ) {
      return 500;
    }
    if (
      name.includes("dal") ||
      name.includes("curry") ||
      name.includes("gravy")
    ) {
      return 250;
    }

    // Default estimate
    return 350;
  }

  /**
   * Estimate protein content based on category.
   */
  private estimateProtein(item: ApifyMenuItem): number | undefined {
    const name = `${item.name || item.itemName || ""} ${item.category || ""}`.toLowerCase();

    if (
      name.includes("paneer") ||
      name.includes("chicken") ||
      name.includes("fish") ||
      name.includes("meat")
    ) {
      return 20;
    }
    if (
      name.includes("dal") ||
      name.includes("lentil") ||
      name.includes("bean")
    ) {
      return 12;
    }
    if (
      name.includes("rice") ||
      name.includes("bread") ||
      name.includes("pasta")
    ) {
      return 8;
    }

    return 10; // Default
  }

  /**
   * Estimate price range category from delivery fee.
   */
  private estimatePriceRange(deliveryPrice?: number): string {
    if (!deliveryPrice) return "₹₹"; // Default

    if (deliveryPrice < 50) return "₹";
    if (deliveryPrice < 100) return "₹₹";
    if (deliveryPrice < 200) return "₹₹₹";
    return "₹₹₹₹";
  }
}

/**
 * Validate latitude/longitude.
 */
function isValidLatLng(lat: number, lng: number): boolean {
  return (
    typeof lat === "number" &&
    typeof lng === "number" &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
}
