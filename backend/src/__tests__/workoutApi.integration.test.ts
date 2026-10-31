import express from "express";
import type { Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabaseLike } from "../db/types";
import { CsvExerciseRepository } from "../modules/workouts/exerciseCsvRepository";
import { CsvExerciseRecommendationService, exerciseFamilyKey } from "../modules/workouts/exerciseRecommendation";
import { CANONICAL_EQUIPMENT } from "../modules/equipment/catalog";

type Row = Record<string, any>;

function mockOpenRouterExerciseGeneration() {
  vi.doMock("../modules/workouts/exerciseAiFallback", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../modules/workouts/exerciseAiFallback")>();
    let generatedIndex = 0;
    return {
      ...actual,
      validateUncataloguedExercise: vi.fn(async (input: any) => {
        const name = String(input.exerciseName).toLowerCase();
        if (name === "hate" || name.includes("nonsense")) return null;
        if (name.includes("good morning")) return {
          valid: true, canonicalName: "Good Morning", primaryMuscle: "hamstrings",
          secondaryMuscles: ["glutes"], equipmentName: "Barbell", confidence: 0.97,
        };
        if (name.includes("meadows")) return {
          valid: true, canonicalName: "Meadows Row", primaryMuscle: "back",
          secondaryMuscles: ["biceps"], equipmentName: "Dumbbells", confidence: 0.95,
        };
        return {
          valid: true, canonicalName: "Single Arm Dumbbell Row", primaryMuscle: "back",
          secondaryMuscles: ["biceps"], equipmentName: "Dumbbells", confidence: 0.95,
        };
      }),
      getAiExerciseFallback: vi.fn(async (input: any) => Array.from({ length: input.count }, (_, index) => {
        generatedIndex += 1;
        const muscle = input.targetMuscles[index % input.targetMuscles.length];
        const machine = input.equipment.find((item: any) => item.name !== "No Equipment")?.name ?? "Bodyweight";
        return {
          sourceIndex: -generatedIndex,
          exercise: `${muscle} AI Movement ${generatedIndex}`,
          machine,
          muscle,
          primaryMuscle: muscle,
          muscleCategories: [muscle],
          timeTakenOneSet: "25-45 sec",
          targetedMuscle: muscle,
          targetedMuscles: [muscle],
          instructions: "Use controlled form and a comfortable full range of motion.",
          sets: 3,
          repRangeLow: 8,
          repRangeHigh: 12,
        };
      })),
    };
  });
}

