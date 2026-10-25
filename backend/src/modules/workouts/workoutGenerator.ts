import { createHash } from "node:crypto";
import type { DatabaseLike } from "../../db/types";
import { normalizeExerciseValue } from "./exerciseCsvRepository";
import { canonicalMuscleKey } from "./muscleTaxonomy";
import { exerciseFamilyKey, exerciseRecommendationService } from "./exerciseRecommendation";
import { getAiExerciseFallback, type ExerciseFallbackEquipment } from "./exerciseAiFallback";

export interface GeneratedExercise {
  exerciseId: string;
  exerciseName: string;
  primaryMuscle: string;
  instructions: string;
  sets: number;
  repRangeLow: number;
  repRangeHigh: number;
  suggestedWeightKg: number | null;
  wasSubstituted: boolean;
  originalExerciseName?: string;
  equipmentRequired: string[]; // equipment names required for this exercise
  requiresEquipment: boolean; // true if exercise needs gym equipment, false for bodyweight
  muscle: string;
  machine: string;
}

export type EquipmentMode = "USER_EQUIPMENT" | "SCANNED" | "FULL_GYM";

const FOCUS_TO_MUSCLES: Record<string, string[]> = {
  Push: ["chest", "shoulders", "triceps"],
  Pull: ["back", "biceps"],
  Chest: ["chest"],
  Back: ["back"],
  Biceps: ["biceps"],
  Triceps: ["triceps"],
  Shoulders: ["shoulders"],
  "Legs + Shoulders": ["quads", "hamstrings", "glutes", "calves", "shoulders"],
  "Chest + Triceps": ["chest", "triceps"],
  "Back + Biceps": ["back", "biceps"],
  Legs: ["quads", "hamstrings", "glutes", "calves"],
  "Shoulders + Core": ["shoulders", "core"],
  "Full Body": ["chest", "back", "legs", "shoulders", "core"],
  "Upper Body": ["chest", "back", "shoulders", "biceps", "triceps"],
  "Lower Body": ["quads", "hamstrings", "glutes", "calves"],
  "Full Body A": ["chest", "back", "legs", "shoulders", "core"],
  "Full Body B": ["chest", "back", "legs", "shoulders", "core"],
  "Full Body C": ["chest", "back", "legs", "shoulders", "core"],
};
export function musclesForFocus(focus: string): string[] {
  return (FOCUS_TO_MUSCLES[focus] ?? FOCUS_TO_MUSCLES["Full Body"]).map(canonicalMuscleKey);
}

/**
 * Equipment and recovery may reorder exercises inside a unit, but they must
 * never replace the plan's target muscles with a different workout.
 */
export function resolveMusclesForLockedUnit(
  unitMuscles: string[],
  recentlyTrainedMuscles: Iterable<string>
): string[] {
  const recent = new Set(recentlyTrainedMuscles);
  const fresh = unitMuscles.filter((muscle) => !recent.has(muscle));
  const recovering = unitMuscles.filter((muscle) => recent.has(muscle));
  if (fresh.length === 0) return [...unitMuscles];
  return [...fresh, ...recovering];
}

export function pickFocusForDay(dayIndex: number, daysPerWeek: number): string {
  const rotation = ["Chest + Triceps", "Back + Biceps", "Legs", "Shoulders + Core", "Full Body"];
  return rotation[dayIndex % Math.min(rotation.length, Math.max(daysPerWeek, 1))];
}

async function getAvailableEquipmentIds(database: DatabaseLike, userId: string): Promise<Set<string>> {
  const rows = await database.all<{ equipmentId: string }>(
    `SELECT equipmentId FROM UserEquipment WHERE userId = ?`,
    userId
  );
  return new Set(rows.map((r) => r.equipmentId));
}

async function getEquipmentAliases(database: DatabaseLike, equipmentIds: Set<string>): Promise<string[]> {
  if (equipmentIds.size === 0) return [];
  const rows = await database.all<{ name: string; alias: string | null }>(
    `SELECT e.name, ea.alias FROM Equipment e LEFT JOIN EquipmentAlias ea ON ea.equipmentId=e.id
     WHERE e.id IN (${[...equipmentIds].map(() => "?").join(",")})`,
    ...equipmentIds
  );
  return [...new Set(rows.flatMap((row) => [row.name, row.alias].filter((value): value is string => Boolean(value))))];
}

