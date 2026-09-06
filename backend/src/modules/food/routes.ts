import { Router } from "express";
import { db } from "../../db/client";
import { requireAuth, AuthedRequest } from "../../common/auth";
import { getMapsProvider } from "../../maps/provider";
import { rankPlaces, DEFAULT_WEIGHTS } from "./rankRestaurants";

export const foodRouter = Router();
foodRouter.use(requireAuth);

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
