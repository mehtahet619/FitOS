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

import type { FoodPipelineDiagnostics, NearbyPlace } from "./provider";

interface ApifyRun {
  id: string;
  status: "SUCCEEDED" | "FAILED" | "RUNNING" | "READY";
  defaultDatasetId?: string;
}

interface FoodDish {
  id: string;
  restaurantId: string;
  restaurantName: string;
  restaurantUrl?: string;
  name: string;
  category?: string;
  description?: string;
  priceInr?: number;
  isVeg?: boolean;
  inStock?: boolean;
  imageUrl?: string;
  calories?: number;
  proteinG?: number;
  carbsG?: number;
  fatG?: number;
}

interface ApifyRestaurant {
  id?: string | number;
  restaurantId?: string | number;
  restaurant_id?: string | number;
  restaurantName?: string;
  name?: string;
  restaurantName?: string;
  Restaurantname?: string;
  Cuisinescuisines?: string;
  Localitylocality?: string;
  Ratingrating?: number | string;
  costForTwo?: string | number;
  CostforTwo?: string | number;
  "Cost for twocostForTwo"?: string | number;
  DeliverydeliveryTime?: string | number;
  LinkrestaurantUrl?: string;
  rating?: number | string;
  avgRating?: number | string;
  cuisines?: string;
  locality?: string;
  deliveryPrice?: number;
  deliveryTime?: string | number;
  latitude?: number | string;
  longitude?: number | string;
  lat?: number | string;
  lng?: number | string;
  lon?: number | string;
  address?: string;
  url?: string;
  restaurantUrl?: string;
  menus?: ApifyMenuItem[];
  menuItems?: ApifyMenuItem[];
  dishes?: ApifyMenuItem[];
  rowType?: string;
  itemName?: string;
  dishName?: string;
  title?: string;
  item_name?: string;
  restaurant_id?: string | number;
  restaurant?: string;
  dishId?: string | number;
  itemId?: string | number;
  veg?: boolean | string | number;
  vegetarian?: boolean | string | number;
  available?: boolean | string;
  inStock?: boolean | string;
  price?: number | string;
  priceInr?: number;
  category?: string;
  description?: string;
  isVeg?: boolean;
  inStock?: boolean;
  imageUrl?: string;
}

interface ApifyMenuItem {
  rowType?: string;
  id?: string | number;
  restaurantId?: string | number;
  restaurant_id?: string | number;
  restaurantName?: string;
  restaurant?: string;
  name?: string;
  dishName?: string;
  title?: string;
  itemName?: string;
  item_name?: string;
  dishId?: string | number;
  itemId?: string | number;
  price?: number | string;
  priceInr?: number | string;
  isVeg?: boolean | string | number;
  veg?: boolean | string | number;
  vegetarian?: boolean | string | number;
  inStock?: boolean | string;
  available?: boolean | string;
  imageUrl?: string;
  category?: string;
  description?: string;
}

export class FoodPipelineError extends Error {
  constructor(public readonly diagnostics: FoodPipelineDiagnostics) {
    super(diagnostics.error || "Healthy food pipeline failed");
    this.name = "FoodPipelineError";
  }
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
  public lastDiagnostics: FoodPipelineDiagnostics = {
    success: false,
    stage: "restaurant_search",
    restaurantsFound: 0,
    restaurantIdentifiersFound: 0,
    rawMenuRecordsFound: 0,
    normalizedDishesFound: 0,
  };

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

    console.log("========== FOOD SEARCH START ==========");
    console.log("User coordinates:", { latitude, longitude });
    console.log("Apify Actor ID:", this.actorId);
    console.log("Menu mode enabled:", true);

    // Validate coordinates
    if (!isValidLatLng(latitude, longitude)) {
      throw new Error("Invalid latitude/longitude provided");
    }

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const searchRunId = await this.startActorRun({
          latitude,
          longitude,
          mode: "search",
          proxyConfiguration: this.proxyConfiguration(),
          maxItems: 20,
        });
        const searchRun = await this.waitForActorRun(searchRunId);
        const searchResults = searchRun.defaultDatasetId
          ? await this.getDatasetItems(searchRun.defaultDatasetId)
          : [];
        console.log("========== APIFY SEARCH COMPLETE ==========");
        console.log("Restaurant count:", searchResults.length);
        console.log("Sample restaurant records:", JSON.stringify(searchResults.slice(0, 3), null, 2));
        console.log("Restaurant keys:", Object.keys(searchResults[0] || {}));
        const restaurants = this.normalizeRestaurants(searchResults);
        this.lastDiagnostics = {
          success: false,
          stage: "identifier_extraction",
          restaurantsFound: searchResults.length,
          restaurantIdentifiersFound: 0,
          rawMenuRecordsFound: 0,
          normalizedDishesFound: 0,
        };