async function getFallbackEquipment(
  database: DatabaseLike,
  equipmentMode: EquipmentMode,
  availableEquipmentIds: Set<string>,
): Promise<ExerciseFallbackEquipment[]> {
  if (equipmentMode !== "FULL_GYM" && availableEquipmentIds.size === 0) {
    return [{ name: "Bodyweight", aliases: [] }];
  }
  const rows = await database.all<{ name: string; alias: string | null }>(
    `SELECT e.name,ea.alias FROM Equipment e LEFT JOIN EquipmentAlias ea ON ea.equipmentId=e.id
     WHERE e.name != 'No Equipment'${equipmentMode === "FULL_GYM" ? "" : ` AND e.id IN (${[...availableEquipmentIds].map(() => "?").join(",")})`}`,
    ...(equipmentMode === "FULL_GYM" ? [] : [...availableEquipmentIds]),
  );
  const byName = new Map<string, ExerciseFallbackEquipment>();
  for (const row of rows) {
    const key = normalizeExerciseValue(row.name);
    const option = byName.get(key) ?? { name: row.name, aliases: [] };
    if (row.alias && !option.aliases.includes(row.alias)) option.aliases.push(row.alias);
    byName.set(key, option);
  }
  // Bodyweight is always compatible with a user's equipment snapshot.
  if (!byName.has("bodyweight")) byName.set("bodyweight", { name: "Bodyweight", aliases: [] });
  return [...byName.values()];
}

function stableCsvId(prefix: string, value: string): string {
  return `${prefix}-${createHash("sha256").update(normalizeExerciseValue(value)).digest("hex").slice(0, 32)}`;
}

/** Persist only the selected CSV rows into the existing Exercise relation so
 * WorkoutExercise and workout history keep their current foreign-key model. */
