import fs from "fs";
import path from "path";
import { PostgresDatabase } from "./postgres";

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
  await database.close();
  console.log("PostgreSQL migration applied.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
