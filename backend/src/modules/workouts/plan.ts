import type { DatabaseLike } from "../../db/types";
import { v4 as uuidv4 } from "uuid";

export interface WorkoutUnit {
  key: string;
  label: string;
  muscles: string[];
  status: "PENDING" | "COMPLETED";
  completedAt?: string;
}

export interface PlanState {
  id: string;
  userId: string;
  structureKey: string;
  cycleId: string;
  cycleStatus: "IN_PROGRESS" | "COMPLETED";
  currentIndex: number;
  units: WorkoutUnit[];
  activeWorkoutId: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface CompletedWorkoutUnit {
  name: string;
  completedAt: string;
  muscles: string[];
}

export interface CycleHistoryEntry {
  cycleId: string;
  structureKey: string;
  startedAt: string;
  completedAt: string;
  units: WorkoutUnit[];
}

export const PLAN_DEFINITIONS: Record<string, WorkoutUnit[]> = {
  PPL: [
    { key: "push", label: "Push", muscles: ["chest", "shoulders", "triceps"], status: "PENDING" },
    { key: "pull", label: "Pull", muscles: ["back", "biceps"], status: "PENDING" },
    { key: "legs", label: "Legs", muscles: ["quads", "hamstrings", "glutes", "calves"], status: "PENDING" },
  ],
  INDIVIDUAL: [
    { key: "chest", label: "Chest", muscles: ["chest"], status: "PENDING" },
    { key: "back", label: "Back", muscles: ["back"], status: "PENDING" },
    { key: "biceps", label: "Biceps", muscles: ["biceps"], status: "PENDING" },
    { key: "triceps", label: "Triceps", muscles: ["triceps"], status: "PENDING" },
    { key: "shoulders", label: "Shoulders", muscles: ["shoulders"], status: "PENDING" },
    { key: "legs", label: "Legs", muscles: ["quads", "hamstrings", "glutes", "calves"], status: "PENDING" },
  ],
  BRO: [
    { key: "chest-triceps", label: "Chest + Triceps", muscles: ["chest", "triceps"], status: "PENDING" },
    { key: "back-biceps", label: "Back + Biceps", muscles: ["back", "biceps"], status: "PENDING" },
    { key: "legs-shoulders", label: "Legs + Shoulders", muscles: ["quads", "hamstrings", "glutes", "calves", "shoulders"], status: "PENDING" },
  ],
  UPPER_LOWER: [
    { key: "upper", label: "Upper Body", muscles: ["chest", "back", "shoulders", "biceps", "triceps"], status: "PENDING" },
    { key: "lower", label: "Lower Body", muscles: ["quads", "hamstrings", "glutes", "calves"], status: "PENDING" },
  ],
  FULL_BODY: [
    { key: "full-body-a", label: "Full Body A", muscles: ["chest", "back", "legs", "shoulders", "core"], status: "PENDING" },
    { key: "full-body-b", label: "Full Body B", muscles: ["chest", "back", "legs", "shoulders", "core"], status: "PENDING" },
    { key: "full-body-c", label: "Full Body C", muscles: ["chest", "back", "legs", "shoulders", "core"], status: "PENDING" },
  ],
};

export const PLAN_LABELS: Record<string, string> = {
  PPL: "Push-Pull-Legs",
  INDIVIDUAL: "Individual Muscle Split",
  BRO: "Bro / Multi-Muscle Split",
  UPPER_LOWER: "Upper/Lower Split",
  FULL_BODY: "Full Body",
};

export type StructureKey = keyof typeof PLAN_DEFINITIONS;

export const KNOWN_MUSCLES = [
  "chest", "back", "biceps", "triceps", "shoulders",
  "quads", "hamstrings", "glutes", "calves", "core",
] as const;

export type ProgressionPhase =
  | "NO_PLAN"
  | "PLAN_SELECTED"
  | "CYCLE_STARTED"
  | "WORKOUT_UNIT_PENDING"
  | "CYCLE_COMPLETED"
  | "PLAN_SWITCH_ALLOWED";

export function listAvailableStructures(): { key: StructureKey; label: string; unitCount: number; units: string[] }[] {
  return (Object.keys(PLAN_DEFINITIONS) as StructureKey[]).map((key) => ({
    key,
    label: PLAN_LABELS[key],
    unitCount: PLAN_DEFINITIONS[key].length,
    units: PLAN_DEFINITIONS[key].map((unit) => unit.label),
  }));
}

export function deriveProgressionPhase(state: PlanState | undefined): ProgressionPhase {
  if (!state) return "NO_PLAN";
  if (state.cycleStatus === "COMPLETED") return "PLAN_SWITCH_ALLOWED";
  const completedCount = state.units.filter((unit) => unit.status === "COMPLETED").length;
  if (completedCount === 0) return "CYCLE_STARTED";
  return "WORKOUT_UNIT_PENDING";
}

export function toNamedUnits(units: WorkoutUnit[]): Array<{ name: string; status: WorkoutUnit["status"]; key: string; muscles: string[] }> {
  return units.map((unit) => ({
    name: unit.label,
    status: unit.status,
    key: unit.key,
    muscles: unit.muscles,
  }));
}

export function serializePlanSnapshot(state: PlanState | undefined): {
  activePlan: string | null;
  cycleId: string | null;
  cycleStatus: "IN_PROGRESS" | "COMPLETED" | "NOT_STARTED";
  workoutUnits: Array<{ name: string; status: string }>;
  planSwitchAllowed: boolean;
  nextWorkout: string | null;
  remainingWorkouts: string[];
  machineState: ProgressionPhase;
} {
  if (!state) {
    return {
      activePlan: null,
      cycleId: null,
      cycleStatus: "NOT_STARTED",
      workoutUnits: [],
      planSwitchAllowed: true,
      nextWorkout: null,
      remainingWorkouts: [],
      machineState: "NO_PLAN",
    };
  }
  const next = nextUnit(state);
  return {
    activePlan: state.structureKey,
    cycleId: state.cycleId,
    cycleStatus: state.cycleStatus,
    workoutUnits: toNamedUnits(state.units).map(({ name, status }) => ({ name, status })),
    planSwitchAllowed: canSwitchPlan(state),
    nextWorkout: next?.label ?? null,
    remainingWorkouts: remainingUnits(state).map((unit) => unit.label),
    machineState: deriveProgressionPhase(state),
  };
}

function parseState(row: any): PlanState {
  const userId = row?.userId ?? "unknown";
  let units: WorkoutUnit[] = [];
  try {
    const unitsJson = row?.unitsJson;
    if (!unitsJson) {
      console.warn(`unitsJson is null/empty for user ${userId}, defaulting to empty array`);
    } else {
      const parsed = JSON.parse(unitsJson);
      if (Array.isArray(parsed)) {
        units = parsed as WorkoutUnit[];
      } else {
        console.error(`Invalid unitsJson format for user ${userId}: expected array, got ${typeof parsed}`);
      }
    }
  } catch (error) {
    console.error(`Failed to parse unitsJson for user ${userId}:`, error);
    console.error(`Raw unitsJson: ${row?.unitsJson}`);
  }
  return { ...row, units };
}

export async function getActiveWorkoutPlan(
  database: DatabaseLike,
  userId: string
): Promise<{ structureKey: string | null; cycleId: string | null; cycleStatus: string } | null> {
  const state = await getPlanState(database, userId);
  if (!state) return null;
  return {
    structureKey: state.structureKey,
    cycleId: state.cycleId,
    cycleStatus: state.cycleStatus,
  };
}

export async function getPlanState(database: DatabaseLike, userId: string): Promise<PlanState | undefined> {
  const row = await database.get(`SELECT * FROM WorkoutPlanState WHERE userId = ?`, userId);
  return row ? parseState(row) : undefined;
}

export async function getCurrentCycle(
  database: DatabaseLike,
  userId: string
): Promise<{ cycleId: string; structureKey: string; cycleStatus: "IN_PROGRESS" | "COMPLETED"; units: WorkoutUnit[] } | null> {
  const state = await getPlanState(database, userId);
  if (!state) return null;
  return {
    cycleId: state.cycleId,
    structureKey: state.structureKey,
    cycleStatus: state.cycleStatus,
    units: state.units,
  };
}

export function nextUnit(state: PlanState): WorkoutUnit | undefined {
  if (state.cycleStatus !== "IN_PROGRESS") return undefined;
  const pending = state.units.find((unit) => unit.status === "PENDING");
  if (pending) return pending;
  return state.units[state.currentIndex];
}

export function remainingUnits(state: PlanState): WorkoutUnit[] {
  if (state.cycleStatus === "COMPLETED") return [];
  const pending = state.units.filter((unit) => unit.status === "PENDING");
  if (pending.length > 0) return pending;
  return state.units.slice(state.currentIndex);
}

export function completedUnits(state: PlanState): WorkoutUnit[] {
  const done = state.units.filter((unit) => unit.status === "COMPLETED");
  if (done.length > 0) return done;
  return state.units.slice(0, state.currentIndex);
}

export function canSwitchPlan(state: PlanState | undefined): boolean {
  return !state || state.cycleStatus === "COMPLETED";
}

export async function canSwitchWorkoutPlan(database: DatabaseLike, userId: string): Promise<boolean> {
  const state = await getPlanState(database, userId);
  return canSwitchPlan(state);
}

export function definitionFor(structureKey: string): WorkoutUnit[] | undefined {
  const definition = PLAN_DEFINITIONS[structureKey];
  if (!definition) return undefined;
  return definition.map((unit) => ({
    ...unit,
    status: "PENDING" as const,
  }));
}

export function buildCycleId(): string {
  return `cycle_${uuidv4().slice(0, 8)}`;
}

export function normalizeCustomUnits(
  custom: Array<{ label: string; muscles: string[] }>
): WorkoutUnit[] | { error: string } {
  if (custom.length < 2) {
    return { error: "A custom split needs at least two workout units." };
  }
  const known = new Set<string>(KNOWN_MUSCLES);
  const units: WorkoutUnit[] = [];
  for (const raw of custom) {
    const label = raw.label.trim();
    const muscles = raw.muscles.map((muscle) => muscle.trim().toLowerCase()).filter(Boolean);
    if (!label || muscles.length === 0) {
      return { error: "Each custom workout unit needs a label and at least one muscle." };
    }
    const invalid = muscles.filter((muscle) => !known.has(muscle));
    if (invalid.length > 0) {
      return { error: `Unknown muscle(s): ${invalid.join(", ")}` };
    }
    units.push({
      key: muscles.join("-"),
      label,
      muscles,
      status: "PENDING",
    });
  }
  return units;
}

export async function switchWorkoutPlan(
  database: DatabaseLike,
  userId: string,
  newStructureKey: string,
  nowIso: string,
  customUnits?: Array<{ label: string; muscles: string[] }>
): Promise<PlanState | { error: string }> {
  const existing = await getPlanState(database, userId);

  if (!canSwitchPlan(existing)) {
    return {
      error: "Complete the active workout cycle before switching plans.",
      cycleStatus: existing?.cycleStatus,
      remainingWorkouts: existing ? remainingUnits(existing).map((unit) => unit.label) : [],
      planSwitchAllowed: false,
    } as { error: string };
  }

  let units = definitionFor(newStructureKey);
  if (!units) {
    return { error: `Unknown workout structure: ${newStructureKey}` };
  }

  if (customUnits && customUnits.length > 0) {
    if (newStructureKey !== "BRO") {
      return { error: "Custom workout units are only allowed for the Bro / Multi-Muscle Split." };
    }
    const normalized = normalizeCustomUnits(customUnits);
    if ("error" in normalized) return normalized;
    units = normalized;
  }

  const id = uuidv4();
  const cycleId = buildCycleId();

  await database.run(
    `INSERT INTO WorkoutPlanState (id, userId, structureKey, cycleId, cycleStatus, currentIndex, unitsJson, activeWorkoutId, createdAt, completedAt)
     VALUES (?, ?, ?, ?, 'IN_PROGRESS', 0, ?, NULL, ?, NULL)
     ON CONFLICT(userId) DO UPDATE SET
       id = excluded.id,
       structureKey = excluded.structureKey,
       cycleId = excluded.cycleId,
       cycleStatus = excluded.cycleStatus,
       currentIndex = excluded.currentIndex,
       unitsJson = excluded.unitsJson,
       activeWorkoutId = NULL,
       createdAt = excluded.createdAt,
       completedAt = NULL`,
    id, userId, newStructureKey, cycleId, JSON.stringify(units), nowIso
  );

  return (await getPlanState(database, userId))!;
}

export async function startNewWorkoutCycle(
  database: DatabaseLike,
  userId: string,
  nowIso: string
): Promise<PlanState | { error: string }> {
  const existing = await getPlanState(database, userId);

  if (!existing) {
    return { error: "No active workout plan found. Select a workout structure first." };
  }
  if (existing.cycleStatus !== "COMPLETED") {
    return { error: "Complete the current cycle before starting a new one." };
  }

  const units = existing.units.map((unit) => ({
    key: unit.key,
    label: unit.label,
    muscles: [...unit.muscles],
    status: "PENDING" as const,
  }));
  if (units.length === 0) {
    return { error: `Unknown workout structure: ${existing.structureKey}` };
  }

  const id = uuidv4();
  const cycleId = buildCycleId();

  await database.run(
    `UPDATE WorkoutPlanState SET
       id = ?,
       cycleId = ?,
       cycleStatus = 'IN_PROGRESS',
       currentIndex = 0,
       unitsJson = ?,
       activeWorkoutId = NULL,
       createdAt = ?,
       completedAt = NULL
     WHERE userId = ?`,
    id, cycleId, JSON.stringify(units), nowIso, userId
  );

  return (await getPlanState(database, userId))!;
}

export async function getCompletedWorkoutUnits(
  database: DatabaseLike,
  userId: string,
  cycleId: string
): Promise<WorkoutUnit[]> {
  const state = await getPlanState(database, userId);
  if (!state || state.cycleId !== cycleId) return [];
  return completedUnits(state);
}

export async function getRemainingWorkoutUnits(
  database: DatabaseLike,
  userId: string,
  cycleId: string
): Promise<WorkoutUnit[]> {
  const state = await getPlanState(database, userId);
  if (!state || state.cycleId !== cycleId) return [];
  return remainingUnits(state);
}

export async function getNextRequiredWorkout(
  database: DatabaseLike,
  userId: string
): Promise<WorkoutUnit | { error: string } | null> {
  const state = await getPlanState(database, userId);
  if (!state) return { error: "No active workout plan. Select a structure first." };
  if (state.cycleStatus === "COMPLETED") return null;
  const unit = nextUnit(state);
  return unit ?? null;
}

export async function getWorkoutHistory(
  database: DatabaseLike,
  userId: string,
  limit: number = 20
): Promise<Array<{ id: string; focus: string; status: string; createdAt: string; completedAt: string | null }>> {
  const rows = await database.all<any>(
    `SELECT id, focus, status, createdAt, completedAt FROM Workout WHERE userId = ? ORDER BY createdAt DESC LIMIT ?`,
    userId, limit
  );
  return rows.map((row) => ({
    id: row.id,
    focus: row.focus,
    status: row.status,
    createdAt: row.createdAt,
    completedAt: row.completedAt ?? null,
  }));
}

function startOfRecoveryWindow(): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - 2);
  date.setUTCHours(0, 0, 0, 0);
  return date.toISOString();
}

