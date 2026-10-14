import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import { db, nowIso } from "../../db/client";
import { requireAuth, AuthedRequest } from "../../common/auth";
import { ensureExerciseRows, generateWorkout, musclesForFocus } from "./workoutGenerator";
import { getAiExerciseFallback, validateUncataloguedExercise } from "./exerciseAiFallback";
import { loadExerciseWithLinks } from "../exercises/substitutionEngine";
import {
  canSwitchWorkoutPlan,
  getActiveWorkoutPlan,
  getCompletedWorkoutUnits,
  getCycleHistory,
  getCurrentCycle,
  getNextRequiredWorkout,
  getPlanState,
  getRecentlyTrainedMuscles,
  getRemainingWorkoutUnits,
  getTodayWorkoutDecision,
  getWorkoutHistory,
  listAvailableStructures,
  completedUnits as listCompletedUnits,
  nextUnit,
  remainingUnits,
  serializePlanSnapshot,
  startNewWorkoutCycle,
  switchWorkoutPlan,
  completeWorkout,
  PLAN_LABELS,
} from "./plan";
import type { WorkoutUnit } from "./plan";
import { getEquipmentVisionProvider } from "../../vision/equipmentVisionProvider";
import { normalizeExerciseValue } from "./exerciseCsvRepository";
import { exerciseFamilyKey, exerciseRecommendationService } from "./exerciseRecommendation";
import type { RecommendedExercise } from "./exerciseRecommendation";
import { refreshProgressForCompletedWorkout } from "../grow-impact/service";

export const workoutRouter = Router();
workoutRouter.use(requireAuth);
const CSV_WORKOUT_GENERATOR_VERSION = "csv-v1";

function belongsToCurrentPlanStep(workout: any, state: any, planStepIndex: number): boolean {
  if (!workout || !state) return false;
  if (workout.cycleId && workout.cycleId !== state.cycleId) return false;
  if (workout.planStepIndex != null && Number(workout.planStepIndex) !== planStepIndex) return false;
  return true;
}

workoutRouter.get("/plan/structures", async (_req, res) => {
  return res.json({ structures: listAvailableStructures() });
});

workoutRouter.get("/plan", async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const started = Date.now();
  const log = (label: string) => {
    console.info(`[TRACE] GET /workouts/plan:${label} durationMs=${Date.now() - started}`);
  };

  try {
    log("plan-state:start");
    const state = await getPlanState(db, userId);
    log("plan state fetched");

    if (!state) {
      log("no plan state");
      return res.json({
        activePlan: null,
        activePlanKey: null,
        cycleId: null,
        cycleStatus: "NOT_STARTED",
        currentIndex: 0,
        completedUnits: [],
        nextWorkout: null,
        remainingWorkouts: [],
        planSwitchAllowed: true,
        machineState: "NO_PLAN",
        units: [],
        workoutUnits: [],
        stateSnapshot: serializePlanSnapshot(undefined),
        plan: null,
        cycle: null,
        recentlyTrainedMuscles: [],
        decision: {
          nextUnit: null,
          targetMuscles: [],
          recentlyTrainedMuscles: [],
          remainingUnits: [],
          completedUnits: [],
          cycleStatus: "NOT_STARTED",
          planSwitchAllowed: true,
          machineState: "NO_PLAN",
          history: [],
          todayOptions: [],
          blockedAlternatives: [],
        },
      });
    }

    const [activePlan, cycle, decision, recentlyTrained] = await Promise.all([
      getActiveWorkoutPlan(db, userId),
      getCurrentCycle(db, userId),
      getTodayWorkoutDecision(db, userId),
      getRecentlyTrainedMuscles(db, userId),
    ]);
    log("plan data fetched");

    const snapshot = serializePlanSnapshot(state);

    log("response ready");
    return res.json({
      activePlan: state
        ? {
            structureKey: state.structureKey,
            structureLabel: PLAN_LABELS[state.structureKey] ?? state.structureKey,
          }
        : null,
      activePlanKey: snapshot.activePlan,
      cycleId: snapshot.cycleId,
      cycleStatus: snapshot.cycleStatus,
      currentIndex: state.currentIndex,
      completedUnits: listCompletedUnits(state),
      nextWorkout: decision.nextUnit
        ? {
            key: decision.nextUnit.key,
            label: decision.nextUnit.label,
            muscles: decision.nextUnit.muscles,
          }
        : null,
      remainingWorkouts: decision.remainingUnits.map((unit) => ({
        key: unit.key,
        label: unit.label,
        muscles: unit.muscles,
      })),
      planSwitchAllowed: snapshot.planSwitchAllowed,
      machineState: snapshot.machineState,
      units: state.units,
      workoutUnits: snapshot.workoutUnits,
      stateSnapshot: snapshot,
      plan: activePlan,
      cycle,
      recentlyTrainedMuscles: recentlyTrained,
      decision,
    });
  } catch (error: any) {
    console.error(`[workouts/plan] userId=${userId} - UNHANDLED ERROR:`, error);
    return res.status(500).json({
      error: "Internal server error",
      detail: error?.message || String(error),
      stack: process.env.NODE_ENV === "development" ? error?.stack : undefined,
    });
  }
});

workoutRouter.get("/plan/completed-units", async (req: AuthedRequest, res) => {
  const state = await getPlanState(db, req.userId!);
  if (!state) return res.status(409).json({ error: "No active workout plan." });
  const units = await getCompletedWorkoutUnits(db, req.userId!, state.cycleId);
  return res.json({ cycleId: state.cycleId, completedUnits: units });
});

workoutRouter.get("/plan/remaining-units", async (req: AuthedRequest, res) => {
  const state = await getPlanState(db, req.userId!);
  if (!state) return res.status(409).json({ error: "No active workout plan." });
  const units = await getRemainingWorkoutUnits(db, req.userId!, state.cycleId);
  return res.json({ cycleId: state.cycleId, remainingUnits: units });
});

workoutRouter.get("/plan/can-switch", async (req: AuthedRequest, res) => {
  const allowed = await canSwitchWorkoutPlan(db, req.userId!);
  return res.json({ planSwitchAllowed: allowed });
});

workoutRouter.get("/plan/cycle-history", async (req: AuthedRequest, res) => {
  const history = await getCycleHistory(db, req.userId!, 10);
  return res.json({ history });
});

workoutRouter.get("/plan/recently-trained", async (req: AuthedRequest, res) => {
  const muscles = await getRecentlyTrainedMuscles(db, req.userId!);
  return res.json({ muscles });
});

workoutRouter.get("/plan/next-workout", async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const decision = await getNextRequiredWorkout(db, userId);
  if (decision && "error" in decision) {
    return res.status(409).json({ error: decision.error });
  }
  return res.json({ nextWorkout: decision });
});

workoutRouter.get("/plan/today-decision", async (req: AuthedRequest, res) => {
  const decision = await getTodayWorkoutDecision(db, req.userId!);
  return res.json(decision);
});

const planSchema = z.object({
  structureKey: z.enum(["PPL", "INDIVIDUAL", "BRO"]),
  customUnits: z.array(z.object({
    label: z.string().min(1).max(80),
    muscles: z.array(z.string().min(1)).min(1).max(8),
  })).min(2).max(7).optional(),
});
workoutRouter.post("/plan", async (req: AuthedRequest, res) => {
  const parsed = planSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "structureKey must be PPL, INDIVIDUAL, or BRO" });

  const result = await switchWorkoutPlan(
    db,
    req.userId!,
    parsed.data.structureKey,
    nowIso(),
    parsed.data.customUnits
  );
  if ("error" in result) {
    return res.status(409).json({ error: result.error, planSwitchAllowed: false });
  }
  return res.status(201).json(result);
});

workoutRouter.post("/plan/start-cycle", async (req: AuthedRequest, res) => {
  const result = await startNewWorkoutCycle(db, req.userId!, nowIso());
  if ("error" in result) {
    return res.status(409).json({ error: result.error });
  }
  return res.status(201).json(result);
});