        const restaurantIds = restaurants
          .map((restaurant) => this.extractRestaurantIdentifier(restaurant))
          .filter((id): id is string => Boolean(id))
          .slice(0, 10);
        console.log("Extracted restaurant identifiers:", restaurantIds);
        console.log("Identifier count:", restaurantIds.length);
        this.lastDiagnostics.restaurantIdentifiersFound = restaurantIds.length;
        if (restaurantIds.length === 0) {
          throw new FoodPipelineError({
            ...this.lastDiagnostics,
            error: "Restaurant search results do not contain usable identifiers for menu extraction.",
          });
        }

        const menuInput = {
          mode: "menu",
          restaurantIds,
          proxyConfiguration: this.proxyConfiguration(),
          maxItems: 200,
        };
        console.log("========== MENU EXTRACTION START ==========");
        console.log("Menu extraction input:", JSON.stringify(menuInput, null, 2));
        console.log("Starting menu scraping...");
        const menuResults = await this.getRestaurantMenus(restaurantIds);
        console.log("Raw menu records:", menuResults.length);
        console.log("========== RAW MENU RESULTS ==========");
        console.log("Raw menu record count:", menuResults.length);
        console.log("Raw menu sample:", JSON.stringify(menuResults.slice(0, 10), null, 2));
        console.log("Menu record keys:", Object.keys(menuResults[0] || {}));
        this.lastDiagnostics.stage = "dish_normalization";
        this.lastDiagnostics.rawMenuRecordsFound = menuResults.length;
        const dishes = this.normalizeDishes(menuResults, restaurants);
        console.log("Normalized dishes:", dishes.length);
        console.log("Valid dishes:", dishes.length);
        console.log("Sample dishes:", dishes.slice(0, 5));
        this.lastDiagnostics.normalizedDishesFound = dishes.length;
        if (dishes.length === 0) {
          this.lastDiagnostics.error = "Menu dataset contained no recognizable dish names.";
          return [];
        }

        const places = this.transformToNearbyPlaces(restaurants, dishes, latitude, longitude, query);

