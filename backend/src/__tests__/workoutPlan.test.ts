import { describe, expect, it } from "vitest";
import {
  canSwitchPlan,
  canSwitchWorkoutPlan,
  completedUnits,
  completeWorkout,
  definitionFor,
  deriveProgressionPhase,
  nextUnit,
  PLAN_DEFINITIONS,
  PLAN_LABELS,
  remainingUnits,
  serializePlanSnapshot,
  switchWorkoutPlan,
  startNewWorkoutCycle,
  completeWorkoutUnit,
  listAvailableStructures,
  getNextRequiredWorkout,
  getTodayWorkoutDecision,
  buildCycleId,
  normalizeCustomUnits,
} from "../modules/workouts/plan";
import { resolveMusclesForLockedUnit } from "../modules/workouts/workoutGenerator";
import type { PlanState, WorkoutUnit } from "../modules/workouts/plan";

interface DatabaseLike {
  all<T>(sql: string, ...params: unknown[]): Promise<T[]>;
  get<T>(sql: string, ...params: unknown[]): Promise<T | undefined>;
  run(sql: string, ...params: unknown[]): Promise<{ changes: number }>;
  exec(sql: string): Promise<void>;
}

function makeState(partial: Partial<PlanState> & { userId: string; structureKey: string; cycleId: string; units: WorkoutUnit[] }): PlanState {
  return {
    id: "state_id",
    cycleStatus: "IN_PROGRESS",
    currentIndex: 0,
    activeWorkoutId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    completedAt: null,
    ...partial,
  };
}

class InMemoryDb implements DatabaseLike {
  rows: any[] = [];
  async all<T>(sql: string, ...params: unknown[]): Promise<T[]> {
    if (
      sql.includes("WorkoutHistory") ||
      sql.includes("UserEquipment") ||
      sql.includes("FROM Exercise") ||
      sql.includes("FROM Workout WHERE")
    ) {
      return [] as T[];
    }
    return this.rows as T[];
  }
  async get<T>(sql: string, ...params: unknown[]): Promise<T | undefined> {
    return this.rows[0] as T | undefined;
  }
  async run(sql: string, ...params: unknown[]): Promise<{ changes: number }> {
    if (sql.includes("INSERT INTO WorkoutCycleHistory")) {
      return { changes: 1 };
    }
    if (sql.includes("INSERT INTO WorkoutPlanState")) {
      this.rows = [{
        id: params[0],
        userId: params[1],
        structureKey: params[2],
        cycleId: params[3],
        cycleStatus: "IN_PROGRESS",
        currentIndex: 0,
        unitsJson: params[4],
        activeWorkoutId: null,
        createdAt: params[5],
        completedAt: null,
      }];
      return { changes: 1 };
    }
    if (sql.includes("UPDATE WorkoutPlanState")) {
      if (!this.rows[0]) return { changes: 0 };
      if (sql.includes("currentIndex = ?") && sql.includes("unitsJson = ?") && sql.includes("cycleStatus = ?")) {
        this.rows[0].currentIndex = params[0];
        this.rows[0].unitsJson = params[1];
        this.rows[0].activeWorkoutId = null;
        this.rows[0].cycleStatus = params[2];
        this.rows[0].completedAt = params[3];
      } else if (sql.includes("cycleId = ?") && sql.includes("currentIndex = 0")) {
        this.rows[0].id = params[0];
        this.rows[0].cycleId = params[1];
        this.rows[0].cycleStatus = "IN_PROGRESS";
        this.rows[0].currentIndex = 0;
        this.rows[0].unitsJson = params[2];
        this.rows[0].activeWorkoutId = null;
        this.rows[0].createdAt = params[3];
        this.rows[0].completedAt = null;
      }
    }
    return { changes: 1 };
  }
  async exec(sql: string): Promise<void> {}
}

