import { createHash } from "node:crypto";
import type { DatabaseLike } from "../../db/types";
import { canonicalMuscleKey } from "./muscleTaxonomy";
import { exerciseFamilyKey, getAiExerciseFallback, type ExerciseFallbackEquipment, type RecommendedExercise } from "./exerciseAiFallback";

function normalizeExerciseValue(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

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

function exerciseCountForDuration(minutes: number): number {
  if (minutes <= 30) return 3;
  if (minutes <= 45) return 4;
  if (minutes <= 70) return 5;
  if (minutes <= 110) return 6;
  if (minutes <= 180) return 7;
  return 8;
}

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
  "Full Body": ["chest", "back", "quads", "hamstrings", "glutes", "shoulders", "core"],
  "Upper Body": ["chest", "back", "shoulders", "biceps", "triceps"],
  "Lower Body": ["quads", "hamstrings", "glutes", "calves"],
  "Full Body A": ["chest", "back", "quads", "hamstrings", "glutes", "shoulders", "core"],
  "Full Body B": ["chest", "back", "quads", "hamstrings", "glutes", "shoulders", "core"],
  "Full Body C": ["chest", "back", "quads", "hamstrings", "glutes", "shoulders", "core"],
};
export function musclesForFocus(focus: string): string[] {
  const configuredTargets = FOCUS_TO_MUSCLES[focus];
  if (!configuredTargets) {
    throw new Error(`Unsupported workout focus "${focus}". Refusing to silently generate a Full Body workout for an unknown split.`);
  }
  return configuredTargets.map(canonicalMuscleKey);
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



async function getFallbackEquipment(
  database: DatabaseLike,
  equipmentMode: EquipmentMode,
  availableEquipmentIds: Set<string>,
): Promise<ExerciseFallbackEquipment[]> {
  if (equipmentMode !== "FULL_GYM" && availableEquipmentIds.size === 0) {
    return [{ name: "Bodyweight", aliases: [] }];
  }
  const rows = await database.all<{ name: string; alias: string | null }>(
    `SELECT e.name, ea.alias FROM Equipment e LEFT JOIN EquipmentAlias ea ON ea.equipmentId=e.id
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

function stableAiId(prefix: string, value: string): string {
  return `${prefix}-${createHash("sha256").update(normalizeExerciseValue(value)).digest("hex").slice(0, 32)}`;
}

/** Persist only the selected AI-generated exercises into the existing Exercise relation so
 * WorkoutExercise and workout history keep their current foreign-key model. */
export async function ensureExerciseRows(
  database: DatabaseLike,
  selected: RecommendedExercise[]
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
      equipmentId = existingMachine?.id ?? stableAiId("ai-equipment", exercise.machine);
      if (!existingMachine) {
        await database.run(
          `INSERT INTO Equipment (id,name,normalizedName,category,isCustom) VALUES (?,?,?, 'ai-generated', 0) ON CONFLICT(name) DO NOTHING`,
          equipmentId, exercise.machine, machineKey
        );
        const persistedMachine = await database.get<{ id: string }>(`SELECT id FROM Equipment WHERE lower(name)=lower(?)`, exercise.machine);
        if (!persistedMachine) throw new Error(`Could not persist AI equipment value "${exercise.machine}".`);
        equipmentId = persistedMachine.id;
        equipmentRows.push({ id: equipmentId, name: exercise.machine });
      }
      equipmentIdByAlias.set(machineKey, equipmentId);
    }

    if (!exerciseRecord) {
      // Secondary muscles remain exercise anatomy metadata only. They are
      // persisted separately and never used to allocate workout exercise slots.
      const categories = exercise.secondaryMuscles ?? [];
      const exerciseId = stableAiId("ai-exercise", exercise.exercise);
      await database.run(
        `INSERT INTO Exercise (id,name,primaryMuscle,secondaryMuscles,movementPattern,difficulty,defaultSets,repRangeLow,repRangeHigh,instructions,requiresEquipment,createdAt)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(name) DO NOTHING`,
        exerciseId, exercise.exercise, exercise.primaryMuscle,
        categories.filter((muscle) => normalizeExerciseValue(muscle) !== normalizeExerciseValue(exercise.primaryMuscle)).join(","),
        "ai_generated", "beginner", exercise.sets ?? 3, exercise.repRangeLow ?? 8, exercise.repRangeHigh ?? 12, exercise.instructions ?? "", normalizeExerciseValue(exercise.machine) === "bodyweight" ? 0 : 1, createdAt
      );
      const persistedExercise = await database.get<{ id: string }>(`SELECT id FROM Exercise WHERE lower(name)=lower(?)`, exercise.exercise);
      if (!persistedExercise) throw new Error(`Could not persist AI exercise value "${exercise.exercise}".`);
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
      stableAiId("ai-exercise-equipment", `${exercise.exercise}|${exercise.machine}`), exerciseRecord.id, equipmentId
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
  options?: { lockToMuscles?: string[]; equipmentMode?: EquipmentMode; scannedEquipmentIds?: string[]; userEquipmentIds?: string[]; excludedExerciseNames?: string[]; excludedExerciseFamilyKeys?: string[]; selectionSeed?: string }
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


  const requestedCount = Math.max(exerciseCountForDuration(durationMin), unitMuscles.length >= 5 ? unitMuscles.length : 0);
  const aiExercises = await getAiExerciseFallback({
    targetMuscles: unitMuscles,
    sessionDurationMinutes: durationMin,
    count: requestedCount,
    equipment: await getFallbackEquipment(database, equipmentMode, availableEquipmentIds),
    excludedExerciseNames: options?.excludedExerciseNames,
    excludedFamilyKeys: options?.excludedExerciseFamilyKeys,
  });
  if (aiExercises.length !== requestedCount) {
    throw new Error(
      process.env.OPENROUTER_API_KEY
        ? `OpenRouter generated ${aiExercises.length} of ${requestedCount} required exercises. Please retry.`
        : "OpenRouter is not configured. Set OPENROUTER_API_KEY to generate workouts."
    );
  }
  const seenMovementFamilies = new Set<string>();
  const selectedExercises = aiExercises.filter((exercise) => {
    const familyKey = exerciseFamilyKey(exercise.exercise);
    if (seenMovementFamilies.has(familyKey)) return false;
    seenMovementFamilies.add(familyKey);
    return true;
  });
  if (selectedExercises.length !== requestedCount) {
    throw new Error("OpenRouter returned duplicate movement patterns. Please retry workout generation.");
  }
  const exerciseIds = await ensureExerciseRows(database, selectedExercises);
  const generated = await Promise.all(selectedExercises.map(async (exercise): Promise<GeneratedExercise> => {
    const exerciseRecord = exerciseIds.get(exercise.sourceIndex);
    if (!exerciseRecord) throw new Error(`No database exercise record was created for AI exercise ${exercise.exercise}.`);
    return {
      exerciseId: exerciseRecord.id,
      exerciseName: exercise.exercise,
      primaryMuscle: exercise.primaryMuscle,
      instructions: exercise.instructions ?? "",
      sets: exercise.sets ?? exerciseRecord.sets,
      repRangeLow: exercise.repRangeLow ?? exerciseRecord.repRangeLow,
      repRangeHigh: exercise.repRangeHigh ?? exerciseRecord.repRangeHigh,
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
    requestedExerciseCount: requestedCount,
    availableExerciseCount: selectedExercises.length,
    limitedByDataset: false,
  };
}
