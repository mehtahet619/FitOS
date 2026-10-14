import { normalizeExerciseValue } from "./exerciseCsvRepository";

/**
 * Explicit muscle-group membership shared by generation, catalog validation,
 * and substitutions. These are workout groupings, not arbitrary synonyms:
 * for example, biceps does not become a Back muscle merely because both are
 * classified as upper pull.
 */
const MUSCLE_GROUPS: Record<string, string[]> = {
  back: [
    "back", "lat", "lats", "latissimus dorsi", "upper back", "mid back", "middle back",
    "rhomboid", "rhomboids", "rhomboid major", "rhomboid minor", "traps", "trapezius",
    "lower back", "erector spinae", "spinal erectors",
  ],
};

const MUSCLE_ALIASES: Record<string, string> = {
  lat: "lats",
  "latissimus dorsi": "lats",
  "middle back": "mid back",
  rhomboid: "rhomboids",
  "rhomboid major": "rhomboids",
  "rhomboid minor": "rhomboids",
  trapezius: "traps",
  "spinal erectors": "erector spinae",
};

const GROUP_ROOTS = new Set(Object.keys(MUSCLE_GROUPS));

const MUSCLE_GROUP_BY_MEMBER = new Map<string, string>();
for (const [group, members] of Object.entries(MUSCLE_GROUPS)) {
  for (const member of members) MUSCLE_GROUP_BY_MEMBER.set(normalizeExerciseValue(member), group);
}

export function canonicalMuscleKey(value: string): string {
  const key = normalizeExerciseValue(value);
  return MUSCLE_ALIASES[key] ?? key;
}

/** True when an exercise's primary muscle belongs to the requested workout target. */
export function primaryMuscleMatchesTarget(target: string, primaryMuscle: string | undefined | null): boolean {
  if (!primaryMuscle?.trim()) return false;
  const targetKey = normalizeExerciseValue(target);
  const primaryKey = normalizeExerciseValue(primaryMuscle);
  if (!targetKey || !primaryKey) return false;
  if (targetKey === primaryKey) return true;

  const targetGroup = GROUP_ROOTS.has(targetKey) ? targetKey : MUSCLE_GROUP_BY_MEMBER.get(targetKey);
  const primaryGroup = GROUP_ROOTS.has(primaryKey) ? primaryKey : MUSCLE_GROUP_BY_MEMBER.get(primaryKey);
  return Boolean(targetGroup && primaryGroup === targetGroup);
}

/** True only when two primary muscles share an explicitly declared workout group. */
export function primaryMusclesShareGroup(left: string | undefined | null, right: string | undefined | null): boolean {
  if (!left?.trim() || !right?.trim()) return false;
  const leftKey = normalizeExerciseValue(left);
  const rightKey = normalizeExerciseValue(right);
  if (leftKey === rightKey) return true;
  const leftGroup = MUSCLE_GROUP_BY_MEMBER.get(leftKey);
  return Boolean(leftGroup && MUSCLE_GROUP_BY_MEMBER.get(rightKey) === leftGroup);
}

/** Returns whether a CSV muscle category contributes to one of the workout targets. */
export function muscleCategoryMatchesTarget(target: string, category: string): boolean {
  return primaryMuscleMatchesTarget(target, category);
}
