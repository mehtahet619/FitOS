import { Router } from "express";
import { db } from "../../db/client";
import { requireAuth, AuthedRequest } from "../../common/auth";
import { getMapsProvider } from "../../maps/provider";
import { rankPlaces, DEFAULT_WEIGHTS } from "./rankRestaurants";
import { getAiProvider, HealthyDishInput } from "../../ai/provider";
import { v4 as uuidv4 } from "uuid";

export const foodRouter = Router();
foodRouter.use(requireAuth);

foodRouter.post("/healthy-nearby", async (req: AuthedRequest, res) => {
  const latitude = Number(req.body?.latitude);
  const longitude = Number(req.body?.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return res.status(400).json({ error: "Location is required" });
  }

  const result = await getMapsProvider().findNearbyFood({ latitude, longitude, query: "healthy food" });
  const dishes: HealthyDishInput[] = result.places.flatMap((place) =>
    place.dishes.map((dish) => ({
      dishId: uuidv4(),
      name: dish.name,
      restaurantName: place.name,
      restaurantUrl: place.restaurantUrl,
      priceInr: dish.estPriceInr,
      calories: dish.estCalories,
      proteinG: dish.estProteinG,
      description: `${place.cuisines || "Nearby menu"} ${place.locality || ""}`.trim(),
    }))
  );
  console.log("Apify restaurants:", result.places.length);
  console.log("Verified menu items:", dishes.length);
  if (!dishes.length) {
    return res.status(424).json({ error: "We found restaurants nearby, but couldn't access enough menu details yet." });
  }

  const analyses = await getAiProvider().analyzeHealthyDishes({ dishes });
  const validIds = new Set(dishes.map((dish) => dish.dishId));
  const byId = new Map(dishes.map((dish) => [dish.dishId, dish]));
  const recommendations = analyses
    .filter((analysis) => validIds.has(analysis.dishId))
    .map((analysis) => ({
      ...byId.get(analysis.dishId)!,
      dishName: byId.get(analysis.dishId)!.name,
      healthScore: Math.max(0, Math.min(100, Number(analysis.healthScore) || 0)),
      reasons: Array.isArray(analysis.reasons) ? analysis.reasons.slice(0, 4) : [],
      nutritionConfidence: analysis.nutritionConfidence || "llm_estimated",
    }))
    .sort((a, b) => b.healthScore - a.healthScore)
    .slice(0, 10);
  console.log("Meal plan data source:", "healthy-dish-analysis");
  console.log("Generated meals:", recommendations.length);
  return res.json({
    restaurantsFound: result.places.length,
    dishesFound: dishes.length,
    recommendations,
    dataSource: "healthy-dish-analysis",
  });
});

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