export async function getRecentlyTrainedMuscles(
  database: DatabaseLike,
  userId: string
): Promise<Array<{ muscle: string; lastTrainedAt: string }>> {
  const rows = await database.all<{ muscle: string; lastTrainedAt: string }>(
    `SELECT e.primaryMuscle as muscle, MAX(h.recordedAt) as lastTrainedAt
     FROM WorkoutHistory h
     JOIN Exercise e ON e.id = h.exerciseId
     WHERE h.userId = ? AND h.recordedAt >= ?
     GROUP BY e.primaryMuscle
     ORDER BY lastTrainedAt DESC`,
    userId, startOfRecoveryWindow()
  );
  return rows;
}

export interface TodayWorkoutDecision {
  nextUnit: WorkoutUnit | null;
  targetMuscles: string[];
  recentlyTrainedMuscles: Array<{ muscle: string; lastTrainedAt: string }>;
  remainingUnits: WorkoutUnit[];
  completedUnits: WorkoutUnit[];
  cycleStatus: "IN_PROGRESS" | "COMPLETED" | "NOT_STARTED";
  planSwitchAllowed: boolean;
  machineState: ProgressionPhase;
  history: Array<{ id: string; focus: string; status: string; createdAt: string; completedAt: string | null }>;
  todayOptions: WorkoutUnit[];
  blockedAlternatives: WorkoutUnit[];
  warning?: string;
}

