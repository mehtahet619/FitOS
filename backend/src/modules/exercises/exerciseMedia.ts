import { normalizeExerciseValue } from "../workouts/exerciseCsvRepository";

export interface ExerciseDemoMatch {
  provider: "youtube" | "vimeo";
  videoId: string;
  title: string;
  sourceName: string;
  sourceUrl: string;
  thumbnailUrl: string;
}

interface CuratedExerciseDemo extends ExerciseDemoMatch {
  exerciseNames: string[];
  equipment: string[];
}

// These records are manually matched to exercise guide pages and their exact
// demonstrated movement. Matching is deliberately exact after normalization.
const CURATED_DEMOS: readonly CuratedExerciseDemo[] = [
  {
    exerciseNames: ["Lat Pulldown", "Lat Pull Down"],
    equipment: ["Cable Machine", "Lat Pulldown"],
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
    provider: "vimeo",
    videoId: "756788734?h=145dc3923d",
    title: "Seated Cable Row",
    sourceName: "Muscle & Strength",
    sourceUrl: "https://www.muscleandstrength.com/exercises/seated-row.html",
    thumbnailUrl: "https://vumbnail.com/756788734.jpg",
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
): ExerciseDemoMatch | null {
  const name = normalizeExerciseValue(exerciseName);
  const equipment = new Set(equipmentRequired.map(normalizeExerciseValue));
  const match = CURATED_DEMOS.find((demo) =>
    demo.exerciseNames.some((candidate) => normalizeExerciseValue(candidate) === name)
    && demo.equipment.some((candidate) => equipment.has(normalizeExerciseValue(candidate)))
  );
  if (!match) return null;
  const { exerciseNames: _names, equipment: _equipment, ...publicMatch } = match;
  return publicMatch;
}

export function exerciseDemoEmbedUrl(demo: ExerciseDemoMatch): string {
  if (demo.provider === "youtube") {
    return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(demo.videoId)}?rel=0&cc_load_policy=1`;
  }
  const [videoId, hash] = demo.videoId.split("?h=");
  return `https://player.vimeo.com/video/${encodeURIComponent(videoId)}?h=${encodeURIComponent(hash || "")}&texttrack=en`;
}
