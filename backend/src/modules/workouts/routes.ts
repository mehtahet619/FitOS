import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import { db, nowIso } from "../../db/client";
import { requireAuth, AuthedRequest } from "../../common/auth";
import { generateWorkout } from "./workoutGenerator";
import { loadExerciseWithLinks, loadSubstituteCandidates, pickSubstitute } from "../exercises/substitutionEngine";
import { getAiProvider } from "../../ai/provider";
import {
  canSwitchWorkoutPlan,
  getActiveWorkoutPlan,
  getCompletedWorkoutUnits,
  getCycleHistory,
  getCurrentCycle,
  getExercisesForWorkout,
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

export const workoutRouter = Router();
workoutRouter.use(requireAuth);

workoutRouter.get("/plan/structures", async (_req, res) => {
  return res.json({ structures: listAvailableStructures() });
});

workoutRouter.get("/plan", async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const state = await getPlanState(db, userId);
  const activePlan = await getActiveWorkoutPlan(db, userId);
  const cycle = await getCurrentCycle(db, userId);
  const decision = await getTodayWorkoutDecision(db, userId);
  const recentlyTrained = await getRecentlyTrainedMuscles(db, userId);
  const snapshot = serializePlanSnapshot(state);

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
    currentIndex: state?.currentIndex ?? 0,
    completedUnits: state ? listCompletedUnits(state) : [],
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
    units: state?.units ?? [],
    workoutUnits: snapshot.workoutUnits,
    stateSnapshot: snapshot,
    plan: activePlan,
    cycle,
    recentlyTrainedMuscles: recentlyTrained,
    decision,
  });
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
  dayIndex: z.number().int().min(0).optional(),
});

