import {
  CsvExercise,
  CsvExerciseRepository,
  csvExerciseAlternativesRepository,
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
  getSwapAlternatives(
    currentExerciseName: string,
    currentMachine: string,
    slotPrimaryMuscle: string,
    excludedExerciseNames?: Iterable<string>,
  ): RecommendedExercise[];
}

function exactDatasetValue(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US").replace(/\s+/g, " ");
}

function targetedMuscleKey(values: string[]): string {
  return [...new Set(values.map(normalizeExerciseValue).filter(Boolean))].sort().join("|");
}

const familyVariationPhrases = [
  /\bstraight bar\b/g,
  /\bt bar\b/g,
  /\bpec deck\b/g,
  /\b(?:wide|close|narrow|neutral|underhand|overhand|supinated|pronated|semi supinated) grip\b/g,
  /\b(?:standard|wide|close|narrow|split|staggered) stance\b/g,
  /\b(?:single|one) (?:arm|leg)\b/g,
  /\b(?:controlled|slow|explosive) tempo\b/g,
  /\b(?:eccentric emphasis|constant tension|full range|partial range)\b/g,
  /\b(?:1 5|one and a half) reps?\b/g,
  /\b(?:wide|close|narrow|neutral|underhand|overhand|supinated|pronated|semi supinated|standard|alternating|unilateral|bilateral|assisted|paused|pause|explosive|seated|standing|kneeling|lying|prone|supine|bent over|flat|low|mid|high|incline|decline)\b/g,
  /\b(?:d|v|single|wide|close) handle\b/g,
  /\b(?:low|mid|high) cable\b/g,
];

const familyEquipmentWords = new Set([
  "barbell", "dumbbell", "dumbbells", "kettlebell", "kettlebells", "cable", "machine",
  "selectorized", "smith", "band", "bands", "resistance", "bodyweight", "plate", "loaded",
  "ez", "rope", "handle", "handles", "bar", "landmine",
]);

/**
 * Deterministically reduce CSV name variants to a movement family. Equipment,
 * grip, stance, tempo, and body-position labels do not create new families;
 * meaningful movement descriptors such as "straight arm" and named patterns
 * such as "pullover" are retained.
 */
export function exerciseFamilyKey(exerciseName: string): string {
  let normalized = normalizeExerciseValue(exerciseName);
  for (const phrase of familyVariationPhrases) normalized = normalized.replace(phrase, " ");
  normalized = normalized
    .replace(/\bpull down\b/g, "pulldown")
    .replace(/\b(?:chin up|assisted pull up|assisted pullup)\b/g, "pullup")
    .replace(/\bpull up\b/g, "pullup")
    .replace(/\bchest fly\b/g, "fly");
  const familyWords = normalized.split(" ").filter((word) => word && !familyEquipmentWords.has(word));
  return familyWords.join(" ").replace(/\s+/g, " ").trim() || normalizeExerciseValue(exerciseName);
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

type Candidate = { row: CsvExercise; matchingMuscles: string[]; targetKeys: Set<string>; familyKey: string };

function selectWithCoverage(
  candidates: Candidate[],
  count: number,
): RecommendedExercise[] {
  const selected: RecommendedExercise[] = [];
  const selectedFamilies = new Set<string>();
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

    // Prefer a genuinely new movement family whenever one remains. Reuse a
    // family only after all available families have been selected.
    const firstNewFamily = remaining.findIndex((candidate) => !selectedFamilies.has(candidate.familyKey));
    const [next] = remaining.splice(firstNewFamily >= 0 ? firstNewFamily : 0, 1);
    selected.push({ ...next.row, primaryMuscle: next.matchingMuscles[0] });
    selectedFamilies.add(next.familyKey);
    next.matchingMuscles.forEach((muscle) => coveredTargets.add(normalizeExerciseValue(muscle)));
    next.row.muscleCategories.forEach((muscle) => coveredCategories.add(normalizeExerciseValue(muscle)));
    usedMachines.add(normalizeExerciseValue(next.row.machine));
  }
  return selected;
}

export class CsvExerciseRecommendationService implements ExerciseRecommendationService {
  private readonly alternativesRepository: CsvExerciseRepository;

  constructor(
    private readonly repository: CsvExerciseRepository = csvExerciseRepository,
    alternativesRepository?: CsvExerciseRepository,
  ) {
    // Tests and embedded callers that supply an in-memory repository keep a
    // self-contained fixture. The production service reads swaps exclusively
    // from the curated 50k alternatives dataset.
    this.alternativesRepository = alternativesRepository
      ?? (repository === csvExerciseRepository ? csvExerciseAlternativesRepository : repository);
  }

