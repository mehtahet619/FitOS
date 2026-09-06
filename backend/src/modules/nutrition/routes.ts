import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { db, nowIso } from "../../db/client";
import { requireAuth, AuthedRequest } from "../../common/auth";
import { generateDailyMealPlan } from "./nutritionEngine";

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

  const plan = await generateDailyMealPlan(db, {
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
