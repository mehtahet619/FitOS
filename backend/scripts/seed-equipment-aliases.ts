const { db, nowIso } = require("../src/db/client");
const { v4: uuidv4 } = require("uuid");

const EQUIPMENT_ALIASES: Record<string, string[]> = {
  "lat_pulldown": [
    "lat pulldown",
    "lat pulldown machine",
    "pulldown machine",
    "lat pull down",
    "wide grip lat pulldown",
    "close grip lat pulldown",
    "reverse grip lat pulldown",
  ],
  "chest_press": [
    "chest press",
    "machine chest press",
    "seated chest press",
    "chest press machine",
    "iso-lateral chest press",
    "converging chest press",
  ],
  "pec_deck": [
    "pec deck",
    "pec deck machine",
    "butterfly machine",
    "butterfly",
    "chest fly machine",
    "seated fly",
    "pec fly machine",
  ],
  "leg_press": [
    "leg press",
    "leg press machine",
    "seated leg press",
    "45 degree leg press",
    "horizontal leg press",
    "vertical leg press",
  ],
  "cable_machine": [
    "cable machine",
    "cable crossover",
    "cable tower",
    "functional trainer",
    "cable column",
    "dual cable machine",
  ],
  "smith_machine": [
    "smith machine",
    "smith machine squat",
    "smith machine bench",
  ],
  "squat_rack": [
    "squat rack",
    "power rack",
    "half rack",
    "squat stand",
    "power cage",
  ],
  "bench": [
    "bench",
    "flat bench",
    "adjustable bench",
    "incline bench",
    "decline bench",
    "weight bench",
  ],
  "barbell": [
    "barbell",
    "olympic barbell",
    "standard barbell",
    "bar",
  ],
  "dumbbells": [
    "dumbbells",
    "dumbbell",
    "db",
    "hex dumbbells",
    "rubber dumbbells",
  ],
  "pull_up_bar": [
    "pull-up bar",
    "pullup bar",
    "chin-up bar",
    "chinup bar",
    "pull up station",
  ],
  "resistance_bands": [
    "resistance bands",
    "resistance band",
    "exercise bands",
    "loop bands",
    "tube bands",
  ],
  "treadmill": [
    "treadmill",
    "running machine",
  ],
  "exercise_bike": [
    "exercise bike",
    "stationary bike",
    "spin bike",
    "cycling machine",
  ],
  "leg_extension": [
    "leg extension",
    "leg extension machine",
    "seated leg extension",
  ],
  "leg_curl": [
    "leg curl",
    "leg curl machine",
    "seated leg curl",
    "lying leg curl",
    "standing leg curl",
  ],
  "preacher_curl": [
    "preacher curl",
    "preacher curl bench",
    "preacher bench",
  ],
  "assisted_pullup": [
    "assisted pull-up",
    "assisted pullup",
    "assisted chin-up",
    "assisted chinup",
    "pull-up assist machine",
  ],
  "kettlebells": [
    "kettlebell",
    "kettlebells",
    "kb",
  ],
  "medicine_ball": [
    "medicine ball",
    "med ball",
    "wall ball",
  ],
  "exercise_ball": [
    "exercise ball",
    "stability ball",
    "swiss ball",
    "yoga ball",
  ],
  "ez_curl_bar": [
    "ez curl bar",
    "ez bar",
    "curl bar",
  ],
  "foam_roller": [
    "foam roller",
    "foam roll",
    "roller",
  ],
  "other": [
    "other",
    "unknown",
    "misc",
  ],
};

async function main() {
  console.log("Seeding EquipmentAlias table...");

  // Get all equipment with their normalized names
  const equipment = await db.all(
    `SELECT id, normalizedName FROM Equipment`
  );

  const equipmentByNormalized = new Map();
  for (const eq of equipment) {
    if (eq.normalizedName) {
      equipmentByNormalized.set(eq.normalizedName, eq.id);
    }
  }

  let count = 0;
  const aliasEntries = Object.entries(EQUIPMENT_ALIASES);
  for (let i = 0; i < aliasEntries.length; i++) {
    const normalized = aliasEntries[i][0];
    const aliases = aliasEntries[i][1];
    const equipmentId = equipmentByNormalized.get(normalized);
    if (!equipmentId) {
      console.warn(`Equipment with normalizedName "${normalized}" not found, skipping`);
      continue;
    }

    for (const alias of aliases) {
      await db.run(
        `INSERT INTO EquipmentAlias (id, alias, equipmentId) VALUES (?, ?, ?)
         ON CONFLICT(alias, equipmentId) DO NOTHING`,
        uuidv4(), alias, equipmentId
      );
      count++;
    }
  }

  console.log(`Seeded ${count} equipment aliases`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});