import fs from "fs";
import path from "path";
import { MySqlDatabase } from "./mysql";

async function main() {
  const database = new MySqlDatabase();
  const schemaPath = path.resolve(__dirname, "../../src/db/schema.sql");
  const schema = fs.readFileSync(schemaPath, "utf8")
    .replace(/^PRAGMA[^;]+;\s*/gim, "")
    .replace(/\bUser\b/g, "`User`")
    .replace(/CREATE INDEX IF NOT EXISTS idx_user_email_lower ON `User`\(LOWER\(email\)\);\s*/g, "")
    .replace(/CREATE UNIQUE INDEX IF NOT EXISTS idx_user_email_normalized_unique ON `User`\(LOWER\(email\)\);\s*/g, "");

  await database.exec(schema);
  await database.exec(`
    ALTER TABLE Workout ADD COLUMN IF NOT EXISTS planStepIndex INTEGER,
    ADD COLUMN IF NOT EXISTS cycleId TEXT,
    ADD COLUMN IF NOT EXISTS equipmentMode TEXT NOT NULL DEFAULT 'USER_EQUIPMENT',
    ADD COLUMN IF NOT EXISTS equipmentSnapshot TEXT NOT NULL DEFAULT '[]',
    ADD COLUMN IF NOT EXISTS generatorVersion TEXT
  `);
  await database.exec(`
    ALTER TABLE WorkoutExercise
      ADD COLUMN IF NOT EXISTS sourceExerciseName TEXT,
      ADD COLUMN IF NOT EXISTS sourceMuscle TEXT,
      ADD COLUMN IF NOT EXISTS sourcePrimaryMuscle TEXT,
      ADD COLUMN IF NOT EXISTS sourceMachine TEXT
  `);
  await database.exec(`ALTER TABLE NutritionRecommendation ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'general-nutrition'`);
  await database.exec(`ALTER TABLE Equipment ADD COLUMN IF NOT EXISTS normalizedName TEXT, ADD COLUMN IF NOT EXISTS category TEXT`);
  await database.exec(`ALTER TABLE Exercise ADD COLUMN IF NOT EXISTS imageUrl TEXT, ADD COLUMN IF NOT EXISTS requiresEquipment INTEGER NOT NULL DEFAULT 1`);

  console.log("MySQL/TiDB migration applied.");
  await database.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