export async function ensureExerciseRows(
  database: DatabaseLike,
  selected: ReturnType<typeof exerciseRecommendationService.getRecommendedExercises>["exercises"]
): Promise<Map<number, { id: string; sets: number; repRangeLow: number; repRangeHigh: number }>> {
  const existingRows = await database.all<{
    id: string;
    name: string;
    defaultSets: number;
    repRangeLow: number;
    repRangeHigh: number;
  }>(`SELECT id,name,defaultSets,repRangeLow,repRangeHigh FROM Exercise`);
  const byNormalizedName = new Map(existingRows.map((row) => [normalizeExerciseValue(row.name), row]));
  const equipmentRows = await database.all<{ id: string; name: string }>(`SELECT id,name FROM Equipment`);
  const aliasRows = await database.all<{ equipmentId: string; alias: string }>(`SELECT equipmentId,alias FROM EquipmentAlias ORDER BY alias,equipmentId`);
  const equipmentIdByAlias = new Map<string, string>();
  for (const row of equipmentRows) equipmentIdByAlias.set(normalizeExerciseValue(row.name), row.id);
  for (const row of aliasRows) {
    const key = normalizeExerciseValue(row.alias);
    if (!equipmentIdByAlias.has(key)) equipmentIdByAlias.set(key, row.equipmentId);
  }

  const ids = new Map<number, { id: string; sets: number; repRangeLow: number; repRangeHigh: number }>();
  const createdAt = new Date().toISOString();
  for (const exercise of selected) {
    const nameKey = normalizeExerciseValue(exercise.exercise);
    let exerciseRecord = byNormalizedName.get(nameKey);
    const machineKey = normalizeExerciseValue(exercise.machine);
    let equipmentId = equipmentIdByAlias.get(machineKey);
    if (!equipmentId) {
      const existingMachine = equipmentRows.find((row) => normalizeExerciseValue(row.name) === machineKey);
      equipmentId = existingMachine?.id ?? stableCsvId("csv-equipment", exercise.machine);
      if (!existingMachine) {
        await database.run(
          `INSERT INTO Equipment (id,name,normalizedName,category,isCustom) VALUES (?,?,?, 'csv', 0) ON CONFLICT(name) DO NOTHING`,
          equipmentId, exercise.machine, machineKey
        );
        const persistedMachine = await database.get<{ id: string }>(`SELECT id FROM Equipment WHERE lower(name)=lower(?)`, exercise.machine);
        if (!persistedMachine) throw new Error(`Could not persist CSV equipment value "${exercise.machine}".`);
        equipmentId = persistedMachine.id;
        equipmentRows.push({ id: equipmentId, name: exercise.machine });
      }
      equipmentIdByAlias.set(machineKey, equipmentId);
    }

    if (!exerciseRecord) {
      const categories = exercise.muscleCategories;
      const exerciseId = stableCsvId("csv-exercise", exercise.exercise);
      await database.run(
        `INSERT INTO Exercise (id,name,primaryMuscle,secondaryMuscles,movementPattern,difficulty,defaultSets,repRangeLow,repRangeHigh,instructions,requiresEquipment,createdAt)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(name) DO NOTHING`,
        exerciseId, exercise.exercise, exercise.primaryMuscle,
        categories.filter((muscle) => normalizeExerciseValue(muscle) !== normalizeExerciseValue(exercise.primaryMuscle)).join(","),
        "csv_recommendation", "beginner", 3, 8, 12, "", normalizeExerciseValue(exercise.machine) === "bodyweight" ? 0 : 1, createdAt
      );
      const persistedExercise = await database.get<{ id: string }>(`SELECT id FROM Exercise WHERE lower(name)=lower(?)`, exercise.exercise);
      if (!persistedExercise) throw new Error(`Could not persist CSV exercise value "${exercise.exercise}".`);
      exerciseRecord = {
        id: persistedExercise.id,
        name: exercise.exercise,
        defaultSets: 3,
        repRangeLow: 8,
        repRangeHigh: 12,
      };
      byNormalizedName.set(nameKey, exerciseRecord);
    }

    await database.run(
      `INSERT INTO ExerciseEquipment (id,exerciseId,equipmentId) VALUES (?,?,?) ON CONFLICT(exerciseId,equipmentId) DO NOTHING`,
      stableCsvId("csv-exercise-equipment", `${exercise.exercise}|${exercise.machine}`), exerciseRecord.id, equipmentId
    );
    ids.set(exercise.sourceIndex, {
      id: exerciseRecord.id,
      sets: exerciseRecord.defaultSets || 3,
      repRangeLow: exerciseRecord.repRangeLow || 8,
      repRangeHigh: exerciseRecord.repRangeHigh || 12,
    });
  }
  return ids;
}

/**
 * Conservative progressive overload: look at the most recent completed sets
 * for this exercise. If the user hit the top of their rep range across all
 * sets last time, suggest a small weight increase (~5%, rounded to the
 * nearest 2.5kg plate). Otherwise repeat the same weight.
 */
export async function suggestNextWeight(
  database: DatabaseLike,
  userId: string,
  exerciseId: string
): Promise<number | null> {
  const history = await database.all<{ weightKg: number | null; reps: number | null }>(
    `SELECT weightKg, reps FROM WorkoutHistory WHERE userId = ? AND exerciseId = ? ORDER BY recordedAt DESC LIMIT 5`,
    userId,
    exerciseId
  );
  if (history.length === 0) return null;

  const lastWeight = history[0].weightKg;
  if (lastWeight == null) return null;

  const exercise = await database.get<{ repRangeHigh: number }>(
    `SELECT repRangeHigh FROM Exercise WHERE id = ?`,
    exerciseId
  );
  const repCeiling = exercise?.repRangeHigh ?? 12;
  const hitCeiling = history.every((h) => (h.reps ?? 0) >= repCeiling);

  if (hitCeiling) {
    const raw = lastWeight * 1.05;
    return Math.round(raw / 2.5) * 2.5;
  }
  return lastWeight;
}

/**
 * Generates a workout for a user: pulls exercises matching the day's target
 * muscles, resolves each against the user's available equipment (swapping
 * or dropping as needed), and applies conservative progressive overload
 * based on the user's most recent logged performance for that exercise.
 */
