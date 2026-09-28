#!/usr/bin/env ts-node
/**
 * Import exercises from Free Exercise DB (https://github.com/yuhonas/free-exercise-db)
 * Run with: npm run import:exercises
 */

const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch");
const { db, nowIso } = require("../src/db/client");
const { v4: uuidv4 } = require("uuid");

interface FreeExerciseDBExercise {
  id: string;
  name: string;
  force: string | null;
  level: "beginner" | "intermediate" | "expert";
  mechanic: "isolation" | "compound" | null;
  equipment: string | null;
  primaryMuscles: string[];
  secondaryMuscles: string[];
  instructions: string[];
  category: string;
  images: string[];
}

const EQUIPMENT_MAP: Record<string, string> = {
  "body only": "No Equipment",
  "dumbbell": "Dumbbells",
  "barbell": "Barbell",
  "cable": "Cable Machine",
  "machine": "Machine",
  "kettlebells": "Kettlebells",
  "bands": "Resistance Bands",
  "medicine ball": "Medicine Ball",
  "exercise ball": "Exercise Ball",
  "e-z curl bar": "EZ Curl Bar",
  "foam roll": "Foam Roller",
  "other": "Other",
};

const MUSCLE_MAP: Record<string, string> = {
  "abdominals": "abs",
  "abductors": "abductors",
  "adductors": "adductors",
  "biceps": "biceps",
  "calves": "calves",
  "chest": "chest",
  "forearms": "forearms",
  "glutes": "glutes",
  "hamstrings": "hamstrings",
  "lats": "lats",
  "lower back": "lower_back",
  "middle back": "middle_back",
  "neck": "neck",
  "quadriceps": "quads",
  "shoulders": "shoulders",
  "traps": "traps",
  "triceps": "triceps",
};

const DIFFICULTY_MAP: Record<string, "beginner" | "intermediate" | "advanced"> = {
  "beginner": "beginner",
  "intermediate": "intermediate",
  "expert": "advanced",
};

const MOVEMENT_PATTERN_MAP: Record<string, string> = {
  "push": "push",
  "pull": "pull",
  "static": "isometric",
};

const DEFAULT_SETS = 3;
const DEFAULT_REP_LOW = 8;
const DEFAULT_REP_HIGH = 12;

async function fetchExerciseList(): Promise<string[]> {
  const response = await fetch("https://api.github.com/repos/yuhonas/free-exercise-db/contents/exercises");
  if (!response.ok) throw new Error(`Failed to fetch exercise list: ${response.status}`);
  const items = await response.json();
  return items
    .filter((item: any) => item.type === "file" && item.name.endsWith(".json"))
    .map((item: any) => item.download_url);
}

