import {
  CsvExercise,
  CsvExerciseRepository,
  csvExerciseRepository,
  normalizeExerciseLookupName,
  normalizeExerciseValue,
} from "./exerciseCsvRepository";
import { muscleCategoryMatchesTarget } from "./muscleTaxonomy";

export type RecommendationEquipmentMode = "FULL_GYM" | "SCANNED" | "USER_EQUIPMENT";

export interface ExerciseRecommendationInput {
  targetMuscles: string[];
  sessionDurationMinutes: number;
  requestedCount?: number;
  excludedExerciseNames?: Iterable<string>;
  /** Movement families already represented by an exercise selected for this workout. */
  excludedExerciseFamilyKeys?: Iterable<string>;
  /** Equipment names and aliases from the existing FitOS equipment catalog. */
  availableEquipment: Iterable<string>;
  equipmentMode: RecommendationEquipmentMode;
  /** Changes tie-breaking between workout generations so users do not get the same first exercises every time. */
  selectionSeed?: string;
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

export function getExerciseSwapContext(exerciseName: string, machine: string): Pick<CsvExercise, "targetedMuscle" | "targetedMuscles" | "timeTakenOneSet"> | undefined {
  const nameKey = normalizeExerciseValue(exerciseName);
  const machineKey = normalizeExerciseValue(machine);
  const familyKey = exerciseFamilyKey(exerciseName);
  const rows = csvExerciseRepository.getAll();
  const matches = rows.filter((row) =>
    row.targetedMuscles.length > 0
    && row.timeTakenOneSet
    && (normalizeExerciseValue(row.exercise) === nameKey || exerciseFamilyKey(row.exercise) === familyKey),
  );
  const selected = [...matches].sort((left, right) => {
    const score = (row: CsvExercise) =>
      (normalizeExerciseValue(row.exercise) === nameKey ? 4 : 0)
      + (normalizeExerciseValue(row.machine) === machineKey ? 2 : 0)
      + (row.alternativeRank === 1 ? 1 : 0);
    return score(right) - score(left) || left.sourceIndex - right.sourceIndex;
  })[0];
  return selected ? {
    targetedMuscle: selected.targetedMuscle,
    targetedMuscles: selected.targetedMuscles,
    timeTakenOneSet: selected.timeTakenOneSet,
  } : undefined;
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
  selectionSeed = "default",
): RecommendedExercise[] {
  const selected: RecommendedExercise[] = [];
  const selectedFamilies = new Set<string>();
  const coveredTargets = new Set<string>();
  const coveredCategories = new Set<string>();
  const usedMachines = new Set<string>();
  const tieBreakRank = new Map(candidates.map((candidate) => {
    // FNV-1a-style hash gives stable ordering within one generation while
    // varying the order across sessions/users when selectionSeed changes.
    const value = `${selectionSeed}:${candidate.row.sourceIndex}:${candidate.row.exercise}`;
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return [candidate, hash >>> 0] as const;
  }));
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
      return (tieBreakRank.get(left) ?? 0) - (tieBreakRank.get(right) ?? 0);
    });

    // A session must not fill its slots with superficial variations of the
    // same movement (for example, standard, eccentric-emphasis and wide-grip
    // overhead presses). If no new family remains, stop and let the caller use
    // a genuinely different fallback or show fewer exercises.
    const firstNewFamily = remaining.findIndex((candidate) => !selectedFamilies.has(candidate.familyKey));
    if (firstNewFamily < 0) break;
    const [next] = remaining.splice(firstNewFamily, 1);
    selected.push({ ...next.row, primaryMuscle: next.matchingMuscles[0] });
    selectedFamilies.add(next.familyKey);
    next.matchingMuscles.forEach((muscle) => coveredTargets.add(normalizeExerciseValue(muscle)));
    next.row.muscleCategories.forEach((muscle) => coveredCategories.add(normalizeExerciseValue(muscle)));
    usedMachines.add(normalizeExerciseValue(next.row.machine));
    // Remove every remaining variant of the selected movement family.
    for (let index = remaining.length - 1; index >= 0; index -= 1) {
      if (remaining[index].familyKey === next.familyKey) remaining.splice(index, 1);
    }
  }
  return selected;
}

export class CsvExerciseRecommendationService implements ExerciseRecommendationService {
  private readonly alternativesRepository: CsvExerciseRepository;

