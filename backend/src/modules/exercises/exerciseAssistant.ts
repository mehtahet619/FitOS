export interface ExerciseAssistantContext {
  name: string;
  primaryMuscle: string;
  secondaryMuscles: string[];
  equipment: string[];
  instructions: string;
  movementPattern?: string;
  alternatives?: Array<{ name: string; equipment: string[] }>;
}

export interface ExerciseAssistantProvider {
  name: "OpenRouter" | "Anthropic" | "OpenAI";
  apiKey: string;
  model: string;
  url: string;
}

const OFF_TOPIC_REPLY = "I can help with this exercise's technique, form, breathing, or alternatives.";

function isExerciseQuestion(question: string): boolean {
  if (/\b(c\+\+|javascript|python|write (?:a )?(?:program|script|code)|poem|recipe|politics)\b/i.test(question)) return false;
  return /\b(exercise|workout|form|technique|setup|set up|breath(?:e|ing)?|inhale|exhale|muscles?|worked|mistakes?|errors?|avoid|alternatives?|substitute|equipment|gear|grip|tempo|eccentric|concentric|row|press|curl|squat|deadlift|pulldown|pull-up|lunge|reps?|repetitions?|range of motion|posture|elbows?|shoulders?|back|wrists?|cable)\b/i.test(question);
}

function getDirectExerciseAnswer(context: ExerciseAssistantContext, question: string): string | null {
  const normalizedQuestion = question.toLowerCase();
  const exerciseName = context.name;
  const exerciseKey = exerciseName.toLowerCase();
  const movementPattern = String(context.movementPattern || "").toLowerCase();
  const isRow = movementPattern === "horizontal_pull" || /\b(row|rowing)\b/.test(exerciseKey);
  const eccentric = /eccentric|slow tempo|controlled tempo/.test(exerciseKey);

  if (/breath|breathe|breathing|inhale|exhale/.test(normalizedQuestion)) {
    if (isRow) {
      const returnCue = eccentric
        ? "Inhale as you extend your arms back over about 3 seconds, keeping the cable under tension"
        : "Inhale as you extend your arms back under control";
      return `For the ${exerciseName}, exhale as you pull the handle toward your torso. ${returnCue}. Keep your torso steady and avoid holding your breath.`;
    }
    if (/horizontal_push|vertical_push/.test(movementPattern)) {
      return `For the ${exerciseName}, exhale as you press the resistance away and inhale as you lower it under control. Keep breathing steadily instead of holding your breath.`;
    }
    if (/squat|hinge|lunge/.test(movementPattern)) {
      return `For the ${exerciseName}, inhale as you lower into the movement and exhale as you stand or extend. Keep your trunk braced and avoid holding your breath.`;
    }
    return `For the ${exerciseName}, exhale through the hardest part of the lift and inhale during the controlled return. Keep your breathing steady and avoid holding your breath.`;
  }

  if (/which muscles|muscles worked|what muscles|muscle does|target muscles/.test(normalizedQuestion)) {
    const supporting = context.secondaryMuscles.length ? ` It also involves ${context.secondaryMuscles.join(", ")}.` : "";
    return `The ${exerciseName} primarily works ${context.primaryMuscle}.${supporting}`;
  }

  if (/equipment|what do i need|what gear/.test(normalizedQuestion)) {
    return context.equipment.length
      ? `For the ${exerciseName}, use ${context.equipment.join(" and ")}.`
      : `The ${exerciseName} uses bodyweight; no equipment is required.`;
  }

  if (/alternative|instead|substitute/.test(normalizedQuestion)) {
    if (!context.alternatives?.length) return `I don't have a specific alternative listed for the ${exerciseName}. Tell me what equipment you have available, and I can help narrow one down.`;
    return `Options for the ${exerciseName}: ${context.alternatives.map((alternative) => `${alternative.name}${alternative.equipment.length ? ` (requires ${alternative.equipment.join(", ")})` : " (bodyweight)"}`).join("; ")}. Choose one you can set up comfortably.`;
  }

  if (/common mistake|mistakes|what should i avoid/.test(normalizedQuestion)) {
    if (isRow) return `For the ${exerciseName}, avoid jerking the handle, shrugging your shoulders, rounding your back, or letting the return pull you forward. Keep the lowering phase controlled.`;
    return `For the ${exerciseName}, avoid swinging, rushing the lowering phase, or forcing a painful range. Keep the movement controlled.`;
  }

  if (/setup|set up|form|technique/.test(normalizedQuestion)) {
    if (context.instructions.trim()) return context.instructions.trim();
    if (isRow) return `For the ${exerciseName}, sit tall with feet braced and knees softly bent. Start with arms extended, pull the handle toward your lower ribs, then return slowly without rounding or rocking your torso.`;
    return `For the ${exerciseName}, use a stable setup, move through a comfortable range with controlled tempo, and stop if you feel pain.`;
  }

  return null;
}

