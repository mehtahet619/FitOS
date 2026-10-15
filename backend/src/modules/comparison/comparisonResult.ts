/**
 * Normalises the FitOS comparison service's response for the Vision Coach.
 *
 * The service's OpenAPI document declares an untyped `200` response (no
 * response model is published), so the success payload is not formally
 * specified anywhere. This module therefore reads a bounded set of plausible
 * field names and surfaces ONLY values that are actually present in the
 * response — it never invents a score, a correction, a reference movement, or a
 * conclusion. When nothing recognisable comes back, `normalizeComparison`
 * returns null so the caller can report "no usable result" instead of rendering
 * an empty or fabricated card.
 */

export interface ComparisonDifference {
  /** Joint / body part identifier reported by the service, tidied for display. */
  part: string | null;
  /** Text the service returned for this difference, when it returned any. */
  detail: string | null;
  /** Numeric deviation the service returned, when it returned one. */
  deviation: number | null;
}

export interface ComparisonAnalysis {
  exerciseId: string;
  exerciseName: string | null;
  /** Raw score exactly as returned by the service. */
  formScore: number | null;
  /** `formScore` expressed 0-100, only when that conversion is unambiguous. */
  formScorePercent: number | null;
  confidence: number | null;
  differences: ComparisonDifference[];
  corrections: string[];
  summary: string | null;
}

const MAX_DIFFERENCES = 6;
const MAX_CORRECTIONS = 6;
const MAX_TEXT_LENGTH = 240;

const SCORE_KEYS = [
  "form_score", "formscore", "overall_score", "overallscore", "score", "similarity",
  "similarity_score", "match_score", "accuracy", "overall", "total_score", "form_accuracy",
];
const CONFIDENCE_KEYS = ["confidence", "confidence_score", "certainty", "confidence_level"];
const DIFFERENCE_KEYS = ["differences", "deviations", "issues", "mismatches", "problems", "errors", "discrepancies"];
const CORRECTION_KEYS = ["corrections", "recommendations", "suggestions", "tips", "advice", "fixes", "cues", "improvements"];
const SUMMARY_KEYS = ["summary", "message", "feedback", "analysis", "conclusion", "details", "description", "comment"];
const WRAPPER_KEYS = ["result", "results", "data", "analysis", "comparison", "payload", "response", "body"];

const DIFFERENCE_TITLE_KEYS = [
  "joint", "joint_name", "body_part", "bodypart", "part", "landmark", "name", "label", "key", "id", "type",
];
const DIFFERENCE_DETAIL_KEYS = [
  "detail", "description", "message", "issue", "deviation", "deviation_description",
  "correction", "recommendation", "suggestion", "feedback", "text", "reason", "explanation",
];
const DIFFERENCE_VALUE_KEYS = ["deviation", "delta", "difference", "value", "amount", "error", "magnitude", "angle_diff"];

function normalizeKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * Flattens an object graph into a lowercase-keyed lookup so a value can be found
 * whether the service nests it directly, inside a `result`/`data` wrapper, or
 * inside a `results[0]` array entry. First match wins, so shallower fields take
 * precedence over nested ones.
 */
function collectFields(value: unknown, lookup: Map<string, unknown>, depth: number, seen: Set<unknown>): void {
  if (depth > 4 || value === null || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);

  if (Array.isArray(value)) {
    for (const entry of value) collectFields(entry, lookup, depth + 1, seen);
    return;
  }

  for (const [rawKey, entry] of Object.entries(value as Record<string, unknown>)) {
    const key = normalizeKey(rawKey);
    if (key && !lookup.has(key)) lookup.set(key, entry);
    if (entry !== null && typeof entry === "object") collectFields(entry, lookup, depth + 1, seen);
  }
}

function pick(lookup: Map<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    const value = lookup.get(key);
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function toText(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed.slice(0, MAX_TEXT_LENGTH) : null;
  }
  return null;
}

