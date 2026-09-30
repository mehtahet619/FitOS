import type { DatabaseLike } from "../../db/types";
import {
  loadExerciseWithLinks,
  loadSubstituteCandidates,
  isPerformable,
  pickSubstitute,
  ExerciseWithLinks,
} from "../exercises/substitutionEngine";

export interface GeneratedExercise {
  exerciseId: string;
  name: string;
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
  return FOCUS_TO_MUSCLES[focus] ?? FOCUS_TO_MUSCLES["Full Body"];
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
  options?: { lockToMuscles?: string[]; equipmentMode?: EquipmentMode; scannedEquipmentIds?: string[] }
): Promise<{ focus: string; exercises: GeneratedExercise[] }> {
  const unitMuscles = options?.lockToMuscles?.length ? options.lockToMuscles : musclesForFocus(focus);
  const equipmentMode = options?.equipmentMode ?? "USER_EQUIPMENT";

  let availableEquipmentIds: Set<string>;
  if (equipmentMode === "FULL_GYM") {
    // In FULL_GYM mode, all equipment is available
    const allEquipment = await database.all<{ id: string }>(`SELECT id FROM Equipment`);
    availableEquipmentIds = new Set(allEquipment.map((e) => e.id));
  } else if (equipmentMode === "SCANNED") {
    availableEquipmentIds = new Set(options?.scannedEquipmentIds ?? []);
  } else {
    availableEquipmentIds = await getAvailableEquipmentIds(database, userId);
  }

  // History may influence freshness/order inside a split, but it must never
  // widen a plan step to a different primary target.
  const musclesForWorkout = [...unitMuscles];

  // Roughly 1 exercise per 9 min of session time, capped sensibly.
  const targetExerciseCount = Math.max(3, Math.min(8, Math.round(durationMin / 9)));
  const perMuscle = Math.max(1, Math.ceil(targetExerciseCount / musclesForWorkout.length));

  const generated: GeneratedExercise[] = [];

  for (const muscle of musclesForWorkout) {
    const rows = await database.all<{ id: string }>(`SELECT id FROM Exercise WHERE lower(primaryMuscle) = lower(?)`, muscle);
    const poolMappedResults = await Promise.all(rows.map((r) => loadExerciseWithLinks(database, r.id)));
    const poolMapped: ExerciseWithLinks[] = poolMappedResults.filter(
      (e): e is ExerciseWithLinks => e !== null
    );

    const directlyPerformable = poolMapped.filter((ex) =>
      isPerformable(ex.requiredEquipmentIds, availableEquipmentIds)
    );

    let chosen: { exercise: ExerciseWithLinks; wasSubstituted: boolean; originalExerciseName?: string }[] = [];

    if (directlyPerformable.length >= perMuscle) {
      chosen = directlyPerformable.slice(0, perMuscle).map((exercise) => ({ exercise, wasSubstituted: false }));
    } else {
      chosen = directlyPerformable.map((exercise) => ({ exercise, wasSubstituted: false }));
      const notPerformable = poolMapped.filter(
        (ex) => !isPerformable(ex.requiredEquipmentIds, availableEquipmentIds)
      );

      for (const base of notPerformable) {
        if (chosen.length >= perMuscle) break;
        const candidates = (await loadSubstituteCandidates(database, base.id)).filter((candidate) =>
          unitMuscles.includes(candidate.primaryMuscle)
        );
        const substitute = pickSubstitute(base, candidates, availableEquipmentIds);
        if (substitute && !chosen.some((c) => c.exercise.id === substitute.id)) {
          chosen.push({ exercise: substitute, wasSubstituted: true, originalExerciseName: base.name });
        }
      }
    }

    for (const { exercise, wasSubstituted, originalExerciseName } of chosen) {
      const suggestedWeightKg = await suggestNextWeight(database, userId, exercise.id);
      // Get equipment names for this exercise
      const equipRows = await database.all<{ name: string }>(
        `SELECT eq.name FROM ExerciseEquipment ee JOIN Equipment eq ON eq.id = ee.equipmentId WHERE ee.exerciseId = ?`,
        exercise.id
      );
      const equipmentRequired = equipRows.map((r) => r.name);
      const requiresEquipment = exercise.requiredEquipmentIds.length > 0;
      generated.push({
        exerciseId: exercise.id,
        name: exercise.name,
        primaryMuscle: exercise.primaryMuscle,
        instructions: exercise.instructions,
        sets: exercise.defaultSets,
        repRangeLow: exercise.repRangeLow,
        repRangeHigh: exercise.repRangeHigh,
        suggestedWeightKg,
        wasSubstituted,
        originalExerciseName,
        equipmentRequired,
        requiresEquipment,
      });
    }
  }

  return { focus, exercises: generated.slice(0, targetExerciseCount) };
}