function makeDatabase(plan: Row, sessionMinutes = 60) {
  const state: {
    exercises: Row[];
    exerciseMuscles: Row[];
    equipment: Row[];
    equipmentAliases: Row[];
    userEquipment: Row[];
    links: Row[];
    workouts: Row[];
    workoutExercises: Row[];
    sets: Row[];
    swapHistory: Row[];
    plan: Row;
  } = { exercises: [], exerciseMuscles: [], equipment: [], equipmentAliases: [], userEquipment: [], links: [], workouts: [], workoutExercises: [], sets: [], swapHistory: [], plan };

  const db: DatabaseLike = {
    async all<T extends import("pg").QueryResultRow = import("pg").QueryResultRow>(sql: string, ...params: unknown[]): Promise<T[]> {
      if (sql.includes("SELECT completedAt FROM Workout")) return state.workouts.filter((row) => row.status === "completed" && row.completedAt).map((row) => ({ completedAt: row.completedAt })) as unknown as T[];
      if (sql === "SELECT name FROM Equipment") return state.equipment.map(({ name }) => ({ name })) as unknown as T[];
      if (sql === "SELECT * FROM Equipment ORDER BY name ASC") return [...state.equipment].sort((a, b) => a.name.localeCompare(b.name)) as T[];
      if (sql.includes("SELECT equipmentId FROM UserEquipment")) return state.userEquipment.filter((row) => row.userId === params[0]).map((row) => ({ equipmentId: row.equipmentId })) as unknown as T[];
      if (sql.includes("SELECT ue.equipmentId,e.name FROM UserEquipment")) return state.userEquipment.filter((row) => row.userId === params[0]).map((row) => ({ equipmentId: row.equipmentId, name: state.equipment.find((equipment) => equipment.id === row.equipmentId)?.name })) as unknown as T[];
      if (sql.includes("SELECT e.id,e.name,ea.alias FROM Equipment")) {
        return state.equipment.flatMap((equipment) => {
          const aliases = state.equipmentAliases.filter((alias) => alias.equipmentId === equipment.id);
          return aliases.length ? aliases.map((alias) => ({ id: equipment.id, name: equipment.name, alias: alias.alias })) : [{ id: equipment.id, name: equipment.name, alias: null }];
        }) as unknown as T[];
      }
      if (/SELECT e\.name,\s*ea\.alias FROM Equipment/.test(sql)) {
        return state.equipment.filter((equipment) => equipment.name !== "No Equipment" && (params.length === 0 || params.includes(equipment.id))).flatMap((equipment) => {
          const aliases = state.equipmentAliases.filter((alias) => alias.equipmentId === equipment.id);
          return aliases.length ? aliases.map((alias) => ({ name: equipment.name, alias: alias.alias })) : [{ name: equipment.name, alias: null }];
        }) as unknown as T[];
      }
      if (sql.includes("SELECT e.* FROM Equipment e JOIN UserEquipment")) {
        return state.userEquipment.filter((row) => row.userId === params[0]).map((row) => state.equipment.find((equipment) => equipment.id === row.equipmentId)).filter(Boolean) as T[];
      }
      if (sql.includes("SELECT id,name,defaultSets,repRangeLow,repRangeHigh FROM Exercise")) return state.exercises as T[];
      if (sql.includes("SELECT id,name,primaryMuscle,secondaryMuscles,requiresEquipment")) return state.exercises as T[];
      if (sql.includes("SELECT em.exerciseId,m.name FROM ExerciseMuscle")) {
        return state.exerciseMuscles.filter((row) => row.role === "PRIMARY").map((row) => ({ exerciseId: row.exerciseId, name: row.muscleName })) as unknown as T[];
      }
      if (sql.includes("SELECT ee.exerciseId,eq.id,eq.name FROM ExerciseEquipment")) {
        return state.links.map((link) => ({ exerciseId: link.exerciseId, id: link.equipmentId, name: state.equipment.find((item) => item.id === link.equipmentId)?.name })) as unknown as T[];
      }
      if (sql.includes("SELECT name FROM Muscle ORDER BY name")) return ["back", "chest", "glutes", "hamstrings"].map((name) => ({ name })) as unknown as T[];
      if (sql.includes("SELECT id,name FROM Equipment")) return state.equipment as T[];
      if (sql.includes("SELECT id FROM WorkoutExercise WHERE workoutId = ? ORDER BY orderIndex ASC")) {
        return state.workoutExercises.filter((row) => row.workoutId === params[0])
          .sort((left, right) => left.orderIndex - right.orderIndex).map(({ id }) => ({ id })) as unknown as T[];
      }
      if (sql.includes("SELECT * FROM WorkoutExercise WHERE workoutId = ? ORDER BY orderIndex ASC")) {
        return state.workoutExercises.filter((row) => row.workoutId === params[0])
          .sort((left, right) => left.orderIndex - right.orderIndex) as T[];
      }
      if (sql.includes("SELECT equipmentId,alias FROM EquipmentAlias")) return state.equipmentAliases as unknown as T[];
      if (sql.includes("SELECT weightKg, reps FROM WorkoutHistory")) return [];
      if (sql.includes("SELECT equipmentId FROM ExerciseEquipment WHERE exerciseId = ?")) {
        return state.links.filter((row) => row.exerciseId === params[0]).map((row) => ({ equipmentId: row.equipmentId })) as unknown as T[];
      }
      if (sql.includes("SELECT eq.name FROM ExerciseEquipment")) {
        return state.links.filter((row) => row.exerciseId === params[0]).map((row) => ({ name: state.equipment.find((eq) => eq.id === row.equipmentId)?.name })) as unknown as T[];
      }
      if (/SELECT\s+e\.name\s+FROM\s+WorkoutExercise\s+we\s+JOIN\s+Exercise\s+e\s+ON\s+e\.id\s*=\s*we\.exerciseId/i.test(sql)) {
        return state.workoutExercises.filter((row) => row.workoutId === params[0])
          .sort((left, right) => left.orderIndex - right.orderIndex)
          .map((row) => ({
            name: row.sourceExerciseName || state.exercises.find((exercise) => exercise.id === row.exerciseId)?.name,
          }))
          .filter((row) => typeof row.name === "string") as unknown as T[];
      }
      if (sql.includes("SELECT COALESCE(we.sourceExerciseName,e.name) as name")) {
        return state.workoutExercises.filter((row) => row.workoutId === params[0]).map((row) => ({ name: row.sourceExerciseName || state.exercises.find((ex) => ex.id === row.exerciseId)?.name })) as unknown as T[];
      }
      if (sql.includes("SELECT familyKey FROM WorkoutExerciseSwapHistory")) {
        return state.swapHistory.filter((row) => row.workoutExerciseId === params[0]).map((row) => ({ familyKey: row.familyKey })) as unknown as T[];
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
      if (sql.includes("SELECT completedAt FROM Workout")) {
        const latest = state.workouts
          .filter((row) => row.userId === params[0] && row.status === "completed" && row.completedAt)
          .sort((left, right) => new Date(right.completedAt!).getTime() - new Date(left.completedAt!).getTime())[0];
        return latest ? ({ completedAt: latest.completedAt } as unknown as T) : undefined;
      }
      if (sql.includes("SELECT * FROM UserProfile")) return { sessionMinutes } as unknown as T;
      if (sql.includes("SELECT id, createdAt, lastScanAt FROM GymEquipmentProfile WHERE userId = ?")) return undefined;
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
      if (sql.includes("SELECT userId,status,equipmentMode,equipmentSnapshot,durationMin FROM Workout WHERE id = ?")) {
        return state.workouts.find((row) => row.id === params[0]) as T | undefined;
      }
      if (sql.includes("SELECT userId,status,focus,durationMin,equipmentMode,equipmentSnapshot FROM Workout WHERE id = ?")) {
        return state.workouts.find((row) => row.id === params[0]) as T | undefined;
      }
      if (sql.includes("SELECT userId,status FROM Workout WHERE id = ?")) return state.workouts.find((row) => row.id === params[0]) as T | undefined;
      if (sql.includes("SELECT * FROM Workout WHERE id = ?")) return state.workouts.find((row) => row.id === params[0]) as T | undefined;
      if (sql.includes("SELECT * FROM WorkoutExercise WHERE id = ?")) return state.workoutExercises.find((row) => row.id === params[0]) as T | undefined;
      if (sql.includes("SELECT * FROM Equipment WHERE name = ?")) return state.equipment.find((row) => row.name === params[0]) as T | undefined;
      if (sql.includes("SELECT id FROM Equipment WHERE lower(name)=lower(?)")) return state.equipment.find((row) => row.name.toLowerCase() === String(params[0]).toLowerCase()) as T | undefined;
      if (sql.includes("SELECT id FROM Exercise WHERE lower(name)=lower(?)")) return state.exercises.find((row) => row.name.toLowerCase() === String(params[0]).toLowerCase()) as T | undefined;
      if (sql.includes("SELECT m.name FROM ExerciseMuscle em JOIN Muscle")) {
        const muscle = state.exerciseMuscles.find((row) => row.exerciseId === params[0] && row.role === "PRIMARY");
        return muscle ? ({ name: muscle.muscleName } as unknown as T) : undefined;
      }
      if (sql.includes("SELECT * FROM Exercise WHERE id = ?")) return state.exercises.find((row) => row.id === params[0]) as T | undefined;
      if (sql.includes("SELECT repRangeHigh FROM Exercise WHERE id = ?")) return state.exercises.find((row) => row.id === params[0]) as T | undefined;
      throw new Error(`Unexpected integration-test lookup: ${sql}`);
    },
    async run(sql: string, ...params: unknown[]): Promise<{ changes: number }> {
      if (sql.includes("INSERT INTO GymEquipmentProfile (")) {
        // Gym profile synchronization is a side effect of saving workout equipment.
        // This test focuses on workout generation, so accept the profile upsert.
      } else if (sql.includes("INSERT INTO Equipment (")) {
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
      } else if (sql.includes("UPDATE WorkoutExercise SET orderIndex = ?")) {
        const row = state.workoutExercises.find((exercise) => exercise.id === params[1] && exercise.workoutId === params[2]);
        if (row) row.orderIndex = params[0] as number;
      } else if (sql.includes("UPDATE WorkoutExercise SET exerciseId=?,status='pending'")) {
        const row = state.workoutExercises.find((exercise) => exercise.id === params[5] && exercise.workoutId === params[6]);
        if (row) Object.assign(row, {
          exerciseId: params[0], status: "pending",
          sourceExerciseName: params[1], sourceMuscle: params[2], sourcePrimaryMuscle: params[3], sourceMachine: params[4],
        });
      } else if (sql.includes("UPDATE WorkoutExercise")) {
        const row = state.workoutExercises.find((exercise) => exercise.id === params[6]);
        if (row) Object.assign(row, {
          exerciseId: params[0], replacedFromId: params[1], status: "replaced",
          sourceExerciseName: params[2], sourceMuscle: params[3], sourcePrimaryMuscle: params[4], sourceMachine: params[5],
        });
      } else if (sql.includes("INSERT INTO WorkoutExerciseSwapHistory")) {
        if (!state.swapHistory.some((row) => row.workoutExerciseId === params[0] && row.familyKey === params[1])) {
          state.swapHistory.push({ workoutExerciseId: params[0], familyKey: params[1], exerciseName: params[2], createdAt: params[3] });
        }
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

  it("persists OpenRouter-generated names and swaps only the requested slot without changing its programming", async () => {
    const sampleCsv = [
      "exercise,machine,muscle,time_taken_1_set,targeted_muscle",
      'Barbell Row,Barbell,Back,20-40 sec,"Latissimus Dorsi, Rhomboid Major"',
      'Lat Pulldown,Lat Pulldown,Back,20-40 sec,"Latissimus Dorsi, Rhomboid Major"',
      'Dumbbell Row,Dumbbells,Back,20-40 sec,"Latissimus Dorsi, Rhomboid Major"',
      'Cable Row,Cable Machine,Back,20-40 sec,"Latissimus Dorsi, Rhomboid Major"',
      'Seated Cable Row,Cable Machine,Back,20-40 sec,"Latissimus Dorsi, Rhomboid Major"',
      'Straight Arm Pulldown,Cable Machine,Back,20-40 sec,"Latissimus Dorsi, Rhomboid Major"',
      'Dumbbell Pullover,Dumbbells,Back,20-40 sec,"Latissimus Dorsi, Rhomboid Major"',
      'Face Pull,Cable Machine,Back,20-40 sec,"Latissimus Dorsi, Rhomboid Major"',
      'Bodyweight Row,Bodyweight,Back,25-45 sec,"Latissimus Dorsi, Rhomboid Major"',
      'Deadlift,Barbell,Back,20-40 sec,"Gluteus Maximus, Hamstrings"',
      'Dumbbell Deadlift,Dumbbells,Back,20-40 sec,"Gluteus Maximus, Hamstrings"',
      'Bench Press,Barbell,Chest,20-40 sec,"Pectoralis Major, Triceps Brachii"',
    ].join("\n");
    const service = new CsvExerciseRecommendationService(new CsvExerciseRepository("integration.csv", () => sampleCsv));
    const planState = {
      currentIndex: 0, cycleId: "current-cycle", cycleStatus: "IN_PROGRESS", activeWorkoutId: null,
      units: [{ key: "back", label: "Back", muscles: ["back"] }],
    };
    const { db, state } = makeDatabase(planState);
    const selectedEquipment = ["Lat Pulldown", "Dumbbells", "Cable Machine", "Bench"];
    state.equipment = selectedEquipment.concat("Barbell").map((name) => ({ id: `equipment-${name}`, name }));
    state.exercises.push({
      id: "catalog-dumbbell-deadlift", name: "Dumbbell Deadlift", primaryMuscle: "back", secondaryMuscles: "legs",
      defaultSets: 3, repRangeLow: 8, repRangeHigh: 12, instructions: "",
    });
    state.links.push({ id: "catalog-dumbbell-deadlift-equipment", exerciseId: "catalog-dumbbell-deadlift", equipmentId: "equipment-Dumbbells" });
    state.exercises.push(
      { id: "catalog-deadlift", name: "Deadlift", primaryMuscle: "back", secondaryMuscles: "legs", defaultSets: 3, repRangeLow: 8, repRangeHigh: 12, instructions: "" },
      { id: "catalog-dumbbell-rows", name: "Dumbbell Rows", primaryMuscle: "biceps", secondaryMuscles: "back", defaultSets: 3, repRangeLow: 8, repRangeHigh: 12, instructions: "" },
      { id: "catalog-biceps-row-test", name: "Biceps Curl", primaryMuscle: "biceps", secondaryMuscles: "back", defaultSets: 3, repRangeLow: 8, repRangeHigh: 12, instructions: "" },
      { id: "catalog-bench-press", name: "Bench Press", primaryMuscle: "chest", secondaryMuscles: "", defaultSets: 3, repRangeLow: 8, repRangeHigh: 12, instructions: "" },
    );
    state.exerciseMuscles.push(
      { exerciseId: "catalog-dumbbell-rows", muscleName: "Upper Back", role: "PRIMARY" },
      { exerciseId: "catalog-dumbbell-rows", muscleName: "Biceps", role: "SECONDARY" },
      { exerciseId: "catalog-biceps-row-test", muscleName: "Biceps", role: "PRIMARY" },
      { exerciseId: "catalog-biceps-row-test", muscleName: "Back", role: "SECONDARY" },
    );
    state.links.push(
      { id: "catalog-dumbbell-rows-dumbbells", exerciseId: "catalog-dumbbell-rows", equipmentId: "equipment-Dumbbells" },
      { id: "catalog-dumbbell-rows-bench", exerciseId: "catalog-dumbbell-rows", equipmentId: "equipment-Bench" },
    );
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
    vi.doMock("../modules/workouts/exerciseRecommendation", async (importOriginal) => ({
      ...await importOriginal<typeof import("../modules/workouts/exerciseRecommendation")>(),
      exerciseRecommendationService: service,
    }));
    vi.doMock("../modules/workouts/exerciseAiFallback", async (importOriginal) => ({
      ...await importOriginal<typeof import("../modules/workouts/exerciseAiFallback")>(),
      validateUncataloguedExercise: async ({ exerciseName }: { exerciseName: string }) => {
        const validations: Record<string, any> = {
          "good morning": {
            valid: true, canonicalName: "Good Morning", primaryMuscle: "hamstrings", secondaryMuscles: ["glutes"],
            equipmentName: "Barbell", confidence: 0.98,
          },
          "meadows row": {
            valid: true, canonicalName: "Meadows Row", primaryMuscle: "back", secondaryMuscles: ["biceps"],
            equipmentName: "Dumbbells", confidence: 0.96,
          },
          "dumbel row": {
            valid: true, canonicalName: "Single Arm Dumbbell Row", primaryMuscle: "back", secondaryMuscles: ["biceps"],
            equipmentName: "Dumbbells", confidence: 0.93,
          },
        };
        return validations[exerciseName.toLowerCase()] ?? null;
      },
    }));

    mockOpenRouterExerciseGeneration();
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
      const catalogResponse = await fetch(`${baseUrl}/`);
      expect(catalogResponse.status).toBe(200);
      const catalog = await catalogResponse.json() as Array<{ name: string }>;
      expect(catalog.map((row) => row.name)).toEqual(expect.arrayContaining([...CANONICAL_EQUIPMENT]));

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
        body: JSON.stringify({ durationMinutes: 90, equipmentMode: "USER_EQUIPMENT", availableEquipmentNames: selectedEquipment }),
      });
      expect(generateResponse.status).toBe(201);
      const generated = await generateResponse.json() as any;
      expect(generated.exercises).toHaveLength(6);
      expect(generated.availableExerciseCount).toBe(6);
      expect(new Set(generated.exercises.map((exercise: any) => exerciseFamilyKey(exercise.exerciseName))).size).toBe(generated.exercises.length);
      expect(generated.exercises.every((exercise: any) => exercise.instructions.length > 0)).toBe(true);
      expect(generated.workout.durationMin).toBe(90);
      expect(generated.workout.cycleId).toBe("current-cycle");
      expect(generated.exercises.every((exercise: any) => exercise.exerciseName && exercise.machine && String(exercise.muscle).toLowerCase() === "back")).toBe(true);
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
      const slot = before.exercises[0];

      const swapResponse = await fetch(`${baseUrl}/workouts/${before.id}/replace-exercise`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workoutExerciseId: slot.workoutExerciseId, reason: "user_preference" }),
      });
      expect(swapResponse.status).toBe(200);
      const swapped = await swapResponse.json() as any;
      expect(swapped.workoutExerciseId).toBe(slot.workoutExerciseId);
      expect(swapped.exercise.exerciseName).not.toBe(slot.exerciseName);
      expect(exerciseFamilyKey(swapped.exercise.exerciseName)).not.toBe(exerciseFamilyKey(slot.exerciseName));
      expect(String(swapped.exercise.targetedMuscle).toLowerCase()).toBe("back");
      expect(swapped.exercise.timeTakenOneSet).toBe("25-45 sec");
      expect(selectedEquipment).toContain(swapped.exercise.machine);
      expect(before.exercises.filter((exercise: any) => exercise.workoutExerciseId !== slot.workoutExerciseId).some(
        (exercise: any) => exercise.exerciseName === swapped.exercise.exerciseName,
      )).toBe(false);

      const after = await (await fetch(`${baseUrl}/workouts/today`)).json() as any;
      expect(after.exercises).toHaveLength(6);
      expect(after.durationMin).toBe(before.durationMin);

      // The endpoint may choose any eligible slot above; assert by stable slot
      // ID rather than assuming the selected slot is always at index 1.
      const afterBySlotId = new Map(after.exercises.map((exercise: any) => [exercise.workoutExerciseId, exercise]));
      for (const previous of original) {
        const current = afterBySlotId.get(previous.workoutExerciseId) as any;
        expect(current, `slot ${previous.workoutExerciseId} should still exist`).toBeDefined();
        if (previous.workoutExerciseId === slot.workoutExerciseId) {
          expect(current.exerciseName).toBe(swapped.exercise.exerciseName);
          expect(current.muscle).toBe(previous.muscle);
          expect(current.targetSets).toBe(previous.targetSets);
          expect(current.repRangeLow).toBe(previous.repRangeLow);
          expect(current.repRangeHigh).toBe(previous.repRangeHigh);
        } else {
          expect(current.exerciseName).toBe(previous.exerciseName);
          expect(current.machine).toBe(previous.machine);
          expect(current.targetSets).toBe(previous.targetSets);
          expect(current.repRangeLow).toBe(previous.repRangeLow);
          expect(current.repRangeHigh).toBe(previous.repRangeHigh);
        }
      }
      expect(state.workoutExercises.map((exercise) => exercise.orderIndex).sort((a, b) => a - b)).toEqual(Array.from({ length: 6 }, (_, index) => index));
      expect(new Set(state.swapHistory.filter((row) => row.workoutExerciseId === slot.workoutExerciseId).map((row) => row.familyKey)).size).toBe(2);

      const historyBeforeSecondSwap = state.swapHistory
        .filter((row) => row.workoutExerciseId === slot.workoutExerciseId)
        .map((row) => row.familyKey);
      const secondSwapResponse = await fetch(`${baseUrl}/workouts/${before.id}/replace-exercise`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workoutExerciseId: slot.workoutExerciseId, reason: "user_preference" }),
      });
      const secondSwapBody = await secondSwapResponse.json() as any;
      if (secondSwapResponse.status === 200) {
        const secondFamily = exerciseFamilyKey(secondSwapBody.exercise.exerciseName);
        expect(historyBeforeSecondSwap).not.toContain(secondFamily);
        expect(secondFamily).not.toBe(exerciseFamilyKey(slot.exerciseName));
        expect(secondFamily).not.toBe(exerciseFamilyKey(swapped.exercise.exerciseName));
        expect(state.swapHistory.filter((row) => row.workoutExerciseId === slot.workoutExerciseId)
          .some((row) => row.familyKey === secondFamily)).toBe(true);
      } else {
        expect(secondSwapResponse.status).toBe(422);
        expect(secondSwapBody.error).toMatch(/no curated CSV substitute matches/i);
        expect(state.swapHistory.filter((row) => row.workoutExerciseId === slot.workoutExerciseId)).toHaveLength(2);
      }

      const reorderIds = [...state.workoutExercises]
        .filter((exercise) => exercise.workoutId === before.id)
        .sort((left, right) => right.orderIndex - left.orderIndex)
        .map((exercise) => exercise.id);
      const reorderResponse = await fetch(`${baseUrl}/workouts/${before.id}/reorder-exercises`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workoutExerciseIds: reorderIds }),
      });
      expect(reorderResponse.status).toBe(200);
      expect(state.workoutExercises.filter((exercise) => exercise.workoutId === before.id)
        .sort((left, right) => left.orderIndex - right.orderIndex).map((exercise) => exercise.id)).toEqual(reorderIds);

      const editSlotId = reorderIds[0];
      // Reproduce the reported stale-plan case with concrete catalogue slots:
      // a row replacement must rebalance the two next movements from the new
      // Deadlift selection, rather than treating the old names as cached output.
      const addCatalogExercise = (id: string, name: string, primaryMuscle = "back") => {
        state.exercises.push({ id, name, primaryMuscle, secondaryMuscles: "", defaultSets: 3, repRangeLow: 8, repRangeHigh: 12, instructions: "" });
      };
      addCatalogExercise("catalog-seated-cable-row", "Seated Cable Row");
      addCatalogExercise("catalog-lat-pulldown", "Lat Pulldown");
      addCatalogExercise("catalog-face-pull", "Face Pull");
      const orderedWorkoutRows = state.workoutExercises
        .filter((exercise) => exercise.workoutId === before.id)
        .sort((left, right) => left.orderIndex - right.orderIndex);
      Object.assign(orderedWorkoutRows[0], { exerciseId: "catalog-seated-cable-row", sourceExerciseName: "Seated Cable Row", sourcePrimaryMuscle: "Back", sourceMachine: "Cable Machine" });
      Object.assign(orderedWorkoutRows[1], { exerciseId: "catalog-lat-pulldown", sourceExerciseName: "Lat Pulldown", sourcePrimaryMuscle: "Back", sourceMachine: "Lat Pulldown" });
      Object.assign(orderedWorkoutRows[2], { exerciseId: "catalog-face-pull", sourceExerciseName: "Face Pull", sourcePrimaryMuscle: "Back", sourceMachine: "Cable Machine" });
      const priorSuggestionIds = [orderedWorkoutRows[1].id, orderedWorkoutRows[2].id];
      const originalEditedExercise = state.workoutExercises.find((exercise) => exercise.id === editSlotId);
      const typoResponse = await fetch(`${baseUrl}/workouts/${before.id}/edit-exercise`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workoutExerciseId: editSlotId, exerciseName: "dumbel deadlift", targetMuscle: "back", equipmentName: "Dumbbells" }),
      });
      expect(typoResponse.status).toBe(422);
      const typoBody = await typoResponse.json() as any;
      expect(typoBody.code).toBe("EXERCISE_CONFIRMATION_REQUIRED");
      expect(typoBody.suggestions).toEqual(expect.arrayContaining([expect.objectContaining({ name: "Dumbbell Deadlift" })]));
      expect(state.workoutExercises.find((exercise) => exercise.id === editSlotId)).toEqual(originalEditedExercise);

      const typoRowResponse = await fetch(`${baseUrl}/workouts/${before.id}/edit-exercise`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workoutExerciseId: editSlotId, exerciseName: "dumbel row", targetMuscle: "back", equipmentName: "Dumbbells" }),
      });
      const typoRow = await typoRowResponse.json() as any;
      // The fixture catalog's canonical row name is "Dumbbell Rows".
      expect(typoRow.suggestions.map((candidate: any) => candidate.name)).toEqual(expect.arrayContaining(["Dumbbell Rows"]));
      // The UI cancellation path hides these suggestions without issuing a confirmation request.
      expect(state.workoutExercises.find((exercise) => exercise.id === editSlotId)).toEqual(originalEditedExercise);
      const aiNewNearMatchResponse = await fetch(`${baseUrl}/workouts/${before.id}/edit-exercise`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workoutExerciseId: editSlotId, exerciseName: "dumbel row", targetMuscle: "back", equipmentName: "Dumbbells", validateWithAi: true }),
      });
      const aiNewNearMatch = await aiNewNearMatchResponse.json() as any;
      expect(aiNewNearMatch).toMatchObject({
        code: "EXERCISE_CONFIRMATION_REQUIRED",
        suggestions: [expect.objectContaining({ name: "Single Arm Dumbbell Row", aiValidated: true })],
      });
      expect(state.exercises.some((exercise) => exercise.name === "Single Arm Dumbbell Row")).toBe(true);
      expect(state.workoutExercises.find((exercise) => exercise.id === editSlotId)).toEqual(originalEditedExercise);

      const bedliftResponse = await fetch(`${baseUrl}/workouts/${before.id}/edit-exercise`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workoutExerciseId: editSlotId, exerciseName: "bedlift", targetMuscle: "back", equipmentName: "Dumbbells" }),
      });
      expect((await bedliftResponse.json() as any).suggestions).toEqual(expect.arrayContaining([expect.objectContaining({ name: "Deadlift" })]));

      const nonsenseResponse = await fetch(`${baseUrl}/workouts/${before.id}/edit-exercise`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workoutExerciseId: editSlotId, exerciseName: "hate", targetMuscle: "back", equipmentName: "Dumbbells" }),
      });
      expect(nonsenseResponse.status).toBe(422);
      expect(await nonsenseResponse.json()).toMatchObject({
        code: "EXERCISE_CATALOG_ENTRY_MISSING",
        error: expect.stringContaining("No matching exercise record exists"),
      });
      expect(state.exercises.some((exercise) => exercise.name === "hate")).toBe(false);
      expect(state.workoutExercises.find((exercise) => exercise.id === editSlotId)).toEqual(originalEditedExercise);

      const emptyResponse = await fetch(`${baseUrl}/workouts/${before.id}/edit-exercise`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workoutExerciseId: editSlotId, exerciseName: "", targetMuscle: "back", equipmentName: "Dumbbells" }),
      });
      expect(emptyResponse.status).toBe(400);
      expect(state.workoutExercises.find((exercise) => exercise.id === editSlotId)).toEqual(originalEditedExercise);

      const wrongMuscleResponse = await fetch(`${baseUrl}/workouts/${before.id}/edit-exercise`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workoutExerciseId: editSlotId, exerciseName: "Bench Press", targetMuscle: "back", equipmentName: "Dumbbells" }),
      });
      expect(wrongMuscleResponse.status).toBe(422);
      const wrongSecondaryMuscleResponse = await fetch(`${baseUrl}/workouts/${before.id}/edit-exercise`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workoutExerciseId: editSlotId, exerciseName: "Biceps Curl", targetMuscle: "back", equipmentName: "Dumbbells" }),
      });
      expect(wrongSecondaryMuscleResponse.status).toBe(422);
      expect((await wrongSecondaryMuscleResponse.json() as any).error).toMatch(/not mapped to Back/i);
      expect(state.workoutExercises.find((exercise) => exercise.id === editSlotId)).toEqual(originalEditedExercise);

      // Reproduce the reported transition directly: the original row is
      // replaced with Deadlift, then the same slot is restored for the row
      // primary/secondary muscle regression below.
      const recommendationSpy = vi.spyOn(service, "getRecommendedExercises");
      const directDeadliftResponse = await fetch(`${baseUrl}/workouts/${before.id}/edit-exercise`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workoutExerciseId: editSlotId, exerciseName: "Deadlift", targetMuscle: "back", equipmentName: "Dumbbells" }),
      });
      expect(directDeadliftResponse.status).toBe(200);
      expect(state.workoutExercises.find((exercise) => exercise.id === editSlotId)?.exerciseId).toBe("catalog-deadlift");
      const restoreSeatedRowResponse = await fetch(`${baseUrl}/workouts/${before.id}/edit-exercise`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workoutExerciseId: editSlotId, exerciseName: "Seated Cable Row", targetMuscle: "back", equipmentName: "Cable Machine" }),
      });
      expect(restoreSeatedRowResponse.status).toBe(200);
      expect(state.workoutExercises.find((exercise) => exercise.id === editSlotId)?.exerciseId).toBe("catalog-seated-cable-row");
      recommendationSpy.mockClear();

      // A primary Upper Back mapping belongs to the Back workout target even
      // when the legacy Exercise row says biceps and biceps is secondary.
      const originalProgramming = (({ orderIndex, targetSets, repRangeLow, repRangeHigh }) => ({
        orderIndex, targetSets, repRangeLow, repRangeHigh,
      }))(state.workoutExercises.find((exercise) => exercise.id === editSlotId)!);
      const dumbbellRowEditResponse = await fetch(`${baseUrl}/workouts/${before.id}/edit-exercise`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workoutExerciseId: editSlotId, exerciseName: "  DUMBBELL ROWS  ", targetMuscle: "back", equipmentName: "Dumbbells" }),
      });
      expect(dumbbellRowEditResponse.status).toBe(200);
      const dumbbellRow = state.workoutExercises.find((exercise) => exercise.id === editSlotId);
      expect(dumbbellRow).toMatchObject({
        exerciseId: "catalog-dumbbell-rows", sourceExerciseName: "Dumbbell Rows", sourcePrimaryMuscle: "Upper Back",
        ...originalProgramming,
      });
      const canonicalDumbbellRowWorkout = await (await fetch(`${baseUrl}/workouts/today`)).json() as any;
      expect(canonicalDumbbellRowWorkout.exercises).toEqual(expect.arrayContaining([
        expect.objectContaining({
          workoutExerciseId: editSlotId, exerciseId: "catalog-dumbbell-rows", exerciseName: "Dumbbell Rows",
          primaryMuscle: "Upper Back", muscle: "Upper Back", machine: "Dumbbells",
          equipmentRequired: ["Dumbbells", "Bench"],
        }),
      ]));

      recommendationSpy.mockClear();
      const editResponse = await fetch(`${baseUrl}/workouts/${before.id}/edit-exercise`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workoutExerciseId: editSlotId, exerciseName: "Deadlift", targetMuscle: "back", equipmentName: "Dumbbells" }),
      });
      expect(editResponse.status).toBe(200);
      expect(await editResponse.json()).toMatchObject({ updated: true, rebalancedExerciseCount: 5 });
      const editedSlot = state.workoutExercises.find((exercise) => exercise.id === editSlotId);
      expect(editedSlot).toMatchObject({ sourceExerciseName: "Deadlift", sourcePrimaryMuscle: "back", sourceMachine: "Dumbbells" });
      expect(editedSlot?.exerciseId).toBe("catalog-deadlift");
      const rebalancedRows = state.workoutExercises.filter((exercise) => exercise.workoutId === before.id && exercise.id !== editSlotId);
      expect(rebalancedRows.every((exercise) => exerciseFamilyKey(exercise.sourceExerciseName || "") !== exerciseFamilyKey("Deadlift"))).toBe(true);
      expect(rebalancedRows.some((exercise) => priorSuggestionIds.includes(exercise.id))).toBe(true);
      const afterRebalance = await (await fetch(`${baseUrl}/workouts/today`)).json() as any;
      for (const row of rebalancedRows) {
        expect(afterRebalance.exercises).toEqual(expect.arrayContaining([
          expect.objectContaining({ workoutExerciseId: row.id, exerciseId: row.exerciseId, exerciseName: row.sourceExerciseName }),
        ]));
      }
      const confirmedResponse = await fetch(`${baseUrl}/workouts/${before.id}/edit-exercise`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workoutExerciseId: editSlotId, exerciseName: "dumbel deadlift", confirmedExerciseId: "catalog-dumbbell-deadlift",
          targetMuscle: "back", equipmentName: "Dumbbells",
        }),
      });
      expect(confirmedResponse.status).toBe(200);
      expect(state.workoutExercises.find((exercise) => exercise.id === editSlotId)?.exerciseId).toBe("catalog-dumbbell-deadlift");
      const refreshedWorkoutResponse = await fetch(`${baseUrl}/workouts/today`);
      expect(refreshedWorkoutResponse.status).toBe(200);
      const refreshedWorkout = await refreshedWorkoutResponse.json() as any;
      expect(refreshedWorkout.exercises).toEqual(expect.arrayContaining([
        expect.objectContaining({ exerciseId: "catalog-dumbbell-deadlift", exerciseName: "Dumbbell Deadlift" }),
      ]));

      const validOtherMuscleResponse = await fetch(`${baseUrl}/workouts/${before.id}/edit-exercise`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workoutExerciseId: editSlotId, exerciseName: "Good Morning", targetMuscle: "back", equipmentName: "Dumbbells" }),
      });
      expect(validOtherMuscleResponse.status).toBe(422);
      expect(await validOtherMuscleResponse.json()).toMatchObject({ code: "EXERCISE_TARGET_MISMATCH", exerciseName: "Good Morning" });
      expect(state.exercises.some((exercise) => exercise.name === "Good Morning" && exercise.primaryMuscle === "hamstrings")).toBe(true);
      expect(state.workoutExercises.find((exercise) => exercise.id === editSlotId)?.exerciseId).toBe("catalog-dumbbell-deadlift");

      const aiNewExerciseResponse = await fetch(`${baseUrl}/workouts/${before.id}/edit-exercise`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workoutExerciseId: editSlotId, exerciseName: "Meadows Row", targetMuscle: "back", equipmentName: "Dumbbells" }),
      });
      expect(aiNewExerciseResponse.status).toBe(422);
      const aiNewExercise = await aiNewExerciseResponse.json() as any;
      expect(aiNewExercise).toMatchObject({
        code: "EXERCISE_CONFIRMATION_REQUIRED",
        suggestions: [expect.objectContaining({ name: "Meadows Row", aiValidated: true })],
      });
      expect(state.workoutExercises.find((exercise) => exercise.id === editSlotId)?.exerciseId).toBe("catalog-dumbbell-deadlift");
      const confirmedNewExerciseResponse = await fetch(`${baseUrl}/workouts/${before.id}/edit-exercise`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workoutExerciseId: editSlotId, exerciseName: "Meadows Row", confirmedExerciseId: aiNewExercise.suggestions[0].id,
          targetMuscle: "back", equipmentName: "Dumbbells",
        }),
      });
      expect(confirmedNewExerciseResponse.status).toBe(200);
      expect(state.workoutExercises.find((exercise) => exercise.id === editSlotId)?.exerciseId).toBe(aiNewExercise.suggestions[0].id);
      expect(state.workoutExercises.filter((exercise) => exercise.workoutId === before.id)
        .sort((left, right) => left.orderIndex - right.orderIndex).map((exercise) => exercise.id)).toEqual(reorderIds);

      const refreshResponse = await fetch(`${baseUrl}/workouts/generate`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ durationMinutes: 30, equipmentMode: "USER_EQUIPMENT", availableEquipmentNames: selectedEquipment, replaceExisting: true }),
      });
      expect(refreshResponse.status).toBe(201);
      const refreshed = await refreshResponse.json() as any;
      expect(refreshed.workout.durationMin).toBe(30);
      expect(refreshed.exercises).toHaveLength(3);
      expect(refreshed.workout.id).not.toBe(before.id);
      expect(state.workouts.find((workout) => workout.id === before.id)?.status).toBe("superseded");
      expect(state.workoutExercises.filter((exercise) => exercise.workoutId === before.id)).toHaveLength(4);
      expect(oldCycleWorkout.status).toBe("pending");
      const current = await (await fetch(`${baseUrl}/workouts/today`)).json() as any;
      expect(current.id).toBe(refreshed.workout.id);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("replaces a same-step legacy workout with OpenRouter results while preserving logged sets", async () => {
    const sampleCsv = [
      "exercise,machine,muscle",
      "Barbell Row,Barbell,Back",
      "Lat Pulldown,Lat Pulldown,Back",
      "Dumbbell Row,Dumbbells,Back",
      "Cable Row,Cable Machine,Back",
      "Deadlift,Barbell,Back",
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
    vi.doMock("../modules/workouts/exerciseRecommendation", async (importOriginal) => ({
      ...await importOriginal<typeof import("../modules/workouts/exerciseRecommendation")>(),
      exerciseRecommendationService: service,
    }));

    mockOpenRouterExerciseGeneration();
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
      expect(generated.exercises).toHaveLength(5);
      expect(generated.exercises.every((exercise: any) => String(exercise.muscle).toLowerCase() === "back" && exercise.machine !== "Bodyweight")).toBe(true);
      expect(state.workouts.find((workout) => workout.id === legacyId)?.status).toBe("superseded");
      expect(state.workoutExercises.find((exercise) => exercise.id === "legacy-workout-slot")).toBeDefined();
      expect(state.sets).toContain(preservedSet);
      expect(state.plan.activeWorkoutId).toBe(generated.workout.id);

      const current = await (await fetch(`${baseUrl}/workouts/today`)).json() as any;
      expect(current.id).toBe(generated.workout.id);
      expect(current.exercises).toHaveLength(5);
      expect(current.exercises.every((exercise: any) => String(exercise.muscle).toLowerCase() === "back")).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
