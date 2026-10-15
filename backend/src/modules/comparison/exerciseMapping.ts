/**
 * Maps a Vision Coach exercise key (`squat` / `curl` / `pushup`) onto an
 * exercise identifier the comparison service actually accepts.
 *
 * The identifiers are never hardcoded: they are read from the service's own
 * `GET /exercises` catalogue so the mapping cannot drift from what the service
 * supports. When nothing in the catalogue matches confidently the comparison is
 * reported as unsupported instead of sending a guessed id.
 */

import type { ComparisonExercise } from "./comparisonProvider";

const SYNONYMS: Record<string, readonly string[]> = {
  squat: ["squat", "back squat", "barbell squat", "bodyweight squat", "air squat", "goblet squat", "front squat"],
  curl: ["curl", "bicep curl", "biceps curl", "dumbbell curl", "barbell curl", "arm curl", "elbow flexion"],
  pushup: ["pushup", "push up", "push ups", "press up", "pressup", "push up"],
};

const MIN_MATCH_SCORE = 70;

function canonical(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function scoreCandidate(localKey: string, candidate: ComparisonExercise): number {
  const key = canonical(localKey);
  const id = canonical(candidate.id);
  const name = canonical(candidate.name);
  const synonyms = SYNONYMS[key] ?? [key];
  const canonicalSynonyms = synonyms.map(canonical);

  if (id === key || name === key) return 100;
  if (canonicalSynonyms.includes(id)) return 95;
  if (canonicalSynonyms.includes(name)) return 93;
  if (name.startsWith(`${key} `) || name.endsWith(` ${key}`)) return 80;
  if (id.startsWith(`${key} `) || id.endsWith(` ${key}`) || id.startsWith(key) || id.endsWith(key)) return 75;
  if (name.includes(key) || id.includes(key)) return 72;

  for (const synonym of canonicalSynonyms) {
    if (synonym !== key && (name.includes(synonym) || id.includes(synonym))) return MIN_MATCH_SCORE;
  }
  return 0;
}

export interface ExerciseMatch {
  matched: boolean;
  /** Identifier to send as `exercise_id`; null when nothing matched confidently. */
  exerciseId: string | null;
  /** Catalogue name for display, when the service provided one. */
  exerciseName: string | null;
}

export function matchSupportedExercise(localKey: string, catalogue: readonly ComparisonExercise[]): ExerciseMatch {
  let best: { score: number; candidate: ComparisonExercise } | null = null;
  for (const candidate of catalogue) {
    const score = scoreCandidate(localKey, candidate);
    if (score > (best?.score ?? 0)) best = { score, candidate };
  }
  if (!best || best.score < MIN_MATCH_SCORE) {
    return { matched: false, exerciseId: null, exerciseName: null };
  }
  return { matched: true, exerciseId: best.candidate.id, exerciseName: best.candidate.name };
}
