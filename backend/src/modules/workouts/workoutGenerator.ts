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
}

const FOCUS_TO_MUSCLES: Record<string, string[]> = {
  "Chest + Triceps": ["chest", "triceps"],
  "Back + Biceps": ["back", "biceps"],
  Legs: ["quads", "hamstrings", "glutes", "calves"],
  "Shoulders + Core": ["shoulders", "core"],
  "Full Body": ["chest", "back", "legs", "shoulders", "core"],
};
const ALL_MUSCLES = ["chest", "back", "biceps", "triceps", "quads", "hamstrings", "glutes", "calves", "shoulders", "core"];

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

function startOfTrainingWeek(): string {
  const date = new Date();
  const day = date.getUTCDay();
  const daysSinceMonday = (day + 6) % 7;
  date.setUTCDate(date.getUTCDate() - daysSinceMonday);
  date.setUTCHours(0, 0, 0, 0);
  return date.toISOString();
}

async function getWeeklyTrainedMuscles(database: DatabaseLike, userId: string): Promise<Set<string>> {
  const rows = await database.all<{ primaryMuscle: string }>(
    `SELECT DISTINCT e.primaryMuscle
     FROM WorkoutHistory h
     JOIN Exercise e ON e.id = h.exerciseId
     WHERE h.userId = ? AND h.recordedAt >= ?`,
    userId,
    startOfTrainingWeek(),
  );
  return new Set(rows.map((row) => row.primaryMuscle));
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
  durationMin: number
): Promise<{ focus: string; exercises: GeneratedExercise[] }> {
  const muscles = FOCUS_TO_MUSCLES[focus] ?? FOCUS_TO_MUSCLES["Full Body"];
  const availableEquipmentIds = await getAvailableEquipmentIds(database, userId);
  const trainedMuscles = await getWeeklyTrainedMuscles(database, userId);
  const freshFocusMuscles = muscles.filter((muscle) => !trainedMuscles.has(muscle));
  const freshMuscles = ALL_MUSCLES.filter((muscle) => !trainedMuscles.has(muscle));
  const musclesForWorkout = freshFocusMuscles.length > 0
    ? freshFocusMuscles
    : freshMuscles.length > 0
      ? freshMuscles
      : muscles;

  // Roughly 1 exercise per 9 min of session time, capped sensibly.
  const targetExerciseCount = Math.max(3, Math.min(8, Math.round(durationMin / 9)));
  const perMuscle = Math.max(1, Math.ceil(targetExerciseCount / musclesForWorkout.length));

  const generated: GeneratedExercise[] = [];

  for (const muscle of musclesForWorkout) {
    const rows = await database.all<{ id: string }>(`SELECT id FROM Exercise WHERE primaryMuscle = ?`, muscle);
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
        const candidates = await loadSubstituteCandidates(database, base.id);
        const substitute = pickSubstitute(base, candidates, availableEquipmentIds);
        if (substitute && !chosen.some((c) => c.exercise.id === substitute.id)) {
          chosen.push({ exercise: substitute, wasSubstituted: true, originalExerciseName: base.name });
        }
      }
    }

    for (const { exercise, wasSubstituted, originalExerciseName } of chosen) {
      const suggestedWeightKg = await suggestNextWeight(database, userId, exercise.id);
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
      });
    }
  }

  return { focus, exercises: generated.slice(0, targetExerciseCount) };
}
