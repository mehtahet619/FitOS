import { v4 as uuidv4 } from "uuid";
import { db, nowIso } from "./client";
import { CANONICAL_EQUIPMENT } from "../modules/equipment/catalog";

interface ExerciseSeed {
  name: string;
  primaryMuscle: string;
  secondaryMuscles: string[];
  movementPattern: string;
  difficulty: "beginner" | "intermediate" | "advanced";
  defaultSets: number;
  repRangeLow: number;
  repRangeHigh: number;
  instructions: string;
  equipment: string[];
}

const EXERCISES: ExerciseSeed[] = [
  // CHEST
  { name: "Barbell Bench Press", primaryMuscle: "chest", secondaryMuscles: ["triceps", "shoulders"], movementPattern: "horizontal_push", difficulty: "intermediate", defaultSets: 4, repRangeLow: 6, repRangeHigh: 10, instructions: "Lie on bench, lower bar to mid-chest, press up.", equipment: ["Barbell", "Bench"] },
  { name: "Dumbbell Bench Press", primaryMuscle: "chest", secondaryMuscles: ["triceps", "shoulders"], movementPattern: "horizontal_push", difficulty: "intermediate", defaultSets: 4, repRangeLow: 8, repRangeHigh: 12, instructions: "Lie on bench, press dumbbells up over chest.", equipment: ["Dumbbells", "Bench"] },
  { name: "Incline Dumbbell Press", primaryMuscle: "chest", secondaryMuscles: ["shoulders", "triceps"], movementPattern: "horizontal_push", difficulty: "intermediate", defaultSets: 3, repRangeLow: 8, repRangeHigh: 12, instructions: "On an incline bench, press dumbbells up and slightly together.", equipment: ["Dumbbells", "Bench"] },
  { name: "Dumbbell Fly", primaryMuscle: "chest", secondaryMuscles: ["shoulders"], movementPattern: "horizontal_push", difficulty: "intermediate", defaultSets: 3, repRangeLow: 10, repRangeHigh: 15, instructions: "Lie on bench, arc dumbbells out and up with slight elbow bend.", equipment: ["Dumbbells", "Bench"] },
  { name: "Floor Dumbbell Press", primaryMuscle: "chest", secondaryMuscles: ["triceps"], movementPattern: "horizontal_push", difficulty: "beginner", defaultSets: 4, repRangeLow: 8, repRangeHigh: 12, instructions: "Lie on the floor, press dumbbells up; range of motion is shorter than a bench press.", equipment: ["Dumbbells"] },
  { name: "Cable Chest Press", primaryMuscle: "chest", secondaryMuscles: ["triceps", "shoulders"], movementPattern: "horizontal_push", difficulty: "intermediate", defaultSets: 3, repRangeLow: 10, repRangeHigh: 15, instructions: "Set cables at chest height, press handles forward and together.", equipment: ["Cable Machine"] },
  { name: "Push-ups", primaryMuscle: "chest", secondaryMuscles: ["triceps", "shoulders", "core"], movementPattern: "horizontal_push", difficulty: "beginner", defaultSets: 3, repRangeLow: 8, repRangeHigh: 20, instructions: "Hands under shoulders, lower chest to floor, press back up keeping core tight.", equipment: [] },
  { name: "Resistance Band Chest Press", primaryMuscle: "chest", secondaryMuscles: ["triceps"], movementPattern: "horizontal_push", difficulty: "beginner", defaultSets: 3, repRangeLow: 12, repRangeHigh: 20, instructions: "Anchor band behind you, press handles forward at chest height.", equipment: ["Resistance Bands"] },

  // TRICEPS
  { name: "Close-Grip Bench Press", primaryMuscle: "triceps", secondaryMuscles: ["chest", "shoulders"], movementPattern: "horizontal_push", difficulty: "intermediate", defaultSets: 3, repRangeLow: 8, repRangeHigh: 12, instructions: "Bench press with hands shoulder-width apart to bias triceps.", equipment: ["Barbell", "Bench"] },
  { name: "Cable Triceps Pushdown", primaryMuscle: "triceps", secondaryMuscles: [], movementPattern: "elbow_extension", difficulty: "beginner", defaultSets: 3, repRangeLow: 10, repRangeHigh: 15, instructions: "Push cable bar down, extending elbows fully, elbows pinned to sides.", equipment: ["Cable Machine"] },
  { name: "Overhead Dumbbell Triceps Extension", primaryMuscle: "triceps", secondaryMuscles: ["shoulders"], movementPattern: "elbow_extension", difficulty: "beginner", defaultSets: 3, repRangeLow: 10, repRangeHigh: 15, instructions: "Hold one dumbbell overhead with both hands, lower behind head, extend up.", equipment: ["Dumbbells"] },
  { name: "Diamond Push-ups", primaryMuscle: "triceps", secondaryMuscles: ["chest"], movementPattern: "elbow_extension", difficulty: "intermediate", defaultSets: 3, repRangeLow: 6, repRangeHigh: 15, instructions: "Push-up with hands close together forming a diamond shape.", equipment: [] },
  { name: "Resistance Band Triceps Pushdown", primaryMuscle: "triceps", secondaryMuscles: [], movementPattern: "elbow_extension", difficulty: "beginner", defaultSets: 3, repRangeLow: 12, repRangeHigh: 20, instructions: "Anchor band overhead, push down extending elbows.", equipment: ["Resistance Bands"] },

  // BACK
  { name: "Pull-ups", primaryMuscle: "back", secondaryMuscles: ["biceps"], movementPattern: "vertical_pull", difficulty: "advanced", defaultSets: 4, repRangeLow: 4, repRangeHigh: 10, instructions: "Hang from bar, pull chin above the bar, lower with control.", equipment: ["Pull-up Bar"] },
  { name: "Lat Pulldown", primaryMuscle: "back", secondaryMuscles: ["biceps"], movementPattern: "vertical_pull", difficulty: "beginner", defaultSets: 4, repRangeLow: 8, repRangeHigh: 12, instructions: "Pull bar down to upper chest, squeeze shoulder blades together.", equipment: ["Lat Pulldown"] },
  { name: "Barbell Bent-Over Row", primaryMuscle: "back", secondaryMuscles: ["biceps", "shoulders"], movementPattern: "horizontal_pull", difficulty: "intermediate", defaultSets: 4, repRangeLow: 6, repRangeHigh: 10, instructions: "Hinge at hips, row bar to lower ribs, keep back flat.", equipment: ["Barbell"] },
  { name: "Dumbbell Row", primaryMuscle: "back", secondaryMuscles: ["biceps"], movementPattern: "horizontal_pull", difficulty: "beginner", defaultSets: 4, repRangeLow: 8, repRangeHigh: 12, instructions: "One hand on bench, row dumbbell to hip, squeeze shoulder blade.", equipment: ["Dumbbells", "Bench"] },
  { name: "Resistance Band Row", primaryMuscle: "back", secondaryMuscles: ["biceps"], movementPattern: "horizontal_pull", difficulty: "beginner", defaultSets: 3, repRangeLow: 12, repRangeHigh: 20, instructions: "Anchor band in front, row handles to ribs, squeeze shoulder blades.", equipment: ["Resistance Bands"] },
  { name: "Inverted Row", primaryMuscle: "back", secondaryMuscles: ["biceps", "core"], movementPattern: "horizontal_pull", difficulty: "intermediate", defaultSets: 3, repRangeLow: 8, repRangeHigh: 15, instructions: "Under a low bar, pull chest to bar keeping body straight.", equipment: ["Pull-up Bar"] },
  { name: "Superman Rows (Bodyweight)", primaryMuscle: "back", secondaryMuscles: ["core"], movementPattern: "horizontal_pull", difficulty: "beginner", defaultSets: 3, repRangeLow: 10, repRangeHigh: 20, instructions: "Lie face down, lift chest and arms, pull elbows back like rowing.", equipment: [] },

  // BICEPS
  { name: "Barbell Curl", primaryMuscle: "biceps", secondaryMuscles: [], movementPattern: "elbow_flexion", difficulty: "beginner", defaultSets: 3, repRangeLow: 8, repRangeHigh: 12, instructions: "Curl bar up keeping elbows pinned to sides.", equipment: ["Barbell"] },
  { name: "Dumbbell Curl", primaryMuscle: "biceps", secondaryMuscles: [], movementPattern: "elbow_flexion", difficulty: "beginner", defaultSets: 3, repRangeLow: 8, repRangeHigh: 12, instructions: "Curl dumbbells up alternating or together, control the descent.", equipment: ["Dumbbells"] },
  { name: "Resistance Band Curl", primaryMuscle: "biceps", secondaryMuscles: [], movementPattern: "elbow_flexion", difficulty: "beginner", defaultSets: 3, repRangeLow: 12, repRangeHigh: 20, instructions: "Stand on band, curl handles up keeping elbows fixed.", equipment: ["Resistance Bands"] },
  { name: "Chin-ups", primaryMuscle: "back", secondaryMuscles: ["biceps"], movementPattern: "vertical_pull", difficulty: "advanced", defaultSets: 3, repRangeLow: 4, repRangeHigh: 10, instructions: "Underhand-grip vertical pull. Trains the lats and upper back, with the biceps assisting.", equipment: ["Pull-up Bar"] },

  // LEGS - quads
  { name: "Barbell Back Squat", primaryMuscle: "quads", secondaryMuscles: ["glutes", "hamstrings"], movementPattern: "squat", difficulty: "intermediate", defaultSets: 4, repRangeLow: 5, repRangeHigh: 10, instructions: "Bar on upper back, squat to depth, drive up through heels.", equipment: ["Barbell", "Squat Rack"] },
  { name: "Smith Machine Squat", primaryMuscle: "quads", secondaryMuscles: ["glutes"], movementPattern: "squat", difficulty: "beginner", defaultSets: 4, repRangeLow: 8, repRangeHigh: 12, instructions: "Squat under the fixed bar path of the smith machine.", equipment: ["Smith Machine"] },
  { name: "Leg Press", primaryMuscle: "quads", secondaryMuscles: ["glutes"], movementPattern: "squat", difficulty: "beginner", defaultSets: 4, repRangeLow: 8, repRangeHigh: 12, instructions: "Press platform away by extending knees and hips.", equipment: ["Leg Press"] },
  { name: "Goblet Squat", primaryMuscle: "quads", secondaryMuscles: ["glutes", "core"], movementPattern: "squat", difficulty: "beginner", defaultSets: 4, repRangeLow: 8, repRangeHigh: 15, instructions: "Hold one dumbbell at chest, squat down between knees.", equipment: ["Dumbbells"] },
  { name: "Bodyweight Squat", primaryMuscle: "quads", secondaryMuscles: ["glutes"], movementPattern: "squat", difficulty: "beginner", defaultSets: 4, repRangeLow: 12, repRangeHigh: 25, instructions: "Feet shoulder-width, squat down keeping chest up, drive up.", equipment: [] },
  { name: "Walking Lunges", primaryMuscle: "quads", secondaryMuscles: ["glutes", "hamstrings"], movementPattern: "lunge", difficulty: "beginner", defaultSets: 3, repRangeLow: 10, repRangeHigh: 20, instructions: "Step forward into a lunge, alternate legs walking forward.", equipment: [] },

  // LEGS - hamstrings/glutes
  { name: "Barbell Romanian Deadlift", primaryMuscle: "hamstrings", secondaryMuscles: ["glutes", "back"], movementPattern: "hinge", difficulty: "intermediate", defaultSets: 4, repRangeLow: 6, repRangeHigh: 10, instructions: "Hinge at hips keeping bar close to legs, feel hamstring stretch, drive hips forward.", equipment: ["Barbell"] },
  { name: "Dumbbell Romanian Deadlift", primaryMuscle: "hamstrings", secondaryMuscles: ["glutes"], movementPattern: "hinge", difficulty: "beginner", defaultSets: 4, repRangeLow: 8, repRangeHigh: 12, instructions: "Hinge at hips holding dumbbells close to legs, drive hips forward to stand.", equipment: ["Dumbbells"] },
  { name: "Glute Bridge", primaryMuscle: "glutes", secondaryMuscles: ["hamstrings"], movementPattern: "hinge", difficulty: "beginner", defaultSets: 3, repRangeLow: 12, repRangeHigh: 20, instructions: "Lie on back, feet planted, drive hips up squeezing glutes.", equipment: [] },
  { name: "Single-Leg Glute Bridge", primaryMuscle: "glutes", secondaryMuscles: ["hamstrings"], movementPattern: "hinge", difficulty: "intermediate", defaultSets: 3, repRangeLow: 10, repRangeHigh: 15, instructions: "Glute bridge with one leg extended straight out.", equipment: [] },

  // CALVES
  { name: "Standing Calf Raise (Barbell)", primaryMuscle: "calves", secondaryMuscles: [], movementPattern: "plantarflexion", difficulty: "beginner", defaultSets: 4, repRangeLow: 12, repRangeHigh: 20, instructions: "Bar on back, rise onto toes, lower slowly.", equipment: ["Barbell"] },
  { name: "Bodyweight Calf Raise", primaryMuscle: "calves", secondaryMuscles: [], movementPattern: "plantarflexion", difficulty: "beginner", defaultSets: 4, repRangeLow: 15, repRangeHigh: 25, instructions: "Rise onto toes, pause, lower slowly. Add a step edge for range.", equipment: [] },

  // SHOULDERS
  { name: "Barbell Overhead Press", primaryMuscle: "shoulders", secondaryMuscles: ["triceps"], movementPattern: "vertical_push", difficulty: "intermediate", defaultSets: 4, repRangeLow: 6, repRangeHigh: 10, instructions: "Press bar from shoulders to overhead, keep core tight.", equipment: ["Barbell"] },
  { name: "Dumbbell Shoulder Press", primaryMuscle: "shoulders", secondaryMuscles: ["triceps"], movementPattern: "vertical_push", difficulty: "beginner", defaultSets: 4, repRangeLow: 8, repRangeHigh: 12, instructions: "Press dumbbells from shoulder height straight overhead.", equipment: ["Dumbbells"] },
  { name: "Resistance Band Overhead Press", primaryMuscle: "shoulders", secondaryMuscles: ["triceps"], movementPattern: "vertical_push", difficulty: "beginner", defaultSets: 3, repRangeLow: 12, repRangeHigh: 20, instructions: "Stand on band, press handles from shoulders overhead.", equipment: ["Resistance Bands"] },
  { name: "Pike Push-ups", primaryMuscle: "shoulders", secondaryMuscles: ["triceps"], movementPattern: "vertical_push", difficulty: "intermediate", defaultSets: 3, repRangeLow: 6, repRangeHigh: 15, instructions: "Hips high in an inverted-V, lower head toward floor, press back up.", equipment: [] },
  { name: "Dumbbell Lateral Raise", primaryMuscle: "shoulders", secondaryMuscles: [], movementPattern: "abduction", difficulty: "beginner", defaultSets: 3, repRangeLow: 12, repRangeHigh: 15, instructions: "Raise dumbbells out to the sides to shoulder height.", equipment: ["Dumbbells"] },
  { name: "Resistance Band Lateral Raise", primaryMuscle: "shoulders", secondaryMuscles: [], movementPattern: "abduction", difficulty: "beginner", defaultSets: 3, repRangeLow: 12, repRangeHigh: 20, instructions: "Stand on band, raise handles out to sides.", equipment: ["Resistance Bands"] },

  // CORE
  { name: "Plank", primaryMuscle: "core", secondaryMuscles: ["shoulders"], movementPattern: "anti_extension", difficulty: "beginner", defaultSets: 3, repRangeLow: 1, repRangeHigh: 1, instructions: "Hold a straight-body plank on forearms for time.", equipment: [] },
  { name: "Hanging Leg Raise", primaryMuscle: "core", secondaryMuscles: [], movementPattern: "flexion", difficulty: "advanced", defaultSets: 3, repRangeLow: 8, repRangeHigh: 15, instructions: "Hang from bar, raise legs to hip height or higher with control.", equipment: ["Pull-up Bar"] },
  { name: "Cable Woodchopper", primaryMuscle: "core", secondaryMuscles: ["shoulders"], movementPattern: "rotation", difficulty: "intermediate", defaultSets: 3, repRangeLow: 10, repRangeHigh: 15, instructions: "Pull cable diagonally across body, rotating through the torso.", equipment: ["Cable Machine"] },
  { name: "Bicycle Crunch", primaryMuscle: "core", secondaryMuscles: [], movementPattern: "flexion_rotation", difficulty: "beginner", defaultSets: 3, repRangeLow: 15, repRangeHigh: 25, instructions: "Alternate elbow to opposite knee in a cycling motion.", equipment: [] },
  { name: "Mountain Climbers", primaryMuscle: "core", secondaryMuscles: ["shoulders"], movementPattern: "dynamic", difficulty: "beginner", defaultSets: 3, repRangeLow: 20, repRangeHigh: 40, instructions: "In plank position, drive knees toward chest alternately at pace.", equipment: [] },
];

