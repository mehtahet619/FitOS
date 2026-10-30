import { describe, expect, it } from "vitest";
import { musclesForFocus } from "../modules/workouts/workoutGenerator";

describe("strict workout focus targeting", () => {
  it("keeps Push workouts inside push muscle groups only", () => {
    expect(musclesForFocus("Push")).toEqual(["chest", "shoulders", "triceps"]);
  });

  it("keeps Pull workouts inside pull muscle groups only", () => {
    expect(musclesForFocus("Pull")).toEqual(["back", "biceps"]);
  });

  it("keeps Legs workouts inside leg muscle groups only", () => {
    expect(musclesForFocus("Legs")).toEqual(["quads", "hamstrings", "glutes", "calves"]);
  });

  it("keeps individual muscle workouts strictly on the selected muscle", () => {
    expect(musclesForFocus("Back")).toEqual(["back"]);
    expect(musclesForFocus("Chest")).toEqual(["chest"]);
    expect(musclesForFocus("Biceps")).toEqual(["biceps"]);
    expect(musclesForFocus("Triceps")).toEqual(["triceps"]);
    expect(musclesForFocus("Shoulders")).toEqual(["shoulders"]);
  });

  it("does not silently turn an unknown focus into Full Body", () => {
    expect(() => musclesForFocus("Unknown Split")).toThrow(/Unsupported workout focus/);
  });
});
