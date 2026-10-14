import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { exerciseDemoEmbedUrl, findExerciseDemo } from "../modules/exercises/exerciseMedia";

describe("curated exercise demo matching", () => {
  it("matches canonical exercise metadata with normalized capitalization and spacing", () => {
    expect(findExerciseDemo("  LAT   PULLDOWN ", ["Cable Machine"])?.title).toBe("Lat Pull Down");
    expect(findExerciseDemo("Seated Cable Row", ["Cable Machine"])?.provider).toBe("youtube");
    expect(exerciseDemoEmbedUrl(findExerciseDemo("Seated Cable Row", ["Cable Machine"])!))
      .toContain("youtube-nocookie.com/embed/xQNrFHEMhI4");
    expect(findExerciseDemo("Dumbbell Row", ["Dumbbell"])?.sourceName).toBe("Men's Health");
  });

  it("requires the exact exercise variation and compatible equipment", () => {
    expect(findExerciseDemo("Wide Grip Seated Cable Row", ["Cable Machine"])).toBeNull();
    expect(findExerciseDemo("Dumbbell Row", ["Cable Machine"])).toBeNull();
    expect(findExerciseDemo("Unknown Row", ["Dumbbell"])).toBeNull();
    expect(exerciseDemoEmbedUrl(findExerciseDemo("Lat Pulldown", ["Cable Machine"])!))
      .toContain("youtube-nocookie.com/embed/iKrKgWR9wbY");
  });

  it("keeps the exercise media and player layout responsive on small screens", () => {
    const css = fs.readFileSync(path.resolve(__dirname, "../../../frontend/styles.css"), "utf8");
    const app = fs.readFileSync(path.resolve(__dirname, "../../../frontend/app.js"), "utf8");
    expect(css).toContain(".workout-exercise-support { grid-column: 2 / 4");
    expect(css).toContain(".exercise-demo-preview { position: relative");
    expect(css).toContain("aspect-ratio: 16 / 9");
    expect(css).toContain(".exercise-demo-player iframe { display: block; width: 100%; height: 100%");
    expect(app).toContain("Video unavailable for this exact exercise variation.");
  });
});
