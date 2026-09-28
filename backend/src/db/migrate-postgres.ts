import fs from "fs";
import path from "path";
import { PostgresDatabase } from "./postgres";
import { v4 as uuidv4 } from "uuid";

async function main() {
  const database = new PostgresDatabase();
  const schemaPath = path.resolve(__dirname, "../../src/db/schema.sql");
  const schema = fs
    .readFileSync(schemaPath, "utf-8")
    .replace(/^PRAGMA[^;]+;\s*/gim, "")
    .replace(/\bUser\b/g, '"User"');

  await database.exec(schema);
  await database.exec(`ALTER TABLE NutritionRecommendation ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'general-nutrition'`);
  await database.exec(`ALTER TABLE WorkoutPlanState ADD COLUMN IF NOT EXISTS cycleId TEXT`);
  await database.exec(`ALTER TABLE Equipment ADD COLUMN IF NOT EXISTS normalizedName TEXT`);
  await database.exec(`ALTER TABLE Equipment ADD COLUMN IF NOT EXISTS category TEXT`);
  await database.exec(`ALTER TABLE Exercise ADD COLUMN IF NOT EXISTS imageUrl TEXT`);
  await database.exec(`
    CREATE TABLE IF NOT EXISTS WorkoutCycleHistory (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL REFERENCES "User"(id),
      cycleId TEXT NOT NULL,
      structureKey TEXT NOT NULL,
      unitsJson TEXT NOT NULL,
      startedAt TEXT NOT NULL,
      completedAt TEXT NOT NULL
    )
  `);

  // Migrate existing Exercise.secondaryMuscles to ExerciseMuscle table
  await migrateExerciseMuscles(database);

  // Populate Equipment normalizedName and category
  await normalizeEquipment(database);

  // Seed Muscle table
  await seedMuscles(database);

  await database.close();
  console.log("PostgreSQL migration applied.");
}

async function migrateExerciseMuscles(database: PostgresDatabase) {
  const exercises = await database.all<{ id: string; primaryMuscle: string; secondaryMuscles: string }>(
    `SELECT id, primaryMuscle, secondaryMuscles FROM Exercise`
  );

  for (const ex of exercises) {
    // Ensure muscle exists
    await database.run(
      `INSERT INTO Muscle (id, name, category) VALUES (?, ?, 'unknown')
       ON CONFLICT(name) DO NOTHING`,
      uuidv4(), ex.primaryMuscle
    );
    const primaryMuscle = await database.get<{ id: string }>(`SELECT id FROM Muscle WHERE name = ?`, ex.primaryMuscle);
    if (primaryMuscle) {
      await database.run(
        `INSERT INTO ExerciseMuscle (id, exerciseId, muscleId, role, weight) VALUES (?, ?, ?, 'PRIMARY', 1.0)
         ON CONFLICT(exerciseId, muscleId, role) DO NOTHING`,
        uuidv4(), ex.id, primaryMuscle.id
      );
    }

    if (ex.secondaryMuscles) {
      const secondaryMuscles = ex.secondaryMuscles.split(",").filter(Boolean);
      for (const muscleName of secondaryMuscles) {
        await database.run(
          `INSERT INTO Muscle (id, name, category) VALUES (?, ?, 'unknown')
           ON CONFLICT(name) DO NOTHING`,
          uuidv4(), muscleName
        );
        const muscle = await database.get<{ id: string }>(`SELECT id FROM Muscle WHERE name = ?`, muscleName);
        if (muscle) {
          await database.run(
            `INSERT INTO ExerciseMuscle (id, exerciseId, muscleId, role, weight) VALUES (?, ?, ?, 'SECONDARY', 0.5)
             ON CONFLICT(exerciseId, muscleId, role) DO NOTHING`,
            uuidv4(), ex.id, muscle.id
          );
        }
      }
    }
  }
  console.log("Migrated ExerciseMuscle relationships");
}

async function normalizeEquipment(database: PostgresDatabase) {
  const equipment = await database.all<{ id: string; name: string }>(`SELECT id, name FROM Equipment`);

  const EQUIPMENT_CATEGORIES: Record<string, string> = {
    "Barbell": "free_weight",
    "Dumbbells": "free_weight",
    "Bench": "support",
    "Pull-up Bar": "bodyweight",
    "Resistance Bands": "band",
    "Cable Machine": "machine",
    "Squat Rack": "rack",
    "Treadmill": "cardio",
    "Exercise Bike": "cardio",
    "Smith Machine": "machine",
    "Leg Press": "machine",
    "Lat Pulldown": "machine",
    "Chest Press": "machine",
    "Pec Deck": "machine",
    "Leg Extension": "machine",
    "Leg Curl": "machine",
    "Preacher Curl": "support",
    "Assisted Pull-up": "machine",
    "Kettlebells": "free_weight",
    "Medicine Ball": "free_weight",
    "Exercise Ball": "support",
    "EZ Curl Bar": "free_weight",
    "Foam Roller": "support",
    "No Equipment": "bodyweight",
  };

  for (const eq of equipment) {
    const normalized = eq.name.toLowerCase().replace(/[^a-z0-9]+/g, "_");
    const category = EQUIPMENT_CATEGORIES[eq.name] || "other";
    await database.run(
      `UPDATE Equipment SET normalizedName = ?, category = ? WHERE id = ?`,
      normalized, category, eq.id
    );
  }
  console.log("Normalized equipment names and categories");
}

async function seedMuscles(database: PostgresDatabase) {
  const muscles = [
    { name: "chest", category: "upper_push" },
    { name: "back", category: "upper_pull" },
    { name: "biceps", category: "upper_pull" },
    { name: "triceps", category: "upper_push" },
    { name: "shoulders", category: "upper_push" },
    { name: "quads", category: "lower_push" },
    { name: "hamstrings", category: "lower_pull" },
    { name: "glutes", category: "lower_pull" },
    { name: "calves", category: "lower_push" },
    { name: "core", category: "core" },
    { name: "forearms", category: "upper_pull" },
    { name: "traps", category: "upper_pull" },
    { name: "lats", category: "upper_pull" },
    { name: "rear_delts", category: "upper_pull" },
    { name: "front_delts", category: "upper_push" },
    { name: "side_delts", category: "upper_push" },
    { name: "abs", category: "core" },
    { name: "obliques", category: "core" },
    { name: "lower_back", category: "core" },
    { name: "adductors", category: "lower_pull" },
    { name: "abductors", category: "lower_pull" },
  ];

  for (const muscle of muscles) {
    await database.run(
      `INSERT INTO Muscle (id, name, category) VALUES (?, ?, ?)
       ON CONFLICT(name) DO NOTHING`,
      uuidv4(), muscle.name, muscle.category
    );
  }
  console.log("Seeded Muscle table");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
