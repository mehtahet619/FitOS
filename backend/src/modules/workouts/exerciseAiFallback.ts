import { normalizeExerciseValue } from "./exerciseCsvRepository";
import { exerciseFamilyKey, type RecommendedExercise } from "./exerciseRecommendation";

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
  name: "OpenRouter" | "Anthropic";
  apiKey: string;
  model: string;
  url: string;
}

function configuredProviders(): ProviderConfig[] {
  const providers: ProviderConfig[] = [];
  if (process.env.OPENROUTER_API_KEY) {
    providers.push({
      name: "OpenRouter",
      apiKey: process.env.OPENROUTER_API_KEY,
      model: process.env.OPENROUTER_MODEL || "openrouter/auto",
      url: "https://openrouter.ai/api/v1/chat/completions",
    });
  }
  if (process.env.ANTHROPIC_API_KEY) {
    providers.push({
      name: "Anthropic",
      apiKey: process.env.ANTHROPIC_API_KEY,
      model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6",
      url: "https://api.anthropic.com/v1/messages",
    });
  }
  return providers;
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
    });
    if (result.length >= input.count) break;
  }

  if (result.length < input.count) throw new Error(`Provider returned only ${result.length} valid of ${input.count} requested exercises.`);
  return result;
}

async function callProvider(provider: ProviderConfig, input: ExerciseFallbackInput): Promise<string> {
  const prompt = {
    task: "Suggest safe, conventional strength-training exercises that fill gaps in a workout dataset.",
    sessionDurationMinutes: input.sessionDurationMinutes,
    numberOfExercises: input.count,
    targetMuscles: input.targetMuscles,
    allowedEquipment: input.equipment.map(({ name, aliases }) => ({ name, aliases })),
    ...(input.targetedMuscle ? { requiredTargetedMuscle: input.targetedMuscle } : {}),
    ...(input.timeTakenOneSet ? { requiredOneSetDuration: input.timeTakenOneSet } : {}),
    rules: [
      "Return only a JSON object with an exercises array; do not use markdown.",
      "Each item must have exercise, machine, and muscle string fields.",
      "Use only an exact allowedEquipment name or alias for machine; never invent equipment.",
      "Use only one of the exact targetMuscles values for muscle; never change the workout focus.",
      "Return distinct movement patterns, not grip, stance, tempo, or equipment variants of one movement.",
      "Do not add explanations, warmups, or exercises beyond the requested number.",
    ],
  };
  const system = "You are a conservative exercise catalog assistant. Follow the supplied constraints exactly and return valid JSON only.";
  const body = provider.name === "OpenRouter"
    ? {
      model: provider.model,
      temperature: 0.1,
      max_tokens: 1200,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify(prompt) },
      ],
    }
    : {
      model: provider.model,
      max_tokens: 1200,
      system,
      messages: [{ role: "user", content: JSON.stringify(prompt) }],
    };
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(provider.name === "OpenRouter"
      ? { Authorization: `Bearer ${provider.apiKey}` }
      : { "x-api-key": provider.apiKey, "anthropic-version": "2023-06-01" }),
  };
  const response = await fetch(provider.url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = await response.json() as any;
  const content = provider.name === "OpenRouter"
    ? payload.choices?.[0]?.message?.content
    : payload.content?.find((block: any) => block.type === "text")?.text;
  if (typeof content !== "string") throw new Error("Provider returned no text content.");
  return content;
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