function safeExerciseFallback(context: ExerciseAssistantContext, question: string): string {
  const directAnswer = getDirectExerciseAnswer(context, question);
  if (directAnswer) return directAnswer;
  const instructions = context.instructions.trim();
  if (instructions) return `For the ${context.name}, ${instructions}`;
  return `For the ${context.name}, use a stable setup and controlled movement through a comfortable range. Stop if you feel pain.`;
}

function containsInternalAssistantText(answer: string): boolean {
  return /catalog(?:ue)?|database|provider|API key|model configuration|internal limitation|instructions are (?:currently )?empty|I(?:'m| am) limited to guidance/i.test(answer)
    || /```|#include\s*<|\bint\s+main\s*\(/i.test(answer);
}

export function buildExerciseAssistantMessages(context: ExerciseAssistantContext, question: string) {
  const system = [
    "You are FitOS's exercise coach. Answer the user's actual question directly and naturally about the named exercise.",
    "Help with technique, setup, breathing, muscles worked, common mistakes, and alternatives.",
    "Never mention catalogs, databases, APIs, providers, models, missing stored text, or implementation limitations.",
    "Do not write code or answer unrelated requests. For an unrelated request, reply exactly: I can help with this exercise's technique, form, breathing, or alternatives.",
    "Only name an alternative if it appears in the supplied alternatives. State its equipment requirement.",
    "Use conservative concise advice, do not diagnose injuries, and tell the user to stop if a movement causes pain.",
  ].join(" ");
  const user = JSON.stringify({
    exercise: {
      name: context.name,
      primaryTargetMuscle: context.primaryMuscle,
      secondaryMuscles: context.secondaryMuscles,
      equipment: context.equipment,
      catalogInstructions: context.instructions,
      movementPattern: context.movementPattern || "not specified",
      alternatives: context.alternatives || [],
    },
    question,
  });
  return { system, user };
}

function configuredProviders(): ExerciseAssistantProvider[] {
  const providers: ExerciseAssistantProvider[] = [];
  if (process.env.OPENROUTER_API_KEY) providers.push({
    name: "OpenRouter", apiKey: process.env.OPENROUTER_API_KEY,
    model: process.env.OPENROUTER_MODEL || "openrouter/auto", url: "https://openrouter.ai/api/v1/chat/completions",
  });
  if (process.env.ANTHROPIC_API_KEY) providers.push({
    name: "Anthropic", apiKey: process.env.ANTHROPIC_API_KEY,
    model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6", url: "https://api.anthropic.com/v1/messages",
  });
  if (process.env.OPENAI_API_KEY) providers.push({
    name: "OpenAI", apiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_MODEL || "gpt-4o-mini", url: "https://api.openai.com/v1/chat/completions",
  });
  return providers;
}

export function isExerciseAssistantConfigured(): boolean {
  return configuredProviders().length > 0;
}

async function askProvider(provider: ExerciseAssistantProvider, messages: ReturnType<typeof buildExerciseAssistantMessages>): Promise<string> {
  const anthropic = provider.name === "Anthropic";
  const response = await fetch(provider.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(anthropic
        ? { "x-api-key": provider.apiKey, "anthropic-version": "2023-06-01" }
        : { Authorization: `Bearer ${provider.apiKey}` }),
    },
    body: JSON.stringify(anthropic
      ? { model: provider.model, max_tokens: 700, system: messages.system, messages: [{ role: "user", content: messages.user }] }
      : { model: provider.model, max_tokens: 700, temperature: 0.3, messages: [{ role: "system", content: messages.system }, { role: "user", content: messages.user }] }),
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = await response.json() as any;
  const answer = anthropic
    ? payload.content?.find((block: any) => block.type === "text")?.text
    : payload.choices?.[0]?.message?.content;
  if (typeof answer !== "string" || !answer.trim()) throw new Error("Provider returned no answer.");
  return answer.trim().slice(0, 4000);
}

export async function answerExerciseQuestion(context: ExerciseAssistantContext, question: string): Promise<string> {
  if (!isExerciseQuestion(question)) return OFF_TOPIC_REPLY;
  const directAnswer = getDirectExerciseAnswer(context, question);
  if (directAnswer) return directAnswer;

  const providers = configuredProviders();
  if (!providers.length) return safeExerciseFallback(context, question);
  const messages = buildExerciseAssistantMessages(context, question);
  for (const provider of providers) {
    try {
      const answer = await askProvider(provider, messages);
      return containsInternalAssistantText(answer) ? safeExerciseFallback(context, question) : answer;
    } catch (error) {
      console.warn(`[exercises] ${provider.name} exercise assistant failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return safeExerciseFallback(context, question);
}