export async function generateWorkout(
  database: DatabaseLike,
  userId: string,
  focus: string,
  durationMin: number,
  options?: { lockToMuscles?: string[]; equipmentMode?: EquipmentMode; scannedEquipmentIds?: string[]; userEquipmentIds?: string[] }
): Promise<{ focus: string; exercises: GeneratedExercise[]; requestedExerciseCount: number; availableExerciseCount: number; limitedByDataset: boolean }> {
  const unitMuscles = options?.lockToMuscles?.length ? options.lockToMuscles : musclesForFocus(focus);
  const equipmentMode = options?.equipmentMode ?? "USER_EQUIPMENT";

  let availableEquipmentIds: Set<string>;
  if (equipmentMode === "FULL_GYM") {
    availableEquipmentIds = new Set();
  } else if (equipmentMode === "SCANNED") {
    availableEquipmentIds = new Set(options?.scannedEquipmentIds ?? []);
  } else {
    availableEquipmentIds = new Set(options?.userEquipmentIds ?? await getAvailableEquipmentIds(database, userId));
  }
  const availableEquipment = equipmentMode === "FULL_GYM"
    ? []
    : await getEquipmentAliases(database, availableEquipmentIds);
  if (equipmentMode === "USER_EQUIPMENT" && availableEquipmentIds.size === 0) availableEquipment.push("Bodyweight");

  const result = exerciseRecommendationService.getRecommendedExercises({
    targetMuscles: unitMuscles,
    sessionDurationMinutes: durationMin,
    availableEquipment,
    equipmentMode,
  });
  const missingCount = Math.max(0, result.requestedCount - result.exercises.length);
  const aiExercises = missingCount > 0
    ? await getAiExerciseFallback({
      targetMuscles: unitMuscles,
      sessionDurationMinutes: durationMin,
      count: missingCount,
      equipment: await getFallbackEquipment(database, equipmentMode, availableEquipmentIds),
      excludedExerciseNames: result.exercises.map((exercise) => exercise.exercise),
      excludedFamilyKeys: result.exercises.map((exercise) => exerciseFamilyKey(exercise.exercise)),
    })
    : [];
  // Treat CSV and AI fallback results as one candidate pool. A fallback must not
  // reintroduce a movement family already selected from the CSV catalogue.
  const seenMovementFamilies = new Set<string>();
  const selectedExercises = [...result.exercises, ...aiExercises].filter((exercise) => {
    const familyKey = exerciseFamilyKey(exercise.exercise);
    if (seenMovementFamilies.has(familyKey)) {
      console.warn(`[workouts/generate] dropping duplicate movement family "${familyKey}" (${exercise.exercise})`);
      return false;
    }
    seenMovementFamilies.add(familyKey);
    return true;
  });
  const exerciseIds = await ensureExerciseRows(database, selectedExercises);
  const generated = await Promise.all(selectedExercises.map(async (exercise): Promise<GeneratedExercise> => {
    const exerciseRecord = exerciseIds.get(exercise.sourceIndex);
    if (!exerciseRecord) throw new Error(`No database exercise record was created for CSV row ${exercise.sourceIndex}.`);
    return {
      exerciseId: exerciseRecord.id,
      exerciseName: exercise.exercise,
      primaryMuscle: exercise.primaryMuscle,
      instructions: "",
      sets: exerciseRecord.sets,
      repRangeLow: exerciseRecord.repRangeLow,
      repRangeHigh: exerciseRecord.repRangeHigh,
      suggestedWeightKg: await suggestNextWeight(database, userId, exerciseRecord.id),
      wasSubstituted: false,
      equipmentRequired: [exercise.machine],
      requiresEquipment: normalizeExerciseValue(exercise.machine) !== "bodyweight",
      muscle: exercise.muscle,
      machine: exercise.machine,
    };
  }));

  return {
    focus,
    exercises: generated,
    requestedExerciseCount: result.requestedCount,
    availableExerciseCount: result.availableCount + aiExercises.length,
    limitedByDataset: selectedExercises.length < result.requestedCount,
  };
}
