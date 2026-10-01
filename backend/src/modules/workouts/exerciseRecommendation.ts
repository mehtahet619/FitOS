import {
  CsvExercise,
  CsvExerciseRepository,
  csvExerciseRepository,
  normalizeExerciseValue,
} from "./exerciseCsvRepository";

export type RecommendationEquipmentMode = "FULL_GYM" | "SCANNED" | "USER_EQUIPMENT";

export interface ExerciseRecommendationInput {
  targetMuscles: string[];
  sessionDurationMinutes: number;
  /** Equipment names and aliases from the existing FitOS equipment catalog. */
  availableEquipment: Iterable<string>;
  equipmentMode: RecommendationEquipmentMode;
}

export interface RecommendedExercise extends CsvExercise {
  /** Exact CSV muscle category matched to the current plan target. */
  primaryMuscle: string;
}

export interface ExerciseRecommendationResult {
  exercises: RecommendedExercise[];
  requestedCount: number;
  availableCount: number;
  limitedByDataset: boolean;
}

export interface ExerciseRecommendationService {
  getRecommendedExercises(input: ExerciseRecommendationInput): ExerciseRecommendationResult;
}

export function exerciseCountForDuration(minutes: number): number {
  if (!Number.isFinite(minutes) || minutes <= 0) throw new Error("Session duration must be a positive number of minutes.");
  if (minutes <= 30) return 2;
  if (minutes <= 60) return 3;
  if (minutes <= 75) return 4;
  return 5 <= minutes && minutes <= 90 ? 5 : 6;
}

function selectWithCoverage(
  candidates: Array<{ row: CsvExercise; matchingMuscles: string[]; targetKeys: Set<string> }>,
  count: number,
): RecommendedExercise[] {
  const selected: RecommendedExercise[] = [];
  const coveredTargets = new Set<string>();
  const coveredCategories = new Set<string>();
  const usedMachines = new Set<string>();
  const remaining = [...candidates];

  while (selected.length < count && remaining.length > 0) {
    remaining.sort((left, right) => {
      const exactCategoryMatches = (candidate: typeof left) => candidate.matchingMuscles
        .filter((muscle) => candidate.targetKeys.has(normalizeExerciseValue(muscle))).length;
      const leftExactMatches = exactCategoryMatches(left);
      const rightExactMatches = exactCategoryMatches(right);
      if (leftExactMatches !== rightExactMatches) return rightExactMatches - leftExactMatches;
      const newTargetCoverage = (candidate: typeof left) => candidate.matchingMuscles
        .filter((muscle) => !coveredTargets.has(normalizeExerciseValue(muscle))).length;
      const newCategoryCoverage = (candidate: typeof left) => candidate.row.muscleCategories
        .filter((muscle) => !coveredCategories.has(normalizeExerciseValue(muscle))).length;
      const leftTargets = newTargetCoverage(left);
      const rightTargets = newTargetCoverage(right);
      if (leftTargets !== rightTargets) return rightTargets - leftTargets;
      const leftCategories = newCategoryCoverage(left);
      const rightCategories = newCategoryCoverage(right);
      if (leftCategories !== rightCategories) return rightCategories - leftCategories;
      const leftNewMachine = usedMachines.has(normalizeExerciseValue(left.row.machine)) ? 0 : 1;
      const rightNewMachine = usedMachines.has(normalizeExerciseValue(right.row.machine)) ? 0 : 1;
      if (leftNewMachine !== rightNewMachine) return rightNewMachine - leftNewMachine;
      return left.row.sourceIndex - right.row.sourceIndex;
    });

    const [next] = remaining.splice(0, 1);
    selected.push({ ...next.row, primaryMuscle: next.matchingMuscles[0] });
    next.matchingMuscles.forEach((muscle) => coveredTargets.add(normalizeExerciseValue(muscle)));
    next.row.muscleCategories.forEach((muscle) => coveredCategories.add(normalizeExerciseValue(muscle)));
    usedMachines.add(normalizeExerciseValue(next.row.machine));
  }
  return selected;
}

export class CsvExerciseRecommendationService implements ExerciseRecommendationService {
  constructor(private readonly repository: CsvExerciseRepository = csvExerciseRepository) {}

  getRecommendedExercises(input: ExerciseRecommendationInput): ExerciseRecommendationResult {
    const requestedCount = exerciseCountForDuration(input.sessionDurationMinutes);
    const targetKeys = new Set(input.targetMuscles.map(normalizeExerciseValue).filter(Boolean));
    if (targetKeys.size === 0) {
      return { exercises: [], requestedCount, availableCount: 0, limitedByDataset: true };
    }

    const availableEquipment = new Set([...input.availableEquipment].map(normalizeExerciseValue).filter(Boolean));
    const uniqueCandidates = new Map<string, { row: CsvExercise; matchingMuscles: string[]; targetKeys: Set<string> }>();
    for (const row of this.repository.getAll()) {
      // A target term may match a CSV category containing that same full word
      // (for example Back -> Upper Back). This derives relevance only from
      // words present in the plan and dataset; it adds no muscle taxonomy.
      const matchingMuscles = row.muscleCategories.filter((muscle) => {
        const categoryWords = normalizeExerciseValue(muscle).split(" ");
        return [...targetKeys].some((target) => categoryWords.includes(target));
      });
      if (matchingMuscles.length === 0) continue;
      if (input.equipmentMode !== "FULL_GYM" && !availableEquipment.has(normalizeExerciseValue(row.machine))) continue;

      const exerciseKey = normalizeExerciseValue(row.exercise);
      if (!uniqueCandidates.has(exerciseKey)) uniqueCandidates.set(exerciseKey, { row, matchingMuscles, targetKeys });
    }

    const candidates = [...uniqueCandidates.values()];
    const exercises = selectWithCoverage(candidates, requestedCount);
    return {
      exercises,
      requestedCount,
      availableCount: candidates.length,
      limitedByDataset: candidates.length < requestedCount,
    };
  }
}

export const exerciseRecommendationService = new CsvExerciseRecommendationService();
