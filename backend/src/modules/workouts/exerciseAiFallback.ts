function normalizeExerciseValue(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

export interface RecommendedExercise {
  sourceIndex: number;
  exercise: string;
  machine: string;
  muscle: string;
  primaryMuscle: string;
  muscleCategories: string[];
  timeTakenOneSet: string;
  targetedMuscle: string;
  targetedMuscles: string[];
  instructions?: string;
  sets?: number;
  repRangeLow?: number;
  repRangeHigh?: number;
}

export function exerciseFamilyKey(exerciseName: string): string {
  return normalizeExerciseValue(exerciseName)
    .replace(/\\b(?:controlled|slow|explosive|tempo|wide|close|neutral|underhand|overhand|seated|standing|kneeling|lying|prone|supine|barbell|dumbbell|cable|machine)\\b/g, " ")
    .replace(/\s+/g, " ").trim();
}

export interface ExerciseFallbackEquipment {
  name: string;
  aliases: string[];
}

export interface ExerciseFallbackInput {
  targetMuscles: string[];
  sessionDurationMinutes: number;
  count: number;
  equipment: ExerciseFallbackEquipment[];
  excludedExerciseNames?: Iterable<string>;
  excludedFamilyKeys?: Iterable<string>;
  targetedMuscle?: string;
  timeTakenOneSet?: string;
}

interface ProviderConfig {
  name: "OpenRouter";
  apiKey: string;
  model: string;
  url: string;
}

export interface AiExerciseValidationInput {
  exerciseName: string;
  muscles: string[];
  equipment: string[];
}

export interface AiExerciseValidation {
  valid: boolean;
  canonicalName?: string;
  primaryMuscle?: string;
  secondaryMuscles: string[];
  equipmentName?: string;
  confidence: number;
  reason?: string;
}

function configuredProviders(): ProviderConfig[] {
  if (!process.env.OPENROUTER_API_KEY) return [];
  return [{
    name: "OpenRouter",
    apiKey: process.env.OPENROUTER_API_KEY,
    model: process.env.OPENROUTER_MODEL || "openrouter/auto",
    url: "https://openrouter.ai/api/v1/chat/completions",
  }];
}

function parseJson(content: string): unknown {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("Provider did not return a JSON object.");
  return JSON.parse(trimmed.slice(start, end + 1));
}

function validatedExercises(content: string, input: ExerciseFallbackInput): RecommendedExercise[] {
  const payload = parseJson(content) as { exercises?: unknown };
  if (!Array.isArray(payload.exercises)) throw new Error("Provider response is missing exercises.");
  const targetByKey = new Map(input.targetMuscles.map((muscle) => [normalizeExerciseValue(muscle), muscle]));
  const equipmentByAlias = new Map<string, string>();
  for (const option of input.equipment) {
    equipmentByAlias.set(normalizeExerciseValue(option.name), option.name);
    for (const alias of option.aliases) equipmentByAlias.set(normalizeExerciseValue(alias), option.name);
  }
  const excludedNames = new Set([...(input.excludedExerciseNames ?? [])].map(normalizeExerciseValue));
  const excludedFamilies = new Set([...(input.excludedFamilyKeys ?? [])].map(normalizeExerciseValue));
  const names = new Set<string>();
  const families = new Set(excludedFamilies);
  const result: RecommendedExercise[] = [];

  for (const item of payload.exercises) {
    if (!item || typeof item !== "object") continue;
    const candidate = item as Record<string, unknown>;
    if (typeof candidate.exercise !== "string" || typeof candidate.machine !== "string" || typeof candidate.muscle !== "string") continue;
    const exercise = candidate.exercise.trim();
    const nameKey = normalizeExerciseValue(exercise);
    const muscle = targetByKey.get(normalizeExerciseValue(candidate.muscle));
    const machine = equipmentByAlias.get(normalizeExerciseValue(candidate.machine));
    if (!exercise || exercise.length > 100 || !muscle || !machine || excludedNames.has(nameKey) || names.has(nameKey)) continue;
    const family = exerciseFamilyKey(exercise);
    if (!family || families.has(normalizeExerciseValue(family))) continue;
    names.add(nameKey);
    families.add(normalizeExerciseValue(family));
    result.push({
      sourceIndex: -result.length - 1,
      exercise,
      machine,
      muscle,
      primaryMuscle: muscle,
      muscleCategories: [muscle],
      timeTakenOneSet: input.timeTakenOneSet || "25-45 sec",
      targetedMuscle: input.targetedMuscle || muscle,
      targetedMuscles: [input.targetedMuscle || muscle],
      instructions: typeof candidate.instructions === "string" ? candidate.instructions.slice(0, 1200) : "",
      sets: Number.isInteger(candidate.sets) ? Math.max(2, Math.min(5, Number(candidate.sets))) : 3,
      repRangeLow: Number.isInteger(candidate.repRangeLow) ? Math.max(1, Math.min(30, Number(candidate.repRangeLow))) : 8,
      repRangeHigh: Number.isInteger(candidate.repRangeHigh) ? Math.max(1, Math.min(30, Number(candidate.repRangeHigh))) : 12,
    });
    if (result.length >= input.count) break;
  }

  if (result.length < input.count) throw new Error(`Provider returned only ${result.length} valid of ${input.count} requested exercises.`);
  return result;
}

async function callProvider(provider: ProviderConfig, input: ExerciseFallbackInput): Promise<string> {
  const prompt = {
    task: "Generate a complete, balanced strength-training workout directly from the user profile and available gym equipment. Do not use or imitate a fixed exercise catalogue.",
    sessionDurationMinutes: input.sessionDurationMinutes,
    numberOfExercises: input.count,
    targetMuscles: input.targetMuscles,
    allowedEquipment: input.equipment.map(({ name, aliases }) => ({ name, aliases })),
    ...(input.targetedMuscle ? { requiredTargetedMuscle: input.targetedMuscle } : {}),
    ...(input.timeTakenOneSet ? { requiredOneSetDuration: input.timeTakenOneSet } : {}),
    rules: [
      "Return only a JSON object with an exercises array; do not use markdown.",
      "Each item must have exercise, machine, muscle, instructions, sets, repRangeLow, and repRangeHigh fields.",
      "Use only an exact allowedEquipment name or alias for machine; never invent equipment.",
      "Use only one of the exact targetMuscles values for muscle; never change the workout focus.",
      "Distribute exercises across ALL targetMuscles as evenly as practical; for Full Body, cover lower body, push, pull, shoulders and core rather than clustering on one area.",
      "Choose biomechanically sound, distinct movement patterns and avoid duplicate exercises or superficial grip, stance, tempo, or equipment variants.",
      "Prioritize compound movements, then accessories. Match every exercise to the exact equipment the user has available. Bodyweight is allowed.",
      "Provide concise actionable setup and execution instructions, realistic sets (2-4), and sensible rep ranges. Never prescribe an exercise requiring unavailable equipment.",
      "Do not add explanations, warmups, or exercises beyond the requested number.",
    ],
  };
  const system = "You are a conservative exercise catalog assistant. Follow the supplied constraints exactly and return valid JSON only.";
  const body = {
    model: provider.model,
    temperature: 0.1,
    max_tokens: 1600,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      { role: "user", content: JSON.stringify(prompt) },
    ],
  };
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${provider.apiKey}`,
    "HTTP-Referer": "https://fitos.app",
    "X-Title": "FitOS",
  };
  const response = await fetch(provider.url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(25_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = await response.json() as any;
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("Provider returned no text content.");
  return content;
}

async function callExerciseValidator(provider: ProviderConfig, input: AiExerciseValidationInput): Promise<string> {
  const prompt = {
    task: "Validate a user-entered strength-training exercise and identify its catalogue mapping.",
    exerciseName: input.exerciseName,
    allowedMuscles: input.muscles,
    allowedEquipment: input.equipment,
    rules: [
      "Decide whether this is a real, recognized strength-training exercise, not an invented or nonsensical phrase.",
      "If valid, return its conventional canonical exercise name, primary muscle, any secondary muscles, and the equipment needed.",
      "Use only exact values from allowedMuscles and allowedEquipment. If a muscle or equipment cannot be mapped, return valid=false.",
      "Do not claim an exercise targets a muscle just because it may stabilize it; distinguish primary and secondary muscles.",
      "Return confidence from 0 to 1 and a short reason.",
      "Return only JSON with valid, canonicalName, primaryMuscle, secondaryMuscles, equipmentName, confidence, and reason fields.",
    ],
  };
  const system = "You validate conventional resistance-training movements conservatively. Do not invent exercises, muscles, or equipment. Return valid JSON only.";
  const body = {
    model: provider.model,
    temperature: 0,
    max_tokens: 500,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      { role: "user", content: JSON.stringify(prompt) },
    ],
  };
  const response = await fetch(provider.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${provider.apiKey}`,
      "HTTP-Referer": "https://fitos.app",
      "X-Title": "FitOS",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(7_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = await response.json() as any;
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("Provider returned no text content.");
  return content;
}

/** Uses configured LLM providers only to validate and structure a new catalogue entry. */
export async function validateUncataloguedExercise(
  input: AiExerciseValidationInput,
): Promise<AiExerciseValidation | null> {
  const configured = configuredProviders();
  const providers = configured;
  const muscleByKey = new Map(input.muscles.map((muscle) => [normalizeExerciseValue(muscle), muscle]));
  const equipmentByKey = new Map(input.equipment.map((equipment) => [normalizeExerciseValue(equipment), equipment]));
  const configuredThreshold = Number(process.env.EXERCISE_CATALOG_VALIDATION_THRESHOLD);
  const confidenceThreshold = Number.isFinite(configuredThreshold) && configuredThreshold >= 0.5 && configuredThreshold <= 1
    ? configuredThreshold
    : 0.8;
  let rejected: AiExerciseValidation | null = null;
  for (const provider of providers) {
    try {
      const parsed = parseJson(await callExerciseValidator(provider, input)) as Record<string, unknown>;
      const confidence = typeof parsed.confidence === "number" ? parsed.confidence : 0;
      if (parsed.valid !== true) {
        rejected = {
          valid: false,
          secondaryMuscles: [],
          confidence,
          reason: typeof parsed.reason === "string" ? parsed.reason.slice(0, 300) : undefined,
        };
        continue;
      }
      if (confidence < confidenceThreshold || confidence > 1 || typeof parsed.canonicalName !== "string" || !parsed.canonicalName.trim()
        || parsed.canonicalName.trim().length > 100) {
        rejected = { valid: false, secondaryMuscles: [], confidence, reason: "The exercise could not be validated confidently." };
        continue;
      }
      const primaryMuscle = typeof parsed.primaryMuscle === "string"
        ? muscleByKey.get(normalizeExerciseValue(parsed.primaryMuscle))
        : undefined;
      const equipmentName = typeof parsed.equipmentName === "string"
        ? equipmentByKey.get(normalizeExerciseValue(parsed.equipmentName))
        : undefined;
      const secondaryMuscles = Array.isArray(parsed.secondaryMuscles)
        ? parsed.secondaryMuscles.map((muscle) => typeof muscle === "string"
          ? muscleByKey.get(normalizeExerciseValue(muscle))
          : undefined)
        : [];
      if (!primaryMuscle || !equipmentName || !Array.isArray(parsed.secondaryMuscles)
        || secondaryMuscles.some((muscle) => !muscle)) {
        rejected = { valid: false, secondaryMuscles: [], confidence, reason: "The exercise could not be mapped to FitOS muscles and equipment." };
        continue;
      }
      return {
        valid: true,
        canonicalName: parsed.canonicalName.trim(),
        primaryMuscle,
        secondaryMuscles: [...new Set(secondaryMuscles as string[])],
        equipmentName,
        confidence,
        reason: typeof parsed.reason === "string" ? parsed.reason.slice(0, 300) : undefined,
      };
    } catch (error) {
      console.warn(`[workouts] ${provider.name} exercise validation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return rejected;
}

/** Dataset rows remain first choice. Call configured providers in order only for missing exercises. */
export async function getAiExerciseFallback(input: ExerciseFallbackInput): Promise<RecommendedExercise[]> {
  if (input.count <= 0 || input.targetMuscles.length === 0 || input.equipment.length === 0) return [];
  for (const provider of configuredProviders()) {
    try {
      return validatedExercises(await callProvider(provider, input), input);
    } catch (error) {
      console.warn(`[workouts] ${provider.name} exercise fallback failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return [];
}
