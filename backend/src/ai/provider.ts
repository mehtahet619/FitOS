/**
 * AI provider abstraction. The rest of the app never imports a specific
 * vendor SDK directly — only this interface. Swap providers by changing
 * AI_PROVIDER in .env; no call sites change.
 *
 * The AI layer is intentionally NEVER used for: auth, macro math, equipment
 * matching, distance calculation, restaurant ranking, or exercise
 * filtering — all of that is deterministic (see substitutionEngine.ts,
 * workoutGenerator.ts, nutritionEngine.ts, rankRestaurants.ts). AI is used
 * only to phrase natural-language explanations on top of results that were
 * already computed deterministically, and outputs are validated against a
 * JSON schema before use.
 */

export interface AiProvider {
  explainSubstitution(input: {
    originalExercise: string;
    substituteExercise: string;
    reason: string;
  }): Promise<string>;

  explainWorkout(input: { focus: string; exerciseNames: string[] }): Promise<string>;

  analyzeHealthyDishes(input: {
    dishes: HealthyDishInput[];
  }): Promise<HealthyDishAnalysis[]>;
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
}

export interface HealthyDishAnalysis {
  dishId: string;
  healthScore: number;
  reasons: string[];
  nutritionConfidence: "verified" | "estimated" | "llm_estimated";
}

/**
 * Default provider: template-based, zero external calls, zero API key
 * required. This keeps the MVP fully runnable offline. Swap in
 * AnthropicProvider / OpenAiProvider (implement the same interface) once a
 * key is supplied via .env — see README.
 */
export class TemplateAiProvider implements AiProvider {
  async explainSubstitution(input: {
    originalExercise: string;
    substituteExercise: string;
    reason: string;
  }): Promise<string> {
    return `Swapped "${input.originalExercise}" for "${input.substituteExercise}" — ${input.reason}, using only the equipment you have available.`;
  }

  async explainWorkout(input: { focus: string; exerciseNames: string[] }): Promise<string> {
    return `Today's ${input.focus} session: ${input.exerciseNames.join(", ")}. Built around your current equipment.`;
  }

  async analyzeHealthyDishes(input: { dishes: HealthyDishInput[] }): Promise<HealthyDishAnalysis[]> {
    return input.dishes.map((dish) => {
      const text = `${dish.name} ${dish.description || ""} ${dish.category || ""}`.toLowerCase();
      let score = 65;
      if ((dish.proteinG ?? 0) >= 25) score += 15;
      else if ((dish.proteinG ?? 0) >= 15) score += 8;
      if ((dish.calories ?? 999) <= 500) score += 8;
      if (/salad|grilled|tikka|bowl|vegetable|veggie|dal|paneer/.test(text)) score += 8;
      if (/fried|deep fry|sugar|dessert|sweet|cola|shake/.test(text)) score -= 18;
      return {
        dishId: dish.dishId,
        healthScore: Math.max(0, Math.min(100, score)),
        reasons: [
          (dish.proteinG ?? 0) >= 20 ? "Protein-forward choice" : "Balanced option from a nearby menu",
          /salad|vegetable|veggie|bowl/.test(text) ? "Includes vegetable-rich ingredients" : "Compared with other available dishes",
        ],
        nutritionConfidence: "estimated",
      };
    });
  }
}

class OpenAiProvider extends TemplateAiProvider {
  async analyzeHealthyDishes(input: { dishes: HealthyDishInput[] }): Promise<HealthyDishAnalysis[]> {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || "gpt-4o-mini",
        temperature: 0.1,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "Analyze only the supplied real nearby dishes. Never invent a dish. Return JSON: {\"recommendations\":[{\"dishId\":string,\"healthScore\":number,\"reasons\":string[],\"nutritionConfidence\":\"llm_estimated\"}]}" },
          { role: "user", content: JSON.stringify({ task: "Rank healthiest dishes by protein density, calories, nutrition balance, vegetables, cooking method, sugar, fried food, and processing. Return only supplied dish IDs.", dishes: input.dishes }) },
        ],
      }),
    });
    if (!response.ok) throw new Error(`LLM analysis failed (${response.status})`);
    const payload = (await response.json()) as { choices?: { message?: { content?: string } }[] };
    const parsed = JSON.parse(payload.choices?.[0]?.message?.content || "{}");
    return Array.isArray(parsed.recommendations) ? parsed.recommendations : [];
  }
}

export function getAiProvider(): AiProvider {
  // Placeholder for provider switching, e.g.:
  // if (process.env.AI_PROVIDER === "anthropic") return new AnthropicProvider();
  if (process.env.AI_PROVIDER === "openai" && process.env.OPENAI_API_KEY) return new OpenAiProvider();
  return new TemplateAiProvider();
}
