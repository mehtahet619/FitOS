import express from "express";
import type { Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabaseLike } from "../db/types";
import { CsvExerciseRepository } from "../modules/workouts/exerciseCsvRepository";
import { CsvExerciseRecommendationService } from "../modules/workouts/exerciseRecommendation";

type Row = Record<string, any>;

function makeDatabase() {
  const state: {
    exercises: Row[];
    equipment: Row[];
    links: Row[];
    workouts: Row[];
    workoutExercises: Row[];
    sets: Row[];
  } = { exercises: [], equipment: [], links: [], workouts: [], workoutExercises: [], sets: [] };

  const db: DatabaseLike = {
    async all<T extends import("pg").QueryResultRow = import("pg").QueryResultRow>(sql: string, ...params: unknown[]): Promise<T[]> {
      if (sql.includes("SELECT equipmentId FROM UserEquipment")) return [];
      if (sql.includes("SELECT e.name, ea.alias FROM Equipment")) return [];
      if (sql.includes("SELECT id,name,defaultSets,repRangeLow,repRangeHigh FROM Exercise")) return state.exercises as T[];
      if (sql.includes("SELECT id,name FROM Equipment")) return state.equipment as T[];
      if (sql.includes("SELECT equipmentId,alias FROM EquipmentAlias")) return [];
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
      if (sql.includes("SELECT ws.workoutExerciseId, ws.setNumber")) return [];
      throw new Error(`Unexpected integration-test query: ${sql}`);
    },
    async get<T extends import("pg").QueryResultRow = import("pg").QueryResultRow>(sql: string, ...params: unknown[]): Promise<T | undefined> {
      if (sql.includes("SELECT * FROM UserProfile")) return { sessionMinutes: 60 } as unknown as T;
      if (sql.includes("SELECT * FROM Workout WHERE userId = ?")) {
        return state.workouts.find((row) => row.userId === params[0] && row.planStepIndex === params[1] && row.status !== "superseded") as T | undefined;
      }
      if (sql.includes("SELECT COUNT(*) as count FROM WorkoutSet")) return { count: 0 } as unknown as T;
      if (sql.includes("SELECT userId,status,equipmentMode,equipmentSnapshot FROM Workout WHERE id = ?")) {
        return state.workouts.find((row) => row.id === params[0]) as T | undefined;
      }
      if (sql.includes("SELECT userId,status FROM Workout WHERE id = ?")) return state.workouts.find((row) => row.id === params[0]) as T | undefined;
      if (sql.includes("SELECT * FROM Workout WHERE id = ?")) return state.workouts.find((row) => row.id === params[0]) as T | undefined;
      if (sql.includes("SELECT * FROM WorkoutExercise WHERE id = ?")) return state.workoutExercises.find((row) => row.id === params[0]) as T | undefined;
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
          createdAt: params[4], planStepIndex: params[5], equipmentMode: params[6], equipmentSnapshot: params[7],
          generatorVersion: params[8],
        });
      } else if (sql.includes("INSERT INTO WorkoutExercise (")) {
        state.workoutExercises.push({
          id: params[0], workoutId: params[1], exerciseId: params[2], orderIndex: params[3],
          targetSets: params[4], repRangeLow: params[5], repRangeHigh: params[6], status: "pending",
          sourceExerciseName: params[7], sourceMuscle: params[8], sourcePrimaryMuscle: params[9], sourceMachine: params[10],
        });
      } else if (sql.includes("UPDATE WorkoutPlanState SET activeWorkoutId")) {
        // Plan-state advancement is deliberately outside workout generation.
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
      "Barbell Bench Press,Barbell,Chest",
      "Incline Dumbbell Press,Dumbbell,Chest",
      "Cable Chest Fly,Cable Machine,Chest",
      "Dumbbell Bench Press,Dumbbell,Chest",
    ].join("\n");
    const service = new CsvExerciseRecommendationService(new CsvExerciseRepository("integration.csv", () => sampleCsv));
    const { db, state } = makeDatabase();
    const planState = { currentIndex: 0, cycleStatus: "IN_PROGRESS", units: [{ key: "chest", label: "Chest", muscles: ["chest"] }] };

    vi.doMock("../db/client", () => ({ db, nowIso: () => "2026-10-02T00:00:00.000Z" }));
    vi.doMock("../common/auth", () => ({ requireAuth: (req: any, _res: any, next: () => void) => { req.userId = "integration-user"; next(); } }));
    vi.doMock("../modules/workouts/plan", () => ({
      canSwitchWorkoutPlan: async () => true,
      getActiveWorkoutPlan: async () => null,
      getCompletedWorkoutUnits: async () => [],
      getCycleHistory: async () => [],
      getCurrentCycle: async () => null,
      getNextRequiredWorkout: async () => null,
      getPlanState: async () => planState,
      getRecentlyTrainedMuscles: async () => [],
      getRemainingWorkoutUnits: async () => [],
      getTodayWorkoutDecision: async () => ({ nextUnit: null, remainingUnits: [] }),
      getWorkoutHistory: async () => [],
      listAvailableStructures: () => [],
      completedUnits: () => [],
      nextUnit: () => ({ key: "chest", label: "Chest", muscles: ["chest"] }),
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
      const generateResponse = await fetch(`${baseUrl}/workouts/generate`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ equipmentMode: "FULL_GYM" }),
      });
      expect(generateResponse.status).toBe(201);
      const generated = await generateResponse.json() as any;
      const csvNames = new Set(sampleCsv.split("\n").slice(1).map((line) => line.split(",")[0]));
      expect(generated.exercises).toHaveLength(3);
      expect(generated.exercises.every((exercise: any) => csvNames.has(exercise.exerciseName))).toBe(true);
      expect(generated.exercises.every((exercise: any) => exercise.exerciseName && exercise.machine && exercise.muscle)).toBe(true);

      const before = await (await fetch(`${baseUrl}/workouts/today`)).json() as any;
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
        body: JSON.stringify({ equipmentMode: "FULL_GYM", replaceExisting: true }),
      });
      expect(refreshResponse.status).toBe(201);
      const refreshed = await refreshResponse.json() as any;
      expect(refreshed.workout.id).not.toBe(before.id);
      expect(state.workouts.find((workout) => workout.id === before.id)?.status).toBe("superseded");
      expect(state.workoutExercises.filter((exercise) => exercise.workoutId === before.id)).toHaveLength(3);
      const current = await (await fetch(`${baseUrl}/workouts/today`)).json() as any;
      expect(current.id).toBe(refreshed.workout.id);
      expect(current.needsRegeneration).toBe(false);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
