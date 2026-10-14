import { describe, expect, it } from "vitest";
import { normalizeExerciseLookupName, normalizeExerciseValue } from "../modules/workouts/exerciseCsvRepository";

describe("exercise name lookup normalization", () => {
  it("normalizes capitalization, punctuation, whitespace, and singular/plural forms", () => {
    expect(normalizeExerciseLookupName("  DUMBBELL   ROWS! ")).toBe("dumbbell row");
    expect(normalizeExerciseLookupName("Dumbbell Row")).toBe("dumbbell row");
    expect(normalizeExerciseValue("  Seated-Cable   Row ")).toBe("seated cable row");
  });
});