async function fetchExercise(url: string): Promise<FreeExerciseDBExercise | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to fetch exercise: ${response.status}`);
    return await response.json();
  } catch (e) {
    console.error(`Error fetching ${url}:`, e);
    return null;
  }
}

function mapEquipment(equipment: string | null): string[] {
  if (!equipment) return ["No Equipment"];
  const mapped = EQUIPMENT_MAP[equipment.toLowerCase()];
  return mapped ? [mapped] : ["Other"];
}

function mapMuscle(muscle: string): string {
  return MUSCLE_MAP[muscle.toLowerCase()] || muscle.toLowerCase();
}

function mapDifficulty(level: string): "beginner" | "intermediate" | "advanced" {
  return DIFFICULTY_MAP[level] || "beginner";
}

function mapMovementPattern(force: string | null, mechanic: string | null): string {
  if (force) return MOVEMENT_PATTERN_MAP[force] || "other";
  if (mechanic === "compound") return "compound";
  if (mechanic === "isolation") return "isolation";
  return "other";
}

async function ensureEquipment(name: string): Promise<string> {
  let eq = await db.get(`SELECT id FROM Equipment WHERE name = ?`, name);
  if (!eq) {
    const id = uuidv4();
    const normalized = name.toLowerCase().replace(/[^a-z0-9]+/g, "_");
    const category = EQUIPMENT_MAP[name.toLowerCase()] ? "free_weight" : "other";
    await db.run(
      `INSERT INTO Equipment (id, name, normalizedName, category, isCustom) VALUES (?, ?, ?, ?, 0)`,
      id, name, normalized, category
    );
    eq = { id };
  }
  return eq.id;
}

async function ensureMuscle(name: string): Promise<string> {
  let muscle = await db.get(`SELECT id FROM Muscle WHERE name = ?`, name);
  if (!muscle) {
    const id = uuidv4();
    await db.run(`INSERT INTO Muscle (id, name, category) VALUES (?, ?, 'unknown')`, id, name);
    muscle = { id };
  }
  return muscle.id;
}

async function importExercise(ex: FreeExerciseDBExercise, equipmentByName: Map<string, string>, muscleByName: Map<string, string>): Promise<void> {
  const ts = nowIso();
  const equipmentNames = mapEquipment(ex.equipment);
  const equipmentIds = equipmentNames.map((name) => equipmentByName.get(name)).filter(Boolean);

  // Check if exercise already exists
  const existing = await db.get(`SELECT id FROM Exercise WHERE name = ?`, ex.name);
  let exerciseId: string;

  if (existing) {
    exerciseId = existing.id;
    // Update existing exercise
    await db.run(
      `UPDATE Exercise SET
        primaryMuscle = ?,
        secondaryMuscles = ?,
        movementPattern = ?,
        difficulty = ?,
        defaultSets = ?,
        repRangeLow = ?,
        repRangeHigh = ?,
        instructions = ?,
        imageUrl = ?,
        createdAt = ?
       WHERE id = ?`,
      mapMuscle(ex.primaryMuscles[0]),
      ex.secondaryMuscles.map(mapMuscle).join(","),
      mapMovementPattern(ex.force, ex.mechanic),
      mapDifficulty(ex.level),
      DEFAULT_SETS,
      DEFAULT_REP_LOW,
      DEFAULT_REP_HIGH,
      ex.instructions.join(" "),
      ex.images[0] || null,
      ts,
      exerciseId
    );
    // Clear existing relationships
    await db.run(`DELETE FROM ExerciseEquipment WHERE exerciseId = ?`, exerciseId);
    await db.run(`DELETE FROM ExerciseMuscle WHERE exerciseId = ?`, exerciseId);
  } else {
    exerciseId = uuidv4();
    await db.run(
      `INSERT INTO Exercise (id, name, primaryMuscle, secondaryMuscles, movementPattern, difficulty, defaultSets, repRangeLow, repRangeHigh, instructions, imageUrl, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      exerciseId,
      ex.name,
      mapMuscle(ex.primaryMuscles[0]),
      ex.secondaryMuscles.map(mapMuscle).join(","),
      mapMovementPattern(ex.force, ex.mechanic),
      mapDifficulty(ex.level),
      DEFAULT_SETS,
      DEFAULT_REP_LOW,
      DEFAULT_REP_HIGH,
      ex.instructions.join(" "),
      ex.images[0] || null,
      ts
    );
  }

  // Insert ExerciseEquipment relationships
  for (const eqId of equipmentIds) {
    await db.run(
      `INSERT INTO ExerciseEquipment (id, exerciseId, equipmentId) VALUES (?, ?, ?)
       ON CONFLICT(exerciseId, equipmentId) DO NOTHING`,
      uuidv4(), exerciseId, eqId
    );
  }

  // Insert ExerciseMuscle relationships
  const primaryMuscleId = muscleByName.get(mapMuscle(ex.primaryMuscles[0]));
  if (primaryMuscleId) {
    await db.run(
      `INSERT INTO ExerciseMuscle (id, exerciseId, muscleId, role, weight) VALUES (?, ?, ?, 'PRIMARY', 1.0)
       ON CONFLICT(exerciseId, muscleId, role) DO NOTHING`,
      uuidv4(), exerciseId, primaryMuscleId
    );
  }

  for (const secMuscle of ex.secondaryMuscles) {
    const muscleId = muscleByName.get(mapMuscle(secMuscle));
    if (muscleId) {
      await db.run(
        `INSERT INTO ExerciseMuscle (id, exerciseId, muscleId, role, weight) VALUES (?, ?, ?, 'SECONDARY', 0.5)
         ON CONFLICT(exerciseId, muscleId, role) DO NOTHING`,
      uuidv4(), exerciseId, muscleId
    );
    }
  }
}

async function main() {
  console.log("Fetching exercise list from Free Exercise DB...");
  const exerciseUrls = await fetchExerciseList();
  console.log(`Found ${exerciseUrls.length} exercises to import`);

  // Ensure all equipment exists
  const equipmentByName = new Map<string, string>();
  for (const [key, name] of Object.entries(EQUIPMENT_MAP)) {
    const id = await ensureEquipment(name);
    equipmentByName.set(name, id);
  }
  // Also ensure "Other" equipment
  const otherId = await ensureEquipment("Other");
  equipmentByName.set("Other", otherId);

  // Ensure all muscles exist
  const muscleByName = new Map<string, string>();
  const allMuscles = new Set<string>(Object.values(MUSCLE_MAP));
  for (const muscle of allMuscles) {
    const id = await ensureMuscle(muscle);
    muscleByName.set(muscle, id);
  }

  let imported = 0;
  let errors = 0;

  for (const url of exerciseUrls) {
    const ex = await fetchExercise(url);
    if (!ex) {
      errors++;
      continue;
    }

    try {
      await importExercise(ex, equipmentByName, muscleByName);
      imported++;
      if (imported % 50 === 0) {
        console.log(`Imported ${imported}/${exerciseUrls.length} exercises...`);
      }
    } catch (e) {
      console.error(`Failed to import ${ex.name}:`, e);
      errors++;
    }
  }

  console.log(`Import complete: ${imported} imported, ${errors} errors`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});