  getSwapAlternatives(
    currentExerciseName: string,
    currentMachine: string,
    slotPrimaryMuscle: string,
    excludedExerciseNames: Iterable<string> = [],
    excludedFamilyKeys: Iterable<string> = [],
  ): RecommendedExercise[] {
    const nameKey = normalizeExerciseValue(currentExerciseName);
    const machineKey = normalizeExerciseValue(currentMachine);
    const slotPrimaryMuscleKey = normalizeExerciseValue(slotPrimaryMuscle);
    const excludedNames = new Set([...excludedExerciseNames].map(normalizeExerciseValue).filter(Boolean));
    if (!nameKey || !machineKey || !slotPrimaryMuscleKey) return [];

    const excludedFamilies = new Set([...excludedFamilyKeys].map(normalizeExerciseValue).filter(Boolean));
    const currentFamily = exerciseFamilyKey(currentExerciseName);
    excludedFamilies.add(currentFamily);
    const alternativesRows = this.alternativesRepository.getAll();
    const sourceAnchors = alternativesRows.filter((row) =>
      row.alternativeRank === 1
      && exerciseFamilyKey(row.exercise) === currentFamily
      && row.alternativeGroupId
      && row.targetedMuscles.length > 0
      && row.timeTakenOneSet,
    );
    // Prefer an exact dataset name/equipment match. Existing workouts can
    // predate this dataset, so a deterministic family match is the migration
    // bridge; the selected anchor and all alternatives still come only from
    // the new CSV and share its exact targeted muscle and duration.
    const sourceAnchor = [...sourceAnchors].sort((left, right) => {
      const score = (row: CsvExercise) =>
        (normalizeExerciseValue(row.exercise) === nameKey ? 4 : 0)
        + (normalizeExerciseValue(row.machine) === machineKey ? 2 : 0)
        + (row.muscleCategories.some((muscle) => normalizeExerciseValue(muscle) === slotPrimaryMuscleKey) ? 1 : 0);
      return score(right) - score(left) || left.sourceIndex - right.sourceIndex;
    })[0];
    const legacyAnchor = [...alternativesRows].filter((row) =>
      exerciseFamilyKey(row.exercise) === currentFamily
      && row.targetedMuscles.length > 0
      && row.timeTakenOneSet,
    ).sort((left, right) => {
      const score = (row: CsvExercise) =>
        (normalizeExerciseValue(row.exercise) === nameKey ? 4 : 0)
        + (normalizeExerciseValue(row.machine) === machineKey ? 2 : 0)
        + (row.muscleCategories.some((muscle) => normalizeExerciseValue(muscle) === slotPrimaryMuscleKey) ? 1 : 0);
      return score(right) - score(left) || left.sourceIndex - right.sourceIndex;
    })[0];
    const selectedAnchor = sourceAnchor ?? legacyAnchor;
    if (!selectedAnchor) return [];

    const targetKey = targetedMuscleKey(selectedAnchor.targetedMuscles);
    const durationKey = exactDatasetValue(selectedAnchor.timeTakenOneSet);
    const orderedCandidates = sourceAnchor?.alternativeGroupId
      ? alternativesRows
        .filter((row) => row.alternativeGroupId === sourceAnchor.alternativeGroupId
          && (row.alternativeRank ?? 0) > 1
          && targetedMuscleKey(row.targetedMuscles) === targetKey
          && exactDatasetValue(row.timeTakenOneSet) === durationKey)
        .sort((left, right) => (left.alternativeRank ?? 0) - (right.alternativeRank ?? 0))
      : alternativesRows
        .filter((row) => row.targetedMuscles.length > 0
          && row.timeTakenOneSet
          && row.muscleCategories.some((muscle) => normalizeExerciseValue(muscle) === slotPrimaryMuscleKey)
          && targetedMuscleKey(row.targetedMuscles) === targetKey
          && exactDatasetValue(row.timeTakenOneSet) === durationKey)
        .sort((left, right) => left.sourceIndex - right.sourceIndex);

    // Rank 2–6 are the dataset's explicit substitutions. Keep that stable
    // order while allowing at most one genuinely different movement family.
    const candidates: RecommendedExercise[] = [];
    const seenFamilies = new Set(excludedFamilies);
    const seenNames = new Set<string>();
    for (const row of orderedCandidates) {
      const exerciseKey = normalizeExerciseValue(row.exercise);
      const familyKey = exerciseFamilyKey(row.exercise);
      if (excludedNames.has(exerciseKey) || seenNames.has(exerciseKey) || seenFamilies.has(familyKey)) continue;
      seenNames.add(exerciseKey);
      seenFamilies.add(familyKey);
      candidates.push({ ...row, primaryMuscle: slotPrimaryMuscle });
    }
    return candidates;
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
      if (!uniqueCandidates.has(exerciseKey)) uniqueCandidates.set(exerciseKey, {
        row,
        matchingMuscles,
        targetKeys,
        familyKey: exerciseFamilyKey(row.exercise),
      });
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
