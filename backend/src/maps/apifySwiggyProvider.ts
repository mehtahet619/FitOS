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
  id?: string;
  restaurantId?: string;
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
  distance?: string | number;
  isOpen?: boolean;
  address?: string;
  url?: string;
  restaurantUrl?: string;
  menus?: ApifyMenuItem[];
  menuItems?: ApifyMenuItem[];
  dishes?: ApifyMenuItem[];
  rowType?: string;
  itemName?: string;
  price?: number;
  priceInr?: number;
  category?: string;
  description?: string;
  isVeg?: boolean;
  inStock?: boolean;
  imageUrl?: string;
}

interface ApifyMenuItem {
  rowType?: string;
  id?: string;
  restaurantId?: string;
  name?: string;
  itemName?: string;
  price?: number;
  priceInr?: number;
  isVeg?: boolean;
  inStock?: boolean;
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
  private readonly maxRetries = 0; // One attempt only: avoid repeating the full restaurant + menu scrape.
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
        // Some actor runs embed real menu records in restaurant results instead of a separate menu dataset.
        const embeddedMenuResults = this.extractEmbeddedMenuItems(restaurants);
        const allMenuResults = [...menuResults, ...embeddedMenuResults];
        console.log("Raw menu records:", menuResults.length, "embedded:", embeddedMenuResults.length);
        console.log("========== RAW MENU RESULTS ==========");
        console.log("Raw menu record count:", allMenuResults.length);
        console.log("Raw menu sample:", JSON.stringify(allMenuResults.slice(0, 10), null, 2));
        console.log("Menu record keys:", Object.keys(allMenuResults[0] || {}));
        this.lastDiagnostics.stage = "dish_normalization";
        this.lastDiagnostics.rawMenuRecordsFound = allMenuResults.length;
        const dishes = this.normalizeDishes(allMenuResults, restaurants);
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
    const candidate = restaurant.id || restaurant.restaurantId || restaurant.restaurantUrl || restaurant.url;
    return candidate ? String(candidate) : null;
  }

  /**
   * Start an Apify actor run to scrape Swiggy.
   */
  private async startActorRun(input: Record<string, unknown>): Promise<string> {
    const url = `${this.apifyApiUrl}/acts/${this.actorId}/runs?token=${this.apiKey}`;

    let response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      const proxyRejected = /proxy.{0,40}(reject|invalid|not available|not supported|group|residential)|(?:reject|invalid).{0,40}proxy/i.test(errorText);
      const hasProxyConfiguration = Boolean(input.proxyConfiguration && typeof input.proxyConfiguration === "object");
      if (proxyRejected && hasProxyConfiguration) {
        console.warn("[Apify Swiggy] Residential proxy rejected; retrying this actor start with DATACENTER proxy.");
        response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...input,
            proxyConfiguration: { useApifyProxy: true, apifyProxyGroups: ["DATACENTER"] },
          }),
        });
        if (!response.ok) {
          const fallbackText = await response.text().catch(() => "");
          throw new Error(`Apify actor start failed with residential and datacenter proxies (${response.status}): ${fallbackText.slice(0, 300)}`);
        }
      } else {
        throw new Error(`Apify actor start failed (${response.status}): ${errorText.slice(0, 300)}`);
      }
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
      .map((restaurant) => {
        const raw = restaurant as ApifyRestaurant & Record<string, unknown>;
        const nested = (raw.restaurant && typeof raw.restaurant === "object"
          ? raw.restaurant
          : {}) as Record<string, unknown>;
        const firstText = (...values: unknown[]): string | undefined => {
          for (const value of values) {
            if (typeof value === "string" && value.trim()) return value.trim();
            if (typeof value === "number" && Number.isFinite(value)) return String(value);
          }
          return undefined;
        };
        const id = firstText(
          raw.id, raw.restaurantId, raw.restaurant_id, raw.restaurantID,
          raw.resId, raw.res_id, nested.id, nested.restaurantId, nested.restaurant_id,
          raw.restaurantUrl, raw.url, raw.LinkrestaurantUrl,
        );
        const name = firstText(
          raw.name, raw.restaurantName, raw.Restaurantname, raw.restaurant_name,
          nested.name, nested.restaurantName,
        );
        // Apify actor dataset versions use different keys for coordinates and
        // distance. Normalize known aliases before the nearby-distance filter.
        const latitude = raw.latitude ?? raw.lat ?? raw.Latitude ?? nested.latitude ?? nested.lat;
        const longitude = raw.longitude ?? raw.lng ?? raw.lon ?? raw.Longitude ??
          nested.longitude ?? nested.lng ?? nested.lon;
        const distance = raw.distance ?? raw.distanceKm ?? raw.distance_km ?? raw.Distance ??
          raw.distanceText ?? raw.distance_text ?? raw.distanceFromUser ?? raw.distance_from_user ??
          nested.distance ?? nested.distanceKm ?? nested.distance_km;
        return {
          ...restaurant,
          id,
          restaurantId: firstText(raw.restaurantId, raw.restaurant_id, raw.restaurantID, raw.resId, raw.res_id, nested.id, nested.restaurant_id) || id,
          name,
          latitude: latitude == null ? undefined : Number(latitude),
          longitude: longitude == null ? undefined : Number(longitude),
          distance: typeof distance === "string" || typeof distance === "number" ? distance : undefined,
          rating: raw.rating ?? raw.avgRating ?? raw.Ratingrating ?? raw.ratingValue ?? 0,
          cuisines: firstText(raw.cuisines, raw.Cuisinescuisines, raw.cuisine, nested.cuisines),
          locality: firstText(raw.locality, raw.Localitylocality, raw.address, nested.locality),
          costForTwo: raw.costForTwo ?? raw.CostforTwo ?? raw["Cost for twocostForTwo"],
          deliveryTime: raw.deliveryTime ?? raw.DeliverydeliveryTime,
          url: firstText(raw.url, raw.restaurantUrl, raw.LinkrestaurantUrl, raw.link),
        } as ApifyRestaurant;
      })
      .filter((restaurant) => Boolean(restaurant.id && restaurant.name));
  }

  /** Extract real dish records nested in restaurant-search responses. */
  private extractEmbeddedMenuItems(restaurants: ApifyRestaurant[]): ApifyRestaurant[] {
    const output: ApifyRestaurant[] = [];
    const queueItems = (value: unknown, restaurant: ApifyRestaurant): void => {
      if (Array.isArray(value)) {
        for (const entry of value) queueItems(entry, restaurant);
        return;
      }
      if (!value || typeof value !== "object") return;
      const item = value as Record<string, unknown>;
      const name = this.firstString(item, ["name", "dishName", "itemName", "title", "item_name"]);
      if (name) output.push({
        ...item,
        restaurantId: this.firstString(item, ["restaurantId", "restaurant_id", "restaurantID"]) || restaurant.id || restaurant.restaurantId,
        restaurantName: this.firstString(item, ["restaurantName", "restaurant_name"]) || restaurant.name || restaurant.restaurantName,
        restaurantUrl: this.firstString(item, ["restaurantUrl", "restaurantURL", "url"]) || restaurant.url || restaurant.restaurantUrl,
      } as ApifyRestaurant);
      for (const key of ["items", "menus", "menuItems", "dishes", "products", "menu", "categories"]) {
        if (item[key] !== undefined) queueItems(item[key], restaurant);
      }
    };
    for (const restaurant of restaurants) {
      const raw = restaurant as ApifyRestaurant & Record<string, unknown>;
      for (const key of ["menus", "menuItems", "dishes", "menu"]) {
        if (raw[key] !== undefined) queueItems(raw[key], restaurant);
      }
    }
    const seen = new Set<string>();
    return output.filter((item) => {
      const row = item as Record<string, unknown>;
      const name = this.firstString(row, ["name", "dishName", "itemName", "title", "item_name"]);
      const restaurantId = this.firstString(row, ["restaurantId", "restaurant_id", "restaurantID"]) || "";
      const key = `${restaurantId.toLowerCase()}::${(name || "").toLowerCase()}`;
      if (!name || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private normalizeDishes(records: ApifyRestaurant[], restaurants: ApifyRestaurant[]): FoodDish[] {
    const restaurantMap = new Map(
      restaurants.map((restaurant) => [restaurant.id!, { name: restaurant.name!, restaurantUrl: restaurant.url }])
    );
    const normalized = records
      .map((raw) => {
        const item = raw as ApifyMenuItem & Record<string, unknown>;
        const name = this.firstString(item, ["name", "dishName", "itemName", "title", "item_name"]);
        const rawRestaurantId = this.firstString(item, ["restaurantId", "restaurant_id", "restaurantID", "restaurant_id"]);
        const restaurantName = this.firstString(item, ["restaurantName", "restaurant", "restaurant_name", "Restaurantname"]);
        const restaurantUrl = this.firstString(item, ["restaurantUrl", "restaurantURL", "url", "LinkrestaurantUrl"]);
        const matchedRestaurant = restaurants.find((candidate) =>
          (rawRestaurantId && [candidate.id, candidate.restaurantId].some((value) => value != null && String(value) === rawRestaurantId)) ||
          (restaurantUrl && [candidate.url, candidate.restaurantUrl, candidate.LinkrestaurantUrl].some((value) => value != null && String(value) === restaurantUrl)) ||
          (restaurantName && [candidate.name, candidate.restaurantName, candidate.Restaurantname].some((value) =>
            typeof value === "string" && value.trim().toLowerCase() === restaurantName.trim().toLowerCase()
          ))
        );
        const restaurantId = matchedRestaurant?.id || rawRestaurantId;
        const id = this.firstString(item, ["id", "dishId", "itemId"]);
        const price = this.firstNumber(item, ["priceInr", "price", "cost", "itemPrice"]);
        const description = this.firstString(item, ["description", "itemDescription", "desc"]);
        const category = this.firstString(item, ["category", "categoryName", "menuCategory"]);
        const inStock = item.inStock !== false;
        if (!name || !inStock) return null;
        const restaurant = restaurantId ? restaurantMap.get(restaurantId) : matchedRestaurant ? { name: matchedRestaurant.name!, restaurantUrl: matchedRestaurant.url } : undefined;
        return {
          id: id || `${restaurantId || "nearby"}-${name}`,
          restaurantId: restaurantId || "unknown",
          restaurantName: restaurant?.name || restaurantName || "Nearby Restaurant",
          restaurantUrl: restaurant?.restaurantUrl,
          name,
          category,
          description,
          priceInr: price,
          isVeg: this.normalizeVegetarianFlag(item.isVeg ?? item.is_veg ?? item.veg ?? item.vegetarian ?? item.vegOnly ?? item.veg_only),
          inStock,
          imageUrl: this.firstString(item, ["imageUrl", "image", "image_url"]),
          calories: this.firstNumber(item, ["calories", "caloriesKcal", "energyKcal"]),
          proteinG: this.firstNumber(item, ["proteinG", "protein", "proteins"]),
          carbsG: this.firstNumber(item, ["carbsG", "carbohydrates", "carbs"]),
          fatG: this.firstNumber(item, ["fatG", "fat", "totalFat"]),
        };
      })
      .filter((dish) => dish !== null) as FoodDish[];
    return normalized;
  }

  private normalizeVegetarianFlag(value: unknown): boolean | undefined {
    if (typeof value === "boolean") return value;
    if (typeof value === "number") {
      if (value === 1) return true;
      if (value === 0) return false;
    }
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (["true", "1", "yes", "y", "veg", "vegetarian", "pure veg"].includes(normalized)) return true;
      if (["false", "0", "no", "n", "non-veg", "non veg", "nonvegetarian", "non-vegetarian"].includes(normalized)) return false;
    }
    return undefined;
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
      if (typeof value === "number") {
        if (Number.isFinite(value) && value >= 0) return value;
        continue;
      }
      // Missing/blank strings must stay unknown; Number("") incorrectly becomes 0.
      if (typeof value !== "string" || !value.trim()) continue;
      const cleaned = value.trim().replace(/,/g, "").replace(/[^0-9.+-]/g, "");
      if (!cleaned || !/[0-9]/.test(cleaned)) continue;
      const parsed = Number(cleaned);
      if (Number.isFinite(parsed) && parsed >= 0) return parsed;
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
      .flatMap((r): NearbyPlace[] => {
        const restaurantName = r.name as string;
        const hasCoordinates =
          r.latitude != null &&
          r.longitude != null &&
          isValidLatLng(Number(r.latitude), Number(r.longitude));
        const latitude = hasCoordinates ? Number(r.latitude) : undefined;
        const longitude = hasCoordinates ? Number(r.longitude) : undefined;
        // The Swiggy actor returns a provider distance such as "3.1 km" but normally
        // does not return restaurant coordinates. Keep those genuine results rather
        // than dropping every restaurant or inventing map coordinates.
        const providerDistance = this.parseDistanceKm(r.distance);
        if (!hasCoordinates && providerDistance === undefined) return [];
        const distance = hasCoordinates
          ? this.calculateDistance(userLat, userLng, latitude!, longitude!)
          : providerDistance!;

        const restaurantDishes = dishes
          .filter((dish) => dish.restaurantId === r.id)
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

        return [{
          id: r.url || `swiggy-${restaurantName.replace(/\s+/g, "-")}`,
          name: restaurantName,
          distanceKm: distance,
          rating: Number(r.rating) || 4.0,
          priceRange: this.estimatePriceRange(r.costForTwo ?? r.deliveryPrice),
          isOpenNow: typeof r.isOpen === "boolean" ? r.isOpen : true,
          latitude,
          longitude,
          dishes: restaurantDishes,
          source: "Swiggy",
          locality: r.locality,
          cuisines: r.cuisines,
          deliveryTime: r.deliveryTime,
          costForTwo: r.costForTwo,
          restaurantUrl: r.url,
        }];
      })
      .sort((a, b) => a.distanceKm - b.distanceKm)
      .slice(0, 10); // Return top 10 closest restaurants

    console.log(`[Apify Swiggy] final transformed food suggestions: ${places.length}`);
    return places;
  }

  /** Parse provider distances such as "3.1 km", "850 m", or numeric kilometres. */
  private parseDistanceKm(value?: string | number): number | undefined {
    if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : undefined;
    if (typeof value !== "string" || !value.trim()) return undefined;
    const normalized = value.trim().toLowerCase().replace(/,/g, "");
    let start = -1;
    let end = -1;
    let decimalSeen = false;
    for (let index = 0; index < normalized.length; index += 1) {
      const character = normalized[index];
      if (character >= "0" && character <= "9") {
        if (start === -1) start = index;
        end = index + 1;
      } else if (character === "." && start !== -1 && !decimalSeen) {
        decimalSeen = true;
        end = index + 1;
      } else if (start !== -1) {
        break;
      }
    }
    const amount = start === -1 ? Number.NaN : Number(normalized.slice(start, end));
    if (!Number.isFinite(amount) || amount < 0) return undefined;
    const isMetres = normalized.includes("meter") || normalized.endsWith(" m") || normalized === "m";
    const isKilometres = normalized.includes("km") || normalized.includes("kilometer") || normalized.includes("kilometre");
    if (isMetres && !isKilometres) return amount / 1000;
    return amount;
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