const generateSchema = z.object({
  focus: z.string().optional(),
  durationMinutes: z.number().int().min(15).max(180).optional(),
  dayIndex: z.number().int().min(0).optional(),
  equipmentMode: z.enum(["SCANNED", "FULL_GYM", "USER_EQUIPMENT"]).optional(),
  availableEquipmentNames: z.array(z.string().trim().min(1)).optional(),
  replaceExisting: z.boolean().optional(),
  imageBase64: z.string().min(100).optional(),
  detectedEquipmentNames: z.array(z.string().min(1)).optional(),
});
workoutRouter.post("/generate", async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const profile = await db.get<any>(`SELECT * FROM UserProfile WHERE userId = ?`, userId);
  if (!profile) return res.status(400).json({ error: "Complete onboarding (PUT /user/profile) first" });

  const parsed = generateSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "Invalid workout generation options." });
  const durationMinutes = parsed.data.durationMinutes ?? profile.sessionMinutes;
  const state = await getPlanState(db, userId);
  const requiredUnit = state ? nextUnit(state) : undefined;

  if (!state) return res.status(409).json({ error: "Select a workout structure before generating a workout." });
  if (state.cycleStatus === "COMPLETED" || !requiredUnit) {
    return res.status(409).json({
      error: "This cycle is complete. Start a new cycle or switch workout structures before generating another workout.",
      planSwitchAllowed: true,
    });
  }

  const requestedFocus = parsed.success ? parsed.data.focus : undefined;
  const focus = requiredUnit.label;

  if (requestedFocus && requestedFocus !== focus) {
    return res.status(409).json({
      error: `Your active plan requires ${focus} next. Remaining: ${remainingUnits(state).map((unit) => unit.label).join(", ")}.`,
    });
  }

  const requestedMode = parsed.success ? parsed.data.equipmentMode : undefined;
  const equipmentMode = requestedMode ?? "USER_EQUIPMENT";
  if (parsed.data.availableEquipmentNames !== undefined && equipmentMode !== "USER_EQUIPMENT") {
    return res.status(400).json({ error: "availableEquipmentNames can only be used with USER_EQUIPMENT mode." });
  }
  let userEquipmentOverrideIds: string[] | undefined;
  if (parsed.data.availableEquipmentNames !== undefined) {
    const selectedNames = new Set(parsed.data.availableEquipmentNames.map(normalizeExerciseValue));
    const catalogRows = await db.all<{ id: string; name: string; alias: string | null }>(
      `SELECT e.id,e.name,ea.alias FROM Equipment e LEFT JOIN EquipmentAlias ea ON ea.equipmentId=e.id WHERE e.name != 'No Equipment'`
    );
    const matchedSelection = new Set<string>();
    const selectedEquipmentIds = new Set<string>();
    for (const row of catalogRows) {
      for (const value of [row.name, row.alias]) {
        if (!value) continue;
        const normalized = normalizeExerciseValue(value);
        if (selectedNames.has(normalized)) {
          matchedSelection.add(normalized);
          selectedEquipmentIds.add(row.id);
        }
      }
    }
    const unknownEquipment = [...selectedNames].filter((name) => !matchedSelection.has(name));
    if (unknownEquipment.length > 0) {
      return res.status(400).json({ error: `Unknown equipment selection: ${unknownEquipment.join(", ")}.` });
    }
    userEquipmentOverrideIds = [...selectedEquipmentIds];
  }
  let scannedEquipmentIds: string[] = [];
  if (equipmentMode === "SCANNED") {
    let names = parsed.data.detectedEquipmentNames;
    if (parsed.data.imageBase64) {
      let detection;
      try {
        detection = await getEquipmentVisionProvider().detectEquipment(parsed.data.imageBase64);
      } catch (e: any) {
        console.error(`[workouts/generate] equipment detection failed: ${e?.message || String(e)}`);
        return res.status(503).json({ error: "EQUIPMENT_DETECTION_FAILED", message: "Equipment detection is temporarily unavailable." });
      }
      if (!detection.configured) return res.status(503).json({ error: "EQUIPMENT_DETECTION_FAILED", message: "Equipment detection is temporarily unavailable." });
      names = detection.detections.map((d) => d.equipmentName);
    }
    if (!names?.length) {
      return res.status(400).json({ error: "SCANNED_EQUIPMENT_REQUIRED", message: "Provide a photo or detected equipment names for SCANNED mode." });
    }
    const rows = await db.all<{ id: string; name: string; alias: string | null }>(
      `SELECT e.id,e.name,ea.alias FROM Equipment e LEFT JOIN EquipmentAlias ea ON ea.equipmentId=e.id WHERE e.name != 'No Equipment'`
    );
    const normalized = new Set(names.map(normalizeExerciseValue));
    scannedEquipmentIds = [...new Set(rows
      .filter((row) => normalized.has(normalizeExerciseValue(row.name)) || (row.alias && normalized.has(normalizeExerciseValue(row.alias))))
      .map((row) => row.id))];
  }
  const savedEquipmentRows = await db.all<{ equipmentId: string; name: string }>(
    `SELECT ue.equipmentId,e.name FROM UserEquipment ue JOIN Equipment e ON e.id=ue.equipmentId WHERE ue.userId = ?`, userId);
  const equipmentSnapshot = equipmentMode === "FULL_GYM"
    ? []
    : equipmentMode === "SCANNED"
      ? scannedEquipmentIds
      : userEquipmentOverrideIds ?? savedEquipmentRows.map((row) => row.equipmentId);

  // Check if there's already a workout for the current plan step
  const currentPlanStepIndex = state.currentIndex;
  let existingWorkout = state.activeWorkoutId
    ? await db.get<any>(
      `SELECT * FROM Workout WHERE id = ? AND userId = ? AND status != 'superseded' AND (cycleId = ? OR cycleId IS NULL)`,
      state.activeWorkoutId, userId, state.cycleId
    )
    : undefined;
  if (existingWorkout && !belongsToCurrentPlanStep(existingWorkout, state, currentPlanStepIndex)) {
    existingWorkout = undefined;
  }
  if (!existingWorkout) {
    existingWorkout = await db.get<any>(
      `SELECT * FROM Workout WHERE userId = ? AND cycleId = ? AND planStepIndex = ? AND status = 'pending' ORDER BY createdAt DESC LIMIT 1`,
      userId, state.cycleId, currentPlanStepIndex
    );
  }
  if (existingWorkout && !parsed.data.replaceExisting) {
// Return the existing workout with its exercises
  const existingExercises = await db.all<any>(
    `SELECT we.*, e.name, e.primaryMuscle, e.instructions, e.defaultSets, e.repRangeLow, e.repRangeHigh
     FROM WorkoutExercise we JOIN Exercise e ON e.id = we.exerciseId
     WHERE we.workoutId = ? ORDER BY we.orderIndex ASC`,
    existingWorkout.id
  );
  const exercisesWithEquip = await Promise.all(existingExercises.map(async (ex) => {
    const equipRows = await db.all<{ name: string }>(
      `SELECT eq.name FROM ExerciseEquipment ee JOIN Equipment eq ON eq.id = ee.equipmentId WHERE ee.exerciseId = ?`,
      ex.exerciseId
    );
    const equipmentRequired = equipRows.map((r) => r.name);
    return {
      workoutExerciseId: ex.id,
      exerciseId: ex.exerciseId,
      exerciseName: ex.sourceExerciseName || ex.name,
      primaryMuscle: ex.sourcePrimaryMuscle ?? ex.primaryMuscle,
      muscle: ex.sourceMuscle ?? ex.primaryMuscle,
      machine: ex.sourceMachine ?? equipmentRequired[0] ?? "Bodyweight",
      instructions: ex.instructions,
      targetSets: ex.targetSets,
      repRangeLow: ex.repRangeLow,
      repRangeHigh: ex.repRangeHigh,
      status: ex.status,
      painReported: !!ex.painReported,
      equipmentRequired: ex.sourceMachine ? [ex.sourceMachine] : equipmentRequired,
      equipmentName: ex.sourceMachine ?? equipmentRequired[0] ?? "Bodyweight",
      requiresEquipment: ex.sourceMachine
        ? normalizeExerciseValue(ex.sourceMachine) !== "bodyweight"
        : equipmentRequired.length > 0 && equipmentRequired[0] !== "Bodyweight",
    };
  }));

  return res.json({
    workout: { id: existingWorkout.id, focus: existingWorkout.focus, durationMin: existingWorkout.durationMin, status: existingWorkout.status },
    generatorVersion: existingWorkout.generatorVersion ?? null,
    equipmentMode: existingWorkout.equipmentMode ?? "USER_EQUIPMENT",
    needsRegeneration: existingWorkout.generatorVersion !== CSV_WORKOUT_GENERATOR_VERSION,
    canRegenerate: existingWorkout.status === "pending" && existingWorkout.generatorVersion !== CSV_WORKOUT_GENERATOR_VERSION,
    exercises: exercisesWithEquip.map((exercise, idx) => ({
      workoutExerciseId: exercise.workoutExerciseId,
      exerciseId: exercise.exerciseId,
      exerciseName: exercise.exerciseName,
      primaryMuscle: exercise.primaryMuscle,
      muscle: exercise.muscle,
      machine: exercise.machine,
      instructions: exercise.instructions,
      targetSets: exercise.targetSets,
      repRangeLow: exercise.repRangeLow,
      repRangeHigh: exercise.repRangeHigh,
      suggestedWeightKg: null,
      wasSubstituted: false,
      equipmentRequired: exercise.equipmentRequired,
      equipmentName: exercise.equipmentRequired[0] ?? "Bodyweight",
      requiresEquipment: exercise.requiresEquipment,
    })),
    summary: null, // No summary for existing workout
  });
  }

  if (existingWorkout) {
    const loggedSetCount = await db.get<{ count: number }>(
      `SELECT COUNT(*) as count FROM WorkoutSet ws JOIN WorkoutExercise we ON we.id = ws.workoutExerciseId WHERE we.workoutId = ? AND ws.completed = 1`,
      existingWorkout.id
    );
    if (existingWorkout.status !== "pending") {
      return res.status(409).json({ error: "Only an uncompleted workout can be replaced." });
    }
    const isLegacyWorkout = existingWorkout.generatorVersion !== CSV_WORKOUT_GENERATOR_VERSION;
    if ((loggedSetCount?.count ?? 0) > 0 && !isLegacyWorkout) {
      return res.status(409).json({ error: "This workout has logged sets and cannot be regenerated without affecting your history." });
    }
  }

  const recentlyTrained = await getRecentlyTrainedMuscles(db, userId);
  const recentMuscleSet = new Set(recentlyTrained.map((r) => r.muscle));
  const overlap = requiredUnit.muscles.filter((m) => recentMuscleSet.has(m));
  const remaining = remainingUnits(state);
  if (overlap.length > 0 && remaining.length > 1) {
    console.info(
      `Recovery note: ${overlap.join(", ")} were trained recently. Enforcing plan order requires ${requiredUnit.label} next per plan progression rules.`
    );
  }

  const generation = await generateWorkout(db, userId, focus, durationMinutes, {
    lockToMuscles: requiredUnit.muscles,
    equipmentMode,
    scannedEquipmentIds,
    userEquipmentIds: userEquipmentOverrideIds,
  });
  const { exercises } = generation;
  const availableEquipmentForLog = equipmentMode === "FULL_GYM"
    ? ["FULL_GYM"]
    : equipmentMode === "SCANNED"
      ? (parsed.data.detectedEquipmentNames ?? [])
      : parsed.data.availableEquipmentNames ?? savedEquipmentRows.map((row) => row.name);
  const generationTrace = {
    event: "workout_generation",
    cycleId: state.cycleId,
    targetMuscles: requiredUnit.muscles,
    sessionDurationMinutes: durationMinutes,
    equipmentMode,
    availableEquipment: availableEquipmentForLog,
    csvCandidateCount: generation.availableExerciseCount,
    requestedExerciseCount: generation.requestedExerciseCount,
    persistedExercises: exercises.map(({ exerciseName, muscle, machine }) => ({ exerciseName, muscle, machine })),
  };
  if (exercises.length === 0) {
    console.info(JSON.stringify({ ...generationTrace, event: "workout_generation_empty", persistedExercises: [] }));
    return res.status(422).json({
      code: "CSV_EXERCISES_NOT_FOUND",
      error: `No bundled CSV exercises match the current plan target (${requiredUnit.muscles.join(", ")}) and equipment mode.`,
    });
  }

  const workoutId = uuidv4();
  const ts = nowIso();
  const workoutExerciseIds: string[] = [];
  await db.run(
    `INSERT INTO Workout (id, userId, workoutPlanId, focus, status, durationMin, createdAt, completedAt, planStepIndex, cycleId, equipmentMode, equipmentSnapshot, generatorVersion) VALUES (?, ?, NULL, ?, 'pending', ?, ?, NULL, ?, ?, ?, ?, ?)`,
    workoutId, userId, focus, durationMinutes, ts, currentPlanStepIndex, state.cycleId, equipmentMode, JSON.stringify(equipmentSnapshot), CSV_WORKOUT_GENERATOR_VERSION
  );
  for (const [idx, exercise] of exercises.entries()) {
    const id = uuidv4();
    workoutExerciseIds.push(id);
    await db.run(
      `INSERT INTO WorkoutExercise (id, workoutId, exerciseId, orderIndex, targetSets, repRangeLow, repRangeHigh, status, replacedFromId, painReported, sourceExerciseName, sourceMuscle, sourcePrimaryMuscle, sourceMachine)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL, 0, ?, ?, ?, ?)`,
      id, workoutId, exercise.exerciseId, idx, exercise.sets, exercise.repRangeLow, exercise.repRangeHigh,
      exercise.exerciseName, exercise.muscle, exercise.primaryMuscle, exercise.machine
    );
  }
  if (existingWorkout) {
    // Archive the old row only after the replacement exists. Its exercise and
    // set rows remain untouched, so previously logged work is preserved.
    await db.run(`UPDATE Workout SET status = 'superseded' WHERE id = ? AND status = 'pending'`, existingWorkout.id);
  }
  if (state)
    await db.run(`UPDATE WorkoutPlanState SET activeWorkoutId = ? WHERE userId = ?`, workoutId, userId);
  console.info(JSON.stringify(generationTrace));

  // The selection is fully local and deterministic; no AI/provider is part of generation.
  const summary = null;
  return res.status(201).json({
    workout: {
      id: workoutId, focus, durationMin: durationMinutes, status: "pending", cycleId: state.cycleId,
      targetMuscles: [...new Set([...requiredUnit.muscles, ...exercises.map((exercise) => exercise.primaryMuscle)])],
      availableEquipmentNames: equipmentMode === "FULL_GYM" ? ["FULL_GYM"] : availableEquipmentForLog,
    },
    requestedExerciseCount: generation.requestedExerciseCount,
    availableExerciseCount: generation.availableExerciseCount,
    limitedByDataset: generation.limitedByDataset,
    exercises: exercises.map((exercise, idx) => ({
      workoutExerciseId: workoutExerciseIds[idx],
      exerciseId: exercise.exerciseId,
      exerciseName: exercise.exerciseName,
      primaryMuscle: exercise.primaryMuscle,
      muscle: exercise.muscle,
      machine: exercise.machine,
      instructions: exercise.instructions,
      targetSets: exercise.sets,
      repRangeLow: exercise.repRangeLow,
      repRangeHigh: exercise.repRangeHigh,
      suggestedWeightKg: exercise.suggestedWeightKg,
      wasSubstituted: exercise.wasSubstituted,
      originalExerciseName: exercise.originalExerciseName,
      equipmentRequired: exercise.equipmentRequired,
      equipmentName: exercise.equipmentRequired[0] ?? "Bodyweight",
      requiresEquipment: exercise.requiresEquipment,
    })),
    summary,
  });
});

