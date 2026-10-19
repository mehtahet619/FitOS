import { Router } from "express";
import { db } from "../../db/client";
import { requireAuth, AuthedRequest } from "../../common/auth";
import { getMapsProvider } from "../../maps/provider";
import { rankPlaces, DEFAULT_WEIGHTS } from "./rankRestaurants";
import { getAiProvider, HealthyDishInput } from "../../ai/provider";
import { v4 as uuidv4 } from "uuid";
import { runHealthyFoodSearch } from "./healthyFoodCache";

export const foodRouter = Router();
foodRouter.use(requireAuth);

foodRouter.post("/healthy-nearby", async (req: AuthedRequest, res) => {
  const latitude = Number(req.body?.latitude), longitude = Number(req.body?.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180)
    return res.status(400).json({ error: "A valid GPS location is required." });
  // Coalesce/cache identical nearby searches. Rounded coordinates are only a cache key;
  // the actual actor request still receives the exact live GPS coordinates from the device.
  const searchKey = `${latitude.toFixed(4)}:${longitude.toFixed(4)}:healthy-food`;
  let result: Awaited<ReturnType<ReturnType<typeof getMapsProvider>["findNearbyFood"]>>;
  let cacheHit = false;
  try {
    const search = await runHealthyFoodSearch(
      searchKey,
      () => getMapsProvider().findNearbyFood({ latitude, longitude, query: "healthy food" }),
      (value) => value.configured && value.places.length > 0,
    );
    result = search.value;
    cacheHit = search.cached;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Nearby-food search is busy.";
    return res.status(503).json({ success: false, configured: true, stage: "search_in_progress", error: message });
  }
  if (!result.configured) return res.status(503).json({ success: false, configured: false, error: "Nearby food search is not configured on the server. Enable a live places/menu provider and its API credentials.", stage: "provider_configuration" });
  const places = result.places.filter((p) => {
    const hasCoordinates = Number.isFinite(p.latitude) && Number.isFinite(p.longitude) &&
      p.latitude! >= -90 && p.latitude! <= 90 && p.longitude! >= -180 && p.longitude! <= 180;
    // Swiggy search results contain real distance values but not coordinates.
    return hasCoordinates || (Number.isFinite(p.distanceKm) && p.distanceKm >= 0);
  });
  const profile = req.userId ? await db.get<any>(`SELECT primaryGoal, dietaryPref, allergies, foodLikes, dailyBudget, weightKg FROM UserProfile WHERE userId = ?`, req.userId) : undefined;
  const vegetarianOnly = /vegetarian|vegan|^veg$/i.test(String(profile?.dietaryPref || "").trim());
  const dishes: HealthyDishInput[] = places.flatMap((p) => p.dishes.filter((d) => Boolean(d.name?.trim()) && d.inStock !== false).map((d) => ({
    dishId: `${p.id}::${d.id || d.name}`, name: d.name, restaurantName: p.name, restaurantUrl: p.restaurantUrl,
    priceInr: d.estPriceInr > 0 ? d.estPriceInr : undefined, calories: d.estCalories, proteinG: d.estProteinG,
    carbsG: d.estCarbsG, fatG: d.estFatG, isVeg: d.isVeg, description: `${p.cuisines || ""} ${d.description || ""} ${d.category || ""}`.trim(), category: d.category,
  }))).filter((dish) => !vegetarianOnly || dish.isVeg === true);
  if (!dishes.length) return res.status(424).json({
    success: false, configured: true, stage: result.diagnostics?.stage || "menu_extraction",
    restaurantsFound: result.diagnostics?.restaurantsFound ?? places.length,
    restaurantIdentifiersFound: result.diagnostics?.restaurantIdentifiersFound ?? 0,
    rawMenuRecordsFound: result.diagnostics?.rawMenuRecordsFound ?? 0,
    normalizedDishesFound: result.diagnostics?.normalizedDishesFound ?? 0,
    error: vegetarianOnly
      ? "The provider did not identify any menu dishes as vegetarian. FitOS will not guess whether a dish is vegetarian."
      : result.diagnostics?.error || "The provider returned no verified menu dish names. No dishes were invented.",
  });
  const analyses = await getAiProvider().analyzeHealthyDishes({ dishes, preferences: {
    primaryGoal: profile?.primaryGoal, dietaryPref: profile?.dietaryPref, allergies: profile?.allergies,
    foodLikes: profile?.foodLikes,
    dailyBudgetInr: Number.isFinite(Number(profile?.dailyBudget)) ? Number(profile?.dailyBudget) : undefined,
    weightKg: Number.isFinite(Number(profile?.weightKg)) ? Number(profile?.weightKg) : undefined,
  } });
  const dishById = new Map(dishes.map((d) => [d.dishId, d]));
  const placeByDishId = new Map<string, typeof places[number]>();
  for (const p of places) for (const d of p.dishes) placeByDishId.set(`${p.id}::${d.id || d.name}`, p);
  const recommendations = analyses.filter((x) => dishById.has(x.dishId) && placeByDishId.has(x.dishId)).map((x) => {
    const dish = dishById.get(x.dishId)!, place = placeByDishId.get(x.dishId)!;
    const hasCoordinates = Number.isFinite(place.latitude) && Number.isFinite(place.longitude) &&
      place.latitude! >= -90 && place.latitude! <= 90 && place.longitude! >= -180 && place.longitude! <= 180;
    const distanceKm = hasCoordinates
      ? haversineKm(latitude, longitude, place.latitude!, place.longitude!)
      : place.distanceKm;
    const healthScore = Math.max(0, Math.min(100, Number(x.healthScore) || 0));
    const proximityScore = Math.max(0, 100 * (1 - distanceKm / 10));
    return { ...dish, dishName: dish.name, restaurantName: place.name, restaurantUrl: place.restaurantUrl,
      locality: place.locality, restaurantRating: place.rating, distanceKm: Math.round(distanceKm * 100) / 100,
      latitude: place.latitude, longitude: place.longitude, healthScore, proximityScore: Math.round(proximityScore),
      combinedScore: Math.round(healthScore * 0.8 + proximityScore * 0.2),
      reasons: Array.isArray(x.reasons) ? x.reasons.slice(0, 4) : [],
      nutritionConfidence: x.nutritionConfidence || "estimated",
      nutritionDisclaimer: "Nutrition is estimated from available menu data and is not a verified label value.",
    };
  }).sort((x, y) => y.combinedScore - x.combinedScore || x.distanceKm - y.distanceKm).slice(0, 20);
  return res.json({ success: true, configured: true, cacheHit, restaurantsFound: places.length, dishesFound: dishes.length,
    recommendations, ranking: "80% dish health score + 20% proximity score (within 10 km)",
    dataSource: "live provider menu data; nutrition estimates are labeled" });
});

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const r = 6371, dLat = (lat2 - lat1) * Math.PI / 180, dLng = (lng2 - lng1) * Math.PI / 180;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * r * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