describe("workout plan progression state machine", () => {
  describe("plan definitions", () => {
    it("defines PPL cycle in correct order", () => {
      const units = definitionFor("PPL")!;
      expect(units.map((unit) => unit.label)).toEqual(["Push", "Pull", "Legs"]);
      expect(units.every((u) => u.status === "PENDING")).toBe(true);
      expect(PLAN_DEFINITIONS.PPL[0].muscles).toContain("chest");
      expect(PLAN_DEFINITIONS.PPL[1].muscles).toContain("back");
      expect(PLAN_DEFINITIONS.PPL[2].muscles).toContain("quads");
    });

    it("defines INDIVIDUAL muscle cycle in order", () => {
      expect(definitionFor("INDIVIDUAL")!.map((u) => u.label)).toEqual([
        "Chest", "Back", "Biceps", "Triceps", "Shoulders", "Legs",
      ]);
    });

    it("defines BRO / multi-muscle split cycle", () => {
      expect(definitionFor("BRO")!.map((u) => u.label)).toEqual([
        "Chest + Triceps", "Back + Biceps", "Legs + Shoulders",
      ]);
    });

    it("exposes labels and structure listing", () => {
      const structures = listAvailableStructures();
      expect(structures.map((s) => s.key)).toEqual(["PPL", "INDIVIDUAL", "BRO", "UPPER_LOWER", "FULL_BODY"]);
      expect(structures.map((s) => s.label)).toEqual([
        PLAN_LABELS.PPL, PLAN_LABELS.INDIVIDUAL, PLAN_LABELS.BRO, PLAN_LABELS.UPPER_LOWER, PLAN_LABELS.FULL_BODY,
      ]);
    });
  });

  describe("Scenario A: PPL full cycle → unlocked", () => {
    const buildPplState = (index: number, status: "IN_PROGRESS" | "COMPLETED" = "IN_PROGRESS") => {
      const units = definitionFor("PPL")!.map((u, i) => ({
        ...u,
        status: (i < index ? "COMPLETED" : "PENDING") as "COMPLETED" | "PENDING",
      }));
      return makeState({
        userId: "u_A",
        structureKey: "PPL",
        cycleId: "cycle_A",
        currentIndex: index,
        cycleStatus: status,
        units,
        completedAt: status === "COMPLETED" ? "2026-01-02T00:00:00.000Z" : null,
      });
    };

    it("after push complete → next is Pull, remaining = Pull,Legs, switch LOCKED", () => {
      const s = buildPplState(1);
      expect(nextUnit(s)?.label).toBe("Pull");
      expect(remainingUnits(s).map((u) => u.label)).toEqual(["Pull", "Legs"]);
      expect(completedUnits(s).map((u) => u.label)).toEqual(["Push"]);
      expect(canSwitchPlan(s)).toBe(false);
    });

    it("after pull complete → next is Legs, remaining = Legs, switch LOCKED", () => {
      const s = buildPplState(2);
      expect(nextUnit(s)?.label).toBe("Legs");
      expect(remainingUnits(s).map((u) => u.label)).toEqual(["Legs"]);
      expect(canSwitchPlan(s)).toBe(false);
    });

    it("after legs complete → cycle COMPLETED, next is null, switch UNLOCKED", () => {
      const s = buildPplState(3, "COMPLETED");
      expect(nextUnit(s)).toBeUndefined();
      expect(remainingUnits(s).map((u) => u.label)).toEqual([]);
      expect(completedUnits(s).map((u) => u.label)).toEqual(["Push", "Pull", "Legs"]);
      expect(canSwitchPlan(s)).toBe(true);
    });
  });

  describe("Scenario B: PPL incomplete — correct distinction", () => {
    it("Push completed, Pull + Legs pending → Pull is NEXT, both are REMAINING, switching LOCKED", () => {
      const units = definitionFor("PPL")!;
      units[0].status = "COMPLETED";
      const state = makeState({
        userId: "u_B",
        structureKey: "PPL",
        cycleId: "cycle_B",
        currentIndex: 1,
        units,
      });

      const remaining = remainingUnits(state);
      const next = nextUnit(state);

      expect(remaining.map((u) => u.label)).toEqual(["Pull", "Legs"]);
      expect(remaining.length).toBe(2);
      expect(next?.label).toBe("Pull");
      expect(next?.label).not.toBe("Legs");
      expect(canSwitchPlan(state)).toBe(false);
    });

    it("does NOT report Pull as the only remaining when Push done", () => {
      const units = definitionFor("PPL")!;
      units[0].status = "COMPLETED";
      const state = makeState({
        userId: "u_B2",
        structureKey: "PPL",
        cycleId: "cycle_B2",
        currentIndex: 1,
        units,
      });

      const remainingLabels = remainingUnits(state).map((u) => u.label);
      expect(remainingLabels).toContain("Pull");
      expect(remainingLabels).toContain("Legs");
      expect(remainingLabels.length).toBe(2);
    });
  });

  describe("Scenario C: Individual muscles full cycle", () => {
    const buildIndividualState = (index: number, status: "IN_PROGRESS" | "COMPLETED" = "IN_PROGRESS") => {
      const units = definitionFor("INDIVIDUAL")!.map((u, i) => ({
        ...u,
        status: (i < index ? "COMPLETED" : "PENDING") as "COMPLETED" | "PENDING",
      }));
      return makeState({
        userId: "u_C",
        structureKey: "INDIVIDUAL",
        cycleId: "cycle_C",
        currentIndex: index,
        cycleStatus: status,
        units,
        completedAt: status === "COMPLETED" ? "2026-01-06T00:00:00.000Z" : null,
      });
    };

    it("Chest complete → next Back, switch LOCKED", () => {
      const s = buildIndividualState(1);
      expect(nextUnit(s)?.label).toBe("Back");
      expect(completedUnits(s).map((u) => u.label)).toEqual(["Chest"]);
      expect(canSwitchPlan(s)).toBe(false);
    });

    it("Back + Biceps complete → next Triceps, switch LOCKED", () => {
      const s = buildIndividualState(3);
      expect(nextUnit(s)?.label).toBe("Triceps");
      expect(completedUnits(s).map((u) => u.label)).toEqual(["Chest", "Back", "Biceps"]);
      expect(canSwitchPlan(s)).toBe(false);
    });

    it("Shoulders complete → next Legs, switch LOCKED", () => {
      const s = buildIndividualState(5);
      expect(nextUnit(s)?.label).toBe("Legs");
      expect(canSwitchPlan(s)).toBe(false);
    });

    it("All 6 complete → cycle COMPLETED, switch UNLOCKED", () => {
      const s = buildIndividualState(6, "COMPLETED");
      expect(nextUnit(s)).toBeUndefined();
      expect(completedUnits(s).map((u) => u.label)).toEqual([
        "Chest", "Back", "Biceps", "Triceps", "Shoulders", "Legs",
      ]);
      expect(canSwitchPlan(s)).toBe(true);
    });
  });

  describe("Scenario D: Attempted early switch → REJECT", () => {
    it("switchWorkoutPlan rejects when current cycle is IN_PROGRESS", async () => {
      const individualUnits = definitionFor("INDIVIDUAL")!.map((u, i) => ({
        ...u,
        status: i === 0 ? "COMPLETED" : "PENDING",
      })) as WorkoutUnit[];
      const db = new InMemoryDb();
      db.rows = [{
        id: "sid",
        userId: "u_D",
        structureKey: "INDIVIDUAL",
        cycleId: "cycle_D",
        cycleStatus: "IN_PROGRESS",
        currentIndex: 1,
        unitsJson: JSON.stringify(individualUnits),
        activeWorkoutId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        completedAt: null,
      }];

      const result = await switchWorkoutPlan(db, "u_D", "PPL", "2026-01-01T12:00:00.000Z");
      expect("error" in result).toBe(true);
      if ("error" in result) {
        expect(result.error).toMatch(/complete.*cycle/i);
      }
    });

    it("canSwitchPlan is only false when status IN_PROGRESS", () => {
      expect(canSwitchPlan(undefined)).toBe(true);
      expect(canSwitchPlan(makeState({
        userId: "u", structureKey: "PPL", cycleId: "c",
        units: definitionFor("PPL")!, cycleStatus: "IN_PROGRESS",
      }))).toBe(false);
      expect(canSwitchPlan(makeState({
        userId: "u", structureKey: "PPL", cycleId: "c",
        units: definitionFor("PPL")!, cycleStatus: "COMPLETED",
      }))).toBe(true);
    });
  });

  describe("Scenario E: Multi-muscle / Bro split", () => {
    const buildBroState = (index: number, status: "IN_PROGRESS" | "COMPLETED" = "IN_PROGRESS") => {
      const units = definitionFor("BRO")!.map((u, i) => ({
        ...u,
        status: (i < index ? "COMPLETED" : "PENDING") as "COMPLETED" | "PENDING",
      }));
      return makeState({
        userId: "u_E",
        structureKey: "BRO",
        cycleId: "cycle_E",
        currentIndex: index,
        cycleStatus: status,
        units,
        completedAt: status === "COMPLETED" ? "2026-01-03T00:00:00.000Z" : null,
      });
    };

    it("Chest+Triceps complete → next Back+Biceps, switch LOCKED", () => {
      const s = buildBroState(1);
      expect(nextUnit(s)?.label).toBe("Back + Biceps");
      expect(nextUnit(s)?.muscles).toEqual(["back", "biceps"]);
      expect(remainingUnits(s).map((u) => u.label)).toEqual(["Back + Biceps", "Legs + Shoulders"]);
      expect(canSwitchPlan(s)).toBe(false);
    });

    it("Back+Biceps complete → next Legs+Shoulders, switch LOCKED", () => {
      const s = buildBroState(2);
      expect(nextUnit(s)?.label).toBe("Legs + Shoulders");
      expect(canSwitchPlan(s)).toBe(false);
    });

    it("Legs+Shoulders complete → cycle COMPLETED, switch UNLOCKED", () => {
      const s = buildBroState(3, "COMPLETED");
      expect(nextUnit(s)).toBeUndefined();
      expect(completedUnits(s).map((u) => u.label)).toEqual([
        "Chest + Triceps", "Back + Biceps", "Legs + Shoulders",
      ]);
      expect(canSwitchPlan(s)).toBe(true);
    });

    it("does not allow switching after Chest+Triceps only", async () => {
      const broUnits = definitionFor("BRO")!.map((u, i) => ({
        ...u,
        status: i === 0 ? "COMPLETED" : "PENDING",
      })) as WorkoutUnit[];
      const db = new InMemoryDb();
      db.rows = [{
        id: "sid",
        userId: "u_Early",
        structureKey: "BRO",
        cycleId: "cycle_early",
        cycleStatus: "IN_PROGRESS",
        currentIndex: 1,
        unitsJson: JSON.stringify(broUnits),
        activeWorkoutId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        completedAt: null,
      }];

      const attemptPpl = await switchWorkoutPlan(db, "u_Early", "PPL", "2026-01-01T12:00:00.000Z");
      expect("error" in attemptPpl).toBe(true);

      const attemptIndividual = await switchWorkoutPlan(db, "u_Early", "INDIVIDUAL", "2026-01-01T12:00:00.000Z");
      expect("error" in attemptIndividual).toBe(true);
    });
  });

  describe("completeWorkoutUnit advances state deterministically", () => {
    it("advances PPL through Push → Pull → Legs → cycle complete", async () => {
      const db = new InMemoryDb();
      const initialUnits = definitionFor("PPL")!;
      db.rows = [{
        id: "sid",
        userId: "u_step",
        structureKey: "PPL",
        cycleId: "cycle_step",
        cycleStatus: "IN_PROGRESS",
        currentIndex: 0,
        unitsJson: JSON.stringify(initialUnits),
        activeWorkoutId: "w_push",
        createdAt: "2026-01-01T00:00:00.000Z",
        completedAt: null,
      }];

      const r1 = await completeWorkoutUnit(db, "u_step", "w_push", "2026-01-01T12:00:00.000Z");
      expect(r1.cycleStatus).toBe("IN_PROGRESS");
      expect(r1.nextUnit?.label).toBe("Pull");
      expect(r1.planSwitchAllowed).toBe(false);
      expect(r1.cycleCompleted).toBe(false);
      expect(db.rows[0].currentIndex).toBe(1);

      db.rows[0].activeWorkoutId = "w_pull";
      const r2 = await completeWorkoutUnit(db, "u_step", "w_pull", "2026-01-02T12:00:00.000Z");
      expect(r2.cycleStatus).toBe("IN_PROGRESS");
      expect(r2.nextUnit?.label).toBe("Legs");
      expect(r2.planSwitchAllowed).toBe(false);
      expect(r2.cycleCompleted).toBe(false);
      expect(db.rows[0].currentIndex).toBe(2);

      db.rows[0].activeWorkoutId = "w_legs";
      const r3 = await completeWorkoutUnit(db, "u_step", "w_legs", "2026-01-03T12:00:00.000Z");
      expect(r3.cycleStatus).toBe("COMPLETED");
      expect(r3.nextUnit).toBeNull();
      expect(r3.planSwitchAllowed).toBe(true);
      expect(r3.cycleCompleted).toBe(true);
      expect(db.rows[0].currentIndex).toBe(3);
    });

    it("rejects completion when workout id does not match activeWorkoutId", async () => {
      const db = new InMemoryDb();
      db.rows = [{
        id: "sid",
        userId: "u_mismatch",
        structureKey: "PPL",
        cycleId: "cycle_m",
        cycleStatus: "IN_PROGRESS",
        currentIndex: 0,
        unitsJson: JSON.stringify(definitionFor("PPL")!),
        activeWorkoutId: "w_correct",
        createdAt: "2026-01-01T00:00:00.000Z",
        completedAt: null,
      }];

      await expect(
        completeWorkoutUnit(db, "u_mismatch", "w_WRONG", "2026-01-01T12:00:00.000Z")
      ).rejects.toThrow(/not the currently active/);
    });
  });

  describe("startNewWorkoutCycle restarts completed cycle", () => {
    it("requires cycle to be COMPLETED first", async () => {
      const db = new InMemoryDb();
      db.rows = [{
        id: "sid",
        userId: "u_restart",
        structureKey: "PPL",
        cycleId: "cycle_old",
        cycleStatus: "IN_PROGRESS",
        currentIndex: 1,
        unitsJson: JSON.stringify(definitionFor("PPL")!),
        activeWorkoutId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        completedAt: null,
      }];

      const result = await startNewWorkoutCycle(db, "u_restart", "2026-01-04T00:00:00.000Z");
      expect("error" in result).toBe(true);
    });

    it("preserves a custom Bro split when starting a new cycle", async () => {
      const custom = [
        { key: "chest-shoulders", label: "Chest + Shoulders", muscles: ["chest", "shoulders"], status: "COMPLETED" as const },
        { key: "back-hamstrings", label: "Back + Hamstrings", muscles: ["back", "hamstrings"], status: "COMPLETED" as const },
      ];
      const db = new InMemoryDb();
      db.rows = [{
        id: "sid",
        userId: "u_custom_cycle",
        structureKey: "BRO",
        cycleId: "cycle_custom_done",
        cycleStatus: "COMPLETED",
        currentIndex: 2,
        unitsJson: JSON.stringify(custom),
        activeWorkoutId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        completedAt: "2026-01-03T00:00:00.000Z",
      }];
      const result = await startNewWorkoutCycle(db, "u_custom_cycle", "2026-01-04T00:00:00.000Z");
      expect("error" in result).toBe(false);
      if (!("error" in result)) {
        expect(result.units.map((unit) => unit.label)).toEqual(["Chest + Shoulders", "Back + Hamstrings"]);
        expect(result.units.every((unit) => unit.status === "PENDING")).toBe(true);
      }
    });

    it("starts a new cycle once COMPLETED and resets the state", async () => {
      const doneUnits = definitionFor("PPL")!.map((u) => ({ ...u, status: "COMPLETED" as const }));
      const db = new InMemoryDb();
      db.rows = [{
        id: "sid",
        userId: "u_restart_ok",
        structureKey: "PPL",
        cycleId: "cycle_done",
        cycleStatus: "COMPLETED",
        currentIndex: 3,
        unitsJson: JSON.stringify(doneUnits),
        activeWorkoutId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        completedAt: "2026-01-03T00:00:00.000Z",
      }];

      const result = await startNewWorkoutCycle(db, "u_restart_ok", "2026-01-04T00:00:00.000Z");
      expect("error" in result).toBe(false);
      if (!("error" in result)) {
        expect(result.structureKey).toBe("PPL");
        expect(result.cycleId).not.toBe("cycle_done");
        expect(result.cycleStatus).toBe("IN_PROGRESS");
        expect(result.currentIndex).toBe(0);
        expect(result.units.every((u) => u.status === "PENDING")).toBe(true);
        expect(result.units.map((u) => u.label)).toEqual(["Push", "Pull", "Legs"]);
      }
    });
  });

  describe("switchWorkoutPlan only when UNLOCKED", () => {
    it("allows switching a brand-new user (no prior state)", async () => {
      const db = new InMemoryDb();
      db.rows = [];
      const result = await switchWorkoutPlan(db, "u_new", "BRO", "2026-01-01T00:00:00.000Z");
      expect("error" in result).toBe(false);
      if (!("error" in result)) {
        expect(result.structureKey).toBe("BRO");
        expect(result.currentIndex).toBe(0);
        expect(result.cycleStatus).toBe("IN_PROGRESS");
        expect(result.cycleId.startsWith("cycle_")).toBe(true);
      }
    });

    it("allows switching once cycle is COMPLETED", async () => {
      const doneUnits = definitionFor("PPL")!.map((u) => ({ ...u, status: "COMPLETED" as const }));
      const db = new InMemoryDb();
      db.rows = [{
        id: "sid",
        userId: "u_switch",
        structureKey: "PPL",
        cycleId: "cycle_done",
        cycleStatus: "COMPLETED",
        currentIndex: 3,
        unitsJson: JSON.stringify(doneUnits),
        activeWorkoutId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        completedAt: "2026-01-03T00:00:00.000Z",
      }];

      const result = await switchWorkoutPlan(db, "u_switch", "INDIVIDUAL", "2026-01-04T00:00:00.000Z");
      expect("error" in result).toBe(false);
      if (!("error" in result)) {
        expect(result.structureKey).toBe("INDIVIDUAL");
        expect(result.units.map((u) => u.label)).toEqual([
          "Chest", "Back", "Biceps", "Triceps", "Shoulders", "Legs",
        ]);
        expect(result.currentIndex).toBe(0);
        expect(result.cycleStatus).toBe("IN_PROGRESS");
      }
    });
  });

  describe("helpers buildCycleId and todays decision", () => {
    it("buildCycleId produces prefixed ids", () => {
      const id = buildCycleId();
      expect(id.startsWith("cycle_")).toBe(true);
      expect(id.length).toBeGreaterThan("cycle_".length);
    });

    it("getTodayWorkoutDecision reports NOT_STARTED for no state", async () => {
      const db = new InMemoryDb();
      db.rows = [];
      const decision = await getTodayWorkoutDecision(db, "u_none");
      expect(decision.cycleStatus).toBe("NOT_STARTED");
      expect(decision.planSwitchAllowed).toBe(true);
      expect(decision.nextUnit).toBeNull();
      expect(decision.targetMuscles).toEqual([]);
    });

    it("getNextRequiredWorkout reports error when no plan", async () => {
      const db = new InMemoryDb();
      db.rows = [];
      const next = await getNextRequiredWorkout(db, "u_none");
      expect(next && "error" in next ? next.error : undefined).toBeTruthy();
    });
  });

  describe("state snapshot, machine phase, and aliases", () => {
    it("serializePlanSnapshot distinguishes remaining vs next vs switch lock", () => {
      const units = definitionFor("PPL")!.map((unit, index) => ({
        ...unit,
        status: (index === 0 ? "COMPLETED" : "PENDING") as "COMPLETED" | "PENDING",
      }));
      const state = makeState({
        userId: "u_snap",
        structureKey: "PPL",
        cycleId: "cycle_001",
        currentIndex: 1,
        units,
      });
      const snapshot = serializePlanSnapshot(state);
      expect(snapshot.activePlan).toBe("PPL");
      expect(snapshot.cycleStatus).toBe("IN_PROGRESS");
      expect(snapshot.nextWorkout).toBe("Pull");
      expect(snapshot.remainingWorkouts).toEqual(["Pull", "Legs"]);
      expect(snapshot.planSwitchAllowed).toBe(false);
      expect(snapshot.workoutUnits.map((unit) => unit.name)).toEqual(["Push", "Pull", "Legs"]);
      expect(deriveProgressionPhase(state)).toBe("WORKOUT_UNIT_PENDING");
    });

    it("canSwitchWorkoutPlan is false while a cycle is in progress", async () => {
      const db = new InMemoryDb();
      db.rows = [{
        id: "sid",
        userId: "u_lock",
        structureKey: "PPL",
        cycleId: "cycle_lock",
        cycleStatus: "IN_PROGRESS",
        currentIndex: 0,
        unitsJson: JSON.stringify(definitionFor("PPL")!),
        activeWorkoutId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        completedAt: null,
      }];
      expect(await canSwitchWorkoutPlan(db, "u_lock")).toBe(false);
    });

    it("completeWorkout advances the same way as completeWorkoutUnit", async () => {
      const db = new InMemoryDb();
      db.rows = [{
        id: "sid",
        userId: "u_alias",
        structureKey: "PPL",
        cycleId: "cycle_alias",
        cycleStatus: "IN_PROGRESS",
        currentIndex: 0,
        unitsJson: JSON.stringify(definitionFor("PPL")!),
        activeWorkoutId: "w1",
        createdAt: "2026-01-01T00:00:00.000Z",
        completedAt: null,
      }];
      const result = await completeWorkout(db, "u_alias", { workoutId: "w1" }, "2026-01-01T12:00:00.000Z");
      expect(result.nextUnit?.label).toBe("Pull");
      expect(result.planSwitchAllowed).toBe(false);
    });
  });

  describe("custom Bro split units", () => {
    it("normalizes user-configured combinations", () => {
      const units = normalizeCustomUnits([
        { label: "Chest + Shoulders", muscles: ["chest", "shoulders"] },
        { label: "Back + Hamstrings", muscles: ["back", "hamstrings"] },
      ]);
      expect("error" in units).toBe(false);
      if (!("error" in units)) {
        expect(units.map((unit) => unit.label)).toEqual(["Chest + Shoulders", "Back + Hamstrings"]);
      }
    });

    it("rejects unknown muscles", () => {
      const units = normalizeCustomUnits([
        { label: "Alien day", muscles: ["chest", "wings"] },
        { label: "Legs", muscles: ["quads"] },
      ]);
      expect("error" in units).toBe(true);
    });
  });

  describe("Scenario F: exercise recommendation after workout-unit selection", () => {
    it("never lets recovery swap in muscles from a different workout unit", () => {
      const legs = ["quads", "hamstrings", "glutes", "calves"];
      const resolved = resolveMusclesForLockedUnit(legs, ["chest", "back"]);
      expect(resolved.every((muscle) => legs.includes(muscle))).toBe(true);
      expect(resolved).not.toContain("chest");
      expect(resolved).not.toContain("back");
    });

    it("keeps the locked unit even when every target muscle was trained recently", () => {
      const push = ["chest", "shoulders", "triceps"];
      const resolved = resolveMusclesForLockedUnit(push, push);
      expect(resolved).toEqual(push);
    });

    it("today's options are only the next required unit, not remaining alternatives", async () => {
      const units = definitionFor("PPL")!.map((unit, index) => ({
        ...unit,
        status: (index === 0 ? "COMPLETED" : "PENDING") as "COMPLETED" | "PENDING",
      }));
      const db = new InMemoryDb();
      db.rows = [{
        id: "sid",
        userId: "u_f",
        structureKey: "PPL",
        cycleId: "cycle_f",
        cycleStatus: "IN_PROGRESS",
        currentIndex: 1,
        unitsJson: JSON.stringify(units),
        activeWorkoutId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        completedAt: null,
      }];
      const decision = await getTodayWorkoutDecision(db, "u_f");
      expect(decision.nextUnit?.label).toBe("Pull");
      expect(decision.remainingUnits.map((unit) => unit.label)).toEqual(["Pull", "Legs"]);
      expect(decision.todayOptions.map((unit) => unit.label)).toEqual(["Pull"]);
      expect(decision.blockedAlternatives.map((unit) => unit.label)).toContain("Push");
      expect(decision.blockedAlternatives.map((unit) => unit.label)).toContain("Legs");
      expect(decision.planSwitchAllowed).toBe(false);
    });
  });
});
