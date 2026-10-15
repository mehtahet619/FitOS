import { normalizeExerciseValue } from "../workouts/exerciseCsvRepository";

export interface ExerciseDemoMatch {
  kind: "video" | "search";
  provider: "youtube";
  videoId?: string;
  title: string;
  sourceName: string;
  sourceUrl: string;
  thumbnailUrl?: string;
  searchQuery: string;
  searchUrl: string;
}

interface CuratedExerciseDemo extends Omit<ExerciseDemoMatch, "kind" | "searchQuery" | "searchUrl"> {
  videoId: string;
  thumbnailUrl: string;
  exerciseNames: string[];
  equipment: string[];
}

// These records are manually matched to exercise guide pages and their exact
// demonstrated movement. Matching is deliberately exact after normalization.
const CURATED_DEMOS: readonly CuratedExerciseDemo[] = [
  {
    exerciseNames: ["Lat Pulldown", "Lat Pull Down"],
    equipment: ["Cable Machine", "Lat Pulldown", "Lat Pulldown Machine"],
    provider: "youtube",
    videoId: "iKrKgWR9wbY",
    title: "Lat Pull Down",
    sourceName: "Muscle & Strength",
    sourceUrl: "https://www.muscleandstrength.com/exercises/lat-pull-down.html",
    thumbnailUrl: "https://i.ytimg.com/vi/iKrKgWR9wbY/hqdefault.jpg",
  },
  {
    exerciseNames: ["Seated Cable Row"],
    equipment: ["Cable Machine"],
    provider: "youtube",
    videoId: "xQNrFHEMhI4",
    title: "Seated Cable Row",
    sourceName: "Bodybuilding.com",
    sourceUrl: "https://www.youtube.com/watch?v=xQNrFHEMhI4",
    thumbnailUrl: "https://i.ytimg.com/vi/xQNrFHEMhI4/hqdefault.jpg",
  },
  {
    exerciseNames: ["Dumbbell Row"],
    equipment: ["Dumbbell", "Dumbbells"],
    provider: "youtube",
    videoId: "roCP6wCXPqo",
    title: "Dumbbell Row",
    sourceName: "Men's Health",
    sourceUrl: "https://www.youtube.com/watch?v=roCP6wCXPqo",
    thumbnailUrl: "https://i.ytimg.com/vi/roCP6wCXPqo/hqdefault.jpg",
  },
  {
    exerciseNames: ["One Arm Dumbbell Row", "Single Arm Dumbbell Row"],
    equipment: ["Dumbbell", "Dumbbells"],
    provider: "youtube",
    videoId: "YZgVEy6cmaY",
    title: "One Arm Dumbbell Row",
    sourceName: "Muscle & Strength",
    sourceUrl: "https://www.muscleandstrength.com/exercises/one-arm-dumbbell-row.html",
    thumbnailUrl: "https://i.ytimg.com/vi/YZgVEy6cmaY/hqdefault.jpg",
  },
];

export function findExerciseDemo(
  exerciseName: string,
  equipmentRequired: readonly string[],
): ExerciseDemoMatch {
  const name = normalizeExerciseValue(exerciseName);
  const equipment = new Set(equipmentRequired.map(normalizeExerciseValue));
  const match = CURATED_DEMOS.find((demo) =>
    demo.exerciseNames.some((candidate) => normalizeExerciseValue(candidate) === name)
    && demo.equipment.some((candidate) => equipment.has(normalizeExerciseValue(candidate)))
  );
  const searchQuery = buildExerciseSearchQuery(exerciseName, equipmentRequired);
  const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(searchQuery)}`;
  if (!match || !isValidYouTubeVideoId(match.videoId)) {
    return {
      kind: "search",
      provider: "youtube",
      title: `${exerciseName.trim()} proper form demonstration`,
      sourceName: "YouTube search",
      sourceUrl: searchUrl,
      searchQuery,
      searchUrl,
    };
  }
  const { exerciseNames: _names, equipment: _equipment, ...publicMatch } = match;
  return { ...publicMatch, kind: "video", searchQuery, searchUrl };
}

function buildExerciseSearchQuery(exerciseName: string, equipmentRequired: readonly string[]): string {
  const canonicalName = exerciseName.trim();
  const normalizedName = normalizeExerciseValue(canonicalName);
  const equipmentQualifier = equipmentRequired.map((equipment) => equipment.trim()).find((equipment) => {
    const normalizedEquipment = normalizeExerciseValue(equipment);
    return normalizedEquipment && normalizedEquipment !== "no equipment" && !normalizedName.includes(normalizedEquipment);
  });
  return [canonicalName, equipmentQualifier, "proper form demonstration"].filter(Boolean).join(" ");
}

export function isValidYouTubeVideoId(videoId: string): boolean {
  return /^[A-Za-z0-9_-]{11}$/.test(videoId);
}

export function exerciseDemoEmbedUrl(demo: ExerciseDemoMatch): string | null {
  if (demo.kind !== "video" || !demo.videoId || !isValidYouTubeVideoId(demo.videoId)) return null;
  return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(demo.videoId)}?rel=0&cc_load_policy=1&enablejsapi=1`;
}