export async function getTodayWorkoutDecision(
  database: DatabaseLike,
  userId: string
): Promise<TodayWorkoutDecision> {
  const history = await getWorkoutHistory(database, userId, 20);
  const state = await getPlanState(database, userId);
  const recentlyTrained = await getRecentlyTrainedMuscles(database, userId);

  if (!state) {
    return {
      nextUnit: null,
      targetMuscles: [],
      recentlyTrainedMuscles: recentlyTrained,
      remainingUnits: [],
      completedUnits: [],
      cycleStatus: "NOT_STARTED",
      planSwitchAllowed: true,
      machineState: "NO_PLAN",
      history,
      todayOptions: [],
      blockedAlternatives: [],
    };
  }

  const next = nextUnit(state);
  const remaining = remainingUnits(state);
  const completed = completedUnits(state);
  const switchAllowed = canSwitchPlan(state);
  const recentlyTrainedSet = new Set(recentlyTrained.map((entry) => entry.muscle));

  let warning: string | undefined;
  if (next) {
    const overlap = next.muscles.filter((muscle) => recentlyTrainedSet.has(muscle));
    if (overlap.length > 0 && remaining.length > 1) {
      warning = `Muscle(s) ${overlap.join(", ")} were trained recently. Following the active plan order, ${next.label} is still required next. Other remaining units (${remaining.slice(1).map((unit) => unit.label).join(", ")}) stay pending — they are not skipped.`;
    }
  }

  const blockedAlternatives = [
    ...completed,
    ...remaining.filter((unit) => unit.key !== next?.key),
  ];

  return {
    nextUnit: next ?? null,
    targetMuscles: next?.muscles ?? [],
    recentlyTrainedMuscles: recentlyTrained,
    remainingUnits: remaining,
    completedUnits: completed,
    cycleStatus: state.cycleStatus,
    planSwitchAllowed: switchAllowed,
    machineState: deriveProgressionPhase(state),
    history,
    todayOptions: next ? [next] : [],
    blockedAlternatives,
    warning,
  };
}

