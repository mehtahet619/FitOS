/**
 * AI provider abstraction for FitOS.
 * Nearby-food ranking uses OpenRouter first and Anthropic Claude as fallback.
 * The model may rank only real supplied dish records; all IDs and scores are
 * validated before results are returned. Nutrition values are never filled in
 * by the LLM.
 */

export interface AiProvider {
  explainSubstitution(input: { originalExercise: string; substituteExercise: string; reason: string }): Promise<string>;
  explainWorkout(input: { focus: string; exerciseNames: string[] }): Promise<string>;
  analyzeHealthyDishes(input: { dishes: HealthyDishInput[]; preferences?: HealthyFoodPreferences }): Promise<HealthyDishAnalysis[]>;
}

export interface HealthyDishInput {
  dishId: string;
  name: string;
  restaurantName: string;
  restaurantUrl?: string;
  priceInr?: number;
  description?: string;
  category?: string;
  calories?: number;
  proteinG?: number;
  carbsG?: number;
  fatG?: number;
  isVeg?: boolean;
}

export interface HealthyFoodPreferences {
  primaryGoal?: string;
  dietaryPref?: string;
  allergies?: string;
  foodLikes?: string;
  dailyBudgetInr?: number;
  weightKg?: number;
}

export interface HealthyDishAnalysis {
  dishId: string;
  healthScore: number;
  reasons: string[];
  nutritionConfidence: "verified" | "estimated" | "llm_estimated";
}

export class TemplateAiProvider implements AiProvider {
  async explainSubstitution(input: { originalExercise: string; substituteExercise: string; reason: string }): Promise<string> {
    return `Swapped "${input.originalExercise}" for "${input.substituteExercise}" — ${input.reason}, using only the equipment you have available.`;
  }
  async explainWorkout(input: { focus: string; exerciseNames: string[] }): Promise<string> {
    return `Today's ${input.focus} session: ${input.exerciseNames.join(", ")}. Built around your current equipment.`;
  }
  async analyzeHealthyDishes(input: { dishes: HealthyDishInput[]; preferences?: HealthyFoodPreferences }): Promise<HealthyDishAnalysis[]> {
    return input.dishes.map((dish) => {
      const text = `${dish.name} ${dish.description || ""} ${dish.category || ""}`.toLowerCase();
      let score = 55;
      if (dish.proteinG != null && dish.proteinG >= 25) score += 18;
      else if (dish.proteinG != null && dish.proteinG >= 15) score += 10;
      if (dish.calories != null && dish.calories <= 500) score += 8;
      if (/salad|grilled|bowl|vegetable|veggie|dal|paneer/.test(text)) score += 8;
      if (/fried|deep fry|dessert|sweet|cola|shake/.test(text)) score -= 18;
      return {
        dishId: dish.dishId, healthScore: Math.max(0, Math.min(100, score)),
        reasons: [dish.proteinG != null ? `Menu data lists ${dish.proteinG} g protein` : "Nutrition data is not listed by the source"],
        nutritionConfidence: "estimated" as const,
      };
    });
  }
}

type Provider = { name: "OpenRouter" | "Anthropic"; apiKey: string; model: string; url: string };

function configuredProviders(): Provider[] {
  const providers: Provider[] = [];
  if (process.env.OPENROUTER_API_KEY) providers.push({
    name: "OpenRouter", apiKey: process.env.OPENROUTER_API_KEY,
    model: process.env.OPENROUTER_MODEL || "openrouter/auto",
    url: "https://openrouter.ai/api/v1/chat/completions",
  });
  if (process.env.ANTHROPIC_API_KEY) providers.push({
    name: "Anthropic", apiKey: process.env.ANTHROPIC_API_KEY,
    model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6",
    url: "https://api.anthropic.com/v1/messages",
  });
  return providers;
}

