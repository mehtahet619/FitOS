import express from "express";
import type { Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabaseLike } from "../db/types";
import { CsvExerciseRepository } from "../modules/workouts/exerciseCsvRepository";
import { CsvExerciseRecommendationService } from "../modules/workouts/exerciseRecommendation";

type Row = Record<string, any>;

function makeDatabase(plan: Row, sessionMinutes = 60) {
  const state: {
    exercises: Row[];
    equipment: Row[];
    equipmentAliases: Row[];
    userEquipment: Row[];
    links: Row[];
    workouts: Row[];
    workoutExercises: Row[];
    sets: Row[];
    plan: Row;
  } = { exercises: [], equipment: [], equipmentAliases: [], userEquipment: [], links: [], workouts: [], workoutExercises: [], sets: [], plan };

  const db: DatabaseLike = {
    async all<T extends import("pg").QueryResultRow = import("pg").QueryResultRow>(sql: string, ...params: unknown[]): Promise<T[]> {
      if (sql.includes("SELECT equipmentId FROM UserEquipment")) return state.userEquipment.filter((row) => row.userId === params[0]).map((row) => ({ equipmentId: row.equipmentId })) as unknown as T[];
      if (sql.includes("SELECT ue.equipmentId,e.name FROM UserEquipment")) return state.userEquipment.filter((row) => row.userId === params[0]).map((row) => ({ equipmentId: row.equipmentId, name: state.equipment.find((equipment) => equipment.id === row.equipmentId)?.name })) as unknown as T[];
      if (sql.includes("SELECT e.id,e.name,ea.alias FROM Equipment")) {
        return state.equipment.flatMap((equipment) => {
          const aliases = state.equipmentAliases.filter((alias) => alias.equipmentId === equipment.id);
          return aliases.length ? aliases.map((alias) => ({ id: equipment.id, name: equipment.name, alias: alias.alias })) : [{ id: equipment.id, name: equipment.name, alias: null }];
        }) as unknown as T[];
      }
      if (sql.includes("SELECT e.name, ea.alias FROM Equipment")) {
        return state.equipment.filter((equipment) => params.includes(equipment.id)).flatMap((equipment) => {
          const aliases = state.equipmentAliases.filter((alias) => alias.equipmentId === equipment.id);
          return aliases.length ? aliases.map((alias) => ({ name: equipment.name, alias: alias.alias })) : [{ name: equipment.name, alias: null }];
        }) as unknown as T[];
      }
      if (sql.includes("SELECT e.* FROM Equipment e JOIN UserEquipment")) {
        return state.userEquipment.filter((row) => row.userId === params[0]).map((row) => state.equipment.find((equipment) => equipment.id === row.equipmentId)).filter(Boolean) as T[];
      }
      if (sql.includes("SELECT id,name,defaultSets,repRangeLow,repRangeHigh FROM Exercise")) return state.exercises as T[];
      if (sql.includes("SELECT id,name FROM Equipment")) return state.equipment as T[];
      if (sql.includes("SELECT equipmentId,alias FROM EquipmentAlias")) return state.equipmentAliases as unknown as T[];
      if (sql.includes("SELECT weightKg, reps FROM WorkoutHistory")) return [];
      if (sql.includes("SELECT equipmentId FROM ExerciseEquipment WHERE exerciseId = ?")) {
        return state.links.filter((row) => row.exerciseId === params[0]).map((row) => ({ equipmentId: row.equipmentId })) as unknown as T[];
      }
      if (sql.includes("SELECT eq.name FROM ExerciseEquipment")) {
        return state.links.filter((row) => row.exerciseId === params[0]).map((row) => ({ name: state.equipment.find((eq) => eq.id === row.equipmentId)?.name })) as unknown as T[];
      }
      if (sql.includes("SELECT COALESCE(we.sourceExerciseName,e.name) as name")) {
        return state.workoutExercises.filter((row) => row.workoutId === params[0]).map((row) => ({ name: row.sourceExerciseName || state.exercises.find((ex) => ex.id === row.exerciseId)?.name })) as unknown as T[];
      }
      if (sql.includes("SELECT we.*, e.name as exerciseName")) {
        return state.workoutExercises.filter((row) => row.workoutId === params[0])
          .sort((left, right) => left.orderIndex - right.orderIndex)
          .map((row) => ({ ...row, exerciseName: state.exercises.find((ex) => ex.id === row.exerciseId)?.name,
            primaryMuscle: state.exercises.find((ex) => ex.id === row.exerciseId)?.primaryMuscle,
            instructions: state.exercises.find((ex) => ex.id === row.exerciseId)?.instructions })) as unknown as T[];
      }
      if (sql.includes("SELECT ws.workoutExerciseId, ws.setNumber")) {
        const exerciseIds = new Set(state.workoutExercises.filter((row) => row.workoutId === params[0]).map((row) => row.id));
        return state.sets.filter((row) => row.completed && exerciseIds.has(row.workoutExerciseId)) as unknown as T[];
      }
      throw new Error(`Unexpected integration-test query: ${sql}`);
    },
    async get<T extends import("pg").QueryResultRow = import("pg").QueryResultRow>(sql: string, ...params: unknown[]): Promise<T | undefined> {
      if (sql.includes("SELECT * FROM UserProfile")) return { sessionMinutes } as unknown as T;
      if (sql.includes("WHERE id = ? AND userId = ? AND status != 'superseded' AND (cycleId = ? OR cycleId IS NULL)")) {
        return state.workouts.find((row) => row.id === params[0] && row.userId === params[1] && (row.cycleId === params[2] || row.cycleId == null) && row.status !== "superseded") as T | undefined;
      }
      if (sql.includes("WHERE userId = ? AND cycleId = ? AND planStepIndex = ?")) {
        return state.workouts.find((row) => row.userId === params[0] && row.cycleId === params[1] && row.planStepIndex === params[2] && row.status !== "superseded") as T | undefined;
      }
      if (sql.includes("SELECT COUNT(*) as count FROM WorkoutSet")) {
        const exerciseIds = new Set(state.workoutExercises.filter((row) => row.workoutId === params[0]).map((row) => row.id));
        return { count: state.sets.filter((row) => row.completed && exerciseIds.has(row.workoutExerciseId)).length } as unknown as T;
      }
      if (sql.includes("SELECT userId,status,equipmentMode,equipmentSnapshot FROM Workout WHERE id = ?")) {
        return state.workouts.find((row) => row.id === params[0]) as T | undefined;
      }
      if (sql.includes("SELECT userId,status FROM Workout WHERE id = ?")) return state.workouts.find((row) => row.id === params[0]) as T | undefined;
      if (sql.includes("SELECT * FROM Workout WHERE id = ?")) return state.workouts.find((row) => row.id === params[0]) as T | undefined;
      if (sql.includes("SELECT * FROM WorkoutExercise WHERE id = ?")) return state.workoutExercises.find((row) => row.id === params[0]) as T | undefined;
      if (sql.includes("SELECT * FROM Equipment WHERE name = ?")) return state.equipment.find((row) => row.name === params[0]) as T | undefined;
      if (sql.includes("SELECT id FROM Equipment WHERE lower(name)=lower(?)")) return state.equipment.find((row) => row.name.toLowerCase() === String(params[0]).toLowerCase()) as T | undefined;
      if (sql.includes("SELECT id FROM Exercise WHERE lower(name)=lower(?)")) return state.exercises.find((row) => row.name.toLowerCase() === String(params[0]).toLowerCase()) as T | undefined;
      if (sql.includes("SELECT * FROM Exercise WHERE id = ?")) return state.exercises.find((row) => row.id === params[0]) as T | undefined;
      if (sql.includes("SELECT repRangeHigh FROM Exercise WHERE id = ?")) return state.exercises.find((row) => row.id === params[0]) as T | undefined;
      throw new Error(`Unexpected integration-test lookup: ${sql}`);
    },
    async run(sql: string, ...params: unknown[]): Promise<{ changes: number }> {
      if (sql.includes("INSERT INTO Equipment (")) {
        if (!state.equipment.some((row) => row.name.toLowerCase() === String(params[1]).toLowerCase())) {
          state.equipment.push({ id: params[0], name: params[1] });
        }
      } else if (sql.includes("INSERT INTO Exercise (")) {
        if (!state.exercises.some((row) => row.name.toLowerCase() === String(params[1]).toLowerCase())) {
          state.exercises.push({
            id: params[0], name: params[1], primaryMuscle: params[2], secondaryMuscles: params[3],
            movementPattern: params[4], difficulty: params[5], defaultSets: params[6],
            repRangeLow: params[7], repRangeHigh: params[8], instructions: params[9],
          });
        }
      } else if (sql.includes("INSERT INTO ExerciseEquipment (")) {
        if (!state.links.some((row) => row.exerciseId === params[1] && row.equipmentId === params[2])) {
          state.links.push({ id: params[0], exerciseId: params[1], equipmentId: params[2] });
        }
      } else if (sql.includes("INSERT INTO Workout (")) {
        state.workouts.push({
          id: params[0], userId: params[1], focus: params[2], status: "pending", durationMin: params[3],
          createdAt: params[4], planStepIndex: params[5], cycleId: params[6], equipmentMode: params[7], equipmentSnapshot: params[8],
          generatorVersion: params[9],
        });
      } else if (sql.includes("INSERT INTO WorkoutExercise (")) {
        state.workoutExercises.push({
          id: params[0], workoutId: params[1], exerciseId: params[2], orderIndex: params[3],
          targetSets: params[4], repRangeLow: params[5], repRangeHigh: params[6], status: "pending",
          sourceExerciseName: params[7], sourceMuscle: params[8], sourcePrimaryMuscle: params[9], sourceMachine: params[10],
        });
      } else if (sql.includes("UPDATE WorkoutPlanState SET activeWorkoutId")) {
        state.plan.activeWorkoutId = params[0];
      } else if (sql.includes("DELETE FROM UserEquipment WHERE userId = ?")) {
        state.userEquipment = state.userEquipment.filter((row) => row.userId !== params[0]);
      } else if (sql.includes("INSERT INTO UserEquipment (")) {
        state.userEquipment.push({ id: params[0], userId: params[1], equipmentId: params[2] });
      } else if (sql.includes("UPDATE WorkoutExercise")) {
        const row = state.workoutExercises.find((exercise) => exercise.id === params[6]);
        if (row) Object.assign(row, {
          exerciseId: params[0], replacedFromId: params[1], status: "replaced",
          sourceExerciseName: params[2], sourceMuscle: params[3], sourcePrimaryMuscle: params[4], sourceMachine: params[5],
        });
      } else if (sql.includes("UPDATE Workout SET status = 'superseded'")) {
        const row = state.workouts.find((workout) => workout.id === params[0]);
        if (row) row.status = "superseded";
      } else {
        throw new Error(`Unexpected integration-test write: ${sql}`);
      }
      return { changes: 1 };
    },
    async exec(): Promise<void> {},
  };
  return { db, state };
}