// (baseExerciseName, [substituteName in priority order])
const SUBSTITUTIONS: [string, string[]][] = [
  ["Barbell Bench Press", ["Dumbbell Bench Press", "Floor Dumbbell Press", "Cable Chest Press", "Push-ups", "Resistance Band Chest Press"]],
  ["Dumbbell Bench Press", ["Floor Dumbbell Press", "Barbell Bench Press", "Cable Chest Press", "Push-ups", "Resistance Band Chest Press"]],
  ["Incline Dumbbell Press", ["Push-ups", "Cable Chest Press", "Resistance Band Chest Press"]],
  ["Dumbbell Fly", ["Cable Chest Press", "Push-ups", "Resistance Band Chest Press"]],
  ["Close-Grip Bench Press", ["Diamond Push-ups", "Cable Triceps Pushdown", "Overhead Dumbbell Triceps Extension"]],
  ["Cable Triceps Pushdown", ["Overhead Dumbbell Triceps Extension", "Resistance Band Triceps Pushdown", "Diamond Push-ups"]],
  ["Pull-ups", ["Lat Pulldown", "Inverted Row", "Dumbbell Row", "Resistance Band Row", "Superman Rows (Bodyweight)"]],
  ["Lat Pulldown", ["Pull-ups", "Inverted Row", "Dumbbell Row", "Resistance Band Row"]],
  ["Barbell Bent-Over Row", ["Dumbbell Row", "Resistance Band Row", "Inverted Row", "Superman Rows (Bodyweight)"]],
  ["Barbell Curl", ["Dumbbell Curl", "Resistance Band Curl"]],
  ["Dumbbell Curl", ["Barbell Curl", "Resistance Band Curl"]],
  ["Barbell Back Squat", ["Smith Machine Squat", "Leg Press", "Goblet Squat", "Bodyweight Squat", "Walking Lunges"]],
  ["Smith Machine Squat", ["Barbell Back Squat", "Leg Press", "Goblet Squat", "Bodyweight Squat"]],
  ["Leg Press", ["Barbell Back Squat", "Goblet Squat", "Bodyweight Squat", "Walking Lunges"]],
  ["Goblet Squat", ["Bodyweight Squat", "Walking Lunges", "Barbell Back Squat"]],
  ["Barbell Romanian Deadlift", ["Dumbbell Romanian Deadlift", "Glute Bridge", "Single-Leg Glute Bridge"]],
  ["Dumbbell Romanian Deadlift", ["Barbell Romanian Deadlift", "Glute Bridge", "Single-Leg Glute Bridge"]],
  ["Standing Calf Raise (Barbell)", ["Bodyweight Calf Raise"]],
  ["Barbell Overhead Press", ["Dumbbell Shoulder Press", "Resistance Band Overhead Press", "Pike Push-ups"]],
  ["Dumbbell Shoulder Press", ["Resistance Band Overhead Press", "Pike Push-ups", "Barbell Overhead Press"]],
  ["Dumbbell Lateral Raise", ["Resistance Band Lateral Raise"]],
  ["Hanging Leg Raise", ["Bicycle Crunch", "Mountain Climbers", "Plank"]],
  ["Cable Woodchopper", ["Bicycle Crunch", "Mountain Climbers"]],
];

