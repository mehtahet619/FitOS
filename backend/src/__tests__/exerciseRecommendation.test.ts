import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CsvExerciseRepository,
  parseExerciseCsv,
} from "../modules/workouts/exerciseCsvRepository";
import {
  CsvExerciseRecommendationService,
  exerciseCountForDuration,
  exerciseFamilyKey,
} from "../modules/workouts/exerciseRecommendation";

const csvPath = path.resolve(__dirname, "../../data/gym_exercise_database_cleaned.csv.gz");

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
    expect(new Set(result.exercises.map((exercise) => exerciseFamilyKey(exercise.exercise))).size).toBe(3);
  });

  it("varies equally ranked exercise choices when the generation seed changes", () => {
    const variedService = new CsvExerciseRecommendationService(
      new CsvExerciseRepository("variety.csv", () => [
        "exercise,machine,muscle",
        "Chest Press A,Machine,Chest",
        "Chest Press B,Machine,Chest",
        "Chest Press C,Machine,Chest",
        "Chest Press D,Machine,Chest",
        "Chest Press E,Machine,Chest",
        "Chest Press F,Machine,Chest",
        "Chest Press G,Machine,Chest",
        "Chest Press H,Machine,Chest",
      ].join("\n")),
    );

    const recommend = (selectionSeed: string) =>
      variedService.getRecommendedExercises({
        targetMuscles: ["Chest"],
        sessionDurationMinutes: 60,
        availableEquipment: [],
        equipmentMode: "FULL_GYM",
        selectionSeed,
      }).exercises.map((exercise) => exercise.exercise);

    expect(recommend("session-1")).toEqual(recommend("session-1"));
    expect(recommend("session-1")).not.toEqual(recommend("session-2"));
  });

  it("never reuses previous workout movement families when alternatives are available", () => {
    const rotationService = new CsvExerciseRecommendationService(
      new CsvExerciseRepository("rotation.csv", () => [
        "exercise,machine,muscle",
        "Chest Press A,Machine,Chest",
        "Chest Press B,Machine,Chest",
        "Chest Press C,Machine,Chest",
        "Chest Press D,Machine,Chest",
        "Chest Press E,Machine,Chest",
        "Chest Press F,Machine,Chest",
      ].join("\n")),
    );
    const previous = ["Chest Press A", "Chest Press B", "Chest Press C"];
    const result = rotationService.getRecommendedExercises({
      targetMuscles: ["Chest"],
      sessionDurationMinutes: 60,
      availableEquipment: [],
      equipmentMode: "FULL_GYM",
      excludedExerciseNames: previous,
      excludedExerciseFamilyKeys: previous.map(exerciseFamilyKey),
      selectionSeed: "regeneration-2",
    });
    expect(result.exercises).toHaveLength(3);
    expect(result.exercises.map((exercise) => exercise.exercise).some((name) => previous.includes(name))).toBe(false);
    expect(new Set(result.exercises.map((exercise) => exerciseFamilyKey(exercise.exercise))).size).toBe(3);
  });

  it("normalizes equipment and superficial lat-pulldown variations into deterministic families", () => {
    const pulldownFamily = exerciseFamilyKey("Lat Pulldown");
    for (const variation of [
      "Wide-Grip Lat Pulldown",
      "Close-Grip Lat Pulldown",
      "Neutral-Grip Lat Pulldown",
      "Single-Arm Lat Pulldown",
      "Cable Lat Pulldown",
      "Lat Pulldown Machine",
    ]) {
      expect(exerciseFamilyKey(variation)).toBe(pulldownFamily);
    }
    expect(exerciseFamilyKey("Straight-Arm Pulldown")).not.toBe(pulldownFamily);
    expect(exerciseFamilyKey("Dumbbell Pullover")).toBe(exerciseFamilyKey("Machine Pullover"));
    expect(exerciseFamilyKey("Assisted Pull Up")).toBe(exerciseFamilyKey("Wide Grip Chin Up"));
  });

  it("returns at most one exact CSV alternative per movement family", () => {
    const familyService = new CsvExerciseRecommendationService(
      new CsvExerciseRepository("families.csv", () => [
        "exercise,machine,muscle,time_taken_1_set,targeted_muscle",
        'Lat Pulldown,Cable Machine,Back,20-40 sec,"Latissimus Dorsi, Teres Major"',
        'Wide Grip Lat Pulldown,Cable Machine,Back,20-40 sec,"Latissimus Dorsi, Teres Major"',
        'Close Grip Lat Pulldown,Cable Machine,Back,20-40 sec,"Latissimus Dorsi, Teres Major"',
        'Assisted Pull Up,Pull-up Bar,Back,20-40 sec,"Latissimus Dorsi, Teres Major"',
        'Wide Grip Assisted Pull Up,Pull-up Bar,Back,20-40 sec,"Latissimus Dorsi, Teres Major"',
        'Straight-Arm Pulldown,Cable Machine,Back,20-40 sec,"Latissimus Dorsi, Teres Major"',
        'Dumbbell Pullover,Dumbbells,Back,20-40 sec,"Latissimus Dorsi, Teres Major"',
      ].join("\n")),
    );

    const alternatives = familyService.getSwapAlternatives("Lat Pulldown", "Cable Machine", "Back");

    expect(alternatives.map((exercise) => exercise.exercise)).toEqual([
      "Assisted Pull Up",
      "Straight-Arm Pulldown",
      "Dumbbell Pullover",
    ]);
    expect(new Set(alternatives.map((exercise) => exerciseFamilyKey(exercise.exercise))).size).toBe(alternatives.length);
    expect(alternatives.every((exercise) => exercise.timeTakenOneSet === "20-40 sec")).toBe(true);
    expect(alternatives.every((exercise) => exercise.targetedMuscle === "Latissimus Dorsi, Teres Major")).toBe(true);
  });

  it("uses only exact targeted-muscle and one-set-duration matches for swaps", () => {
    const swapService = new CsvExerciseRecommendationService(
      new CsvExerciseRepository("swap.csv", () => [
        "exercise,machine,muscle,time_taken_1_set,targeted_muscle",
        'Barbell Curl,Barbell,Biceps,20-40 sec,"Biceps Brachii, Brachialis"',
        'Cable Curl,Cable Machine,Biceps,20-40 sec,"Biceps Brachii, Brachialis"',
        'Hammer Curl,Dumbbells,"Biceps, Brachialis, Forearms",20-40 sec,"Brachioradialis, Biceps Brachii, Brachialis"',
        'Slow Cable Curl,Cable Machine,Biceps,25-45 sec,"Biceps Brachii, Brachialis"',
        'Preacher Curl,Preacher Curl Machine,Biceps,20-40 sec,"Brachialis, Biceps Brachii"',
        'Concentration Curl,Dumbbells,Biceps,20-40 sec,"Biceps Brachii, Brachialis"',
      ].join("\n")),
    );

    const alternatives = swapService.getSwapAlternatives(
      "Barbell Curl",
      "Barbell",
      "Biceps",
      [" BARBELL curl ", "Cable Curl"],
    );

    expect(alternatives.map((exercise) => exercise.exercise)).toEqual([
      "Preacher Curl",
      "Concentration Curl",
    ]);
    expect(alternatives.every((exercise) => exercise.timeTakenOneSet === "20-40 sec")).toBe(true);
    expect(alternatives.every((exercise) => exercise.targetedMuscles.join("|") === "Brachialis|Biceps Brachii" || exercise.targetedMuscles.join("|") === "Biceps Brachii|Brachialis")).toBe(true);
    expect(alternatives.every((exercise) => exercise.primaryMuscle === "Biceps")).toBe(true);
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

  it("rebalances without selecting variants of the newly chosen movement family", () => {
    const rebalanceService = new CsvExerciseRecommendationService(
      new CsvExerciseRepository("rebalance.csv", () => [
        "exercise,machine,muscle",
        "Lat Pulldown,Cable Machine,Back",
        "Face Pull,Cable Machine,Back",
        "Deadlift,Barbell,Back",
        "Standard Deadlift,Barbell,Back",
      ].join("\n")),
    );

    const result = rebalanceService.getRecommendedExercises({
      targetMuscles: ["Back"],
      sessionDurationMinutes: 45,
      requestedCount: 2,
      availableEquipment: ["Cable Machine", "Barbell"],
      equipmentMode: "USER_EQUIPMENT",
      excludedExerciseNames: ["Deadlift"],
      excludedExerciseFamilyKeys: [exerciseFamilyKey("Deadlift")],
    });

    expect(result.exercises.map((exercise) => exercise.exercise)).toEqual(["Lat Pulldown", "Face Pull"]);
    expect(result.exercises.every((exercise) => exerciseFamilyKey(exercise.exercise) !== exerciseFamilyKey("Deadlift"))).toBe(true);
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

    expect(source).toHaveLength(1524);

    expect(exerciseCountForDuration(120)).toBe(5);

    expect(
      String(CsvExerciseRecommendationService),
    ).not.toMatch(
      /Math\.random|fetch\(|https?:\/\//i,
    );
  });

  it("never fills a workout with superficial variations of the same movement", () => {
    const variationService = new CsvExerciseRecommendationService(
      new CsvExerciseRepository("shoulders-variants.csv", () =>
        [
          "exercise,machine,muscle",
          "Overhead Press,Barbell,Shoulders",
          "Eccentric Emphasis Overhead Press,Barbell,Shoulders",
          "Wide Grip Overhead Press,Barbell,Shoulders",
          "Dumbbell Lateral Raise,Dumbbell,Shoulders",
          "Rear Delt Fly,Cable Machine,Shoulders",
        ].join("\n"),
      ),
    );

    const result = variationService.getRecommendedExercises({
      targetMuscles: ["Shoulders"],
      sessionDurationMinutes: 60,
      availableEquipment: [],
      equipmentMode: "FULL_GYM",
    });

    expect(result.exercises).toHaveLength(3);
    expect(new Set(result.exercises.map((exercise) => exerciseFamilyKey(exercise.exercise))).size).toBe(3);
    expect(result.exercises.map((exercise) => exercise.exercise)).not.toContain("Eccentric Emphasis Overhead Press");
    expect(result.exercises.map((exercise) => exercise.exercise)).not.toContain("Wide Grip Overhead Press");
  });

  it("returns fewer exercises rather than repeating a movement when only variants exist", () => {
    const variantsOnlyService = new CsvExerciseRecommendationService(
      new CsvExerciseRepository("overhead-only.csv", () =>
        [
          "exercise,machine,muscle",
          "Overhead Press,Barbell,Shoulders",
          "Eccentric Emphasis Overhead Press,Barbell,Shoulders",
          "Wide Grip Overhead Press,Barbell,Shoulders",
        ].join("\n"),
      ),
    );

    const result = variantsOnlyService.getRecommendedExercises({
      targetMuscles: ["Shoulders"],
      sessionDurationMinutes: 60,
      availableEquipment: [],
      equipmentMode: "FULL_GYM",
    });

    expect(result.exercises).toHaveLength(1);
    expect(result.availableCount).toBe(1);
    expect(result.limitedByDataset).toBe(true);
  });
});
