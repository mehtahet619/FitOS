import fs from "fs";
import path from "path";
import { PostgresDatabase } from "./postgres";

async function main() {
  const database = new PostgresDatabase();
  const schemaPath = path.join(__dirname, "schema.sql");
  const schema = fs
    .readFileSync(schemaPath, "utf8")
    .replace(/^PRAGMA[^;]+;\s*/gim, "")
    .replace(/\bUser\b/g, '"User"');

  await database.exec(schema);
  await database.exec(`ALTER TABLE NutritionRecommendation ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'general-nutrition'`);
  await database.close();
  console.log("PostgreSQL migration applied.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});