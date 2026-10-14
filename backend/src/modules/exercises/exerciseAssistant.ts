export interface ExerciseAssistantContext {
  name: string;
  primaryMuscle: string;
  secondaryMuscles: string[];
  equipment: string[];
  instructions: string;
  movementPattern?: string;
}

export interface ExerciseAssistantProvider {
  name: "OpenRouter" | "Anthropic" | "OpenAI";
  apiKey: string;
  model: string;
  url: string;
}

export function buildExerciseAssistantMessages(context: ExerciseAssistantContext, question: string) {
  const system = [
    "You are FitOS's exercise-specific training assistant.",
    "Answer only about the canonical exercise and exact catalog context supplied by the user message.",
    "You may offer general, conservative guidance about setup, form, breathing, common mistakes, and alternatives.",
    "Do not invent equipment, catalog instructions, video links, or claim a video exists.",
    "If the context is insufficient for a specific detail, say what is unknown and ask a brief follow-up.",
    "Keep advice concise, practical, and avoid diagnosing injuries.",
  ].join(" ");
  const user = JSON.stringify({
    exercise: {
      name: context.name,
      primaryTargetMuscle: context.primaryMuscle,
      secondaryMuscles: context.secondaryMuscles,
      equipment: context.equipment,
      catalogInstructions: context.instructions,
      movementPattern: context.movementPattern || "not specified",
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

export async function answerExerciseQuestion(context: ExerciseAssistantContext, question: string): Promise<string | null> {
  const providers = configuredProviders();
  if (!providers.length) {
    console.warn("[exercises] Exercise assistant unavailable: configure OPENROUTER_API_KEY, ANTHROPIC_API_KEY, or OPENAI_API_KEY.");
    return null;
  }
  const messages = buildExerciseAssistantMessages(context, question);
  for (const provider of providers) {
    try {
      return await askProvider(provider, messages);
    } catch (error) {
      console.warn(`[exercises] ${provider.name} exercise assistant failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return null;
}
