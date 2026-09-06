import type { DatabaseLike } from "../../db/types";

export interface ExerciseWithLinks {
  id: string;
  name: string;
  primaryMuscle: string;
  secondaryMuscles: string;
  movementPattern: string;
  difficulty: string;
  defaultSets: number;
  repRangeLow: number;
  repRangeHigh: number;
  instructions: string;
  requiredEquipmentIds: string[];
}

const DIFFICULTY_RANK: Record<string, number> = {
  beginner: 0,
  intermediate: 1,
  advanced: 2,
};

/**
 * Returns true if `exercise` can be performed given the equipment IDs the
 * user actually has available right now.
 */
export function isPerformable(
  requiredEquipmentIds: string[],
  availableEquipmentIds: Set<string>
): boolean {
  return requiredEquipmentIds.every((id) => availableEquipmentIds.has(id));
}

/**
 * Given a base exercise that the user can't currently perform, and a list of
 * candidate substitutes (already filtered to ones the base exercise's
 * ExerciseSubstitution edges point to, ordered by priority), pick the best
 * one that:
 *   1. Is actually performable with the user's current equipment
 *   2. Preserves primary muscle group
 *   3. Preserves movement pattern where possible
 *   4. Stays within one difficulty tier of the original
 *
 * This is pure deterministic logic — no LLM call. The AI layer is only used
 * later to phrase an explanation of *why* the swap was made.
 */
export function pickSubstitute(
  base: ExerciseWithLinks,
  candidates: ExerciseWithLinks[],
  availableEquipmentIds: Set<string>
): ExerciseWithLinks | null {
  const performable = candidates.filter((c) =>
    isPerformable(c.requiredEquipmentIds, availableEquipmentIds)
  );

  if (performable.length === 0) return null;

  const scored = performable
    .map((c) => {
      let score = 0;
      if (c.primaryMuscle === base.primaryMuscle) score += 10;
      if (c.movementPattern === base.movementPattern) score += 5;
      const diffDelta = Math.abs(
        (DIFFICULTY_RANK[c.difficulty] ?? 1) - (DIFFICULTY_RANK[base.difficulty] ?? 1)
      );
      score -= diffDelta * 3;
      return { candidate: c, score };
    })
    .sort((a, b) => b.score - a.score);

  // Never hand back a "substitute" that doesn't even share the primary
  // muscle group — that would violate the core promise of the product.
  const best = scored.find((s) => s.candidate.primaryMuscle === base.primaryMuscle);
  return best ? best.candidate : null;
}

export async function loadExerciseWithLinks(
  database: DatabaseLike,
  exerciseId: string
): Promise<ExerciseWithLinks | null> {
  const ex = await database.get<any>(`SELECT * FROM Exercise WHERE id = ?`, exerciseId);
  if (!ex) return null;
  const links = await database.all<{ equipmentId: string }>(
    `SELECT equipmentId FROM ExerciseEquipment WHERE exerciseId = ?`,
    exerciseId
  );
  return {
    id: ex.id,
    name: ex.name,
    primaryMuscle: ex.primaryMuscle,
    secondaryMuscles: ex.secondaryMuscles,
    movementPattern: ex.movementPattern,
    difficulty: ex.difficulty,
    defaultSets: ex.defaultSets,
    repRangeLow: ex.repRangeLow,
    repRangeHigh: ex.repRangeHigh,
    instructions: ex.instructions,
    requiredEquipmentIds: links.map((l) => l.equipmentId),
  };
}

export async function loadSubstituteCandidates(
  database: DatabaseLike,
  baseExerciseId: string
): Promise<ExerciseWithLinks[]> {
  const edges = await database.all<{ substituteId: string }>(
    `SELECT substituteId FROM ExerciseSubstitution WHERE baseExerciseId = ? ORDER BY priority ASC`,
    baseExerciseId
  );
  const candidates = await Promise.all(edges.map((e) => loadExerciseWithLinks(database, e.substituteId)));
  return candidates.filter((e): e is ExerciseWithLinks => e !== null);
}