workoutRouter.get("/exercises-for-next", async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const next = await getNextRequiredWorkout(db, userId);
  if (!next) {
    return res.status(409).json({ error: "No next workout scheduled." });
  }
  if ("error" in next) {
    return res.status(409).json({ error: next.error });
  }
  const profile = await db.get<{ sessionMinutes: number }>(`SELECT sessionMinutes FROM UserProfile WHERE userId = ?`, userId);
  if (!profile) return res.status(400).json({ error: "Complete onboarding (PUT /user/profile) first" });
  const preview = await generateWorkout(db, userId, (next as WorkoutUnit).label, profile.sessionMinutes, {
    lockToMuscles: (next as WorkoutUnit).muscles,
    equipmentMode: "USER_EQUIPMENT",
  });
  const normalizedExercises = preview.exercises.map((ex) => ({
    exerciseId: ex.exerciseId,
    exerciseName: ex.exerciseName,
    primaryMuscle: ex.primaryMuscle,
    muscle: ex.muscle,
    machine: ex.machine,
    equipmentRequired: ex.equipmentRequired,
    equipmentName: ex.machine,
    requiresEquipment: ex.requiresEquipment,
  }));
  return res.json({
    workoutUnit: next,
    targetMuscles: (next as WorkoutUnit).muscles,
    requestedExerciseCount: preview.requestedExerciseCount,
    availableExerciseCount: preview.availableExerciseCount,
    limitedByDataset: preview.limitedByDataset,
    exercises: normalizedExercises,
  });
});

