import { describe, it, expect } from "vitest";
import { isPerformable, pickSubstitute, ExerciseWithLinks } from "../modules/exercises/substitutionEngine";
import { computeMacroTargets } from "../modules/nutrition/nutritionEngine";
import { scorePlace, DEFAULT_WEIGHTS } from "../modules/food/rankRestaurants";

function ex(overrides: Partial<ExerciseWithLinks>): ExerciseWithLinks {
  return {
    id: overrides.id ?? Math.random().toString(),
    name: overrides.name ?? "Exercise",
    primaryMuscle: overrides.primaryMuscle ?? "chest",
    secondaryMuscles: overrides.secondaryMuscles ?? "",
    movementPattern: overrides.movementPattern ?? "horizontal_push",
    difficulty: overrides.difficulty ?? "intermediate",
    defaultSets: overrides.defaultSets ?? 3,
    repRangeLow: overrides.repRangeLow ?? 8,
    repRangeHigh: overrides.repRangeHigh ?? 12,
    instructions: overrides.instructions ?? "",
    requiredEquipmentIds: overrides.requiredEquipmentIds ?? [],
  };
}

describe("isPerformable", () => {
  it("is true when all required equipment is available", () => {
    expect(isPerformable(["dumbbell", "bench"], new Set(["dumbbell", "bench", "barbell"]))).toBe(true);
  });

  it("is false when any required equipment is missing", () => {
    expect(isPerformable(["dumbbell", "bench"], new Set(["dumbbell"]))).toBe(false);
  });

  it("is always true for bodyweight exercises (no equipment required)", () => {
    expect(isPerformable([], new Set())).toBe(true);
  });
});

describe("pickSubstitute — the core adaptive-equipment promise", () => {
  it("swaps Dumbbell Bench Press -> Floor Dumbbell Press when the bench is removed", () => {
    const base = ex({
      name: "Dumbbell Bench Press",
      primaryMuscle: "chest",
      movementPattern: "horizontal_push",
      requiredEquipmentIds: ["dumbbell", "bench"],
    });
    const floorPress = ex({
      name: "Floor Dumbbell Press",
      primaryMuscle: "chest",
      movementPattern: "horizontal_push",
      difficulty: "beginner",
      requiredEquipmentIds: ["dumbbell"],
    });
    const pushups = ex({
      name: "Push-ups",
      primaryMuscle: "chest",
      movementPattern: "horizontal_push",
      difficulty: "beginner",
      requiredEquipmentIds: [],
    });

    // User has dumbbells but no bench.
    const available = new Set(["dumbbell"]);
    const result = pickSubstitute(base, [floorPress, pushups], available);

    expect(result?.name).toBe("Floor Dumbbell Press");
  });

  it("falls all the way to Push-ups when the user has no equipment at all", () => {
    const base = ex({ name: "Dumbbell Bench Press", primaryMuscle: "chest", requiredEquipmentIds: ["dumbbell", "bench"] });
    const floorPress = ex({ name: "Floor Dumbbell Press", primaryMuscle: "chest", requiredEquipmentIds: ["dumbbell"] });
    const pushups = ex({ name: "Push-ups", primaryMuscle: "chest", requiredEquipmentIds: [] });

    const result = pickSubstitute(base, [floorPress, pushups], new Set());
    expect(result?.name).toBe("Push-ups");
  });

  it("never returns a substitute that changes the primary muscle group", () => {
    const base = ex({ name: "Barbell Bench Press", primaryMuscle: "chest", requiredEquipmentIds: ["barbell", "bench"] });
    // A bicep curl is performable but must NEVER be offered as a chest substitute.
    const curl = ex({ name: "Dumbbell Curl", primaryMuscle: "biceps", requiredEquipmentIds: ["dumbbell"] });

    const result = pickSubstitute(base, [curl], new Set(["dumbbell"]));
    expect(result).toBeNull();
  });

  it("returns null when nothing in the candidate list is performable", () => {
    const base = ex({ name: "Barbell Back Squat", primaryMuscle: "quads", requiredEquipmentIds: ["barbell", "squat_rack"] });
    const legPress = ex({ name: "Leg Press", primaryMuscle: "quads", requiredEquipmentIds: ["leg_press_machine"] });

    const result = pickSubstitute(base, [legPress], new Set(["dumbbell"]));
    expect(result).toBeNull();
  });

  it("prefers the same movement pattern when multiple performable options preserve the muscle group", () => {
    const base = ex({
      name: "Barbell Bench Press",
      primaryMuscle: "chest",
      movementPattern: "horizontal_push",
      difficulty: "intermediate",
      requiredEquipmentIds: ["barbell", "bench"],
    });
    const flyMachine = ex({
      name: "Pec Deck Fly",
      primaryMuscle: "chest",
      movementPattern: "fly",
      difficulty: "beginner",
      requiredEquipmentIds: [],
    });
    const pushups = ex({
      name: "Push-ups",
      primaryMuscle: "chest",
      movementPattern: "horizontal_push",
      difficulty: "beginner",
      requiredEquipmentIds: [],
    });

    const result = pickSubstitute(base, [flyMachine, pushups], new Set());
    expect(result?.name).toBe("Push-ups");
  });
});

describe("computeMacroTargets", () => {
  it("reduces calories and raises protein-per-kg for a fat_loss goal", () => {
    const maintenance = computeMacroTargets({
      weightKg: 80,
      heightCm: 178,
      age: 28,
      gender: "male",
      daysPerWeek: 4,
      primaryGoal: "general_fitness",
    });
    const fatLoss = computeMacroTargets({
      weightKg: 80,
      heightCm: 178,
      age: 28,
      gender: "male",
      daysPerWeek: 4,
      primaryGoal: "fat_loss",
    });

    expect(fatLoss.calorieTarget).toBeLessThan(maintenance.calorieTarget);
    expect(fatLoss.proteinTargetG).toBeGreaterThan(maintenance.proteinTargetG);
  });

  it("never returns calories below the 1200 floor", () => {
    const targets = computeMacroTargets({
      weightKg: 40,
      heightCm: 150,
      age: 60,
      gender: "female",
      daysPerWeek: 1,
      primaryGoal: "fat_loss",
    });
    expect(targets.calorieTarget).toBeGreaterThanOrEqual(1200);
  });
});

describe("rankRestaurants scoring", () => {
  const place = {
    id: "1",
    name: "Test Place",
    distanceKm: 0.4,
    rating: 4.5,
    priceRange: "$$",
    isOpenNow: true,
    latitude: 0,
    longitude: 0,
    dishes: [{ name: "Chicken Rice Bowl", estPriceInr: 220 }],
    source: "test",
  };

  it("scores a close, well-matched, open restaurant higher than a far, closed one", () => {
    const good = scorePlace({ place, foodMatchScore: 0.9, userBudgetInr: 300 }, DEFAULT_WEIGHTS);
    const bad = scorePlace(
      { place: { ...place, distanceKm: 6, isOpenNow: false, rating: 2 }, foodMatchScore: 0.9, userBudgetInr: 300 },
      DEFAULT_WEIGHTS
    );
    expect(good).toBeGreaterThan(bad);
  });
});
