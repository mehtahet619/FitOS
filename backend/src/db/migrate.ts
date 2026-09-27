import fs from "fs";
import path from "path";
import { db } from "./client";

const schemaPath = path.join(__dirname, "schema.sql");
const schema = fs.readFileSync(schemaPath, "utf-8");
db.exec(schema).then(async () => {
  try {
    await db.exec(`ALTER TABLE NutritionRecommendation ADD COLUMN source TEXT NOT NULL DEFAULT 'general-nutrition'`);
  } catch {
  }

  try {
    await db.exec(`ALTER TABLE WorkoutPlanState ADD COLUMN cycleId TEXT`);
    await db.run(
      `UPDATE WorkoutPlanState SET cycleId = 'cycle_' || substr(id, 1, 8) WHERE cycleId IS NULL`
    );
  } catch {
  }

  try {
    await db.exec(`CREATE TABLE IF NOT EXISTS WorkoutCycleHistory (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL REFERENCES User(id),
      cycleId TEXT NOT NULL,
      structureKey TEXT NOT NULL,
      unitsJson TEXT NOT NULL,
      startedAt TEXT NOT NULL,
      completedAt TEXT NOT NULL
    )`);
  } catch {
  }

  console.log("Migration applied.");
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