export async function completeWorkout(
  database: DatabaseLike,
  userId: string,
  workoutData: { workoutId: string },
  nowIso: string
): Promise<{ cycleStatus: "IN_PROGRESS" | "COMPLETED"; nextUnit: WorkoutUnit | null; planSwitchAllowed: boolean; cycleCompleted: boolean }> {
  return completeWorkoutUnit(database, userId, workoutData.workoutId, nowIso);
}

export async function completeWorkoutUnit(
  database: DatabaseLike,
  userId: string,
  workoutId: string,
  nowIso: string
): Promise<{ cycleStatus: "IN_PROGRESS" | "COMPLETED"; nextUnit: WorkoutUnit | null; planSwitchAllowed: boolean; cycleCompleted: boolean }> {
  const state = await getPlanState(database, userId);
  if (!state) {
    throw new Error("No active plan state for user.");
  }
  if (state.activeWorkoutId !== workoutId) {
    throw new Error("This workout is not the currently active workout for the plan.");
  }

  const nextIndex = state.currentIndex + 1;
  const cycleCompleted = nextIndex >= state.units.length;
  const units = state.units.map((unit, index) =>
    index === state.currentIndex ? { ...unit, status: "COMPLETED" as const, completedAt: nowIso } : unit
  );

  if (cycleCompleted) {
    await archiveCompletedCycle(database, userId, state, units, nowIso);
  }

  await database.run(
    `UPDATE WorkoutPlanState SET
       currentIndex = ?,
       unitsJson = ?,
       activeWorkoutId = NULL,
       cycleStatus = ?,
       completedAt = ?
     WHERE userId = ?`,
    nextIndex,
    JSON.stringify(units),
    cycleCompleted ? "COMPLETED" : "IN_PROGRESS",
    cycleCompleted ? nowIso : null,
    userId
  );

  const updated = (await getPlanState(database, userId))!;
  return {
    cycleStatus: updated.cycleStatus,
    nextUnit: nextUnit(updated) ?? null,
    planSwitchAllowed: canSwitchPlan(updated),
    cycleCompleted,
  };
}

