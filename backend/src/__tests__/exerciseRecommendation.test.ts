import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CsvExerciseRepository,
  parseExerciseCsv,
} from "../modules/workouts/exerciseCsvRepository";
import {
  CsvExerciseRecommendationService,
  exerciseCountForDuration,
} from "../modules/workouts/exerciseRecommendation";

const csvPath = path.resolve(__dirname, "../../data/exercises.csv");

const repository = new CsvExerciseRepository(csvPath);
const service = new CsvExerciseRecommendationService(repository);

const fullGym = (
  targetMuscles: string[],
  sessionDurationMinutes: number,
) =>
  service.getRecommendedExercises({
    targetMuscles,
    sessionDurationMinutes,
    availableEquipment: [],
    equipmentMode: "FULL_GYM",
  });

describe("bundled CSV exercise recommendations", () => {
  it("uses header names regardless of column order and preserves original CSV cells", () => {
    const rows = parseExerciseCsv(
      'machine,Muscle,exercise\n"Cable Machine","Chest, Triceps"," Cable  Press "',
    );

    expect(rows[0]).toMatchObject({
      exercise: " Cable  Press ",
      machine: "Cable Machine",
      muscle: "Chest, Triceps",
    });

    expect(rows[0].muscleCategories).toEqual(["Chest", "Triceps"]);
  });

  it("rejects missing headers and malformed quoted rows clearly", () => {
    expect(() =>
      parseExerciseCsv("exercise,machine\nRow,Cable"),
    ).toThrow(/missing the required "muscle" column/i);

    expect(() =>
      parseExerciseCsv('exercise,machine,muscle\n"Row,Cable,Back'),
    ).toThrow(/malformed/i);

    expect(() =>
      parseExerciseCsv(
        'exercise,machine,muscle\n"Row"invalid,Cable,Back',
      ),
    ).toThrow(/malformed/i);

    expect(() =>
      parseExerciseCsv("exercise,machine,muscle\nRow,Cable"),
    ).toThrow(/expected 3/i);
  });

  it("loads and parses the CSV once per repository instance", () => {
    let readCount = 0;

    const cached = new CsvExerciseRepository("memory.csv", () => {
      readCount += 1;

      return "exercise,machine,muscle\nRow,Barbell,Back";
    });

    expect(cached.getAll()).toBe(cached.getAll());
    expect(readCount).toBe(1);
  });

  it.each([
    [15, 2],
    [30, 2],
    [31, 2],
    [45, 2],
    [46, 3],
    [59, 3],
    [60, 3],
    [61, 3],
    [70, 3],
    [71, 4],
    [75, 4],
    [76, 4],
    [90, 4],
    [91, 4],
    [110, 4],
    [111, 5],
    [120, 5],
    [121, 5],
    [180, 5],
    [181, 6],
    [240, 6],
  ])(
    "uses the duration rule for %i minutes",
    (minutes, count) => {
      expect(exerciseCountForDuration(minutes)).toBe(count);
    },
  );

  it("returns practical Back volume at 30, 60, 90, and 120 minutes", () => {
    expect(fullGym(["Back"], 30).exercises).toHaveLength(2);

    expect(fullGym(["Back"], 60).exercises).toHaveLength(3);

    expect(fullGym(["Back"], 90).exercises).toHaveLength(4);

    expect(fullGym(["Back"], 120).exercises).toHaveLength(5);
  });

  it("chooses different CSV exercise-name patterns before equipment-only variations", () => {
    const mixService =
      new CsvExerciseRecommendationService(
        new CsvExerciseRepository("mix.csv", () =>
          [
            "exercise,machine,muscle",
            "Barbell Bench Press,Barbell,Chest",
            "Dumbbell Bench Press,Dumbbell,Chest",
            "Incline Bench Press,Dumbbell,Upper Chest",
            "Cable Chest Fly,Cable Machine,Chest",
            "Pec Deck Fly,Pec Deck Machine,Chest",
            "Push Up,Bodyweight,Chest",
          ].join("\n"),
        ),
      );

    const result = mixService.getRecommendedExercises({
      targetMuscles: ["Chest"],
      sessionDurationMinutes: 59,
      availableEquipment: [],
      equipmentMode: "FULL_GYM",
    });

    expect(result.exercises).toHaveLength(3);

    expect(result.exercises[0].exercise).toBe(
      "Barbell Bench Press",
    );

    expect(
      result.exercises.map((exercise) => exercise.exercise),
    ).toContain("Cable Chest Fly");

    expect(
      new Set(
        result.exercises.map((exercise) => exercise.exercise),
      ).size,
    ).toBe(3);
  });

  it("returns same-target CSV swap alternatives and excludes exercises already in the workout", () => {
    const swapService =
      new CsvExerciseRecommendationService(
        new CsvExerciseRepository("swap.csv", () =>
          [
            "exercise,machine,muscle",
            "Barbell Bench Press,Barbell,Chest",
            "Cable Chest Fly,Cable Machine,Chest",
            "Lat Pulldown,Cable Machine,Back",
          ].join("\n"),
        ),
      );

    const alternatives = swapService.getCsvAlternatives(
      ["Chest"],
      [" BARBELL bench press "],
    );

    expect(
      alternatives.map((exercise) => exercise.exercise),
    ).toEqual(["Cable Chest Fly"]);

    expect(alternatives[0].primaryMuscle).toBe("Chest");
  });

  it("matches normalized target text and uses CSV categories such as Upper Back", () => {
    const normal = fullGym(["Back"], 60).exercises;

    const varied = fullGym(["  bAcK  "], 60).exercises;

    expect(varied).toEqual(normal);

    expect(
      repository
        .getAll()
        .some((exercise) =>
          exercise.muscleCategories.includes("Upper Back"),
        ),
    ).toBe(true);

    expect(
      fullGym(["Chest"], 60).exercises.every((exercise) =>
        exercise.muscleCategories.some((muscle) =>
          /chest/i.test(muscle),
        ),
      ),
    ).toBe(true);
  });

  it("prioritizes an exact CSV target category ahead of a related category", () => {
    const exactFirstService =
      new CsvExerciseRecommendationService(
        new CsvExerciseRepository("ordered.csv", () =>
          [
            "exercise,machine,muscle",
            "Related,Cable Machine,Upper Back",
            "Exact,Barbell,Back",
          ].join("\n"),
        ),
      );

    const result =
      exactFirstService.getRecommendedExercises({
        targetMuscles: ["Back"],
        sessionDurationMinutes: 15,
        availableEquipment: [],
        equipmentMode: "FULL_GYM",
      });

    expect(
      result.exercises.map((exercise) => exercise.exercise),
    ).toEqual(["Exact", "Related"]);
  });

  it("never returns duplicate exercise names and preserves each selected machine value", () => {
    const result = fullGym(["Chest"], 120).exercises;

    const names = result.map((exercise) =>
      exercise.exercise
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim(),
    );

    expect(new Set(names).size).toBe(names.length);

    for (const exercise of result) {
      const source = repository
        .getAll()
        .find(
          (row) => row.sourceIndex === exercise.sourceIndex,
        );

      expect(source).toBeDefined();

      expect(exercise.machine).toBe(source!.machine);

      expect(exercise.muscle).toBe(source!.muscle);
    }
  });

  it("FULL_GYM considers CSV equipment without an equipment list", () => {
    expect(
      fullGym(["Back"], 60).exercises.length,
    ).toBeGreaterThan(0);
  });

  it("SCANNED mode only returns rows with an available CSV machine or supplied alias", () => {
    const availableMachine = repository
      .getAll()
      .find((row) =>
        row.muscleCategories.includes("Back"),
      )!.machine;

    const result =
      service.getRecommendedExercises({
        targetMuscles: ["Back"],
        sessionDurationMinutes: 120,
        availableEquipment: [availableMachine],
        equipmentMode: "SCANNED",
      });

    expect(result.exercises.length).toBeGreaterThan(0);

    expect(
      result.exercises.every(
        (exercise) =>
          exercise.machine === availableMachine,
      ),
    ).toBe(true);
  });

  it("returns fewer than requested when the CSV has too few matching candidates", () => {
    const shortRepository =
      new CsvExerciseRepository("short.csv", () =>
        [
          "exercise,machine,muscle",
          "One,Barbell,Back",
          "Two,Cable Machine,Back",
        ].join("\n"),
      );

    const shortService =
      new CsvExerciseRecommendationService(
        shortRepository,
      );

    const result =
      shortService.getRecommendedExercises({
        targetMuscles: ["Back"],
        sessionDurationMinutes: 120,
        availableEquipment: [],
        equipmentMode: "FULL_GYM",
      });

    expect(
      result.exercises.map(
        (exercise) => exercise.exercise,
      ),
    ).toEqual(["One", "Two"]);

    expect(result.requestedCount).toBe(5);

    expect(result.limitedByDataset).toBe(true);
  });

  it("does not fall back when the target is absent", () => {
    expect(
      fullGym(["Unlisted Target"], 60).exercises,
    ).toEqual([]);
  });

  it("returns the same CSV-only ordering over repeated calls", () => {
    const first = fullGym(["Back"], 120).exercises;

    const names = first.map(
      (exercise) => exercise.exercise,
    );

    for (let repeat = 0; repeat < 10; repeat += 1) {
      expect(
        fullGym(["Back"], 120).exercises.map(
          (exercise) => exercise.exercise,
        ),
      ).toEqual(names);
    }

    const csvRows = new Set(
      repository.getAll().map(
        (exercise) =>
          `${exercise.sourceIndex}:${exercise.exercise}:${exercise.machine}:${exercise.muscle}`,
      ),
    );

    expect(
      first.every((exercise) =>
        csvRows.has(
          `${exercise.sourceIndex}:${exercise.exercise}:${exercise.machine}:${exercise.muscle}`,
        ),
      ),
    ).toBe(true);
  });

  it("contains no AI, recommendation network call, or random selection", () => {
    const source = repository.getAll();

    expect(source).toHaveLength(10000);

    expect(exerciseCountForDuration(120)).toBe(5);

    expect(
      String(CsvExerciseRecommendationService),
    ).not.toMatch(
      /Math\.random|fetch\(|https?:\/\//i,
    );
  });
});