import { normalizeExerciseLookupName, normalizeExerciseValue } from "../workouts/exerciseCsvRepository";
import { ExerciseDemoMatch, findExerciseDemo, isValidYouTubeVideoId } from "./exerciseMedia";

/**
 * Server-side exercise video resolution.
 *
 * Provider chain, first hit wins:
 *   1. "fitos-curated" — a verified catalogue of official demonstration videos.
 *      This is the approved alternative provider used when no search API is
 *      configured, and it never needs a key.
 *   2. "youtube-data-api" — dynamic YouTube Data API v3 search, enabled only
 *      when YOUTUBE_API_KEY is set. The key stays on the server; clients only
 *      ever receive a video id and its embed URL.
 *
 * Every candidate is checked for embeddability and scored for relevance before
 * it is returned, so a bench press video can never be served for a cable row.
 * Results are cached by canonical exercise id/name to keep quota usage low.
 */

const DEFAULT_MAX_RESULTS = 5;
const DEFAULT_TIMEOUT_MS = 4000;
const DEFAULT_POSITIVE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_NEGATIVE_TTL_MS = 30 * 60 * 1000;
const MAX_CACHE_ENTRIES = 500;
const MIN_RELEVANCE_SCORE = 3;

const TRUSTED_CHANNELS = [
  "nasm",
  "national academy of sports medicine",
  "bodybuilding com",
  "muscle strength",
  "men s health",
  "barbend",
  "buff dudes",
  "scott herman",
  "renaissance periodization",
  "athlean",
  "jeff nippard",
  "squat university",
  "t nation",
  "e3 rehab",
  "calisthenicmovement",
  "team elite physique",
  "picturefit",
];

// Movement families let us confirm a video shows the same movement as the
// exercise and reject a different lift that merely shares a keyword.
const MOVEMENT_FAMILIES: Array<{ family: string; pattern: RegExp; distinct: boolean }> = [
  { family: "bench_press", pattern: /bench ?press/, distinct: true },
  { family: "leg_press", pattern: /leg press/, distinct: true },
  { family: "shoulder_press", pattern: /(overhead press|shoulder press|military press|arnold press|push press)/, distinct: true },
  { family: "press", pattern: /press/, distinct: false },
  { family: "row", pattern: /row/, distinct: true },
  { family: "pulldown", pattern: /(pull ?down|pulldown)/, distinct: true },
  { family: "pull_up", pattern: /(pull ?up|chin ?up)/, distinct: true },
  { family: "curl", pattern: /curl/, distinct: true },
  { family: "squat", pattern: /squat/, distinct: true },
  { family: "deadlift", pattern: /deadlift/, distinct: true },
  { family: "lunge", pattern: /lunge/, distinct: true },
  { family: "hip_thrust", pattern: /(hip thrust|glute bridge)/, distinct: true },
  { family: "good_morning", pattern: /good morning/, distinct: true },
  { family: "pushdown", pattern: /push ?down/, distinct: true },
  { family: "extension", pattern: /extension/, distinct: true },
  { family: "fly", pattern: /(fly|flye|flys|pec deck)/, distinct: true },
  { family: "raise", pattern: /raise/, distinct: true },
  { family: "shrug", pattern: /shrug/, distinct: true },
  { family: "plank", pattern: /plank/, distinct: true },
  { family: "crunch", pattern: /(crunch|sit ?up)/, distinct: true },
  { family: "dip", pattern: /dip/, distinct: true },
  { family: "carry", pattern: /(farmer|suitcase) carry|farmer s walk/, distinct: true },
];

const EQUIPMENT_TOKENS = [
  "barbell", "dumbbell", "cable", "machine", "smith", "ez bar", "ezbar", "kettlebell",
  "band", "resistance band", "trap bar", "hex bar", "bodyweight", "trx", "sled",
];

const QUERY_STOPWORDS = new Set([
  "the", "with", "and", "for", "grip", "wide", "close", "underhand", "overhand", "reverse",
  "alternating", "single", "one", "arm", "leg", "seated", "standing", "lying",
]);

export interface ExerciseVideoQuery {
  exerciseId?: string;
  name: string;
  equipment: readonly string[];
  primaryMuscle?: string | null;
  movementPattern?: string | null;
  instructions?: string | null;
}

export interface ExerciseVideoCandidate {
  videoId: string;
  title: string;
  channelTitle: string;
  thumbnailUrl: string;
  watchUrl: string;
  durationSeconds?: number | null;
  embeddable: boolean;
}