async function archiveCompletedCycle(
  database: DatabaseLike,
  userId: string,
  state: PlanState,
  units: WorkoutUnit[],
  completedAt: string
): Promise<void> {
  const archiveId = uuidv4();
  await database.run(
    `INSERT INTO WorkoutCycleHistory (id, userId, cycleId, structureKey, unitsJson, startedAt, completedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    archiveId, userId, state.cycleId, state.structureKey, JSON.stringify(units), state.createdAt, completedAt
  );
}

export async function getCycleHistory(
  database: DatabaseLike,
  userId: string,
  limit: number = 10
): Promise<CycleHistoryEntry[]> {
  const rows = await database.all<any>(
    `SELECT * FROM WorkoutCycleHistory WHERE userId = ? ORDER BY completedAt DESC LIMIT ?`,
    userId, limit
  );
  return rows.map((row) => ({
    cycleId: row.cycleId,
    structureKey: row.structureKey,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    units: JSON.parse(row.unitsJson) as WorkoutUnit[],
  }));
}

export async function getExercisesForWorkout(
  database: DatabaseLike,
  userId: string,
  workoutUnit: WorkoutUnit
): Promise<Array<{ exerciseId: string; name: string; primaryMuscle: string; equipmentRequired: string[]; requiresEquipment: boolean }>> {
  const muscles = workoutUnit.muscles;
  if (muscles.length === 0) return [];

  const placeholders = muscles.map(() => "?").join(",");
  const equipmentRows = await database.all<{ equipmentId: string }>(
    `SELECT equipmentId FROM UserEquipment WHERE userId = ?`,
    userId
  );
  const userEquipmentIds = new Set(equipmentRows.map((r) => r.equipmentId));

  const rows = await database.all<any>(
    `SELECT DISTINCT e.id, e.name, e.primaryMuscle
     FROM Exercise e
     WHERE e.primaryMuscle IN (${placeholders})
     ORDER BY e.primaryMuscle, e.id`,
    ...muscles
  );

  const results = await Promise.all(
    rows.map(async (row) => {
      const equipRows = await database.all<{ equipmentId: string }>(
        `SELECT equipmentId FROM ExerciseEquipment WHERE exerciseId = ?`,
        row.id
      );
      const requiredIds = new Set(equipRows.map((r) => r.equipmentId));
      const hasBodyweight = requiredIds.size === 0;
      const hasAllEquipment = Array.from(requiredIds).every((id) => userEquipmentIds.has(id));
      const isPerformable = hasBodyweight || hasAllEquipment;
      const names = equipRows.length
        ? (await database.all<{ name: string }>(
            `SELECT eq.name FROM Equipment eq WHERE eq.id IN (${equipRows.map(() => "?").join(",")})`,
            ...equipRows.map((r) => r.equipmentId)
          )).map((r) => r.name)
        : ["Bodyweight"];
      return {
        exerciseId: row.id as string,
        name: row.name as string,
        primaryMuscle: row.primaryMuscle as string,
        equipmentRequired: names,
        requiresEquipment: names.length > 0 && names[0] !== "Bodyweight",
        isPerformable,
      };
    })
  );

  return results
    .filter((r) => r.isPerformable)
    .map(({ isPerformable: _ip, ...rest }) => rest);
}
