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
  getCsvAlternatives(targetMuscles: string[], excludedExerciseNames?: Iterable<string>): RecommendedExercise[];
}

export function exerciseCountForDuration(minutes: number): number {
  if (!Number.isFinite(minutes) || minutes <= 0) throw new Error("Session duration must be a positive number of minutes.");
  if (minutes <= 30) return 2;
  if (minutes <= 45) return 2;
  if (minutes <= 70) return 3;
  if (minutes <= 110) return 4;
  if (minutes <= 180) return 5;
  return 6;
}

type Candidate = { row: CsvExercise; matchingMuscles: string[]; targetKeys: Set<string> };

const variationWords = new Set([
  "alternating", "controlled", "explosive", "grip", "narrow", "overhand", "paused",
  "pause", "semi", "slow", "split", "staggered", "stance", "supinated", "tempo",
  "underhand", "wide",
]);

/** Use only words present in the CSV name/equipment fields to spot close variants. */
function exerciseNameSignature(candidate: Candidate): string[] {
  const ignoredWords = new Set([
    ...normalizeExerciseValue(candidate.row.machine).split(" "),
    ...[...candidate.targetKeys].flatMap((target) => target.split(" ")),
    ...variationWords,
  ]);
  const signature = normalizeExerciseValue(candidate.row.exercise)
    .split(" ")
    .filter((word) => word && !ignoredWords.has(word));
  return signature.length > 0 ? [...new Set(signature)] : normalizeExerciseValue(candidate.row.exercise).split(" ");
}

function redundancyPenalty(candidate: Candidate, selectedSignatures: string[][]): number {
  const signature = exerciseNameSignature(candidate);
  let penalty = 0;
  for (const selected of selectedSignatures) {
    const sharedWords = signature.filter((word) => selected.includes(word)).length;
    const similarity = (2 * sharedWords) / (signature.length + selected.length);
    if (similarity >= 0.8) penalty += 2;
    else if (similarity >= 0.5) penalty += 1;
  }
  return penalty;
}

function repeatedNameEndingPenalty(candidate: Candidate, selectedSignatures: string[][]): number {
  const ending = exerciseNameSignature(candidate).at(-1);
  if (!ending) return 0;
  const priorCount = selectedSignatures.filter((signature) => signature.at(-1) === ending).length;
  return priorCount >= 2 ? (priorCount - 1) * 3 : 0;
}

function selectWithCoverage(
  candidates: Candidate[],
  count: number,
): RecommendedExercise[] {
  const selected: RecommendedExercise[] = [];
  const selectedSignatures: string[][] = [];
  const coveredTargets = new Set<string>();
  const coveredCategories = new Set<string>();
  const usedMachines = new Set<string>();
  const remaining = [...candidates];

  while (selected.length < count && remaining.length > 0) {
    remaining.sort((left, right) => {
      const exactCategoryMatches = (candidate: typeof left) => candidate.matchingMuscles
        .filter((muscle) => candidate.targetKeys.has(normalizeExerciseValue(muscle)) && !coveredTargets.has(normalizeExerciseValue(muscle))).length;
      const leftExactMatches = exactCategoryMatches(left);
      const rightExactMatches = exactCategoryMatches(right);
      if (leftExactMatches !== rightExactMatches) return rightExactMatches - leftExactMatches;
      const leftFamilyPenalty = repeatedNameEndingPenalty(left, selectedSignatures);
      const rightFamilyPenalty = repeatedNameEndingPenalty(right, selectedSignatures);
      if (leftFamilyPenalty !== rightFamilyPenalty) return leftFamilyPenalty - rightFamilyPenalty;
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
      const leftRedundancy = redundancyPenalty(left, selectedSignatures);
      const rightRedundancy = redundancyPenalty(right, selectedSignatures);
      if (leftRedundancy !== rightRedundancy) return leftRedundancy - rightRedundancy;
      const leftNewMachine = usedMachines.has(normalizeExerciseValue(left.row.machine)) ? 0 : 1;
      const rightNewMachine = usedMachines.has(normalizeExerciseValue(right.row.machine)) ? 0 : 1;
      if (leftNewMachine !== rightNewMachine) return rightNewMachine - leftNewMachine;
      return left.row.sourceIndex - right.row.sourceIndex;
    });

    const [next] = remaining.splice(0, 1);
    selected.push({ ...next.row, primaryMuscle: next.matchingMuscles[0] });
    selectedSignatures.push(exerciseNameSignature(next));
    next.matchingMuscles.forEach((muscle) => coveredTargets.add(normalizeExerciseValue(muscle)));
    next.row.muscleCategories.forEach((muscle) => coveredCategories.add(normalizeExerciseValue(muscle)));
    usedMachines.add(normalizeExerciseValue(next.row.machine));
  }
  return selected;
}

export class CsvExerciseRecommendationService implements ExerciseRecommendationService {
  constructor(private readonly repository: CsvExerciseRepository = csvExerciseRepository) {}

  getCsvAlternatives(targetMuscles: string[], excludedExerciseNames: Iterable<string> = []): RecommendedExercise[] {
    const targetKeys = new Set(targetMuscles.map(normalizeExerciseValue).filter(Boolean));
    const excludedNames = new Set([...excludedExerciseNames].map(normalizeExerciseValue).filter(Boolean));
    if (targetKeys.size === 0) return [];

    const uniqueCandidates = new Map<string, RecommendedExercise>();
    for (const row of this.repository.getAll()) {
      const matchingMuscles = row.muscleCategories.filter((muscle) => {
        const categoryKey = normalizeExerciseValue(muscle);
        const categoryWords = new Set(categoryKey.split(" "));
        return [...targetKeys].some((target) => {
          if (categoryKey === target) return true;
          return target.split(" ").some((word) => categoryWords.has(word));
        });
      });
      const exerciseKey = normalizeExerciseValue(row.exercise);
      if (matchingMuscles.length === 0 || excludedNames.has(exerciseKey) || uniqueCandidates.has(exerciseKey)) continue;
      const exactTargetCategory = matchingMuscles.find((muscle) => targetKeys.has(normalizeExerciseValue(muscle)));
      uniqueCandidates.set(exerciseKey, { ...row, primaryMuscle: exactTargetCategory ?? matchingMuscles[0] });
    }
    return [...uniqueCandidates.values()];
  }

  getRecommendedExercises(input: ExerciseRecommendationInput): ExerciseRecommendationResult {
    const requestedCount = exerciseCountForDuration(input.sessionDurationMinutes);
    const targetKeys = new Set(input.targetMuscles.map(normalizeExerciseValue).filter(Boolean));
    if (targetKeys.size === 0) {
      return { exercises: [], requestedCount, availableCount: 0, limitedByDataset: true };
    }

    const availableEquipment = new Set([...input.availableEquipment].map(normalizeExerciseValue).filter(Boolean));
    const uniqueCandidates = new Map<string, Candidate>();
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