workoutRouter.get("/today", async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const state = await getPlanState(db, userId);
  const currentPlanStepIndex = state?.currentIndex ?? 0;
  let workout = state?.activeWorkoutId
    ? await db.get<any>(
      `SELECT * FROM Workout WHERE id = ? AND userId = ? AND status != 'superseded' AND (cycleId = ? OR cycleId IS NULL)`,
      state.activeWorkoutId, userId, state.cycleId
    )
    : undefined;
  if (workout && state && !belongsToCurrentPlanStep(workout, state, currentPlanStepIndex)) {
    workout = undefined;
  }
  if (!workout && state) {
    workout = await db.get<any>(
      `SELECT * FROM Workout WHERE userId = ? AND cycleId = ? AND planStepIndex = ? AND status = 'pending' ORDER BY createdAt DESC LIMIT 1`,
      userId, state.cycleId, currentPlanStepIndex
    );
  }
  if (!workout) return res.status(404).json({ error: "No workout generated today yet. POST /workouts/generate" });
  const exercises = await db.all<any>(
    `SELECT we.*, e.name as exerciseName, e.primaryMuscle, e.instructions FROM WorkoutExercise we JOIN Exercise e ON e.id = we.exerciseId WHERE we.workoutId = ? ORDER BY we.orderIndex ASC`,
    workout.id
  );
  const loggedSets = await db.all<any>(
    `SELECT ws.workoutExerciseId, ws.setNumber, ws.weightKg, ws.reps
     FROM WorkoutSet ws
     JOIN WorkoutExercise we ON we.id = ws.workoutExerciseId
     WHERE we.workoutId = ? AND ws.completed = 1
     ORDER BY ws.setNumber ASC`,
    workout.id
  );
  const loggedSetsByExercise = new Map<string, Array<{ setNumber: number; weightKg: number | null; reps: number | null }>>();
  for (const set of loggedSets) {
    const sets = loggedSetsByExercise.get(set.workoutExerciseId) ?? [];
    sets.push({ setNumber: set.setNumber, weightKg: set.weightKg, reps: set.reps });
    loggedSetsByExercise.set(set.workoutExerciseId, sets);
  }
  // Helper function to serialize exercise consistently
  function serializeExercise(exercise: any, equipmentRequired: string[], requiresEquipment: boolean) {
    const exerciseName = exercise.sourceExerciseName || exercise.exerciseName;
    if (typeof exerciseName !== "string" || exerciseName.trim() === "") {
      throw new Error(`Workout exercise ${exercise.id} has no persisted exercise name.`);
    }
    return {
      workoutExerciseId: exercise.id,
      exerciseId: exercise.exerciseId,
      exerciseName,
      primaryMuscle: exercise.sourcePrimaryMuscle ?? exercise.primaryMuscle,
      muscle: exercise.sourceMuscle ?? exercise.primaryMuscle,
      machine: exercise.sourceMachine ?? equipmentRequired[0] ?? "Bodyweight",
      instructions: exercise.instructions,
      targetSets: exercise.targetSets,
      repRangeLow: exercise.repRangeLow,
      repRangeHigh: exercise.repRangeHigh,
      status: exercise.status,
      painReported: !!exercise.painReported,
      completedSets: loggedSetsByExercise.get(exercise.id) ?? [],
      equipmentRequired,
      equipmentName: equipmentRequired[0] ?? "Bodyweight",
      requiresEquipment,
    };
  }

  // Fetch equipment for each exercise
  const exercisesWithEquip = await Promise.all(exercises.map(async (exercise) => {
    const equipRows = await db.all<{ name: string }>(
      `SELECT eq.name FROM ExerciseEquipment ee JOIN Equipment eq ON eq.id = ee.equipmentId WHERE ee.exerciseId = ?`,
      exercise.exerciseId
    );
    const equipmentRequired = exercise.sourceMachine ? [exercise.sourceMachine] : equipRows.map((r) => r.name);
    const requiresEquipment = exercise.sourceMachine
      ? normalizeExerciseValue(exercise.sourceMachine) !== "bodyweight"
      : equipmentRequired.length > 0 && equipmentRequired[0] !== "Bodyweight";
    return serializeExercise(exercise, equipmentRequired, requiresEquipment);
  }));
  let equipmentSnapshotIds: string[] = [];
  try {
    const snapshot = typeof workout.equipmentSnapshot === "string"
      ? JSON.parse(workout.equipmentSnapshot)
      : workout.equipmentSnapshot;
    if (Array.isArray(snapshot)) equipmentSnapshotIds = snapshot.filter((id): id is string => typeof id === "string");
  } catch {
    equipmentSnapshotIds = [];
  }
  const equipmentSnapshotNames = equipmentSnapshotIds.length
    ? (await db.all<{ id: string; name: string }>(
      `SELECT id,name FROM Equipment WHERE id IN (${equipmentSnapshotIds.map(() => "?").join(",")})`,
      ...equipmentSnapshotIds
    )).map((item) => item.name)
    : [];
  const targetMuscles = [...new Set([
    ...musclesForFocus(workout.focus),
    ...exercises.map((exercise) => exercise.sourcePrimaryMuscle ?? exercise.primaryMuscle).filter(Boolean),
  ])];
  return res.json({
    id: workout.id,
    focus: workout.focus,
    status: workout.status,
    durationMin: workout.durationMin,
    cycleId: workout.cycleId ?? state?.cycleId ?? null,
    generatorVersion: workout.generatorVersion ?? null,
    equipmentMode: workout.equipmentMode ?? "USER_EQUIPMENT",
    availableEquipmentNames: equipmentSnapshotNames,
    targetMuscles,
    needsRegeneration: workout.generatorVersion !== CSV_WORKOUT_GENERATOR_VERSION,
    // Legacy pending workouts can be explicitly refreshed even after logging;
    // the old workout and its set/history rows are retained as superseded.
    canRegenerate: workout.status === "pending" && workout.generatorVersion !== CSV_WORKOUT_GENERATOR_VERSION,
    exercises: exercisesWithEquip,
  });
});

workoutRouter.get("/history", async (req: AuthedRequest, res) => {
  const history = await getWorkoutHistory(db, req.userId!, 30);
  return res.json({ history });
});

const completeSetSchema = z.object({
  workoutExerciseId: z.string(),
  setNumber: z.number().int().positive(),
  weightKg: z.number().nonnegative().optional(),
  reps: z.number().int().nonnegative().optional(),
});

