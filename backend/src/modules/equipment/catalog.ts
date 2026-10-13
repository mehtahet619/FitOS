import { v4 as uuidv4 } from "uuid";
import type { DatabaseLike } from "../../db/types";

/** Canonical choices shared by onboarding, the workout picker, and the seed command. */
export const CANONICAL_EQUIPMENT = [
  "No Equipment",
  "Dumbbells",
  "Barbell",
  "Bench",
  "Pull-up Bar",
  "Resistance Bands",
  "Cable Machine",
  "Squat Rack",
  "Treadmill",
  "Exercise Bike",
  "Smith Machine",
  "Leg Press",
  "Lat Pulldown",
  "Chest Press",
  "Pec Deck",
  "Leg Extension",
  "Leg Curl",
  "Preacher Curl",
  "Assisted Pull-up",
  "Kettlebells",
  "Medicine Ball",
  "Exercise Ball",
  "EZ Curl Bar",
  "Foam Roller",
] as const;

type EquipmentCatalogDatabase = Pick<DatabaseLike, "all" | "run">;

/** Restore missing canonical rows on demand; safe for concurrent/repeated reads. */
export async function ensureCanonicalEquipmentCatalog(database: EquipmentCatalogDatabase) {
  const existing = await database.all<{ name: string }>("SELECT name FROM Equipment");
  const existingNames = new Set(existing.map((row) => row.name));
  for (const name of CANONICAL_EQUIPMENT) {
    if (existingNames.has(name)) continue;
    await database.run(
      "INSERT INTO Equipment (id, name, isCustom) VALUES (?, ?, 0) ON CONFLICT(name) DO NOTHING",
      uuidv4(),
      name,
    );
  }
  return database.all("SELECT * FROM Equipment ORDER BY name ASC");
}