const FOODS: {
  name: string;
  dietType: "vegetarian" | "vegan" | "non_vegetarian" | "eggetarian";
  calories: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  allergens: string[];
  estPriceInr: number;
  mealSlot: "breakfast" | "lunch" | "snack" | "dinner";
}[] = [
  { name: "Greek Yogurt with Berries & Oats", dietType: "vegetarian", calories: 320, proteinG: 22, carbsG: 40, fatG: 8, allergens: ["dairy"], estPriceInr: 120, mealSlot: "breakfast" },
  { name: "Tofu Scramble with Veggies", dietType: "vegan", calories: 300, proteinG: 20, carbsG: 20, fatG: 15, allergens: ["soy"], estPriceInr: 140, mealSlot: "breakfast" },
  { name: "Masala Egg Bhurji with Toast", dietType: "eggetarian", calories: 380, proteinG: 24, carbsG: 30, fatG: 18, allergens: ["egg", "gluten"], estPriceInr: 100, mealSlot: "breakfast" },
  { name: "Chicken Sausage & Egg Wrap", dietType: "non_vegetarian", calories: 420, proteinG: 30, carbsG: 35, fatG: 16, allergens: ["egg", "gluten"], estPriceInr: 160, mealSlot: "breakfast" },
  { name: "Peanut Butter Banana Smoothie", dietType: "vegan", calories: 350, proteinG: 15, carbsG: 45, fatG: 12, allergens: ["peanut"], estPriceInr: 110, mealSlot: "breakfast" },
  { name: "Paneer Bhurji with Roti", dietType: "vegetarian", calories: 450, proteinG: 26, carbsG: 40, fatG: 20, allergens: ["dairy", "gluten"], estPriceInr: 150, mealSlot: "lunch" },
  { name: "Grilled Chicken Rice Bowl", dietType: "non_vegetarian", calories: 520, proteinG: 40, carbsG: 55, fatG: 12, allergens: [], estPriceInr: 220, mealSlot: "lunch" },
  { name: "Rajma Chawal", dietType: "vegan", calories: 480, proteinG: 18, carbsG: 80, fatG: 8, allergens: [], estPriceInr: 130, mealSlot: "lunch" },
  { name: "Chickpea & Veg Salad Bowl", dietType: "vegan", calories: 400, proteinG: 20, carbsG: 45, fatG: 14, allergens: [], estPriceInr: 170, mealSlot: "lunch" },
  { name: "Egg Curry with Rice", dietType: "eggetarian", calories: 500, proteinG: 26, carbsG: 60, fatG: 16, allergens: ["egg"], estPriceInr: 150, mealSlot: "lunch" },
  { name: "Fish Curry with Brown Rice", dietType: "non_vegetarian", calories: 490, proteinG: 35, carbsG: 50, fatG: 14, allergens: ["fish"], estPriceInr: 240, mealSlot: "lunch" },
  { name: "Roasted Chana", dietType: "vegan", calories: 180, proteinG: 10, carbsG: 25, fatG: 4, allergens: [], estPriceInr: 40, mealSlot: "snack" },
  { name: "Protein Shake (Whey)", dietType: "vegetarian", calories: 160, proteinG: 25, carbsG: 8, fatG: 2, allergens: ["dairy"], estPriceInr: 90, mealSlot: "snack" },
  { name: "Vegan Protein Shake", dietType: "vegan", calories: 150, proteinG: 22, carbsG: 10, fatG: 2, allergens: ["soy"], estPriceInr: 100, mealSlot: "snack" },
  { name: "Boiled Eggs (2) with Salt & Pepper", dietType: "eggetarian", calories: 160, proteinG: 13, carbsG: 1, fatG: 11, allergens: ["egg"], estPriceInr: 30, mealSlot: "snack" },
  { name: "Mixed Nuts", dietType: "vegan", calories: 200, proteinG: 6, carbsG: 8, fatG: 17, allergens: ["nuts"], estPriceInr: 80, mealSlot: "snack" },
  { name: "Grilled Paneer Tikka", dietType: "vegetarian", calories: 420, proteinG: 28, carbsG: 15, fatG: 26, allergens: ["dairy"], estPriceInr: 200, mealSlot: "dinner" },
  { name: "Tandoori Chicken with Salad", dietType: "non_vegetarian", calories: 460, proteinG: 42, carbsG: 12, fatG: 22, allergens: [], estPriceInr: 260, mealSlot: "dinner" },
  { name: "Dal Tadka with Quinoa", dietType: "vegan", calories: 430, proteinG: 20, carbsG: 60, fatG: 8, allergens: [], estPriceInr: 140, mealSlot: "dinner" },
  { name: "Egg White Omelette with Veggies", dietType: "eggetarian", calories: 320, proteinG: 30, carbsG: 10, fatG: 14, allergens: ["egg"], estPriceInr: 130, mealSlot: "dinner" },
  { name: "Grilled Fish with Steamed Veggies", dietType: "non_vegetarian", calories: 440, proteinG: 38, carbsG: 15, fatG: 20, allergens: ["fish"], estPriceInr: 280, mealSlot: "dinner" },
];