workoutRouter.post("/generate", async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const profile = await db.get<any>(`SELECT * FROM UserProfile WHERE userId = ?`, userId);
  if (!profile) return res.status(400).json({ error: "Complete onboarding (PUT /user/profile) first" });

  const parsed = generateSchema.safeParse(req.body ?? {});
  const state = await getPlanState(db, userId);
  const requiredUnit = state ? nextUnit(state) : undefined;

  if (state?.activeWorkoutId) return res.status(409).json({ error: "Complete the active workout before generating another one." });
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

  const recentlyTrained = await getRecentlyTrainedMuscles(db, userId);
  const recentMuscleSet = new Set(recentlyTrained.map((r) => r.muscle));
  const overlap = requiredUnit.muscles.filter((m) => recentMuscleSet.has(m));
  const remaining = remainingUnits(state);
  if (overlap.length > 0 && remaining.length > 1) {
    console.info(
      `Recovery note: ${overlap.join(", ")} were trained recently. Enforcing plan order requires ${requiredUnit.label} next per plan progression rules.`
    );
  }

  const { exercises } = await generateWorkout(db, userId, focus, profile.sessionMinutes, {
    lockToMuscles: requiredUnit.muscles,
  });
  if (exercises.length === 0) {
    return res.status(422).json({
      error:
        "No exercises could be resolved for your current equipment for this focus. Try adding at least bodyweight-friendly equipment or a different focus.",
    });
  }

  const workoutId = uuidv4();
  const ts = nowIso();
  const workoutExerciseIds: string[] = [];
  await db.run(
    `INSERT INTO Workout (id, userId, workoutPlanId, focus, status, durationMin, createdAt, completedAt) VALUES (?, ?, NULL, ?, 'pending', ?, ?, NULL)`,
    workoutId, userId, focus, profile.sessionMinutes, ts
  );
  if (state)
    await db.run(`UPDATE WorkoutPlanState SET activeWorkoutId = ? WHERE userId = ?`, workoutId, userId);
  for (const [idx, exercise] of exercises.entries()) {
    const id = uuidv4();
    workoutExerciseIds.push(id);
    await db.run(
      `INSERT INTO WorkoutExercise (id, workoutId, exerciseId, orderIndex, targetSets, repRangeLow, repRangeHigh, status, replacedFromId, painReported) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL, 0)`,
      id, workoutId, exercise.exerciseId, idx, exercise.sets, exercise.repRangeLow, exercise.repRangeHigh
    );
  }

  const summary = await getAiProvider().explainWorkout({
    focus,
    exerciseNames: exercises.map((exercise) => exercise.name),
  });
  return res.status(201).json({
    workout: { id: workoutId, focus, durationMin: profile.sessionMinutes, status: "pending" },
    exercises: exercises.map((exercise, idx) => ({ workoutExerciseId: workoutExerciseIds[idx], ...exercise })),
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
  const exercises = await getExercisesForWorkout(db, userId, next as WorkoutUnit);
  return res.json({
    workoutUnit: next,
    targetMuscles: (next as WorkoutUnit).muscles,
    exercises,
  });
});

workoutRouter.get("/today", async (req: AuthedRequest, res) => {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const workout = await db.get<any>(
    `SELECT * FROM Workout WHERE userId = ? AND createdAt >= ? ORDER BY createdAt DESC LIMIT 1`,
    req.userId!, startOfDay.toISOString()
  );
  if (!workout) return res.status(404).json({ error: "No workout generated today yet. POST /workouts/generate" });
  const exercises = await db.all<any>(
    `SELECT we.*, e.name as exerciseName, e.primaryMuscle, e.instructions FROM WorkoutExercise we JOIN Exercise e ON e.id = we.exerciseId WHERE we.workoutId = ? ORDER BY we.orderIndex ASC`,
    workout.id
  );
  return res.json({
    id: workout.id,
    focus: workout.focus,
    status: workout.status,
    durationMin: workout.durationMin,
    exercises: exercises.map((exercise) => ({
      workoutExerciseId: exercise.id,
      exerciseId: exercise.exerciseId,
      name: exercise.exerciseName,
      primaryMuscle: exercise.primaryMuscle,
      instructions: exercise.instructions,
      targetSets: exercise.targetSets,
      repRangeLow: exercise.repRangeLow,
      repRangeHigh: exercise.repRangeHigh,
      status: exercise.status,
      painReported: !!exercise.painReported,
    })),
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
  const exercise = await db.get<any>(`SELECT * FROM WorkoutExercise WHERE id = ?`, workoutExerciseId);
  if (!exercise || exercise.workoutId !== req.params.id)
    return res.status(404).json({ error: "Workout exercise not found" });
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
  return res.json({
    status: "completed",
    cycle: completionResult,
  });
});

const replaceSchema = z.object({
  workoutExerciseId: z.string(),
  reason: z.enum(["no_equipment", "pain", "user_preference"]).default("no_equipment"),
});

workoutRouter.post("/:id/replace-exercise", async (req: AuthedRequest, res) => {
  const parsed = replaceSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid input" });
  const { workoutExerciseId, reason } = parsed.data;
  const exerciseRow = await db.get<any>(`SELECT * FROM WorkoutExercise WHERE id = ?`, workoutExerciseId);
  if (!exerciseRow || exerciseRow.workoutId !== req.params.id)
    return res.status(404).json({ error: "Workout exercise not found" });
  if (reason === "pain")
    await db.run(`UPDATE WorkoutExercise SET painReported = 1 WHERE id = ?`, workoutExerciseId);
  const equipmentRows = await db.all<{ equipmentId: string }>(
    `SELECT equipmentId FROM UserEquipment WHERE userId = ?`, req.userId!);
  const base = await loadExerciseWithLinks(db, exerciseRow.exerciseId);
  if (!base) return res.status(404).json({ error: "Exercise not found" });
  const candidates = await loadSubstituteCandidates(db, base.id);
  const usedRows = await db.all<{ exerciseId: string }>(
    `SELECT exerciseId FROM WorkoutExercise WHERE workoutId = ?`, req.params.id);
  const usedIds = new Set(usedRows.map((row) => row.exerciseId));
  const freshCandidates = candidates.filter((candidate) => !usedIds.has(candidate.id));
  const substitute = pickSubstitute(
    base, freshCandidates.length ? freshCandidates : candidates, new Set(equipmentRows.map((row) => row.equipmentId)));
  if (!substitute)
    return res.status(422).json({
      error: `No performable substitute found for "${base.name}" with your current equipment. Consider adding equipment or skipping this exercise.`,
    });
  await db.run(
    `UPDATE WorkoutExercise SET exerciseId = ?, replacedFromId = ?, status = 'replaced', targetSets = ?, repRangeLow = ?, repRangeHigh = ? WHERE id = ?`,
    substitute.id, exerciseRow.exerciseId, substitute.defaultSets, substitute.repRangeLow, substitute.repRangeHigh, workoutExerciseId
  );
  const reasonText = reason === "pain"
    ? "you reported discomfort on the original movement"
    : reason === "no_equipment"
      ? "that equipment isn't available to you right now"
      : "you asked for a change";
  const explanation = await getAiProvider().explainSubstitution({
    originalExercise: base.name,
    substituteExercise: substitute.name,
    reason: reasonText,
  });
  return res.json({
    replaced: { from: base.name, to: substitute.name },
    exercise: {
      exerciseId: substitute.id,
      name: substitute.name,
      primaryMuscle: substitute.primaryMuscle,
      instructions: substitute.instructions,
      sets: substitute.defaultSets,
      repRangeLow: substitute.repRangeLow,
      repRangeHigh: substitute.repRangeHigh,
    },
    explanation,
  });
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
