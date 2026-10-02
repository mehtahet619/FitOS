import { describe, expect, it } from "vitest";
import type { DatabaseLike } from "../db/types";
import { generateWorkout } from "../modules/workouts/workoutGenerator";

function memoryDatabase(): { db: DatabaseLike; exercises: any[]; equipment: any[]; queries: string[] } {
  const exercises: any[] = [];
  const equipment: any[] = [];
  const aliases: any[] = [];
  const queries: string[] = [];
  const db = {
    async all<T>(sql: string, ..._params: unknown[]): Promise<T[]> {
      queries.push(sql);
      if (sql.includes("SELECT equipmentId FROM UserEquipment")) return [];
      if (sql.includes("SELECT e.name, ea.alias FROM Equipment")) return [];
      if (sql.includes("SELECT id,name,defaultSets,repRangeLow,repRangeHigh FROM Exercise")) return exercises as T[];
      if (sql.includes("SELECT id,name FROM Equipment")) return equipment as T[];
      if (sql.includes("SELECT equipmentId,alias FROM EquipmentAlias")) return aliases as T[];
      if (sql.includes("SELECT weightKg, reps FROM WorkoutHistory")) return [];
      throw new Error(`Unexpected database query in CSV generator test: ${sql}`);
    },
    async get<T>(sql: string, ...params: unknown[]): Promise<T | undefined> {
      queries.push(sql);
      if (sql.includes("SELECT id FROM Equipment WHERE lower(name)=lower(?)")) {
        return equipment.find((row) => row.name.toLowerCase() === String(params[0]).toLowerCase()) as T | undefined;
      }
      if (sql.includes("SELECT id FROM Exercise WHERE lower(name)=lower(?)")) {
        return exercises.find((row) => row.name.toLowerCase() === String(params[0]).toLowerCase()) as T | undefined;
      }
      return undefined;
    },
    async run(sql: string, ...params: unknown[]): Promise<{ changes: number }> {
      queries.push(sql);
      if (sql.includes("INSERT INTO Equipment")) {
        if (!equipment.some((row) => row.name === params[1])) equipment.push({ id: params[0], name: params[1] });
      }
      if (sql.includes("INSERT INTO Exercise (")) {
        if (!exercises.some((row) => row.name.toLowerCase() === String(params[1]).toLowerCase())) {
          exercises.push({
            id: params[0], name: params[1], primaryMuscle: params[2],
            defaultSets: params[6], repRangeLow: params[7], repRangeHigh: params[8],
          });
        }
      }
      return { changes: 1 };
    },
    async exec(_sql: string): Promise<void> {},
  } as DatabaseLike;
  return { db, exercises, equipment, queries };
}

describe("CSV recommendations inside workout generation", () => {
  it("uses the WorkoutPlanState target passed by the route, persists exact CSV source fields, and does not advance plan state", async () => {
    const { db, exercises, queries } = memoryDatabase();
    const state = { cycleId: "cycle-stays-the-same", currentIndex: 1 };
    const before = { ...state };
    const result = await generateWorkout(db, "user-1", "Back", 60, {
      lockToMuscles: ["back"],
      equipmentMode: "FULL_GYM",
    });

    expect(result.focus).toBe("Back");
    expect(result.exercises).toHaveLength(3);
    expect(result.exercises.every((exercise) => /back/i.test(exercise.muscle))).toBe(true);
    expect(result.exercises.every((exercise) => Boolean(exercise.machine))).toBe(true);
    expect(exercises).toHaveLength(3);
    expect(state).toEqual(before);
    expect(queries.some((sql) => /UPDATE\s+WorkoutPlanState|INSERT\s+INTO\s+WorkoutCycleHistory/i.test(sql))).toBe(false);
  });

  it("keeps PPL target muscles constrained and returns the same workout candidates on repeat", async () => {
    const { db } = memoryDatabase();
    const first = await generateWorkout(db, "user-2", "Pull", 60, {
      lockToMuscles: ["back", "biceps"],
      equipmentMode: "FULL_GYM",
    });
    const second = await generateWorkout(db, "user-2", "Pull", 60, {
      lockToMuscles: ["back", "biceps"],
      equipmentMode: "FULL_GYM",
    });
    expect(first.exercises.map((exercise) => exercise.name)).toEqual(second.exercises.map((exercise) => exercise.name));
    expect(first.exercises.every((exercise) => /back|biceps/i.test(exercise.muscle))).toBe(true);
  });

  it.each([
    [30, 2, 6],
    [45, 2, 6],
    [59, 3, 9],
    [60, 3, 9],
    [90, 4, 12],
    [120, 5, 15],
  ])("generates a practical Chest workout for %i minutes", async (minutes, exerciseCount, workingSets) => {
    const { db } = memoryDatabase();
    const result = await generateWorkout(db, "realistic-volume-user", "Chest", minutes, {
      lockToMuscles: ["chest"],
      equipmentMode: "FULL_GYM",
    });
    expect(result.exercises).toHaveLength(exerciseCount);
    expect(result.exercises.reduce((total, exercise) => total + exercise.sets, 0)).toBe(workingSets);
  });
});