/** "LEFT_KNEE" / "leftKnee" -> "Left knee" — a faithful tidy-up, not an inference. */
function tidyPartName(value: string): string | null {
  const spaced = value
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
  if (!spaced || spaced.length > 60) return null;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

function coerceDifference(entry: unknown): ComparisonDifference | null {
  if (typeof entry === "string") {
    const detail = toText(entry);
    return detail ? { part: null, detail, deviation: null } : null;
  }
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;

  const nested = new Map<string, unknown>();
  collectFields(entry, nested, 0, new Set());

  const rawTitle = pick(nested, DIFFERENCE_TITLE_KEYS);
  const part = typeof rawTitle === "string" ? tidyPartName(rawTitle) : null;

  const rawDetail = pick(nested, DIFFERENCE_DETAIL_KEYS);
  let detail = toText(rawDetail);
  const deviation = toFiniteNumber(pick(nested, DIFFERENCE_VALUE_KEYS));

  // A "detail" field that only repeats a joint name or a bare number adds
  // nothing — drop it rather than showing "knee — knee".
  if (detail && part && detail.toLowerCase() === part.toLowerCase()) detail = null;
  if (detail && toFiniteNumber(detail) !== null && deviation === null) detail = null;

  if (!part && !detail && deviation === null) return null;
  return { part, detail, deviation };
}

function collectDifferences(lookup: Map<string, unknown>): ComparisonDifference[] {
  const raw = pick(lookup, DIFFERENCE_KEYS);
  const entries = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? Object.values(raw) : [];
  const out: ComparisonDifference[] = [];
  for (const entry of entries) {
    const difference = coerceDifference(entry);
    if (difference) out.push(difference);
    if (out.length >= MAX_DIFFERENCES) break;
  }
  return out;
}

function collectCorrections(lookup: Map<string, unknown>): string[] {
  const raw = pick(lookup, CORRECTION_KEYS);
  const entries = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of entries) {
    const text = typeof entry === "string"
      ? toText(entry)
      : toText(pick((() => { const m = new Map<string, unknown>(); collectFields(entry, m, 0, new Set()); return m; })(), ["text", "detail", "message", "description", "correction", "recommendation"]));
    if (!text) continue;
    const dedupeKey = text.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(text);
    if (out.length >= MAX_CORRECTIONS) break;
  }
  return out;
}

/** 0.82 -> 82, 82 -> 82, 1.4 -> 1.4. Values outside 0-100 are dropped. */
function toPercent(score: number | null): number | null {
  if (score === null) return null;
  if (score >= 0 && score <= 1) return Math.round(score * 1000) / 10;
  if (score > 1 && score <= 100) return Math.round(score * 10) / 10;
  return null;
}

function clamp01(value: number | null): number | null {
  if (value === null) return null;
  if (value < 0 || value > 1) return null;
  return value;
}

/**
 * Returns null when the service answered successfully but with nothing the
 * Vision Coach can honestly display.
 */
export function normalizeComparison(
  raw: unknown,
  context: { exerciseId: string; exerciseName: string | null },
): ComparisonAnalysis | null {
  if (!raw || typeof raw !== "object") return null;
  const lookup = new Map<string, unknown>();
  collectFields(raw, lookup, 0, new Set());
  for (const wrapper of WRAPPER_KEYS) lookup.delete(wrapper);

  const formScore = toFiniteNumber(pick(lookup, SCORE_KEYS));
  const confidence = clamp01(toFiniteNumber(pick(lookup, CONFIDENCE_KEYS)));
  const differences = collectDifferences(lookup);
  const corrections = collectCorrections(lookup);
  const summary = toText(pick(lookup, SUMMARY_KEYS));

  if (formScore === null && differences.length === 0 && corrections.length === 0 && !summary) return null;

  return {
    exerciseId: context.exerciseId,
    exerciseName: context.exerciseName,
    formScore,
    formScorePercent: toPercent(formScore),
    confidence,
    differences,
    corrections,
    summary,
  };
}
