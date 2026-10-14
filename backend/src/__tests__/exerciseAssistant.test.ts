import { describe, expect, it } from "vitest";
import { buildExerciseAssistantMessages } from "../modules/exercises/exerciseAssistant";

describe("exercise assistant context", () => {
  it("binds the question to catalog muscles, equipment, and instructions", () => {
    const messages = buildExerciseAssistantMessages({
      name: "Seated Cable Row",
      primaryMuscle: "Lats",
      secondaryMuscles: ["Rhomboids", "Biceps"],
      equipment: ["Cable Machine"],
      instructions: "Sit upright and pull the handle toward your abdomen.",
      movementPattern: "horizontal_pull",
    }, "How should I breathe?");
    expect(messages.user).toContain("Seated Cable Row");
    expect(messages.user).toContain("Rhomboids");
    expect(messages.user).toContain("Cable Machine");
    expect(messages.user).toContain("Sit upright and pull the handle toward your abdomen.");
    expect(messages.user).toContain("How should I breathe?");
    expect(messages.system).toContain("Do not invent equipment, catalog instructions, video links");
  });
});
