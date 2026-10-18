import { afterEach, describe, expect, it, vi } from "vitest";

describe("FitOS nutrition guidance", () => {
  afterEach(() => { delete (globalThis as any).window; });

  async function loadGuidance() {
    vi.resetModules();
    (globalThis as any).window = {};
    await import("../../../frontend/nutrition-guidance.js");
    return (globalThis as any).window.FitOSNutritionGuidance;
  }

  it("scales product nutrients by the serving and preserves missing data", async () => {
    const guidance = await loadGuidance();
    const result = guidance.assess({ nutrients: { carbsG: 80, sugarsG: null }, servingGrams: 50 });
    expect(result.actual.carbsG).toBe(40);
    expect(result.actual.sugarsG).toBeNull();
  });

  it("uses saved weight to personalize protein when no target is available", async () => {
    const guidance = await loadGuidance();
    const result = guidance.assess({ nutrients: { proteinG: 10 }, servingGrams: 100, profile: { weightKg: 65 } });
    expect(result.targets.proteinG).toBe(78);
    expect(result.notes.some((note: string) => note.includes("78.0"))).toBe(true);
  });

  it("does not label carbohydrate alone as unhealthy", async () => {
    const guidance = await loadGuidance();
    const result = guidance.assess({ nutrients: { carbsG: 35, fiberG: 5 }, servingGrams: 100 });
    expect(result.notes.some((note: string) => note.includes("carbohydrates themselves are not inherently unhealthy"))).toBe(false);
  });

  it("flags high sodium and adult caffeine reference contribution", async () => {
    const guidance = await loadGuidance();
    const result = guidance.assess({ nutrients: { sodiumMg: 700, caffeineMg: 200 }, servingGrams: 100, profile: { age: 25 } });
    expect(result.notes.some((note: string) => note.includes("substantial share"))).toBe(true);
    expect(result.notes.some((note: string) => note.includes("200.0 of 400.0"))).toBe(true);
  });
});