foodRouter.get("/nearby", async (req: AuthedRequest, res) => {
  const { lat, lng, foodId } = req.query;
  if (!lat || !lng) return res.status(400).json({ error: "lat and lng query params required" });

  const profile = await db.get<any>(`SELECT * FROM UserProfile WHERE userId = ?`, req.userId!);
  const food = foodId ? await db.get<any>(`SELECT * FROM Food WHERE id = ?`, String(foodId)) : null;

  const maps = getMapsProvider();
  const result = await maps.findNearbyFood({
    latitude: Number(lat),
    longitude: Number(lng),
    query: food?.name ?? "healthy food",
  });

  if (!result.configured) {
    return res.json({
      configured: false,
      message:
        "No live places provider is connected in this MVP, so no restaurant data is shown (the app never invents listings). Wire up MAPS_PROVIDER=google_places with an API key to populate this.",
      forQuery: food?.name ?? "healthy food",
      places: [],
    });
  }

  const ranked = rankPlaces(
    result.places.map((place) => ({
      place,
      foodMatchScore: 0.8, // real provider would compute this from dish-name/nutrition match
      userBudgetInr: profile?.dailyBudget ?? 300,
    })),
    DEFAULT_WEIGHTS
  );

  return res.json({ configured: true, forQuery: food?.name ?? "healthy food", places: ranked });
});

foodRouter.get("/search", async (req, res) => {
  const { q } = req.query;
  const foods = q
    ? await db.all(`SELECT * FROM Food WHERE name LIKE ? LIMIT 20`, `%${String(q)}%`)
    : await db.all(`SELECT * FROM Food LIMIT 20`);
  return res.json(foods);
});