  constructor(
    private readonly repository: CsvExerciseRepository = csvExerciseRepository,
    alternativesRepository?: CsvExerciseRepository,
  ) {
    // The active exercise catalogue is the single source of truth for both
    // recommendations and substitutions. A custom alternatives repository is
    // accepted only for explicit callers and tests.
    this.alternativesRepository = alternativesRepository ?? repository;
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

    // A caller-supplied single repository is the legacy/test-fixture contract:
    // those CSVs do not carry alternative_group_id/rank columns. Keep their
    // exact-matching behavior while production uses the curated grouped file.
    if (this.alternativesRepository === this.repository) {
      const rows = this.repository.getAll();
      const currentRow = rows.find((row) =>
        normalizeExerciseValue(row.exercise) === nameKey
        && normalizeExerciseValue(row.machine) === machineKey,
      );
      if (!currentRow || !currentRow.timeTakenOneSet || currentRow.targetedMuscles.length === 0) return [];
      const targetKey = targetedMuscleKey(currentRow.targetedMuscles);
      const durationKey = exactDatasetValue(currentRow.timeTakenOneSet);
      const matchingRows = rows.filter((row) =>
        targetedMuscleKey(row.targetedMuscles) === targetKey
        && exactDatasetValue(row.timeTakenOneSet) === durationKey,
      );
      const currentIndex = matchingRows.findIndex((row) => row.sourceIndex === currentRow.sourceIndex);
      if (currentIndex < 0) return [];

      const seenFamilies = new Set([...excludedFamilyKeys].map(normalizeExerciseValue).filter(Boolean));
      seenFamilies.add(exerciseFamilyKey(currentRow.exercise));
      const seenNames = new Set<string>();
      const legacyCandidates: RecommendedExercise[] = [];
      for (let offset = 1; offset < matchingRows.length; offset += 1) {
        const row = matchingRows[(currentIndex + offset) % matchingRows.length];
        const exerciseKey = normalizeExerciseValue(row.exercise);
        const familyKey = exerciseFamilyKey(row.exercise);
        if (excludedNames.has(exerciseKey) || seenNames.has(exerciseKey) || seenFamilies.has(familyKey)) continue;
        seenNames.add(exerciseKey);
        seenFamilies.add(familyKey);
        legacyCandidates.push({ ...row, primaryMuscle: slotPrimaryMuscle });
      }
      return legacyCandidates;
    }

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
    // Only use a curated group whose rank-1 source matches this movement
    // family. Falling back to any same-muscle/time row can return unrelated
    // movements (for example, a hip hinge for a cable pull-through).
    const sourceAnchor = [...sourceAnchors].sort((left, right) => {
      const score = (row: CsvExercise) =>
        (normalizeExerciseValue(row.exercise) === nameKey ? 4 : 0)
        + (normalizeExerciseValue(row.machine) === machineKey ? 2 : 0)
        + (row.muscleCategories.some((muscle) => muscleCategoryMatchesTarget(slotPrimaryMuscle, muscle)) ? 1 : 0);
      return score(right) - score(left) || left.sourceIndex - right.sourceIndex;
    })[0];
    const selectedAnchor = sourceAnchor;
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
          && row.muscleCategories.some((muscle) => muscleCategoryMatchesTarget(slotPrimaryMuscle, muscle))
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
    const requestedCount = input.requestedCount ?? exerciseCountForDuration(input.sessionDurationMinutes);
    const targetKeys = new Set(input.targetMuscles.map(normalizeExerciseValue).filter(Boolean));
    if (targetKeys.size === 0) {
      return { exercises: [], requestedCount, availableCount: 0, limitedByDataset: true };
    }

    const availableEquipment = new Set([...input.availableEquipment].map(normalizeExerciseValue).filter(Boolean));
    const excludedExerciseNames = new Set([...(input.excludedExerciseNames ?? [])].map(normalizeExerciseValue));
    const excludedExerciseFamilyKeys = new Set([
      ...(input.excludedExerciseFamilyKeys ?? []),
    ].map((familyKey) => normalizeExerciseValue(familyKey)).filter(Boolean));
    const uniqueCandidates = new Map<string, Candidate>();
    for (const row of this.repository.getAll()) {
      // Apply the same explicit group relationships as edit validation:
      // a Back target can include Lats and Upper Back, but not Biceps merely
      // because both may appear on a pull-day exercise.
      const matchingMuscles = row.muscleCategories.filter((muscle) =>
        [...targetKeys].some((target) => muscleCategoryMatchesTarget(target, muscle)),
      );
      if (matchingMuscles.length === 0) continue;
      if (input.equipmentMode !== "FULL_GYM" && !availableEquipment.has(normalizeExerciseValue(row.machine))) continue;

      const exerciseKey = normalizeExerciseValue(row.exercise);
      if (excludedExerciseNames.has(exerciseKey)) continue;
      if (excludedExerciseFamilyKeys.has(normalizeExerciseValue(exerciseFamilyKey(row.exercise)))) continue;
      if (!uniqueCandidates.has(exerciseKey)) uniqueCandidates.set(exerciseKey, {
        row,
        matchingMuscles,
        targetKeys,
        familyKey: exerciseFamilyKey(row.exercise),
      });
    }

    const candidates = [...uniqueCandidates.values()];
    const exercises = selectWithCoverage(candidates, requestedCount, input.selectionSeed ?? "default");
    const distinctFamilyCount = new Set(candidates.map((candidate) => candidate.familyKey)).size;
    return {
      exercises,
      requestedCount,
      availableCount: distinctFamilyCount,
      limitedByDataset: distinctFamilyCount < requestedCount,
    };
  }
}

export const exerciseRecommendationService = new CsvExerciseRecommendationService();
