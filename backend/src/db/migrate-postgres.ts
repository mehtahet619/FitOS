import fs from "fs";
import path from "path";
import { PostgresDatabase } from "./postgres";
import { v4 as uuidv4 } from "uuid";

async function main() {
  const database = new PostgresDatabase();

  const schemaPath = path.resolve(
    __dirname,
    "../../src/db/schema.sql"
  );

  const schema = fs
    .readFileSync(schemaPath, "utf-8")
    .replace(/^PRAGMA[^;]+;\s*/gim, "")
    .replace(/\bUser\b/g, '"User"');

  // Add planStepIndex column BEFORE executing schema (needed for index creation in schema)
  await database.exec(`ALTER TABLE Workout ADD COLUMN IF NOT EXISTS planStepIndex INTEGER`);

  await database.exec(schema);

  // Nutrition recommendation source
  await database.exec(`
    ALTER TABLE NutritionRecommendation
    ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'general-nutrition'
  `);

  // Workout plan cycle tracking
  await database.exec(`
    ALTER TABLE WorkoutPlanState
    ADD COLUMN IF NOT EXISTS cycleId TEXT
  `);

  // Equipment normalization
  await database.exec(`
    ALTER TABLE Equipment
    ADD COLUMN IF NOT EXISTS normalizedName TEXT
  `);

  await database.exec(`
    ALTER TABLE Equipment
    ADD COLUMN IF NOT EXISTS category TEXT
  `);

  // Exercise image support
  await database.exec(`
    ALTER TABLE Exercise
    ADD COLUMN IF NOT EXISTS imageUrl TEXT
  `);

  // Whether the exercise requires gym equipment.
  //
  // 1 = equipment required
  // 0 = bodyweight / no equipment required
  await database.exec(`
    ALTER TABLE Exercise
    ADD COLUMN IF NOT EXISTS requiresEquipment INTEGER NOT NULL DEFAULT 1
  `);

  // IMPORTANT:
  // Associates a generated workout with the exact step
  // of the active workout-plan cycle.
  //
  // Example:
  // Chest  -> 0
  // Back   -> 1
  // Biceps -> 2
  // Triceps -> 3
  // Shoulders -> 4
  // Legs -> 5
  await database.exec(`
    ALTER TABLE Workout
    ADD COLUMN IF NOT EXISTS planStepIndex INTEGER
  `);

  // Historical record of completed workout-plan cycles.
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

  // Migrate existing Exercise.secondaryMuscles
  // into the normalized ExerciseMuscle relationship table.
  await migrateExerciseMuscles(database);

  // Populate normalized equipment names and categories.
  await normalizeEquipment(database);

  // Seed Muscle table.
  await seedMuscles(database);

  await database.close();

  console.log("PostgreSQL migration applied.");
}

/**
 * Migrate the old Exercise.primaryMuscle and
 * Exercise.secondaryMuscles fields into ExerciseMuscle.
 */
async function migrateExerciseMuscles(
  database: PostgresDatabase
) {
  const exercises = await database.all<{
    id: string;
    primaryMuscle: string;
    secondaryMuscles: string;
  }>(
    `
      SELECT
        id,
        primaryMuscle,
        secondaryMuscles
      FROM Exercise
    `
  );

  for (const ex of exercises) {
    // Skip malformed exercises that don't have a primary muscle.
    if (!ex.primaryMuscle) {
      continue;
    }

    // Ensure primary muscle exists.
    await database.run(
      `
        INSERT INTO Muscle (
          id,
          name,
          category
        )
        VALUES (?, ?, 'unknown')
        ON CONFLICT(name) DO NOTHING
      `,
      uuidv4(),
      ex.primaryMuscle
    );

    const primaryMuscle =
      await database.get<{ id: string }>(
        `
          SELECT id
          FROM Muscle
          WHERE name = ?
        `,
        ex.primaryMuscle
      );

    if (primaryMuscle) {
      await database.run(
        `
          INSERT INTO ExerciseMuscle (
            id,
            exerciseId,
            muscleId,
            role,
            weight
          )
          VALUES (?, ?, ?, 'PRIMARY', 1.0)
          ON CONFLICT(
            exerciseId,
            muscleId,
            role
          ) DO NOTHING
        `,
        uuidv4(),
        ex.id,
        primaryMuscle.id
      );
    }

    // Migrate secondary muscles.
    if (ex.secondaryMuscles) {
      const secondaryMuscles =
        ex.secondaryMuscles
          .split(",")
          .map((muscle) => muscle.trim())
          .filter(Boolean);

      for (const muscleName of secondaryMuscles) {
        await database.run(
          `
            INSERT INTO Muscle (
              id,
              name,
              category
            )
            VALUES (?, ?, 'unknown')
            ON CONFLICT(name) DO NOTHING
          `,
          uuidv4(),
          muscleName
        );

        const muscle =
          await database.get<{ id: string }>(
            `
              SELECT id
              FROM Muscle
              WHERE name = ?
            `,
            muscleName
          );

        if (muscle) {
          await database.run(
            `
              INSERT INTO ExerciseMuscle (
                id,
                exerciseId,
                muscleId,
                role,
                weight
              )
              VALUES (?, ?, ?, 'SECONDARY', 0.5)
              ON CONFLICT(
                exerciseId,
                muscleId,
                role
              ) DO NOTHING
            `,
            uuidv4(),
            ex.id,
            muscle.id
          );
        }
      }
    }
  }

  console.log(
    "Migrated ExerciseMuscle relationships"
  );
}