        this.lastDiagnostics = { ...this.lastDiagnostics, success: true, stage: "complete" };
        return places;
      } catch (e: any) {
        if (e instanceof FoodPipelineError) this.lastDiagnostics = e.diagnostics;
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

  private extractRestaurantIdentifier(restaurant: ApifyRestaurant): string | null {
    const direct = restaurant.id ?? restaurant.restaurantId ?? restaurant.restaurant_id;
    if (direct !== undefined && direct !== null && String(direct).trim()) {
      return String(direct).trim();
    }
    const url = restaurant.restaurantUrl || restaurant.url || restaurant.LinkrestaurantUrl;
    const match = typeof url === "string" ? url.match(/rest(?:aurant)?[-_/]?([0-9]+)/i) : null;
    return match?.[1] ?? null;
  }

  private normalizeIdentifier(value: unknown): string | undefined {
    if (typeof value !== "string" && typeof value !== "number") return undefined;
    const raw = String(value).trim();
    if (!raw) return undefined;
    const urlMatch = raw.match(/rest(?:aurant)?[-_/]?([0-9]+)/i);
    return urlMatch?.[1] ?? raw;
  }

  private parseBoolean(value: unknown): boolean | undefined {
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value === 1 ? true : value === 0 ? false : undefined;
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (["true", "yes", "1", "veg", "vegetarian", "in stock", "available"].includes(normalized)) return true;
      if (["false", "no", "0", "non-veg", "non vegetarian", "out of stock", "unavailable"].includes(normalized)) return false;
    }
    return undefined;
  }

  /**
   * Start an Apify actor run to scrape Swiggy.
   */
  private async startActorRun(input: Record<string, unknown>): Promise<string> {
    const url = `${this.apifyApiUrl}/acts/${this.actorId}/runs?token=${this.apiKey}`;

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

  private proxyConfiguration() {
    return { useApifyProxy: true, apifyProxyGroups: ["RESIDENTIAL"] };
  }

  private async getRestaurantMenus(
    restaurantIds: string[]
  ): Promise<ApifyRestaurant[]> {
    const runId = await this.startActorRun({
      mode: "menu",
      restaurantIds,
      proxyConfiguration: this.proxyConfiguration(),
      maxItems: 200,
    });
    console.log("Menu run ID:", runId);
    const run = await this.waitForActorRun(runId);
    console.log("Menu run status:", run.status, "dataset:", run.defaultDatasetId || "none");
    if (!run.defaultDatasetId) return [];
    const results = await this.getDatasetItems(run.defaultDatasetId);
    console.log("Menu dataset response:", results.slice(0, 3));
    return results;
  }

  private normalizeRestaurants(records: ApifyRestaurant[]): ApifyRestaurant[] {
    return records
      .map((restaurant) => ({
        ...restaurant,
        id: restaurant.id || restaurant.restaurantId || restaurant.restaurantUrl || restaurant.url || restaurant.LinkrestaurantUrl,
        name: restaurant.name || restaurant.restaurantName || restaurant.Restaurantname,
        rating: restaurant.rating ?? restaurant.avgRating ?? restaurant.Ratingrating ?? 4,
        cuisines: restaurant.cuisines || restaurant.Cuisinescuisines,
        locality: restaurant.locality || restaurant.Localitylocality,
        costForTwo: restaurant.costForTwo ?? restaurant.CostforTwo ?? restaurant["Cost for twocostForTwo"],
        deliveryTime: restaurant.deliveryTime || restaurant.DeliverydeliveryTime,
        url: restaurant.url || restaurant.restaurantUrl || restaurant.LinkrestaurantUrl,
      }))
      .filter((restaurant) => Boolean(restaurant.id && restaurant.name));
  }

  private normalizeDishes(records: ApifyRestaurant[], restaurants: ApifyRestaurant[]): FoodDish[] {
    const restaurantMap = new Map(
      restaurants.map((restaurant) => [
        this.normalizeIdentifier(restaurant.id) || this.normalizeIdentifier(restaurant.restaurantId) || "",
        { name: restaurant.name!, restaurantUrl: restaurant.url },
      ])
    );
    const normalized = records
      .flatMap((raw) => {
        const record = raw as ApifyRestaurant & Record<string, unknown>;
        const nested = record.menus || record.menuItems || record.dishes;
        const rows: (ApifyMenuItem & Record<string, unknown>)[] = Array.isArray(nested)
          ? nested.map((item) => ({
              ...item,
              restaurantId: item.restaurantId ?? item.restaurant_id ?? record.id ?? record.restaurantId,
              restaurantName: item.restaurantName ?? record.name ?? record.restaurantName ?? record.Restaurantname,
              restaurantUrl: (item as Record<string, unknown>).restaurantUrl ?? record.url ?? record.restaurantUrl,
            } as ApifyMenuItem & Record<string, unknown>))
          : [];
        if (record.rowType?.toLowerCase().includes("restaurant") && rows.length) return rows;
        return [record as ApifyMenuItem & Record<string, unknown>, ...rows];
      })
      .map((item) => {
        const name = this.firstString(item, ["name", "dishName", "itemName", "title", "item_name", "item"]);
        const rawRestaurantId = item.restaurantId ?? item.restaurant_id;
        const restaurantId = this.normalizeIdentifier(rawRestaurantId);
        const restaurantName = this.firstString(item, ["restaurantName", "restaurant", "Restaurantname"]);
        const id = this.firstString(item, ["id", "dishId", "itemId"]);
        const price = this.firstNumber(item, ["priceInr", "price", "cost", "itemPrice"]);
        const description = this.firstString(item, ["description", "itemDescription", "desc"]);
        const category = this.firstString(item, ["category", "categoryName", "menuCategory"]);
        const stockValue = this.parseBoolean(item.inStock ?? item.available);
        const inStock = stockValue !== false;
        if (!name || !inStock) return null;
        const restaurant = restaurantId ? restaurantMap.get(restaurantId) : undefined;
        const vegValue = this.parseBoolean(item.isVeg ?? item.veg ?? item.vegetarian);
        return {
          id: id || `${restaurantId || "nearby"}-${name}`,
          restaurantId: restaurantId || "unknown",
          restaurantName: restaurant?.name || restaurantName || "Nearby Restaurant",
          restaurantUrl: this.firstString(item, ["restaurantUrl", "restaurant_url"]),
          name,
          category,
          description,
          priceInr: price,
          isVeg: vegValue,
          inStock,
          imageUrl: this.firstString(item, ["imageUrl", "image", "image_url"]),
          calories: this.estimateCalories(item),
          proteinG: this.estimateProtein(item),
        };
      })
      .filter((dish): dish is FoodDish => dish !== null);
    return normalized;
  }

  private firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return undefined;
  }

  private firstNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
    for (const key of keys) {
      const value = record[key];
      if (typeof value !== "number" && typeof value !== "string") continue;
      const text = String(value).trim();
      if (!text) continue;
      const parsed = typeof value === "number" ? value : Number(text.replace(/[^0-9.]/g, ""));
      if (Number.isFinite(parsed)) return parsed;
    }
    return undefined;
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
        console.error("Menu run failed:", JSON.stringify(run, null, 2));
        throw new Error("Apify menu actor run failed");
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
    dishes: FoodDish[],
    userLat: number,
    userLng: number,
    query: string
  ): NearbyPlace[] {
    console.log(`[Apify Swiggy] restaurants returned: ${restaurants.length}`);

    const normalizedQuery = query.trim().toLowerCase();
    const filtered = normalizedQuery
      ? restaurants.filter((restaurant) =>
          `${restaurant.name || ""} ${restaurant.cuisines || ""}`
            .toLowerCase()
            .includes(normalizedQuery)
        )
      : restaurants;
    const restaurantsToTransform = filtered.length > 0 ? filtered : restaurants;
    console.log(`[Apify Swiggy] restaurants after query filtering: ${filtered.length}`);

    const places = restaurantsToTransform
      .map((r) => {
        const restaurantName = r.name as string;
        const parsedLat = Number(r.latitude ?? r.lat);
        const parsedLng = Number(r.longitude ?? r.lng ?? r.lon);
        const hasCoordinates =
          Number.isFinite(parsedLat) && parsedLat >= -90 && parsedLat <= 90 &&
          Number.isFinite(parsedLng) && parsedLng >= -180 && parsedLng <= 180;
        // Keep the API shape stable when the actor omits coordinates, but never
        // pretend the user's coordinates are the restaurant's real coordinates.
        const latitude = hasCoordinates ? parsedLat : userLat;
        const longitude = hasCoordinates ? parsedLng : userLng;
        const distance = hasCoordinates
          ? this.calculateDistance(userLat, userLng, latitude, longitude)
          : Number.POSITIVE_INFINITY;

        const restaurantDishes = dishes
          .filter((dish) => {
            const dishId = this.normalizeIdentifier(dish.restaurantId);
            const restaurantId = this.normalizeIdentifier(r.id) || this.normalizeIdentifier(r.restaurantId);
            return Boolean(dishId && restaurantId && dishId === restaurantId);
          })
          .map((dish) => ({
            id: dish.id,
            restaurantId: dish.restaurantId,
            name: dish.name,
            estPriceInr: dish.priceInr ?? 0,
            description: dish.description,
            category: dish.category,
            isVeg: dish.isVeg,
            inStock: dish.inStock,
            imageUrl: dish.imageUrl,
            estCalories: dish.calories,
            estProteinG: dish.proteinG,
          }));

        return {
          id: r.url || `swiggy-${restaurantName.replace(/\s+/g, "-")}`,
          name: restaurantName,
          distanceKm: distance,
          rating: Number(r.rating) || 4.0,
          priceRange: this.estimatePriceRange(r.costForTwo ?? r.deliveryPrice),
          isOpenNow: true, // Assume open; could enhance with real hours
          latitude,
          longitude,
          dishes: restaurantDishes,
          source: "Swiggy",
          locality: r.locality,
          cuisines: r.cuisines,
          deliveryTime: r.deliveryTime,
          costForTwo: r.costForTwo,
          restaurantUrl: r.url,
        };
      })
      .sort((a, b) => a.distanceKm - b.distanceKm)
      .slice(0, 10); // Return top 10 closest restaurants

    console.log(`[Apify Swiggy] final transformed food suggestions: ${places.length}`);
    return places;
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
  private estimatePriceRange(costForTwo?: string | number): string {
    const numericCost = typeof costForTwo === "number"
      ? costForTwo
      : Number(String(costForTwo ?? "").replace(/[^0-9.]/g, ""));

    if (!Number.isFinite(numericCost)) return "₹₹";
    if (numericCost <= 250) return "₹";
    if (numericCost <= 400) return "₹₹";
    if (numericCost <= 600) return "₹₹₹";
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