function parseAnalyses(raw: string, dishes: HealthyDishInput[]): HealthyDishAnalysis[] {
  const parsed = JSON.parse(raw) as { recommendations?: unknown };
  if (!Array.isArray(parsed.recommendations)) throw new Error("LLM returned no recommendations array.");
  const known = new Map(dishes.map((dish) => [dish.dishId, dish]));
  const seen = new Set<string>();
  const results: HealthyDishAnalysis[] = [];
  for (const item of parsed.recommendations) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (typeof row.dishId !== "string" || !known.has(row.dishId) || seen.has(row.dishId)) continue;
    const score = Number(row.healthScore);
    if (!Number.isFinite(score)) continue;
    seen.add(row.dishId);
    const reasons = Array.isArray(row.reasons)
      ? row.reasons.filter((reason): reason is string => typeof reason === "string").slice(0, 4).map((reason) => reason.slice(0, 180))
      : [];
    const dish = known.get(row.dishId)!;
    // A model cannot make missing nutrition into verified nutrition.
    const hasNutrition = dish.calories != null || dish.proteinG != null || dish.carbsG != null || dish.fatG != null;
    results.push({
      dishId: row.dishId,
      healthScore: Math.max(0, Math.min(100, score)),
      reasons,
      nutritionConfidence: hasNutrition ? "llm_estimated" : "estimated",
    });
  }
  if (!results.length) throw new Error("LLM response did not contain any valid supplied dish IDs.");
  return results;
}

async function analyzeWithProvider(provider: Provider, dishes: HealthyDishInput[], preferences?: HealthyFoodPreferences): Promise<HealthyDishAnalysis[]> {
  const system = [
    "You rank real nearby menu dishes for a fitness app.",
    "Use only the supplied dish records and IDs. Never create, rename, or infer a dish, restaurant, price, distance, calories, protein, or other nutrition value.",
    "Prioritize protein only when protein data is explicitly present; consider known calories/macros, ingredient descriptions, and cooking style when supplied.",
    "Missing nutrition is unknown, not zero. Do not claim a dish is high-protein when protein grams are absent.",
    "Use the user preferences as ranking context. Never assume ingredients or allergen absence from a dish name; mark uncertainty in reasons and do not make medical safety guarantees.",
    "Return JSON only: {\\"recommendations\\":[{\\"dishId\\":string,\\"healthScore\\":number,\\"reasons\\":string[]}]}",
  ].join(" ");
  const user = JSON.stringify({ task: "Rank the supplied dishes from most fitness-friendly to least fitness-friendly. Scores are comparative, not medical advice.", preferences: preferences || {}, dishes });
  const anthropic = provider.name === "Anthropic";
  const response = await fetch(provider.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(anthropic ? { "x-api-key": provider.apiKey, "anthropic-version": "2023-06-01" } : { Authorization: `Bearer ${provider.apiKey}` }),
    },
    body: JSON.stringify(anthropic
      ? { model: provider.model, max_tokens: 1800, temperature: 0.1, system, messages: [{ role: "user", content: user }] }
      : { model: provider.model, max_tokens: 1800, temperature: 0.1, response_format: { type: "json_object" }, messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
    signal: AbortSignal.timeout(18_000),
  });
  if (!response.ok) throw new Error(`${provider.name} request failed with HTTP ${response.status}`);
  const payload = await response.json() as any;
  const raw = anthropic ? payload.content?.find((block: any) => block.type === "text")?.text : payload.choices?.[0]?.message?.content;
  if (typeof raw !== "string" || !raw.trim()) throw new Error(`${provider.name} returned an empty response`);
  return parseAnalyses(raw, dishes);
}

class LlmAiProvider extends TemplateAiProvider {
  async analyzeHealthyDishes(input: { dishes: HealthyDishInput[] }): Promise<HealthyDishAnalysis[]> {
    if (!input.dishes.length) return [];
    for (const provider of configuredProviders()) {
      try { return await analyzeWithProvider(provider, input.dishes, input.preferences); }
      catch (error) {
        console.warn(`[food-ai] ${provider.name} ranking failed; trying next provider: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    // Keep the feature usable during upstream outages, but never pretend the
    // fallback ranking was generated by an LLM.
    return super.analyzeHealthyDishes(input);
  }
}

export function getAiProvider(): AiProvider {
  return configuredProviders().length ? new LlmAiProvider() : new TemplateAiProvider();
}