/**
 * Normalize existing Equipment records.
 */
async function normalizeEquipment(
  database: PostgresDatabase
) {
  const equipment =
    await database.all<{
      id: string;
      name: string;
    }>(
      `
        SELECT id, name
        FROM Equipment
      `
    );

  const EQUIPMENT_CATEGORIES: Record<
    string,
    string
  > = {
    Barbell: "free_weight",
    Dumbbells: "free_weight",
    Bench: "support",

    "Pull-up Bar": "bodyweight",

    "Resistance Bands": "band",

    "Cable Machine": "machine",

    "Squat Rack": "rack",

    Treadmill: "cardio",
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

    Kettlebells: "free_weight",
    "Medicine Ball": "free_weight",

    "Exercise Ball": "support",

    "EZ Curl Bar": "free_weight",

    "Foam Roller": "support",

    "No Equipment": "bodyweight",
  };

  for (const eq of equipment) {
    if (!eq.name) {
      continue;
    }

    const normalized = eq.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");

    const category =
      EQUIPMENT_CATEGORIES[eq.name] ||
      "other";

    await database.run(
      `
        UPDATE Equipment
        SET
          normalizedName = ?,
          category = ?
        WHERE id = ?
      `,
      normalized,
      category,
      eq.id
    );
  }

  console.log(
    "Normalized equipment names and categories"
  );
}

/**
 * Seed the canonical FitOS muscle list.
 */
async function seedMuscles(
  database: PostgresDatabase
) {
  const muscles = [
    {
      name: "chest",
      category: "upper_push",
    },
    {
      name: "back",
      category: "upper_pull",
    },
    {
      name: "biceps",
      category: "upper_pull",
    },
    {
      name: "triceps",
      category: "upper_push",
    },
    {
      name: "shoulders",
      category: "upper_push",
    },
    {
      name: "quads",
      category: "lower_push",
    },
    {
      name: "hamstrings",
      category: "lower_pull",
    },
    {
      name: "glutes",
      category: "lower_pull",
    },
    {
      name: "calves",
      category: "lower_push",
    },
    {
      name: "core",
      category: "core",
    },
    {
      name: "forearms",
      category: "upper_pull",
    },
    {
      name: "traps",
      category: "upper_pull",
    },
    {
      name: "lats",
      category: "upper_pull",
    },
    {
      name: "rear_delts",
      category: "upper_pull",
    },
    {
      name: "front_delts",
      category: "upper_push",
    },
    {
      name: "side_delts",
      category: "upper_push",
    },
    {
      name: "abs",
      category: "core",
    },
    {
      name: "obliques",
      category: "core",
    },
    {
      name: "lower_back",
      category: "core",
    },
    {
      name: "adductors",
      category: "lower_pull",
    },
    {
      name: "abductors",
      category: "lower_pull",
    },
  ];

  for (const muscle of muscles) {
    await database.run(
      `
        INSERT INTO Muscle (
          id,
          name,
          category
        )
        VALUES (?, ?, ?)
        ON CONFLICT(name) DO NOTHING
      `,
      uuidv4(),
      muscle.name,
      muscle.category
    );
  }

  console.log("Seeded Muscle table");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});