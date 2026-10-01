import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { db, nowIso } from "../../db/client";
import { requireAuth, AuthedRequest } from "../../common/auth";
import { generateDailyMealPlan, generateMealPlanFromFoods, FoodRow } from "./nutritionEngine";
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
  const verifiedFoods = nearby.places.flatMap((place) =>
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
  let dataSource: "verified-menu" | "restaurant-estimate" | "general-nutrition";
  let nearbyFoods = verifiedFoods;
  if (verifiedFoods.length > 0) {
    dataSource = "verified-menu";
  } else if (nearby.places.length > 0) {
    dataSource = "restaurant-estimate";
    nearbyFoods = nearby.places.map((place, index): FoodRow => ({
      id: uuidv4(),
      name: place.name,
      dietType: inferDietType(`${place.name} ${place.cuisines || ""}`),
      calories: estimateRestaurantCalories(place.cuisines || place.name),
      proteinG: estimateRestaurantProtein(place.cuisines || place.name),
      carbsG: 55,
      fatG: 18,
      allergens: "",
      estPriceInr: estimateCostForTwo(place.costForTwo),
      mealSlot: ["breakfast", "lunch", "snack", "dinner"][index % 4],
    }));
  } else {
    dataSource = "general-nutrition";
  }

  const plan = dataSource === "general-nutrition"
    ? await generateDailyMealPlan(db, {
        dietaryPref: profile.dietaryPref,
        allergies: (profile.allergies || "").split(",").filter(Boolean),
        dailyBudget: profile.dailyBudget,
        targets: {
          calorieTarget: nutritionProfile.calorieTarget,
          proteinTargetG: nutritionProfile.proteinTargetG,
          carbTargetG: nutritionProfile.carbTargetG,
          fatTargetG: nutritionProfile.fatTargetG,
        },
      })
    : generateMealPlanFromFoods(nearbyFoods, {
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

  console.log("Apify restaurants:", nearby.places.length);
  console.log("Verified menu items:", verifiedFoods.length);
  console.log("Meal plan data source:", dataSource);
  console.log("Generated meals:", Object.keys(plan.slots).length);

  for (const food of dataSource === "general-nutrition" ? [] : nearbyFoods) {
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
    `INSERT INTO NutritionRecommendation (id, nutritionProfileId, createdAt, totalCalories, totalProteinG, totalCarbsG, totalFatG, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    recId,
    nutritionProfile.id,
    ts,
    Math.round(plan.totals.calories),
    plan.totals.proteinG,
    plan.totals.carbsG,
    plan.totals.fatG,
    dataSource
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
    dataSource,
    sourceLabel: dataSource === "verified-menu" ? "Verified menu data" : dataSource === "restaurant-estimate" ? "Restaurant-based estimate" : "General nutrition recommendation",
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

function estimateCostForTwo(value?: string | number): number {
  const parsed = Number(String(value ?? "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed / 2 : 250;
}

function estimateRestaurantCalories(text: string): number {
  const value = text.toLowerCase();
  if (/salad|healthy|subway/.test(value)) return 400;
  if (/burrito|mexican|rice/.test(value)) return 550;
  if (/andhra|south indian|gunpowder/.test(value)) return 600;
  if (/burger|mcdonald/.test(value)) return 650;
  return 500;
}

function estimateRestaurantProtein(text: string): number {
  const value = text.toLowerCase();
  if (/chicken|paneer|protein/.test(value)) return 25;
  if (/salad|healthy|subway/.test(value)) return 20;
  return 15;
}

function inferDietType(name: string): string {
  const value = name.toLowerCase();
  if (/chicken|mutton|lamb|fish|prawn|seafood|egg/.test(value)) return value.includes("egg") ? "eggetarian" : "non_vegetarian";
  if (/paneer|milk|cheese|yogurt|curd|ghee/.test(value)) return "vegetarian";
  return "vegan";
}

nutritionRouter.get("/today", async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const started = Date.now();
  const log = (label: string) => {
    console.info(`[TRACE] GET /nutrition/today:${label} durationMs=${Date.now() - started}`);
  };

  log("profile-query:start");
  const nutritionProfile = await db.get<any>(`SELECT * FROM NutritionProfile WHERE userId = ?`, userId);
  log("profile-query:end");
  if (!nutritionProfile) return res.status(404).json({ error: "No nutrition profile yet" });

  log("recommendation-query:start");
  const rec = await db.get<any>(
    `SELECT * FROM NutritionRecommendation WHERE nutritionProfileId = ? ORDER BY createdAt DESC LIMIT 1`,
    nutritionProfile.id
  );
  log("recommendation-query:end");
  if (!rec) return res.status(404).json({ error: "No nutrition plan generated today yet. POST /nutrition/generate" });

  log("meals-query:start");
  const meals = await db.all<any>(
    `SELECT m.slot, m.foodId, f.name, f.calories, f.proteinG, f.carbsG, f.fatG, f.estPriceInr
     FROM Meal m JOIN Food f ON f.id = m.foodId WHERE m.nutritionRecommendationId = ?`,
    rec.id
  );
  log("meals-query:end");

  log("response ready");
  return res.json({
    recommendationId: rec.id,
    totals: {
      calories: rec.totalCalories,
      proteinG: rec.totalProteinG,
      carbG: rec.totalCarbsG,
      fatG: rec.totalFatG,
    },
    dataSource: rec.source || "general-nutrition",
    sourceLabel: rec.source === "verified-menu" ? "Verified menu data" : rec.source === "restaurant-estimate" ? "Restaurant-based estimate" : "General nutrition recommendation",
    meals,
    disclaimer: DISCLAIMER,
  });
});
