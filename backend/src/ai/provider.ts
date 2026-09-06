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
}

export function getAiProvider(): AiProvider {
  // Placeholder for provider switching, e.g.:
  // if (process.env.AI_PROVIDER === "anthropic") return new AnthropicProvider();
  return new TemplateAiProvider();
}