async function main() {
  console.log("Seeding equipment...");
  const equipmentByName: Record<string, string> = {};
  for (const name of CANONICAL_EQUIPMENT) {
    await db.run(`INSERT INTO Equipment (id, name, isCustom) VALUES (?, ?, 0) ON CONFLICT(name) DO NOTHING`, uuidv4(), name);
    const row = await db.get<{ id: string }>(`SELECT id FROM Equipment WHERE name = ?`, name);
    if (!row) throw new Error(`Equipment seed failed for ${name}`);
    equipmentByName[name] = row.id;
  }

  console.log("Seeding exercises...");
  const exerciseByName: Record<string, string> = {};
  const ts = nowIso();
  for (const ex of EXERCISES) {
    const id = uuidv4();
    const requiresEquipment = ex.equipment.length > 0 ? 1 : 0;
    await db.run(
      `INSERT INTO Exercise (id, name, primaryMuscle, secondaryMuscles, movementPattern, difficulty, defaultSets, repRangeLow, repRangeHigh, instructions, requiresEquipment, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(name) DO NOTHING`,
      id,
      ex.name,
      ex.primaryMuscle,
      ex.secondaryMuscles.join(","),
      ex.movementPattern,
      ex.difficulty,
      ex.defaultSets,
      ex.repRangeLow,
      ex.repRangeHigh,
      ex.instructions,
      requiresEquipment,
      ts
    );
    const row = await db.get<{ id: string }>(`SELECT id FROM Exercise WHERE name = ?`, ex.name);
    if (!row) throw new Error(`Exercise seed failed for ${ex.name}`);
    exerciseByName[ex.name] = row.id;
    for (const eqName of ex.equipment) {
      await db.run(`INSERT INTO ExerciseEquipment (id, exerciseId, equipmentId) VALUES (?, ?, ?) ON CONFLICT(exerciseId, equipmentId) DO NOTHING`, uuidv4(), row.id, equipmentByName[eqName]);
    }
  }

  console.log("Seeding substitution graph...");
  for (const [baseName, subs] of SUBSTITUTIONS) {
    const baseId = exerciseByName[baseName];
    if (!baseId) continue;
    for (let i = 0; i < subs.length; i++) {
      const subId = exerciseByName[subs[i]];
      if (!subId) continue;
      await db.run(`INSERT INTO ExerciseSubstitution (id, baseExerciseId, substituteId, priority) VALUES (?, ?, ?, ?) ON CONFLICT(baseExerciseId, substituteId) DO UPDATE SET priority = excluded.priority`, uuidv4(), baseId, subId, i);
    }
  }

  console.log("Seeding foods...");
  for (const f of FOODS) {
    await db.run(
      `INSERT INTO Food (id, name, dietType, calories, proteinG, carbsG, fatG, allergens, estPriceInr, mealSlot)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      uuidv4(),
      f.name,
      f.dietType,
      f.calories,
      f.proteinG,
      f.carbsG,
      f.fatG,
      f.allergens.join(","),
      f.estPriceInr,
      f.mealSlot
    );
  }

  console.log("Seed complete.");
}

try {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
} catch (e) {
  console.error(e);
  process.exit(1);
}