describe("workout API CSV flow", () => {
  afterEach(() => {
    vi.doUnmock("../db/client");
    vi.doUnmock("../common/auth");
    vi.doUnmock("../modules/workouts/plan");
    vi.doUnmock("../modules/workouts/exerciseRecommendation");
    vi.resetModules();
  });

  it("persists canonical CSV names and swaps only the requested slot without changing its programming", async () => {
    const sampleCsv = [
      "exercise,machine,muscle",
      "Barbell Row,Barbell,Back",
      "Lat Pulldown,Lat Pulldown,Back",
      "Dumbbell Row,Dumbbells,Back",
      "Cable Row,Cable Machine,Back",
      "Seated Cable Row,Cable Machine,Back",
      "Bodyweight Row,Bodyweight,Back",
      "Bench Press,Barbell,Chest",
    ].join("\n");
    const service = new CsvExerciseRecommendationService(new CsvExerciseRepository("integration.csv", () => sampleCsv));
    const planState = {
      currentIndex: 0, cycleId: "current-cycle", cycleStatus: "IN_PROGRESS", activeWorkoutId: null,
      units: [{ key: "back", label: "Back", muscles: ["back"] }],
    };
    const { db, state } = makeDatabase(planState);
    const selectedEquipment = ["Lat Pulldown", "Dumbbells", "Cable Machine"];
    state.equipment = selectedEquipment.concat("Barbell").map((name) => ({ id: `equipment-${name}`, name }));
    const oldCycleWorkout = {
      id: "old-cycle-back-session", userId: "integration-user", focus: "Back", status: "pending",
      durationMin: 60, planStepIndex: 0, cycleId: "previous-cycle", createdAt: "2026-09-01T00:00:00.000Z",
    };
    state.workouts.push(oldCycleWorkout);

    vi.doMock("../db/client", () => ({ db, nowIso: () => "2026-10-02T00:00:00.000Z" }));
    vi.doMock("../common/auth", () => ({ requireAuth: (req: any, _res: any, next: () => void) => { req.userId = "integration-user"; next(); } }));
    vi.doMock("../modules/workouts/plan", () => ({
      canSwitchWorkoutPlan: async () => true,
      getActiveWorkoutPlan: async () => null,
      getCompletedWorkoutUnits: async () => [],
      getCycleHistory: async () => [],
      getCurrentCycle: async () => null,
      getNextRequiredWorkout: async () => null,
      getPlanState: async () => state.plan,
      getRecentlyTrainedMuscles: async () => [],
      getRemainingWorkoutUnits: async () => [],
      getTodayWorkoutDecision: async () => ({ nextUnit: null, remainingUnits: [] }),
      getWorkoutHistory: async () => [],
      listAvailableStructures: () => [],
      completedUnits: () => [],
      nextUnit: (state: any) => state?.units?.[state.currentIndex] ?? null,
      remainingUnits: () => [],
      serializePlanSnapshot: () => ({}),
      startNewWorkoutCycle: async () => ({}),
      switchWorkoutPlan: async () => ({}),
      completeWorkout: async () => ({}),
      PLAN_LABELS: {},
    }));
    vi.doMock("../modules/workouts/exerciseRecommendation", () => ({ exerciseRecommendationService: service }));

    const { workoutRouter } = await import("../modules/workouts/routes.js");
    const { equipmentRouter } = await import("../modules/equipment/routes.js");
    const app = express();
    app.use(express.json());
    app.use("/", equipmentRouter);
    app.use("/workouts", workoutRouter);
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind to a TCP port.");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const staleCycleResponse = await fetch(`${baseUrl}/workouts/today`);
      expect(staleCycleResponse.status).toBe(404);

      const equipmentResponse = await fetch(`${baseUrl}/user/equipment`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ equipmentNames: selectedEquipment }),
      });
      expect(equipmentResponse.status).toBe(200);
      expect(state.userEquipment.map((row) => row.equipmentId).sort()).toEqual(
        selectedEquipment.map((name) => `equipment-${name}`).sort(),
      );

      const generateResponse = await fetch(`${baseUrl}/workouts/generate`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ equipmentMode: "USER_EQUIPMENT", availableEquipmentNames: selectedEquipment }),
      });
      expect(generateResponse.status).toBe(201);
      const generated = await generateResponse.json() as any;
      const csvNames = new Set(sampleCsv.split("\n").slice(1).map((line) => line.split(",")[0]));
      expect(generated.exercises).toHaveLength(3);
      expect(generated.availableExerciseCount).toBe(4);
      expect(generated.exercises.every((exercise: any) => csvNames.has(exercise.exerciseName))).toBe(true);
      expect(generated.workout.durationMin).toBe(60);
      expect(generated.workout.cycleId).toBe("current-cycle");
      expect(generated.exercises.every((exercise: any) => exercise.exerciseName && exercise.machine && exercise.muscle === "Back")).toBe(true);
      expect(generated.exercises.every((exercise: any) => selectedEquipment.includes(exercise.machine))).toBe(true);
      expect(generated.exercises.some((exercise: any) => exercise.machine === "Barbell")).toBe(false);
      expect(generated.exercises.every((exercise: any) => exercise.targetSets === 3)).toBe(true);
      expect(state.workoutExercises.map((exercise) => exercise.sourceExerciseName).sort()).toEqual(
        generated.exercises.map((exercise: any) => exercise.exerciseName).sort(),
      );
      expect(oldCycleWorkout.status).toBe("pending");

      const before = await (await fetch(`${baseUrl}/workouts/today`)).json() as any;
      expect(before.id).toBe(generated.workout.id);
      expect(before.cycleId).toBe("current-cycle");
      expect(before.exercises.map((exercise: any) => exercise.exerciseName)).toEqual(generated.exercises.map((exercise: any) => exercise.exerciseName));
      const original = before.exercises.map((exercise: any) => ({
        workoutExerciseId: exercise.workoutExerciseId, exerciseName: exercise.exerciseName,
        targetSets: exercise.targetSets, repRangeLow: exercise.repRangeLow, repRangeHigh: exercise.repRangeHigh,
        muscle: exercise.muscle, machine: exercise.machine,
      }));
      const slot = before.exercises[1];

      const swapResponse = await fetch(`${baseUrl}/workouts/${before.id}/replace-exercise`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workoutExerciseId: slot.workoutExerciseId, reason: "user_preference" }),
      });
      expect(swapResponse.status).toBe(200);
      const swapped = await swapResponse.json() as any;
      expect(swapped.workoutExerciseId).toBe(slot.workoutExerciseId);
      expect(swapped.exercise.exerciseName).not.toBe(slot.exerciseName);

      const after = await (await fetch(`${baseUrl}/workouts/today`)).json() as any;
      expect(after.exercises).toHaveLength(3);
      expect(after.durationMin).toBe(before.durationMin);
      expect(after.exercises[0].exerciseName).toBe(original[0].exerciseName);
      expect(after.exercises[2].exerciseName).toBe(original[2].exerciseName);
      expect(after.exercises[1]).toMatchObject({
        workoutExerciseId: slot.workoutExerciseId,
        exerciseName: swapped.exercise.exerciseName,
        muscle: original[1].muscle,
        targetSets: original[1].targetSets,
        repRangeLow: original[1].repRangeLow,
        repRangeHigh: original[1].repRangeHigh,
      });
      expect(state.workoutExercises.map((exercise) => exercise.orderIndex)).toEqual([0, 1, 2]);

      const refreshResponse = await fetch(`${baseUrl}/workouts/generate`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ equipmentMode: "USER_EQUIPMENT", availableEquipmentNames: selectedEquipment, replaceExisting: true }),
      });
      expect(refreshResponse.status).toBe(201);
      const refreshed = await refreshResponse.json() as any;
      expect(refreshed.workout.id).not.toBe(before.id);
      expect(state.workouts.find((workout) => workout.id === before.id)?.status).toBe("superseded");
      expect(state.workoutExercises.filter((exercise) => exercise.workoutId === before.id)).toHaveLength(3);
      expect(oldCycleWorkout.status).toBe("pending");
      const current = await (await fetch(`${baseUrl}/workouts/today`)).json() as any;
      expect(current.id).toBe(refreshed.workout.id);
      expect(current.needsRegeneration).toBe(false);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("replaces a same-step legacy workout with the CSV result while preserving logged sets", async () => {
    const sampleCsv = [
      "exercise,machine,muscle",
      "Barbell Row,Barbell,Back",
      "Lat Pulldown,Lat Pulldown,Back",
      "Dumbbell Row,Dumbbells,Back",
      "Cable Row,Cable Machine,Back",
      "Bench Press,Barbell,Chest",
    ].join("\n");
    const service = new CsvExerciseRecommendationService(new CsvExerciseRepository("legacy-refresh.csv", () => sampleCsv));
    const legacyId = "legacy-current-step";
    const planState = {
      currentIndex: 0, cycleId: "current-cycle", cycleStatus: "IN_PROGRESS", activeWorkoutId: legacyId,
      units: [{ key: "back", label: "Back", muscles: ["back"] }],
    };
    const { db, state } = makeDatabase(planState, 59);
    const selectedEquipment = ["Barbell", "Lat Pulldown", "Dumbbells"];
    state.equipment = selectedEquipment.map((name) => ({ id: `equipment-${name}`, name }));
    state.workouts.push({
      id: legacyId, userId: "integration-user", focus: "Back", status: "pending", durationMin: 59,
      planStepIndex: 0, cycleId: "current-cycle", generatorVersion: null, equipmentMode: "USER_EQUIPMENT",
      equipmentSnapshot: JSON.stringify(selectedEquipment.map((name) => `equipment-${name}`)),
    });
    state.exercises.push({
      id: "legacy-chest-exercise", name: "Legacy Chest Press", primaryMuscle: "Chest", defaultSets: 3,
      repRangeLow: 8, repRangeHigh: 12, instructions: "",
    });
    state.workoutExercises.push({
      id: "legacy-workout-slot", workoutId: legacyId, exerciseId: "legacy-chest-exercise", orderIndex: 0,
      targetSets: 3, repRangeLow: 8, repRangeHigh: 12, status: "pending",
      sourceExerciseName: "Legacy Chest Press", sourceMuscle: "Chest", sourcePrimaryMuscle: "Chest", sourceMachine: "Barbell",
    });
    const preservedSet = {
      id: "legacy-logged-set", workoutExerciseId: "legacy-workout-slot", setNumber: 1,
      weightKg: 20, reps: 10, completed: true,
    };
    state.sets.push(preservedSet);

    vi.doMock("../db/client", () => ({ db, nowIso: () => "2026-10-02T00:00:00.000Z" }));
    vi.doMock("../common/auth", () => ({ requireAuth: (req: any, _res: any, next: () => void) => { req.userId = "integration-user"; next(); } }));
    vi.doMock("../modules/workouts/plan", () => ({
      canSwitchWorkoutPlan: async () => true,
      getActiveWorkoutPlan: async () => null,
      getCompletedWorkoutUnits: async () => [],
      getCycleHistory: async () => [],
      getCurrentCycle: async () => null,
      getNextRequiredWorkout: async () => null,
      getPlanState: async () => state.plan,
      getRecentlyTrainedMuscles: async () => [],
      getRemainingWorkoutUnits: async () => [],
      getTodayWorkoutDecision: async () => ({ nextUnit: null, remainingUnits: [] }),
      getWorkoutHistory: async () => [],
      listAvailableStructures: () => [],
      completedUnits: () => [],
      nextUnit: (current: any) => current?.units?.[current.currentIndex] ?? null,
      remainingUnits: () => [],
      serializePlanSnapshot: () => ({}),
      startNewWorkoutCycle: async () => ({}),
      switchWorkoutPlan: async () => ({}),
      completeWorkout: async () => ({}),
      PLAN_LABELS: {},
    }));
    vi.doMock("../modules/workouts/exerciseRecommendation", () => ({ exerciseRecommendationService: service }));

    const { workoutRouter } = await import("../modules/workouts/routes.js");
    const app = express();
    app.use(express.json());
    app.use("/workouts", workoutRouter);
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind to a TCP port.");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const legacyResponse = await fetch(`${baseUrl}/workouts/today`);
      expect(legacyResponse.status).toBe(200);
      const legacy = await legacyResponse.json() as any;
      expect(legacy).toMatchObject({ needsRegeneration: true, canRegenerate: true, generatorVersion: null });
      expect(legacy.availableEquipmentNames).toEqual(selectedEquipment);
      expect(legacy.exercises[0].completedSets).toHaveLength(1);

      const generateResponse = await fetch(`${baseUrl}/workouts/generate`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          replaceExisting: true,
          equipmentMode: "USER_EQUIPMENT",
          availableEquipmentNames: selectedEquipment,
        }),
      });
      expect(generateResponse.status).toBe(201);
      const generated = await generateResponse.json() as any;
      expect(generated.workout.durationMin).toBe(59);
      expect(generated.exercises).toHaveLength(3);
      expect(generated.exercises.every((exercise: any) => exercise.muscle === "Back" && exercise.machine !== "Bodyweight")).toBe(true);
      expect(state.workouts.find((workout) => workout.id === legacyId)?.status).toBe("superseded");
      expect(state.workoutExercises.find((exercise) => exercise.id === "legacy-workout-slot")).toBeDefined();
      expect(state.sets).toContain(preservedSet);
      expect(state.plan.activeWorkoutId).toBe(generated.workout.id);

      const current = await (await fetch(`${baseUrl}/workouts/today`)).json() as any;
      expect(current.id).toBe(generated.workout.id);
      expect(current.needsRegeneration).toBe(false);
      expect(current.exercises).toHaveLength(3);
      expect(current.exercises.every((exercise: any) => exercise.muscle === "Back")).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
