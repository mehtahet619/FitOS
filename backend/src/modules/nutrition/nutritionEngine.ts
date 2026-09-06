import type { DatabaseLike } from "../../db/types";

export interface MacroTargets {
  calorieTarget: number;
  proteinTargetG: number;
  carbTargetG: number;
  fatTargetG: number;
}

/**
 * Mifflin-St Jeor BMR + activity multiplier + goal adjustment. This is a
 * general wellness estimate, not a medical calculation — surfaced with a
 * disclaimer at the API layer.
 */
export function computeMacroTargets(profile: {
  weightKg: number;
  heightCm: number;
  age: number;
  gender: string;
  daysPerWeek: number;
  primaryGoal: string;
}): MacroTargets {
  const { weightKg, heightCm, age, gender, daysPerWeek, primaryGoal } = profile;

  const bmr =
    gender.toLowerCase() === "male"
      ? 10 * weightKg + 6.25 * heightCm - 5 * age + 5
      : 10 * weightKg + 6.25 * heightCm - 5 * age - 161;

  const activityMultiplier = daysPerWeek >= 6 ? 1.7 : daysPerWeek >= 4 ? 1.55 : daysPerWeek >= 2 ? 1.375 : 1.2;
  let calories = bmr * activityMultiplier;

  let proteinPerKg = 1.6;
  switch (primaryGoal) {
    case "fat_loss":
      calories -= 400;
      proteinPerKg = 2.0;
      break;
    case "muscle_gain":
      calories += 300;
      proteinPerKg = 1.8;
      break;
    case "strength":
      proteinPerKg = 1.8;
      break;
    case "endurance":
      proteinPerKg = 1.4;
      break;
    default:
      proteinPerKg = 1.6;
  }

  calories = Math.max(1200, Math.round(calories));
  const proteinTargetG = Math.round(weightKg * proteinPerKg);
  const fatTargetG = Math.round((calories * 0.25) / 9);
  const remainingCalories = calories - proteinTargetG * 4 - fatTargetG * 9;
  const carbTargetG = Math.max(0, Math.round(remainingCalories / 4));

  return { calorieTarget: calories, proteinTargetG, carbTargetG, fatTargetG };
}

export interface MealSlotResult {
  foodId: string;
  name: string;
  calories: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  estPriceInr: number;
}

export interface MealPlanResult {
  slots: Record<string, MealSlotResult>;
  totals: { calories: number; proteinG: number; carbsG: number; fatG: number; estPriceInr: number };
}

interface FoodRow {
  id: string;
  name: string;
  dietType: string;
  calories: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  allergens: string;
  estPriceInr: number;
  mealSlot: string;
}

// dietType filtering: vegan is a subset of vegetarian, etc. Since the Food
// table stores a single dietType per row we accept a compatible-category
// list rather than a strict equality.
function compatibleDietTypes(pref: string): string[] {
  const map: Record<string, string[]> = {
    vegan: ["vegan"],
    vegetarian: ["vegan", "vegetarian"],
    eggetarian: ["vegan", "vegetarian", "eggetarian"],
    non_vegetarian: ["vegan", "vegetarian", "eggetarian", "non_vegetarian"],
  };
  return map[pref] ?? ["vegetarian"];
}

/**
 * Picks one food per meal slot from the seeded Food table, filtered by diet
 * type, allergens, and budget, greedily choosing the option that best fits
 * the remaining calorie budget for that slot. Deterministic — no LLM
 * involved.
 */
export async function generateDailyMealPlan(
  database: DatabaseLike,
  input: {
    dietaryPref: string;
    allergies: string[];
    dailyBudget: number;
    targets: MacroTargets;
  }
): Promise<MealPlanResult> {
  const slots = ["breakfast", "lunch", "snack", "dinner"];
  const slotCalorieShare: Record<string, number> = {
    breakfast: 0.25,
    lunch: 0.35,
    snack: 0.1,
    dinner: 0.3,
  };

  const result: MealPlanResult = {
    slots: {},
    totals: { calories: 0, proteinG: 0, carbsG: 0, fatG: 0, estPriceInr: 0 },
  };

  const perSlotBudget = input.dailyBudget / slots.length;
  const dietTypes = compatibleDietTypes(input.dietaryPref);
  const allergies = input.allergies.filter((a) => a.trim() !== "");

  for (const slot of slots) {
    const placeholders = dietTypes.map(() => "?").join(",");
    const candidates = await database.all<FoodRow>(
      `SELECT * FROM Food WHERE mealSlot = ? AND dietType IN (${placeholders})`,
      slot,
      ...dietTypes
    );

    const filtered = candidates.filter(
      (f) => !allergies.some((a) => f.allergens.toLowerCase().includes(a.toLowerCase()))
    );

    if (filtered.length === 0) continue;

    const targetCalForSlot = input.targets.calorieTarget * slotCalorieShare[slot];
    const best = filtered.reduce((closest, f) => {
      const closestDelta =
        Math.abs(closest.calories - targetCalForSlot) + (closest.estPriceInr > perSlotBudget ? 500 : 0);
      const fDelta = Math.abs(f.calories - targetCalForSlot) + (f.estPriceInr > perSlotBudget ? 500 : 0);
      return fDelta < closestDelta ? f : closest;
    });

    result.slots[slot] = {
      foodId: best.id,
      name: best.name,
      calories: best.calories,
      proteinG: best.proteinG,
      carbsG: best.carbsG,
      fatG: best.fatG,
      estPriceInr: best.estPriceInr,
    };
    result.totals.calories += best.calories;
    result.totals.proteinG += best.proteinG;
    result.totals.carbsG += best.carbsG;
    result.totals.fatG += best.fatG;
    result.totals.estPriceInr += best.estPriceInr;
  }

  return result;
}