export interface ExerciseVideoProvider {
  readonly name: string;
  readonly configured: boolean;
  search(query: string, limit: number): Promise<ExerciseVideoCandidate[]>;
}

export interface ResolvedExerciseVideo {
  demo: ExerciseDemoMatch;
  source: "cache" | "fitos-curated" | "youtube-data-api" | "none";
}

export interface ResolveExerciseVideoOptions {
  /** Bypass and overwrite the cache entry (used after playback fails). */
  refresh?: boolean;
  /** Video ids already known to be unusable for this exercise. */
  excludeVideoIds?: readonly string[];
}

type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

interface CacheEntry {
  demo: ExerciseDemoMatch;
  source: ResolvedExerciseVideo["source"];
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
let providerOverride: ExerciseVideoProvider | null | undefined;

function numberFromEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function positiveTtlMs(): number {
  return numberFromEnv("EXERCISE_VIDEO_CACHE_TTL_HOURS", DEFAULT_POSITIVE_TTL_MS / 3_600_000) * 3_600_000;
}

function negativeTtlMs(): number {
  return numberFromEnv("EXERCISE_VIDEO_NEGATIVE_TTL_MINUTES", DEFAULT_NEGATIVE_TTL_MS / 60_000) * 60_000;
}

function significantTokens(value: string): string[] {
  return normalizeExerciseLookupName(value)
    .split(" ")
    .filter((token) => token.length > 1 && !QUERY_STOPWORDS.has(token) && !EQUIPMENT_TOKENS.includes(token));
}

function equipmentTerm(query: ExerciseVideoQuery): string | null {
  const nameKey = normalizeExerciseValue(query.name);
  for (const item of query.equipment) {
    const normalized = normalizeExerciseValue(item);
    if (!normalized || normalized === "bodyweight") continue;
    if (nameKey.includes(normalized)) continue;
    return item.trim();
  }
  return null;
}

/**
 * Builds the dynamic query, e.g. "Barbell Bench Press proper form demonstration".
 */
export function buildExerciseVideoQuery(query: ExerciseVideoQuery): string {
  const term = equipmentTerm(query);
  const base = term ? `${term} ${query.name.trim()}` : query.name.trim();
  return `${base} proper form demonstration`;
}

function matchedFamilies(value: string): string[] {
  const key = normalizeExerciseValue(value);
  return MOVEMENT_FAMILIES.filter((entry) => entry.pattern.test(key)).map((entry) => entry.family);
}

function conflictingEquipment(query: ExerciseVideoQuery, title: string): boolean {
  const nameKey = normalizeExerciseValue(query.name);
  const titleKey = normalizeExerciseValue(title);
  const declared = EQUIPMENT_TOKENS.filter((token) => nameKey.includes(token));
  const mentioned = EQUIPMENT_TOKENS.filter((token) => titleKey.includes(token));
  if (declared.length === 0) return false;
  // A title that only names equipment the exercise never uses is a different lift.
  return mentioned.length > 0 && mentioned.every((token) => !declared.includes(token));
}

/**
 * Hard relevance gate plus a preference score. Returns null when the candidate
 * is a different movement, different equipment, or not embeddable.
 */
export function scoreExerciseVideo(
  query: ExerciseVideoQuery,
  candidate: ExerciseVideoCandidate,
): number | null {
  if (!candidate.embeddable || !isValidYouTubeVideoId(candidate.videoId)) return null;
  const title = candidate.title || "";
  if (conflictingEquipment(query, title)) return null;

  const exerciseFamilies = matchedFamilies(query.name);
  const titleFamilies = matchedFamilies(title);
  if (exerciseFamilies.length > 0) {
    if (!exerciseFamilies.some((family) => titleFamilies.includes(family))) return null;
    const conflicting = MOVEMENT_FAMILIES
      .filter((entry) => entry.distinct && !exerciseFamilies.includes(entry.family))
      .some((entry) => entry.pattern.test(normalizeExerciseValue(title)));
    if (conflicting) return null;
  }

  const tokens = significantTokens(query.name);
  const titleKey = normalizeExerciseLookupName(title);
  const matchedTokenCount = tokens.filter((token) => titleKey.includes(token)).length;

  // With no recognisable movement family we cannot guess, so require the whole
  // exercise name (e.g. "skull crusher", "farmer s walk") in the title.
  if (exerciseFamilies.length === 0 && (tokens.length === 0 || matchedTokenCount !== tokens.length)) {
    return null;
  }

  let score = matchedTokenCount;
  if (tokens.length > 0 && matchedTokenCount === tokens.length) score += 2;
  if (tokens.length > 0 && titleKey.includes(normalizeExerciseLookupName(query.name))) score += 4;
  if (equipmentTerm(query) && normalizeExerciseValue(title).includes(normalizeExerciseValue(equipmentTerm(query)!))) score += 1;
  if (/(how to|proper form|technique|tutorial|guide|demonstration|form check|step by step)/.test(titleKey)) score += 1;
  if (TRUSTED_CHANNELS.some((channel) => normalizeExerciseValue(candidate.channelTitle || "").includes(channel))) score += 2;

  const duration = candidate.durationSeconds;
  if (typeof duration === "number" && duration > 0) {
    if (duration >= 30 && duration <= 900) score += 1;
    if (duration > 1800) score -= 2;
    if (duration < 30) score -= 3;
  }
  return score >= MIN_RELEVANCE_SCORE ? score : null;
}

export function selectRelevantVideo(
  query: ExerciseVideoQuery,
  candidates: readonly ExerciseVideoCandidate[],
  excludeVideoIds: ReadonlySet<string> = new Set(),
): ExerciseVideoCandidate | null {
  let best: { candidate: ExerciseVideoCandidate; score: number } | null = null;
  for (const candidate of candidates) {
    if (excludeVideoIds.has(candidate.videoId)) continue;
    const score = scoreExerciseVideo(query, candidate);
    if (score === null) continue;
    if (!best || score > best.score) best = { candidate, score };
  }
  return best?.candidate ?? null;
}

function toDemo(candidate: ExerciseVideoCandidate): ExerciseDemoMatch {
  return {
    kind: "video",
    provider: "youtube",
    videoId: candidate.videoId,
    title: candidate.title,
    sourceName: candidate.channelTitle,
    sourceUrl: candidate.watchUrl,
    thumbnailUrl: candidate.thumbnailUrl,
  };
}

const DURATION_UNITS: Record<string, number> = { D: 86400, H: 3600, M: 60, S: 1 };

/** Parses an ISO 8601 duration ("PT4M13S") into seconds. */
function parseIsoDuration(value: string | undefined): number | null {
  if (!value || !value.startsWith("P")) return null;
  const parts = value.slice(1).replace("T", "").match(/[0-9]+[DHMS]/g);
  if (!parts || parts.length === 0) return null;
  let total = 0;
  for (const part of parts) {
    const amount = Number(part.slice(0, -1));
    const unit = DURATION_UNITS[part.slice(-1)];
    if (!Number.isFinite(amount) || unit === undefined) return null;
    total += amount * unit;
  }
  return total;
}

export interface YouTubeProviderOptions {
  apiKey: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

export function createYouTubeVideoProvider(options: YouTubeProviderOptions): ExerciseVideoProvider {
  const fetchImpl: FetchLike = options.fetchImpl ?? ((url, init) => fetch(url, init) as never);
  const timeoutMs = options.timeoutMs ?? numberFromEnv("EXERCISE_VIDEO_SEARCH_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);

  async function request(path: string, params: Record<string, string>): Promise<Record<string, unknown> | null> {
    const url = new URL(`https://www.googleapis.com/youtube/v3/${path}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    url.searchParams.set("key", options.apiKey);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url.toString(), { signal: controller.signal });
      if (!response.ok) {
        console.warn(`[exercise-video] YouTube ${path} responded ${response.status}`);
        return null;
      }
      return (await response.json()) as Record<string, unknown>;
    } catch (error) {
      console.warn(`[exercise-video] YouTube ${path} request failed: ${(error as Error)?.message ?? error}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    name: "youtube-data-api",
    configured: true,
    async search(query: string, limit: number): Promise<ExerciseVideoCandidate[]> {
      const search = await request("search", {
        part: "snippet",
        type: "video",
        maxResults: String(Math.min(Math.max(limit, 1), 10)),
        q: query,
        videoEmbeddable: "true",
        videoSyndicated: "true",
        safeSearch: "strict",
        relevanceLanguage: "en",
        order: "relevance",
      });
      const items = (search?.items as Array<Record<string, any>> | undefined) ?? [];
      const ids = items.map((item) => item?.id?.videoId).filter((id: unknown): id is string => typeof id === "string" && isValidYouTubeVideoId(id));
      if (ids.length === 0) return [];

      // search.list is expensive (100 quota units); videos.list confirms
      // embeddability and duration for the whole batch in a single cheap call.
      const details = await request("videos", {
        part: "snippet,contentDetails,status",
        id: ids.join(","),
        maxResults: String(ids.length),
      });
      const detailItems = new Map<string, Record<string, any>>();
      for (const item of ((details?.items as Array<Record<string, any>> | undefined) ?? [])) {
        detailItems.set(String(item.id), item);
      }

      const candidates: ExerciseVideoCandidate[] = [];
      for (const id of ids) {
        const detail = detailItems.get(id);
        const snippet = detail?.snippet ?? items.find((item) => item?.id?.videoId === id)?.snippet ?? {};
        candidates.push({
          videoId: id,
          title: String(snippet.title ?? ""),
          channelTitle: String(snippet.channelTitle ?? ""),
          thumbnailUrl: String(snippet.thumbnails?.medium?.url ?? snippet.thumbnails?.default?.url ?? `https://i.ytimg.com/vi/${id}/hqdefault.jpg`),
          watchUrl: `https://www.youtube.com/watch?v=${id}`,
          durationSeconds: parseIsoDuration(detail?.contentDetails?.duration),
          embeddable: detail ? detail?.status?.embeddable !== false : false,
        });
      }
      return candidates;
    },
  };
}

export function getVideoSearchProvider(): ExerciseVideoProvider | null {
  if (providerOverride !== undefined) return providerOverride;
  const apiKey = process.env.YOUTUBE_API_KEY?.trim();
  if (!apiKey) {
    // No key: the curated catalogue is the approved alternative provider.
    providerOverride = null;
    return null;
  }
  providerOverride = createYouTubeVideoProvider({ apiKey });
  return providerOverride;
}

/** Test seam — pass null to simulate "search API not configured". */
export function setVideoSearchProviderForTests(provider: ExerciseVideoProvider | null | undefined): void {
  providerOverride = provider;
}

export function exerciseVideoCacheKey(query: ExerciseVideoQuery): string {
  if (query.exerciseId?.trim()) return `id:${query.exerciseId.trim()}`;
  const equipment = query.equipment.map(normalizeExerciseValue).filter(Boolean).sort().join("+");
  return `name:${normalizeExerciseValue(query.name)}|${equipment}`;
}

export function exerciseVideoCacheSize(): number {
  return cache.size;
}

export function clearExerciseVideoCache(): void {
  cache.clear();
}

/** Marks a cached video unusable so the next render re-resolves it. */
export function invalidateExerciseVideo(query: ExerciseVideoQuery, videoId?: string): void {
  const key = exerciseVideoCacheKey(query);
  const entry = cache.get(key);
  if (entry && (!videoId || entry.demo.videoId === videoId)) cache.delete(key);
}

function store(key: string, demo: ExerciseDemoMatch, source: ResolvedExerciseVideo["source"]): void {
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, {
    demo,
    source,
    expiresAt: Date.now() + (demo.kind === "video" ? positiveTtlMs() : negativeTtlMs()),
  });
}

export async function resolveExerciseVideo(
  query: ExerciseVideoQuery,
  options: ResolveExerciseVideoOptions = {},
): Promise<ResolvedExerciseVideo> {
  const key = exerciseVideoCacheKey(query);
  const excluded = new Set(options.excludeVideoIds ?? []);

  if (!options.refresh) {
    const cached = cache.get(key);
    if (cached && cached.expiresAt > Date.now() && !excluded.has(cached.demo.videoId ?? "")) {
      return { demo: cached.demo, source: "cache" };
    }
  }

  // 1. Verified curated catalogue (also produces the written-instructions demo).
  const curated = findExerciseDemo(query.name, query.equipment, {
    instructions: query.instructions,
    primaryMuscle: query.primaryMuscle,
    movementPattern: query.movementPattern,
  });
  if (curated.kind === "video" && curated.videoId && !excluded.has(curated.videoId)) {
    store(key, curated, "fitos-curated");
    return { demo: curated, source: "fitos-curated" };
  }

  // 2. Dynamic search with the server-side API key.
  const provider = getVideoSearchProvider();
  if (provider?.configured) {
    try {
      const candidates = await provider.search(
        buildExerciseVideoQuery(query),
        numberFromEnv("EXERCISE_VIDEO_SEARCH_MAX_RESULTS", DEFAULT_MAX_RESULTS),
      );
      const best = selectRelevantVideo(query, candidates, excluded);
      if (best) {
        const demo = toDemo(best);
        store(key, demo, "youtube-data-api");
        return { demo, source: "youtube-data-api" };
      }
    } catch (error) {
      console.warn(`[exercise-video] search failed for ${query.name}: ${(error as Error)?.message ?? error}`);
    }
  }

  // 3. No playable video: written instructions only, never a stand-in image.
  store(key, curated, "none");
  return { demo: curated, source: "none" };
}
