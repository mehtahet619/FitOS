import fs from "fs";
import path from "path";
import { db } from "./client";

const schemaPath = path.join(__dirname, "schema.sql");
const schema = fs.readFileSync(schemaPath, "utf-8");
db.exec(schema).then(async () => {
	try {
		await db.exec(`ALTER TABLE NutritionRecommendation ADD COLUMN source TEXT NOT NULL DEFAULT 'general-nutrition'`);
	} catch {
		// Existing databases already have the compatibility column.
	}
	console.log("Migration applied.");
}).catch((error) => {
	console.error(error);
	process.exit(1);
});