workoutRouter.post("/:id/complete-set", async (req: AuthedRequest, res) => {
  const parsed = completeSetSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid input" });
  const { workoutExerciseId, setNumber, weightKg, reps } = parsed.data;
  const workout = await db.get<any>(`SELECT id, userId, status FROM Workout WHERE id = ?`, req.params.id);
  if (!workout || workout.userId !== req.userId)
    return res.status(404).json({ error: "Workout not found" });
  if (workout.status === "completed")
    return res.status(409).json({ error: "This workout has already been completed." });
  const exercise = await db.get<any>(
    `SELECT * FROM WorkoutExercise WHERE id = ? AND workoutId = ?`,
    workoutExerciseId, req.params.id
  );
  if (!exercise)
    return res.status(404).json({ error: "Workout exercise not found" });
  if (setNumber > exercise.targetSets)
    return res.status(400).json({ error: "Set number exceeds the exercise target." });
  const existingSet = await db.get<any>(
    `SELECT * FROM WorkoutSet WHERE workoutExerciseId = ? AND setNumber = ? AND completed = 1 LIMIT 1`,
    workoutExerciseId, setNumber
  );
  if (existingSet) return res.json(existingSet);
  const setId = uuidv4();
  const ts = nowIso();
  await db.run(
    `INSERT INTO WorkoutSet (id, workoutExerciseId, setNumber, weightKg, reps, completed, createdAt) VALUES (?, ?, ?, ?, ?, 1, ?)`,
    setId, workoutExerciseId, setNumber, weightKg ?? null, reps ?? null, ts
  );
  await db.run(
    `INSERT INTO WorkoutHistory (id, userId, exerciseId, weightKg, reps, volumeKg, recordedAt) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    uuidv4(), req.userId!, exercise.exerciseId, weightKg ?? null, reps ?? null,
    weightKg && reps ? weightKg * reps : null, ts
  );
  return res.status(201).json(await db.get(`SELECT * FROM WorkoutSet WHERE id = ?`, setId));
});

workoutRouter.post("/:id/complete", async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const workout = await db.get<any>(`SELECT * FROM Workout WHERE id = ?`, req.params.id);
  if (!workout || workout.userId !== userId)
    return res.status(404).json({ error: "Workout not found" });
  if (workout.status === "completed")
    return res.status(409).json({ error: "This workout has already been completed." });

  const ts = nowIso();
  await db.run(`UPDATE Workout SET status = 'completed', completedAt = ? WHERE id = ?`, ts, req.params.id);
  await db.run(
    `UPDATE WorkoutExercise SET status = 'completed' WHERE workoutId = ? AND status = 'pending'`,
    req.params.id
  );

  const state = await getPlanState(db, userId);
  let completionResult = null;
  if (state?.activeWorkoutId === req.params.id) {
    try {
      completionResult = await completeWorkout(db, userId, { workoutId: req.params.id }, ts);
    } catch (err: any) {
      return res.status(409).json({ error: err.message });
    }
  }
  try {
    await refreshProgressForCompletedWorkout(db, userId, ts);
  } catch {
    // The workout record is authoritative; a missing/unavailable reward schema
    // must not turn a successful workout completion into a failed response.
    console.error("[GrowImpact] Monthly progress refresh failed after workout completion.");
  }
  return res.json({
    status: "completed",
    cycle: completionResult,
  });
});

const replaceSchema = z.object({
  workoutExerciseId: z.string(),
  reason: z.enum(["no_equipment", "pain", "user_preference"]).default("no_equipment"),
});

const reorderExercisesSchema = z.object({
  workoutExerciseIds: z.array(z.string().min(1)).min(1),
});

const editExerciseSchema = z.object({
  workoutExerciseId: z.string().min(1),
  exerciseName: z.string().trim().min(2).max(100),
  targetMuscle: z.string().trim().min(1).max(80),
  equipmentName: z.string().trim().min(1).max(80),
  confirmedExerciseId: z.string().min(1).optional(),
  validateWithAi: z.boolean().optional(),
});

const exerciseEditMatchThreshold = (() => {
  const configured = Number(process.env.EXERCISE_EDIT_MATCH_THRESHOLD);
  return Number.isFinite(configured) && configured >= 0.5 && configured <= 1 ? configured : 0.72;
})();

function editNameSimilarity(left: string, right: string): number {
  const a = normalizeExerciseValue(left);
  const b = normalizeExerciseValue(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const above = previous[j];
      previous[j] = Math.min(previous[j] + 1, previous[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return 1 - previous[b.length] / Math.max(a.length, b.length);
}

function editMuscles(exercise: { primaryMuscle?: string; secondaryMuscles?: string }): string[] {
  return [exercise.primaryMuscle, ...(exercise.secondaryMuscles || "").split(",")]
    .filter((muscle): muscle is string => Boolean(muscle?.trim()));
}

workoutRouter.post("/:id/replace-exercise", async (req: AuthedRequest, res) => {
  const parsed = replaceSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid input" });
  const { workoutExerciseId, reason } = parsed.data;
  const workout = await db.get<{ userId: string; status: string; equipmentMode?: string; equipmentSnapshot?: string; durationMin?: number }>(
    `SELECT userId,status,equipmentMode,equipmentSnapshot,durationMin FROM Workout WHERE id = ?`, req.params.id);
  if (!workout || workout.userId !== req.userId)
    return res.status(404).json({ error: "Workout not found" });
  if (workout.status === "completed")
    return res.status(409).json({ error: "This workout has already been completed." });
  const exerciseRow = await db.get<any>(`SELECT * FROM WorkoutExercise WHERE id = ?`, workoutExerciseId);
  if (!exerciseRow || exerciseRow.workoutId !== req.params.id)
    return res.status(404).json({ error: "Workout exercise not found" });
  const loggedSets = await db.get<{ count: number }>(
    `SELECT COUNT(*) as count FROM WorkoutSet WHERE workoutExerciseId = ? AND completed = 1`, workoutExerciseId);
  if ((loggedSets?.count ?? 0) > 0)
    return res.status(409).json({ error: "An exercise cannot be swapped after you have logged sets for it." });
  if (reason === "pain")
    await db.run(`UPDATE WorkoutExercise SET painReported = 1 WHERE id = ?`, workoutExerciseId);
  const equipmentRows = await db.all<{ equipmentId: string }>(
    `SELECT equipmentId FROM UserEquipment WHERE userId = ?`, req.userId!);
  const base = await loadExerciseWithLinks(db, exerciseRow.exerciseId);
  if (!base) return res.status(404).json({ error: "Exercise not found" });
  const allEquipmentRows = await db.all<{ id: string; name: string }>(`SELECT id,name FROM Equipment`);
  const baseMachine = exerciseRow.sourceMachine
    || allEquipmentRows.find((row) => base.requiredEquipmentIds.includes(row.id))?.name
    || "Bodyweight";
  const isBodyweight = normalizeExerciseValue(baseMachine) === "bodyweight";
  const baseRequiresEquipment = !isBodyweight;

  // Bodyweight exercises cannot be substituted for equipment reasons
  if (reason === "no_equipment" && !baseRequiresEquipment) {
    return res.status(422).json({
      error: `"${base.name}" is a bodyweight exercise and does not require equipment. It cannot be substituted for equipment reasons.`,
      requiresEquipment: false,
    });
  }

  let snapshotEquipmentIds: string[] = [];
  let hasEquipmentSnapshot = false;
  try {
    const parsedSnapshot = typeof workout.equipmentSnapshot === "string"
      ? JSON.parse(workout.equipmentSnapshot)
      : workout.equipmentSnapshot;
    if (Array.isArray(parsedSnapshot)) {
      hasEquipmentSnapshot = true;
      snapshotEquipmentIds = parsedSnapshot.filter((id): id is string => typeof id === "string");
    }
  } catch { /* legacy workouts fall back to saved equipment */ }
  const availableEquipmentIds = new Set(
    hasEquipmentSnapshot
      ? snapshotEquipmentIds
      : workout.equipmentMode === "SCANNED"
        ? []
        : equipmentRows.map((row) => row.equipmentId),
  );
  const fullGym = workout.equipmentMode === "FULL_GYM";
  if (fullGym) allEquipmentRows.forEach((row) => availableEquipmentIds.add(row.id));

  // The original session's equipment snapshot defines what was available
  // today. Saved inventory must not widen that constraint for a swap.
  if (reason === "no_equipment" && baseRequiresEquipment) {
    const hasEquipment = base.requiredEquipmentIds.every((id) => availableEquipmentIds.has(id));
    if (hasEquipment) {
      return res.status(422).json({
        error: `"${base.name}" requires equipment available in this workout. Use "pain" or "preference" to swap it.`,
        requiresEquipment: true,
      });
    }
  }

  const usedNames = await db.all<{ name: string }>(
    `SELECT COALESCE(we.sourceExerciseName,e.name) as name FROM WorkoutExercise we JOIN Exercise e ON e.id = we.exerciseId WHERE we.workoutId = ?`, req.params.id);
  const swapHistory = await db.all<{ familyKey: string }>(
    `SELECT familyKey FROM WorkoutExerciseSwapHistory WHERE workoutExerciseId = ?`, workoutExerciseId);
  const excludedFamilyKeys = new Set([
    ...swapHistory.map((row) => row.familyKey),
    ...usedNames.map((row) => exerciseFamilyKey(row.name)),
  ]);
  const csvAlternatives = exerciseRecommendationService.getSwapAlternatives(
    exerciseRow.sourceExerciseName || base.name,
    baseMachine,
    base.primaryMuscle,
    usedNames.map((row) => row.name),
    excludedFamilyKeys,
  );
  const equipmentIdByAlias = new Map<string, string>();
  for (const row of allEquipmentRows) equipmentIdByAlias.set(normalizeExerciseValue(row.name), row.id);
  const equipmentAliases = await db.all<{ equipmentId: string; alias: string }>(
    `SELECT equipmentId,alias FROM EquipmentAlias ORDER BY alias,equipmentId`);
  for (const row of equipmentAliases) {
    const key = normalizeExerciseValue(row.alias);
    if (!equipmentIdByAlias.has(key)) equipmentIdByAlias.set(key, row.equipmentId);
  }

  const performableAlternatives: Array<{ exercise: (typeof csvAlternatives)[number]; equipmentId: string | null }> = [];
  const seenPerformableNames = new Set<string>();
  for (const exercise of csvAlternatives) {
    const machineKey = normalizeExerciseValue(exercise.machine);
    const isBodyweight = machineKey === "bodyweight";
    let equipmentId = equipmentIdByAlias.get(machineKey);
    if (!isBodyweight && !equipmentId && fullGym) {
      equipmentId = `full-gym:${machineKey}`;
      availableEquipmentIds.add(equipmentId);
    }
    if (!isBodyweight && (!equipmentId || !availableEquipmentIds.has(equipmentId))) continue;
    const exerciseNameKey = normalizeExerciseValue(exercise.exercise);
    if (seenPerformableNames.has(exerciseNameKey)) continue;
    seenPerformableNames.add(exerciseNameKey);
    performableAlternatives.push({ exercise, equipmentId: isBodyweight ? null : equipmentId! });
  }

  const nextAlternative = performableAlternatives[0];
  if (!nextAlternative)
    return res.status(422).json({
      error: `No curated CSV substitute matches the target muscle, movement family, and available equipment for "${base.name}". Use Edit exercise to enter your own movement.`,
      requiresEquipment: baseRequiresEquipment,
    });

  const csvExercise = nextAlternative.exercise;
  const previousFamilyKey = exerciseFamilyKey(exerciseRow.sourceExerciseName || base.name);
  const nextFamilyKey = exerciseFamilyKey(csvExercise.exercise);
  const persisted = await ensureExerciseRows(db, [csvExercise]);
  const exerciseRecord = persisted.get(csvExercise.sourceIndex);
  if (!exerciseRecord) throw new Error(`Could not persist CSV substitute "${csvExercise.exercise}".`);
  const persistedSubstitute = await loadExerciseWithLinks(db, exerciseRecord.id);
  if (!persistedSubstitute) throw new Error(`Could not load CSV substitute "${csvExercise.exercise}".`);

  await db.run(
    `UPDATE WorkoutExercise
     SET exerciseId = ?, replacedFromId = ?, status = 'replaced',
         sourceExerciseName = ?, sourceMuscle = ?, sourcePrimaryMuscle = ?, sourceMachine = ?
     WHERE id = ?`,
    persistedSubstitute.id, exerciseRow.exerciseId, csvExercise.exercise, csvExercise.muscle,
    base.primaryMuscle, csvExercise.machine, workoutExerciseId
  );
  const swappedAt = nowIso();
  for (const [familyKey, exerciseName] of [[previousFamilyKey, exerciseRow.sourceExerciseName || base.name], [nextFamilyKey, csvExercise.exercise]]) {
    await db.run(
      `INSERT INTO WorkoutExerciseSwapHistory (workoutExerciseId,familyKey,exerciseName,createdAt) VALUES (?,?,?,?) ON CONFLICT(workoutExerciseId,familyKey) DO NOTHING`,
      workoutExerciseId, familyKey, exerciseName, swappedAt,
    );
  }
  const explanation = `Swapped ${base.name} for ${csvExercise.exercise}.`;
  return res.json({
    workoutExerciseId,
    replaced: { from: base.name, to: csvExercise.exercise },
    exercise: {
      exerciseId: persistedSubstitute.id,
      exerciseName: csvExercise.exercise,
      primaryMuscle: base.primaryMuscle,
      muscle: csvExercise.muscle,
      targetedMuscle: csvExercise.targetedMuscle,
      timeTakenOneSet: csvExercise.timeTakenOneSet,
      machine: csvExercise.machine,
      instructions: persistedSubstitute.instructions,
      targetSets: exerciseRow.targetSets,
      repRangeLow: exerciseRow.repRangeLow,
      repRangeHigh: exerciseRow.repRangeHigh,
      equipmentRequired: [csvExercise.machine],
      equipmentName: csvExercise.machine,
      requiresEquipment: normalizeExerciseValue(csvExercise.machine) !== "bodyweight",
      status: "replaced",
      completedSets: [],
    },
    explanation,
  });
});

workoutRouter.post("/:id/reorder-exercises", async (req: AuthedRequest, res) => {
  const parsed = reorderExercisesSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Provide the workout exercise IDs in the desired order." });
  const workout = await db.get<{ userId: string; status: string }>(
    `SELECT userId,status FROM Workout WHERE id = ?`, req.params.id);
  if (!workout || workout.userId !== req.userId) return res.status(404).json({ error: "Workout not found" });
  if (workout.status === "completed") return res.status(409).json({ error: "A completed workout cannot be reordered." });
  const exercises = await db.all<{ id: string }>(
    `SELECT id FROM WorkoutExercise WHERE workoutId = ? ORDER BY orderIndex ASC`, req.params.id);
  const submitted = parsed.data.workoutExerciseIds;
  if (new Set(submitted).size !== submitted.length
    || submitted.length !== exercises.length
    || submitted.some((id) => !exercises.some((exercise) => exercise.id === id))) {
    return res.status(400).json({ error: "The order must contain each exercise in this workout exactly once." });
  }
  const logged = await db.get<{ count: number }>(
    `SELECT COUNT(*) as count FROM WorkoutSet ws JOIN WorkoutExercise we ON we.id=ws.workoutExerciseId WHERE we.workoutId = ? AND ws.completed = 1`,
    req.params.id);
  if ((logged?.count ?? 0) > 0) return res.status(409).json({ error: "Reorder exercises before logging your first set." });
  for (const [orderIndex, exerciseId] of submitted.entries()) {
    await db.run(`UPDATE WorkoutExercise SET orderIndex = ? WHERE id = ? AND workoutId = ?`, orderIndex, exerciseId, req.params.id);
  }
  return res.json({ workoutExerciseIds: submitted });
});

workoutRouter.post("/:id/edit-exercise", async (req: AuthedRequest, res) => {
  const parsed = editExerciseSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Enter an exercise name, target muscle, and equipment." });
  const { workoutExerciseId, exerciseName, targetMuscle, equipmentName } = parsed.data;
  const workout = await db.get<{
    userId: string; status: string; focus: string; durationMin: number; equipmentMode?: string; equipmentSnapshot?: string;
  }>(`SELECT userId,status,focus,durationMin,equipmentMode,equipmentSnapshot FROM Workout WHERE id = ?`, req.params.id);
  if (!workout || workout.userId !== req.userId) return res.status(404).json({ error: "Workout not found" });
  if (workout.status === "completed") return res.status(409).json({ error: "A completed workout cannot be edited." });
  const logged = await db.get<{ count: number }>(
    `SELECT COUNT(*) as count FROM WorkoutSet ws JOIN WorkoutExercise we ON we.id=ws.workoutExerciseId WHERE we.workoutId = ? AND ws.completed = 1`,
    req.params.id);
  if ((logged?.count ?? 0) > 0) return res.status(409).json({ error: "Edit exercises before logging your first set." });

  const slots = await db.all<any>(
    `SELECT * FROM WorkoutExercise WHERE workoutId = ? ORDER BY orderIndex ASC`, req.params.id);
  const slot = slots.find((exercise) => exercise.id === workoutExerciseId);
  if (!slot) return res.status(404).json({ error: "Workout exercise not found" });
  const targetMuscles = [...new Set([
    ...musclesForFocus(workout.focus),
    ...slots.map((exercise) => exercise.sourcePrimaryMuscle).filter(Boolean),
  ])];
  const targetMuscleByKey = new Map(targetMuscles.map((muscle) => [normalizeExerciseValue(muscle), muscle]));
  const selectedTargetMuscle = targetMuscleByKey.get(normalizeExerciseValue(targetMuscle));
  if (!selectedTargetMuscle) {
    return res.status(400).json({ error: "Choose a target muscle already included in this workout." });
  }

  const allEquipment = await db.all<{ id: string; name: string }>(`SELECT id,name FROM Equipment`);
  const equipmentAliases = await db.all<{ equipmentId: string; alias: string }>(
    `SELECT equipmentId,alias FROM EquipmentAlias ORDER BY alias,equipmentId`);
  const catalogueExercises = await db.all<{
    id: string; name: string; primaryMuscle?: string; secondaryMuscles?: string; requiresEquipment?: number;
  }>(`SELECT id,name,primaryMuscle,secondaryMuscles,requiresEquipment FROM Exercise ORDER BY name`);
  const selectedExercise = parsed.data.confirmedExerciseId
    ? catalogueExercises.find((exercise) => exercise.id === parsed.data.confirmedExerciseId)
    : catalogueExercises.find((exercise) => normalizeExerciseValue(exercise.name) === normalizeExerciseValue(exerciseName));
  if (parsed.data.confirmedExerciseId && !selectedExercise) {
    return res.status(400).json({ error: "Choose an exercise from the FitOS exercise catalog." });
  }
  if (!selectedExercise) {
    if (!parsed.data.validateWithAi) {
      const suggestions = catalogueExercises
        .map((exercise) => ({ ...exercise, score: editNameSimilarity(exerciseName, exercise.name) }))
        .filter((exercise) => {
          const muscles = editMuscles(exercise);
          return !muscles.length || muscles.some((muscle) => normalizeExerciseValue(muscle) === normalizeExerciseValue(selectedTargetMuscle));
        })
        .filter((exercise) => exercise.score >= exerciseEditMatchThreshold)
        .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name))
        .slice(0, 5)
        .map(({ id, name, score }) => ({ id, name, score: Math.round(score * 100) }));
      if (suggestions.length) {
        return res.status(422).json({
          code: "EXERCISE_CONFIRMATION_REQUIRED",
          error: "Choose the matching exercise to continue.",
          suggestions,
        });
      }
    }
    const muscleRows = await db.all<{ name: string }>(`SELECT name FROM Muscle ORDER BY name`);
    const allowedMuscles = [...new Set([
      ...targetMuscles,
      ...muscleRows.map((row) => row.name),
      ...catalogueExercises.flatMap(editMuscles),
    ])];
    const allowedEquipment = [...new Set([
      ...allEquipment.filter((row) => normalizeExerciseValue(row.name) !== "no equipment").map((row) => row.name),
      "Bodyweight",
    ])];
    const aiValidation = await validateUncataloguedExercise({
      exerciseName,
      muscles: allowedMuscles,
      equipment: allowedEquipment,
    });
    if (aiValidation?.valid && aiValidation.canonicalName && aiValidation.primaryMuscle && aiValidation.equipmentName) {
      let aiExercise = catalogueExercises.find((exercise) =>
        normalizeExerciseValue(exercise.name) === normalizeExerciseValue(aiValidation.canonicalName!));
      if (!aiExercise) {
        const primaryMuscle = aiValidation.primaryMuscle;
        const targetedMuscles = [...new Set([primaryMuscle, ...aiValidation.secondaryMuscles])];
        const aiRecommendedExercise: RecommendedExercise = {
          sourceIndex: -900000,
          exercise: aiValidation.canonicalName,
          machine: aiValidation.equipmentName,
          muscle: primaryMuscle,
          primaryMuscle,
          muscleCategories: targetedMuscles,
          timeTakenOneSet: "AI validated",
          targetedMuscle: primaryMuscle,
          targetedMuscles,
        };
        const persistedExercise = await ensureExerciseRows(db, [aiRecommendedExercise]);
        const persistedId = persistedExercise.get(aiRecommendedExercise.sourceIndex)?.id;
        aiExercise = persistedId
          ? { id: persistedId, name: aiValidation.canonicalName, primaryMuscle, secondaryMuscles: aiValidation.secondaryMuscles.join(",") }
          : undefined;
      }
      if (aiExercise) {
        const muscles = editMuscles(aiExercise);
        if (muscles.length && !muscles.some((muscle) => normalizeExerciseValue(muscle) === normalizeExerciseValue(selectedTargetMuscle))) {
          return res.status(422).json({
            code: "EXERCISE_TARGET_MISMATCH",
            error: `${aiExercise.name} is a recognized exercise for ${[aiExercise.primaryMuscle, ...(aiExercise.secondaryMuscles || "").split(",").filter(Boolean)].join(" and ")}, so it cannot replace a ${selectedTargetMuscle} movement in this workout.`,
            exerciseId: aiExercise.id,
            exerciseName: aiExercise.name,
            muscles,
          });
        }
        return res.status(422).json({
          code: "EXERCISE_CONFIRMATION_REQUIRED",
          error: "FitOS validated this exercise and added it to the exercise catalog. Confirm to use it in this workout.",
          suggestions: [{ id: aiExercise.id, name: aiExercise.name, score: Math.round(aiValidation.confidence * 100), aiValidated: true }],
        });
      }
    }
    return res.status(422).json({
      code: "EXERCISE_NOT_FOUND",
      error: "We couldn't find that exercise. Choose an exercise from the suggestions or keep your current exercise.",
      suggestions: [],
    });
  }
  const selectedExerciseMuscles = editMuscles(selectedExercise);
  if (selectedExerciseMuscles.length && !selectedExerciseMuscles.some((muscle) =>
    normalizeExerciseValue(muscle) === normalizeExerciseValue(selectedTargetMuscle))) {
    return res.status(422).json({ error: `${selectedExercise.name} is not mapped to ${selectedTargetMuscle}. Choose a compatible exercise and target muscle.` });
  }
  if (slots.some((exercise) => exercise.id !== slot.id
    && normalizeExerciseValue(exercise.sourceExerciseName || "") === normalizeExerciseValue(selectedExercise.name))) {
    return res.status(409).json({ error: "That exercise is already in this workout." });
  }
  const canonicalExerciseName = selectedExercise.name;

  const aliasToEquipment = new Map<string, { id: string; name: string }>();
  allEquipment.filter((row) => normalizeExerciseValue(row.name) !== "no equipment")
    .forEach((row) => aliasToEquipment.set(normalizeExerciseValue(row.name), row));
  for (const alias of equipmentAliases) {
    const equipment = allEquipment.find((row) => row.id === alias.equipmentId);
    if (equipment && !aliasToEquipment.has(normalizeExerciseValue(alias.alias))) {
      aliasToEquipment.set(normalizeExerciseValue(alias.alias), equipment);
    }
  }
  const isBodyweight = normalizeExerciseValue(equipmentName) === "bodyweight";
  const selectedEquipment = aliasToEquipment.get(normalizeExerciseValue(equipmentName));
  if (!isBodyweight && !selectedEquipment) return res.status(400).json({ error: "Choose equipment from the FitOS equipment catalog." });

  let snapshotIds: string[] = [];
  try {
    const snapshot = typeof workout.equipmentSnapshot === "string" ? JSON.parse(workout.equipmentSnapshot) : workout.equipmentSnapshot;
    if (Array.isArray(snapshot)) snapshotIds = snapshot.filter((id): id is string => typeof id === "string");
  } catch { /* Legacy workout: saved inventory is checked below. */ }
  const fullGym = workout.equipmentMode === "FULL_GYM";
  const availableIds = new Set(fullGym
    ? allEquipment.map((row) => row.id)
    : snapshotIds.length
      ? snapshotIds
      : workout.equipmentMode === "SCANNED"
        ? []
        : (await db.all<{ equipmentId: string }>(`SELECT equipmentId FROM UserEquipment WHERE userId = ?`, req.userId!)).map((row) => row.equipmentId));
  if (!isBodyweight && selectedEquipment && !availableIds.has(selectedEquipment.id)) {
    return res.status(422).json({ error: `${selectedEquipment.name} was not available for this workout.` });
  }

  const chosenMachine = isBodyweight ? "Bodyweight" : selectedEquipment!.name;
  if (selectedExercise.requiresEquipment === 0 && !isBodyweight) {
    return res.status(422).json({ error: `${selectedExercise.name} does not require equipment. Choose Bodyweight.` });
  }
  if (selectedExercise.requiresEquipment === 1 && isBodyweight) {
    return res.status(422).json({ error: `${selectedExercise.name} requires equipment. Choose compatible equipment.` });
  }
  const mappedEquipment = await db.all<{ name: string }>(
    `SELECT eq.name FROM ExerciseEquipment ee JOIN Equipment eq ON eq.id = ee.equipmentId WHERE ee.exerciseId = ?`,
    selectedExercise.id,
  );
  if (mappedEquipment.length && !isBodyweight
    && !mappedEquipment.some((row) => normalizeExerciseValue(row.name) === normalizeExerciseValue(chosenMachine))) {
    return res.status(422).json({ error: `${selectedExercise.name} is not mapped to ${chosenMachine}. Choose compatible equipment.` });
  }
  const otherSlots = slots.filter((exercise) => exercise.id !== slot.id);
  const remainingCoverage = targetMuscles.filter((muscle) => normalizeExerciseValue(muscle) !== normalizeExerciseValue(selectedTargetMuscle));
  const coverageTargets = remainingCoverage.length ? remainingCoverage : targetMuscles;
  const recommendationEquipment = fullGym ? [] : [...new Set([
    ...allEquipment.filter((row) => availableIds.has(row.id)).map((row) => row.name),
    ...equipmentAliases.filter((row) => availableIds.has(row.equipmentId)).map((row) => row.alias),
    "Bodyweight",
  ])];
  let recommendations = otherSlots.length
    ? exerciseRecommendationService.getRecommendedExercises({
      targetMuscles: coverageTargets,
      sessionDurationMinutes: workout.durationMin,
      requestedCount: otherSlots.length,
      availableEquipment: recommendationEquipment,
      equipmentMode: fullGym ? "FULL_GYM" : workout.equipmentMode === "SCANNED" ? "SCANNED" : "USER_EQUIPMENT",
      // Recalculate against the replacement's movement family. Existing
      // suggestions remain eligible and are kept only if the new selection
      // still ranks them for this workout's targets and equipment.
      excludedExerciseNames: [canonicalExerciseName],
      excludedExerciseFamilyKeys: [exerciseFamilyKey(canonicalExerciseName)],
    }).exercises
    : [];
  if (recommendations.length < otherSlots.length) {
    const fallbackEquipment = allEquipment
      .filter((row) => availableIds.has(row.id) && normalizeExerciseValue(row.name) !== "no equipment")
      .map((row) => ({
        name: row.name,
        aliases: equipmentAliases.filter((alias) => alias.equipmentId === row.id).map((alias) => alias.alias),
      }));
    if (!fallbackEquipment.some((row) => normalizeExerciseValue(row.name) === "bodyweight")) {
      fallbackEquipment.push({ name: "Bodyweight", aliases: [] });
    }
    const missingCount = otherSlots.length - recommendations.length;
    const aiRecommendations = await getAiExerciseFallback({
      targetMuscles: coverageTargets,
      sessionDurationMinutes: workout.durationMin,
      count: missingCount,
      equipment: fallbackEquipment,
      excludedExerciseNames: [canonicalExerciseName, ...recommendations.map((exercise) => exercise.exercise)],
      excludedFamilyKeys: [exerciseFamilyKey(canonicalExerciseName), ...recommendations.map((exercise) => exercise.exercise)],
    });
    recommendations = [...recommendations, ...aiRecommendations.map((exercise, index) => ({
      ...exercise,
      sourceIndex: -1000 - index,
    }))];
  }
  if (recommendations.length !== otherSlots.length) {
    return res.status(422).json({
      code: "WORKOUT_REBALANCE_UNAVAILABLE",
      error: "FitOS couldn't find enough distinct exercises for this workout with the selected equipment. Your current workout was left unchanged.",
    });
  }
  const persisted = await ensureExerciseRows(db, recommendations);
  await db.run(
    `UPDATE WorkoutExercise SET exerciseId=?,status='pending',sourceExerciseName=?,sourceMuscle=?,sourcePrimaryMuscle=?,sourceMachine=? WHERE id=? AND workoutId=?`,
    selectedExercise.id, canonicalExerciseName, selectedTargetMuscle, selectedTargetMuscle, chosenMachine, slot.id, req.params.id,
  );
  for (const [index, exercise] of recommendations.entries()) {
    const exerciseRecord = persisted.get(exercise.sourceIndex);
    const otherSlot = otherSlots[index];
    if (!exerciseRecord || !otherSlot) continue;
    await db.run(
      `UPDATE WorkoutExercise SET exerciseId=?,status='pending',sourceExerciseName=?,sourceMuscle=?,sourcePrimaryMuscle=?,sourceMachine=? WHERE id=? AND workoutId=?`,
      exerciseRecord.id, exercise.exercise, exercise.muscle, exercise.primaryMuscle, exercise.machine, otherSlot.id, req.params.id,
    );
  }
  return res.json({ updated: true, rebalancedExerciseCount: recommendations.length, targetMuscles: coverageTargets });
});

workoutRouter.post("/:id/skip-exercise", async (req: AuthedRequest, res) => {
  const { workoutExerciseId } = req.body || {};
  const exercise = await db.get<any>(`SELECT * FROM WorkoutExercise WHERE id = ?`, workoutExerciseId);
  if (!exercise || exercise.workoutId !== req.params.id)
    return res.status(404).json({ error: "Workout exercise not found" });
  await db.run(`UPDATE WorkoutExercise SET status = 'skipped' WHERE id = ?`, workoutExerciseId);
  return res.json({ status: "skipped" });
});

workoutRouter.post("/:id/report-pain", async (req: AuthedRequest, res) => {
  const { workoutExerciseId } = req.body || {};
  const exercise = await db.get<any>(`SELECT * FROM WorkoutExercise WHERE id = ?`, workoutExerciseId);
  if (!exercise || exercise.workoutId !== req.params.id)
    return res.status(404).json({ error: "Workout exercise not found" });
  await db.run(`UPDATE WorkoutExercise SET painReported = 1 WHERE id = ?`, workoutExerciseId);
  return res.json({
    warning: "Stop performing this exercise. Pain during exercise is not something this app can assess — please consult a qualified medical professional before continuing this movement.",
    suggestion: "Use POST /workouts/:id/replace-exercise with reason=pain to get an alternative movement pattern.",
  });
});
