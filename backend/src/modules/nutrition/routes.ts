import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { db, nowIso } from "../../db/client";
import { requireAuth, AuthedRequest } from "../../common/auth";
import { generateDailyMealPlan } from "./nutritionEngine";
import { generateMealPlanFromFoods, FoodRow } from "./nutritionEngine";
import { getMapsProvider } from "../../maps/provider";

export const nutritionRouter = Router();
nutritionRouter.use(requireAuth);

const DISCLAIMER =
  "These are approximate general-wellness estimates, not medical or clinical advice. Consult a qualified professional for medical or dietary conditions.";

nutritionRouter.post("/generate", async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const profile = await db.get<any>(`SELECT * FROM UserProfile WHERE userId = ?`, userId);
  const nutritionProfile = await db.get<any>(`SELECT * FROM NutritionProfile WHERE userId = ?`, userId);
  if (!profile || !nutritionProfile) {
    return res.status(400).json({ error: "Complete onboarding (PUT /user/profile) first" });
  }

  const latitude = Number(req.body?.latitude);
  const longitude = Number(req.body?.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return res.status(400).json({ error: "Location is required to suggest food available nearby" });
  }

  const nearby = await getMapsProvider().findNearbyFood({
    latitude,
    longitude,
    query: "healthy food",
  });
  const nearbyFoods = nearby.places.flatMap((place) =>
    place.dishes.map((dish, index): FoodRow => ({
      id: uuidv4(),
      name: dish.name,
      dietType: inferDietType(dish.name),
      calories: dish.estCalories ?? 350,
      proteinG: dish.estProteinG ?? 10,
      carbsG: Math.max(0, Math.round((dish.estCalories ?? 350) * 0.12)),
      fatG: Math.max(0, Math.round((dish.estCalories ?? 350) * 0.03)),
      allergens: "",
      estPriceInr: dish.estPriceInr,
      mealSlot: inferMealSlot(dish.name, index),
    }))
  );
  if (nearbyFoods.length === 0) {
    return res.status(424).json({
      error: nearby.configured
        ? "No verified nearby menu items were returned by Swiggy. No meal plan was generated."
        : "Nearby food provider is not configured. Add APIFY_API_KEY in Render before generating a meal plan.",
    });
  }

  const plan = generateMealPlanFromFoods(nearbyFoods, {
    dietaryPref: profile.dietaryPref,
    allergies: (profile.allergies || "").split(",").filter(Boolean),
    dailyBudget: profile.dailyBudget,
    targets: {
      calorieTarget: nutritionProfile.calorieTarget,
      proteinTargetG: nutritionProfile.proteinTargetG,
      carbTargetG: nutritionProfile.carbTargetG,
      fatTargetG: nutritionProfile.fatTargetG,
    },
  });

  if (Object.keys(plan.slots).length === 0) {
    return res.status(424).json({ error: "No nearby menu items matched your dietary preferences and allergies." });
  }

  for (const food of nearbyFoods) {
    await db.run(
      `INSERT INTO Food (id, name, dietType, calories, proteinG, carbsG, fatG, allergens, estPriceInr, mealSlot) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      food.id,
      food.name,
      food.dietType,
      food.calories,
      food.proteinG,
      food.carbsG,
      food.fatG,
      food.allergens,
      food.estPriceInr,
      food.mealSlot
    );
  }

  const recId = uuidv4();
  const ts = nowIso();
  await db.run(
    `INSERT INTO NutritionRecommendation (id, nutritionProfileId, createdAt, totalCalories, totalProteinG, totalCarbsG, totalFatG) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    recId,
    nutritionProfile.id,
    ts,
    Math.round(plan.totals.calories),
    plan.totals.proteinG,
    plan.totals.carbsG,
    plan.totals.fatG
  );

  for (const [slot, meal] of Object.entries(plan.slots)) {
    await db.run(`INSERT INTO Meal (id, nutritionRecommendationId, foodId, slot) VALUES (?, ?, ?, ?)`, uuidv4(), recId, meal.foodId, slot);
  }

  return res.status(201).json({
    recommendationId: recId,
    targets: {
      calorieTarget: nutritionProfile.calorieTarget,
      proteinTargetG: nutritionProfile.proteinTargetG,
      carbTargetG: nutritionProfile.carbTargetG,
      fatTargetG: nutritionProfile.fatTargetG,
    },
    plan: plan.slots,
    totals: plan.totals,
    disclaimer: DISCLAIMER,
  });
});

function inferMealSlot(name: string, index: number): string {
  const value = name.toLowerCase();
  if (/breakfast|dosa|idli|poha|paratha|omelette|pancake/.test(value)) return "breakfast";
  if (/snack|shake|juice|fruit|chaat|sandwich/.test(value)) return "snack";
  if (/dinner/.test(value)) return "dinner";
  return index % 4 === 0 ? "breakfast" : index % 4 === 1 ? "lunch" : index % 4 === 2 ? "snack" : "dinner";
}

function inferDietType(name: string): string {
  const value = name.toLowerCase();
  if (/chicken|mutton|lamb|fish|prawn|seafood|egg/.test(value)) return value.includes("egg") ? "eggetarian" : "non_vegetarian";
  if (/paneer|milk|cheese|yogurt|curd|ghee/.test(value)) return "vegetarian";
  return "vegan";
}

nutritionRouter.get("/today", async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const nutritionProfile = await db.get<any>(`SELECT * FROM NutritionProfile WHERE userId = ?`, userId);
  if (!nutritionProfile) return res.status(404).json({ error: "No nutrition profile yet" });

  const rec = await db.get<any>(
    `SELECT * FROM NutritionRecommendation WHERE nutritionProfileId = ? ORDER BY createdAt DESC LIMIT 1`,
    nutritionProfile.id
  );
  if (!rec) return res.status(404).json({ error: "No nutrition plan generated today yet. POST /nutrition/generate" });

  const meals = await db.all<any>(
    `SELECT m.slot, m.foodId, f.name, f.calories, f.proteinG, f.carbsG, f.fatG, f.estPriceInr
     FROM Meal m JOIN Food f ON f.id = m.foodId WHERE m.nutritionRecommendationId = ?`,
    rec.id
  );

  return res.json({
    recommendationId: rec.id,
    totals: {
      calories: rec.totalCalories,
      proteinG: rec.totalProteinG,
      carbsG: rec.totalCarbsG,
      fatG: rec.totalFatG,
    },
    meals,
    disclaimer: DISCLAIMER,
  });
});
