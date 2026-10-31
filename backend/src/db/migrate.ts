import fs from "fs";
import path from "path";
import { db } from "./client";
import { v4 as uuidv4 } from "uuid";

const schemaPath = path.join(__dirname, "schema.sql");
const schema = fs.readFileSync(schemaPath, "utf-8");

db.exec(schema)
  .then(async () => {
    try {
      await db.exec(`ALTER TABLE User ADD COLUMN name TEXT`);
    } catch { /* already migrated */ }
    try {
      await db.exec(`ALTER TABLE User ADD COLUMN emailVerified INTEGER NOT NULL DEFAULT 1`);
    } catch { /* already migrated */ }
    try {
      await db.exec(`ALTER TABLE User ADD COLUMN emailVerifiedAt TEXT`);
    } catch { /* already migrated */ }
    await db.run(`UPDATE User SET emailVerified=1,emailVerifiedAt=COALESCE(emailVerifiedAt,createdAt) WHERE emailVerified=0 AND passwordHash IS NOT NULL`);
    await db.run(`UPDATE User SET emailVerifiedAt=createdAt WHERE emailVerified=1 AND emailVerifiedAt IS NULL`);
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_user_email_lower ON User(LOWER(email))`);
    const duplicateEmails = await db.all<{ normalized: string; count: number }>(`SELECT LOWER(email) AS normalized,COUNT(*) AS count FROM User GROUP BY LOWER(email) HAVING COUNT(*)>1`);
    if (duplicateEmails.length) throw new Error("Cannot add normalized email uniqueness: duplicate accounts differing only by email case must be resolved first");
    await db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_user_email_normalized_unique ON User(LOWER(email))`);
    await db.exec(`
      CREATE TABLE IF NOT EXISTS GymEquipmentProfile (
        id TEXT PRIMARY KEY,
        userId TEXT UNIQUE NOT NULL REFERENCES User(id),
        equipmentJson TEXT NOT NULL DEFAULT '[]',
        tourCompleted INTEGER NOT NULL DEFAULT 0,
        lastScanAt TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      )
    `);
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_gymequipmentprofile_user ON GymEquipmentProfile(userId)`);
    await db.exec(`
      CREATE TABLE IF NOT EXISTS PendingRegistration (
        id TEXT PRIMARY KEY, userId TEXT REFERENCES User(id) ON DELETE CASCADE,
        email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, passwordHash TEXT NOT NULL,
        otpHash TEXT, otpExpiresAt TEXT, otpAttempts INTEGER NOT NULL DEFAULT 0,
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
      )
    `);
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_pending_registration_expiry ON PendingRegistration(otpExpiresAt)`);
    await db.exec(`
      CREATE TABLE IF NOT EXISTS AuthSession (
        id TEXT PRIMARY KEY, userId TEXT NOT NULL REFERENCES User(id) ON DELETE CASCADE,
        refreshTokenHash TEXT NOT NULL, expiresAt TEXT NOT NULL, revokedAt TEXT,
        createdAt TEXT NOT NULL, lastUsedAt TEXT NOT NULL
      )
    `);
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_auth_session_user ON AuthSession(userId)`);
    await db.exec(`
      CREATE TABLE IF NOT EXISTS PasswordResetChallenge (
        id TEXT PRIMARY KEY, userId TEXT NOT NULL REFERENCES User(id) ON DELETE CASCADE,
        otpHash TEXT, otpExpiresAt TEXT, otpAttempts INTEGER NOT NULL DEFAULT 0,
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
      )
    `);
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_password_reset_expiry ON PasswordResetChallenge(otpExpiresAt)`);
    await db.exec(`
      CREATE TABLE IF NOT EXISTS LoginChallenge (
        id TEXT PRIMARY KEY, userId TEXT NOT NULL UNIQUE REFERENCES User(id) ON DELETE CASCADE,
        otpHash TEXT, otpExpiresAt TEXT, otpAttempts INTEGER NOT NULL DEFAULT 0,
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
      )
    `);
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_login_challenge_expiry ON LoginChallenge(otpExpiresAt)`);

    try {
      await db.exec(`
        ALTER TABLE NutritionRecommendation
        ADD COLUMN source TEXT NOT NULL DEFAULT 'general-nutrition'
      `);
    } catch {
      // Column already exists
    }

    try {
      await db.exec(`
        ALTER TABLE WorkoutPlanState
        ADD COLUMN cycleId TEXT
      `);

      await db.run(`
        UPDATE WorkoutPlanState
        SET cycleId = 'cycle_' || substr(id, 1, 8)
        WHERE cycleId IS NULL
      `);
    } catch {
      // Column already exists or migration already applied
    }

    try {
      await db.exec(`
        ALTER TABLE Equipment
        ADD COLUMN normalizedName TEXT
      `);

      await db.exec(`
        ALTER TABLE Equipment
        ADD COLUMN category TEXT
      `);
    } catch {
      // Columns already exist
    }

    try {
      await db.exec(`
        ALTER TABLE Exercise
        ADD COLUMN imageUrl TEXT
      `);
    } catch {
      // Column already exists
    }

    try {
      await db.exec(`
        ALTER TABLE Exercise
        ADD COLUMN requiresEquipment INTEGER NOT NULL DEFAULT 1
      `);
    } catch {
      // Column already exists
    }

    /*
     * Associates each Workout with the exact step
     * of the active WorkoutPlanState.
     *
     * Individual Muscle Split example:
     *
     * 0 = Chest
     * 1 = Back
     * 2 = Biceps
     * 3 = Triceps
     * 4 = Shoulders
     * 5 = Legs
     *
     * This allows workout generation to know:
     *
     * "This workout belongs to the currently locked
     * Back step."
     */
    try {
      await db.exec(`
        ALTER TABLE Workout
        ADD COLUMN planStepIndex INTEGER
      `);
    } catch {
      // Column already exists
    }
    for (const [column, definition] of [
      ["cycleId", "TEXT"],
      ["equipmentMode", "TEXT NOT NULL DEFAULT 'USER_EQUIPMENT'"],
      ["equipmentSnapshot", "TEXT NOT NULL DEFAULT '[]'"],
      ["generatorVersion", "TEXT"],
    ]) {
      try {
        await db.exec(`ALTER TABLE Workout ADD COLUMN ${column} ${definition}`);
      } catch {
        // Column already exists.
      }
    }
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_workout_user_cycle_step ON Workout(userId, planStepIndex)`);
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_workout_cycle_step_context ON Workout(userId, cycleId, planStepIndex)`);
    await db.exec(`UPDATE Workout SET cycleId = (SELECT cycleId FROM WorkoutPlanState WHERE WorkoutPlanState.activeWorkoutId = Workout.id) WHERE cycleId IS NULL AND EXISTS (SELECT 1 FROM WorkoutPlanState WHERE WorkoutPlanState.activeWorkoutId = Workout.id)`);

    for (const column of ["sourceExerciseName", "sourceMuscle", "sourcePrimaryMuscle", "sourceMachine"]) {
      try {
        await db.exec(`ALTER TABLE WorkoutExercise ADD COLUMN ${column} TEXT`);
      } catch {
        // Snapshot column already exists.
      }
    }

    /*
     * Stores completed workout-plan cycles.
     *
     * This is separate from planStepIndex:
     *
     * planStepIndex
     *   = current position inside a cycle
     *
     * WorkoutCycleHistory
     *   = record of a completed cycle
     */
    try {
      await db.exec(`
        CREATE TABLE IF NOT EXISTS WorkoutCycleHistory (
          id TEXT PRIMARY KEY,
          userId TEXT NOT NULL REFERENCES User(id),
          cycleId TEXT NOT NULL,
          structureKey TEXT NOT NULL,
          unitsJson TEXT NOT NULL,
          startedAt TEXT NOT NULL,
          completedAt TEXT NOT NULL
        )
      `);
    } catch {
      // Table already exists
    }

    // Migrate existing Exercise.secondaryMuscles
    // into ExerciseMuscle relationships.
    try {
      await migrateExerciseMuscles();
    } catch (e) {
      console.error(
        "ExerciseMuscle migration failed:",
        e
      );
    }

    // Normalize equipment names and categories.
    try {
      await normalizeEquipment();
    } catch (e) {
      console.error(
        "Equipment normalization failed:",
        e
      );
    }

    // Seed canonical muscle list.
    try {
      await seedMuscles();
    } catch (e) {
      console.error(
        "Muscle seeding failed:",
        e
      );
    }


    // Correct the legacy Chin-ups classification. Chin-ups are a compound
    // vertical pull with back as the primary target and biceps assisting.
    // Rebuild the normalized relationships because the original migration
    // may already have inserted the incorrect biceps PRIMARY relationship.
    try {
      const chinUps = await db.get<{ id: string }>(`SELECT id FROM Exercise WHERE lower(name) = 'chin-ups'`);
      const back = await db.get<{ id: string }>(`SELECT id FROM Muscle WHERE lower(name) = 'back'`);
      const biceps = await db.get<{ id: string }>(`SELECT id FROM Muscle WHERE lower(name) = 'biceps'`);
      if (chinUps && back && biceps) {
        await db.run(`UPDATE Exercise SET primaryMuscle = 'back', secondaryMuscles = 'biceps', instructions = 'Underhand-grip vertical pull. Trains the lats and upper back, with the biceps assisting.' WHERE id = ?`, chinUps.id);
        await db.run(`DELETE FROM ExerciseMuscle WHERE exerciseId = ?`, chinUps.id);
        await db.run(`INSERT INTO ExerciseMuscle (id, exerciseId, muscleId, role, weight) VALUES (?, ?, ?, 'PRIMARY', 1.0)`, uuidv4(), chinUps.id, back.id);
        await db.run(`INSERT INTO ExerciseMuscle (id, exerciseId, muscleId, role, weight) VALUES (?, ?, ?, 'SECONDARY', 0.5)`, uuidv4(), chinUps.id, biceps.id);
        await db.run(`
          DELETE FROM ExerciseSubstitution
          WHERE substituteId = ? AND baseExerciseId IN (
            SELECT id FROM Exercise WHERE lower(primaryMuscle) = 'biceps'
          )
        `, chinUps.id);
      }
    } catch (error) {
      console.error("Chin-ups muscle classification correction failed:", error);
      throw error;
    }

    console.log("Migration applied.");
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

async function migrateExerciseMuscles() {
  const exercises =
    await db.all<{
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
    if (!ex.primaryMuscle) {
      continue;
    }

    /*
     * Ensure primary muscle exists.
     */
    await db.run(
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
      await db.get<{ id: string }>(
        `
          SELECT id
          FROM Muscle
          WHERE name = ?
        `,
        ex.primaryMuscle
      );

    if (primaryMuscle) {
      await db.run(
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

    /*
     * Migrate secondary muscles.
     */
    if (ex.secondaryMuscles) {
      const secondaryMuscles =
        ex.secondaryMuscles
          .split(",")
          .map((muscleName) => muscleName.trim())
          .filter(Boolean);

      for (const muscleName of secondaryMuscles) {
        await db.run(
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
          await db.get<{ id: string }>(
            `
              SELECT id
              FROM Muscle
              WHERE name = ?
            `,
            muscleName
          );

        if (muscle) {
          await db.run(
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

async function normalizeEquipment() {
  const equipment =
    await db.all<{
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

    await db.run(
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

async function seedMuscles() {
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
    await db.run(
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
