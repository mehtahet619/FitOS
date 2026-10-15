import { normalizeExerciseValue } from "../workouts/exerciseCsvRepository";

export interface ExerciseDemoMatch {
  kind: "video" | "instructions";
  provider?: "youtube";
  videoId?: string;
  title: string;
  sourceName?: string;
  sourceUrl?: string;
  thumbnailUrl?: string;
  instructions?: string;
}

interface CuratedExerciseDemo extends Omit<ExerciseDemoMatch, "kind" | "instructions"> {
  videoId: string;
  thumbnailUrl: string;
  sourceName: string;
  sourceUrl: string;
  exerciseNames: string[];
  equipment: string[];
}

export interface ExerciseInstructionContext {
  instructions?: string | null;
  primaryMuscle?: string | null;
  movementPattern?: string | null;
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
  {
    exerciseNames: ["Bench Press"],
    equipment: ["Barbell"],
    provider: "youtube",
    videoId: "CayG6UYqL8g",
    title: "Barbell Bench Press",
    sourceName: "NASM",
    sourceUrl: "https://www.youtube.com/watch?v=CayG6UYqL8g",
    thumbnailUrl: "https://i.ytimg.com/vi/CayG6UYqL8g/hqdefault.jpg",
  },
  {
    exerciseNames: ["Back Squat"],
    equipment: ["Barbell"],
    provider: "youtube",
    videoId: "3tn-xqyUUkQ",
    title: "Back Squat",
    sourceName: "BarBend",
    sourceUrl: "https://www.youtube.com/watch?v=3tn-xqyUUkQ",
    thumbnailUrl: "https://i.ytimg.com/vi/3tn-xqyUUkQ/hqdefault.jpg",
  },
];

export function findExerciseDemo(
  exerciseName: string,
  equipmentRequired: readonly string[],
  instructionContext: ExerciseInstructionContext = {},
): ExerciseDemoMatch {
  const name = normalizeExerciseValue(exerciseName);
  const equipment = new Set(equipmentRequired.map(normalizeExerciseValue));
  const match = CURATED_DEMOS.find((demo) =>
    demo.exerciseNames.some((candidate) => normalizeExerciseValue(candidate) === name)
    && demo.equipment.some((candidate) => equipment.has(normalizeExerciseValue(candidate)))
  );
  if (!match || !isValidYouTubeVideoId(match.videoId)) {
    return {
      kind: "instructions",
      title: `${exerciseName.trim()} instructions`,
      instructions: buildExerciseInstructionFallback(exerciseName, equipmentRequired, instructionContext),
    };
  }
  const { exerciseNames: _names, equipment: _equipment, ...publicMatch } = match;
  return {
    ...publicMatch,
    kind: "video",
    instructions: buildExerciseInstructionFallback(exerciseName, equipmentRequired, instructionContext),
  };
}

export function buildExerciseInstructionFallback(
  exerciseName: string,
  equipmentRequired: readonly string[],
  context: ExerciseInstructionContext = {},
): string {
  const normalizedName = normalizeExerciseValue(exerciseName);
  const eccentric = normalizedName.includes("eccentric emphasis");
  const row = /\brow\b/.test(normalizedName) || normalizedName.includes("pulldown") || normalizedName.includes("pull up");
  const eccentricRow = eccentric && row;
  const savedInstructions = context.instructions?.trim();
  if (savedInstructions) {
    return eccentric && !/3 seconds|three seconds|slowly/i.test(savedInstructions)
      ? `${savedInstructions} Emphasize the return by lowering the resistance over about 3 seconds.`
      : savedInstructions;
  }

  const patternGuidance: Record<string, string> = {
    horizontal_push: "Brace your torso, press the resistance away from your chest, then return it under control.",
    vertical_push: "Brace your torso and press the resistance overhead through a comfortable range, then lower it under control.",
    horizontal_pull: "Brace your torso and pull the resistance toward your ribs, then extend your arms under control.",
    vertical_pull: "Keep your torso steady, pull down with your elbows toward your sides, then return overhead under control.",
    squat: "Keep your whole foot grounded, sit your hips down and back with knees tracking over toes, then stand with control.",
    hinge: "Keep a soft bend in your knees, hinge at your hips while keeping the load close, then extend your hips to stand.",
    lunge: "Step into a stable split stance, lower with control while keeping your front knee aligned over your foot, then return to standing.",
    elbow_flexion: "Keep your upper arms steady, flex your elbows to raise the resistance, then lower it slowly.",
    elbow_extension: "Keep your upper arms steady, extend your elbows against the resistance, then return slowly.",
    abduction: "Keep your torso steady, move the working limb away from your midline through a comfortable range, then return slowly.",
    plantarflexion: "Rise through the balls of your feet, pause briefly, then lower your heels slowly through a comfortable range.",
    anti_extension: "Brace your abdomen and keep your spine neutral while resisting movement through your trunk.",
    flexion: "Brace your trunk and curl through a comfortable range without swinging, then return slowly.",
    rotation: "Brace your hips and rotate through your trunk under control, then return to the starting position.",
  };
  const movementPattern = context.movementPattern?.trim().toLowerCase() || "";
  const setup = equipmentRequired.length > 0
    ? `Set up the ${exerciseName} with ${equipmentRequired.join(" and ")}.`
    : `Set up for ${exerciseName} using bodyweight.`;
  if (eccentricRow) {
    return `${setup} Sit tall with your feet braced. Pull the handle toward your lower ribs, then extend your arms back over about 3 seconds while keeping tension on the cable. Avoid rocking your torso.`;
  }
  const inferredPattern = movementPattern === "csv_recommendation" && row ? "horizontal_pull" : movementPattern;
  const movement = patternGuidance[inferredPattern]
    || "Move through a comfortable range with controlled tempo, then return to the starting position without swinging.";
  const target = context.primaryMuscle?.trim();
  const eccentricCue = eccentric ? "Lower the resistance over about 3 seconds to emphasize the return phase." : "";
  return [setup, movement, eccentricCue, target ? `Keep the ${target} muscles engaged.` : "Keep the target muscles engaged.", "Stop if you feel pain."]
    .join(" ");
}

export function isValidYouTubeVideoId(videoId: string): boolean {
  return /^[A-Za-z0-9_-]{11}$/.test(videoId);
}

export function exerciseDemoEmbedUrl(demo: ExerciseDemoMatch): string | null {
  if (demo.kind !== "video" || !demo.videoId || !isValidYouTubeVideoId(demo.videoId)) return null;
  return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(demo.videoId)}?rel=0&cc_load_policy=1&enablejsapi=1`;
}
