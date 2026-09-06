import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import { db, nowIso } from "../../db/client";
import { requireAuth, AuthedRequest } from "../../common/auth";
import { generateWorkout, pickFocusForDay } from "./workoutGenerator";
import { loadExerciseWithLinks, loadSubstituteCandidates, pickSubstitute } from "../exercises/substitutionEngine";
import { getAiProvider } from "../../ai/provider";

export const workoutRouter = Router();
workoutRouter.use(requireAuth);

const generateSchema = z.object({
  focus: z.string().optional(),
  dayIndex: z.number().int().min(0).optional(),
});

workoutRouter.post("/generate", async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const profile = await db.get<any>(`SELECT * FROM UserProfile WHERE userId = ?`, userId);
  if (!profile) return res.status(400).json({ error: "Complete onboarding (PUT /user/profile) first" });

  const parsed = generateSchema.safeParse(req.body ?? {});
  const focus = parsed.success && parsed.data.focus
    ? parsed.data.focus
    : pickFocusForDay(parsed.success ? parsed.data.dayIndex ?? 0 : 0, profile.daysPerWeek);
  const { exercises } = await generateWorkout(db, userId, focus, profile.sessionMinutes);
  if (exercises.length === 0) {
    return res.status(422).json({ error: "No exercises could be resolved for your current equipment for this focus. Try adding at least bodyweight-friendly equipment or a different focus." });
  }

  const workoutId = uuidv4();
  const ts = nowIso();
  const workoutExerciseIds: string[] = [];
  await db.run(`INSERT INTO Workout (id, userId, workoutPlanId, focus, status, durationMin, createdAt, completedAt) VALUES (?, ?, NULL, ?, 'pending', ?, ?, NULL)`, workoutId, userId, focus, profile.sessionMinutes, ts);
  for (const [idx, exercise] of exercises.entries()) {
    const id = uuidv4();
    workoutExerciseIds.push(id);
    await db.run(`INSERT INTO WorkoutExercise (id, workoutId, exerciseId, orderIndex, targetSets, repRangeLow, repRangeHigh, status, replacedFromId, painReported) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL, 0)`, id, workoutId, exercise.exerciseId, idx, exercise.sets, exercise.repRangeLow, exercise.repRangeHigh);
  }

  const summary = await getAiProvider().explainWorkout({ focus, exerciseNames: exercises.map((exercise) => exercise.name) });
  return res.status(201).json({
    workout: { id: workoutId, focus, durationMin: profile.sessionMinutes, status: "pending" },
    exercises: exercises.map((exercise, idx) => ({ workoutExerciseId: workoutExerciseIds[idx], ...exercise })),
    summary,
  });
});

workoutRouter.get("/today", async (req: AuthedRequest, res) => {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const workout = await db.get<any>(`SELECT * FROM Workout WHERE userId = ? AND createdAt >= ? ORDER BY createdAt DESC LIMIT 1`, req.userId!, startOfDay.toISOString());
  if (!workout) return res.status(404).json({ error: "No workout generated today yet. POST /workouts/generate" });
  const exercises = await db.all<any>(`SELECT we.*, e.name as exerciseName, e.primaryMuscle, e.instructions FROM WorkoutExercise we JOIN Exercise e ON e.id = we.exerciseId WHERE we.workoutId = ? ORDER BY we.orderIndex ASC`, workout.id);
  return res.json({ id: workout.id, focus: workout.focus, status: workout.status, durationMin: workout.durationMin, exercises: exercises.map((exercise) => ({ workoutExerciseId: exercise.id, exerciseId: exercise.exerciseId, name: exercise.exerciseName, primaryMuscle: exercise.primaryMuscle, instructions: exercise.instructions, targetSets: exercise.targetSets, repRangeLow: exercise.repRangeLow, repRangeHigh: exercise.repRangeHigh, status: exercise.status, painReported: !!exercise.painReported })) });
});

const completeSetSchema = z.object({ workoutExerciseId: z.string(), setNumber: z.number().int().positive(), weightKg: z.number().nonnegative().optional(), reps: z.number().int().nonnegative().optional() });

workoutRouter.post("/:id/complete-set", async (req: AuthedRequest, res) => {
  const parsed = completeSetSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid input" });
  const { workoutExerciseId, setNumber, weightKg, reps } = parsed.data;
  const exercise = await db.get<any>(`SELECT * FROM WorkoutExercise WHERE id = ?`, workoutExerciseId);
  if (!exercise || exercise.workoutId !== req.params.id) return res.status(404).json({ error: "Workout exercise not found" });
  const setId = uuidv4();
  const ts = nowIso();
  await db.run(`INSERT INTO WorkoutSet (id, workoutExerciseId, setNumber, weightKg, reps, completed, createdAt) VALUES (?, ?, ?, ?, ?, 1, ?)`, setId, workoutExerciseId, setNumber, weightKg ?? null, reps ?? null, ts);
  await db.run(`INSERT INTO WorkoutHistory (id, userId, exerciseId, weightKg, reps, volumeKg, recordedAt) VALUES (?, ?, ?, ?, ?, ?, ?)`, uuidv4(), req.userId!, exercise.exerciseId, weightKg ?? null, reps ?? null, weightKg && reps ? weightKg * reps : null, ts);
  return res.status(201).json(await db.get(`SELECT * FROM WorkoutSet WHERE id = ?`, setId));
});

workoutRouter.post("/:id/complete", async (req: AuthedRequest, res) => {
  const workout = await db.get<any>(`SELECT * FROM Workout WHERE id = ?`, req.params.id);
  if (!workout || workout.userId !== req.userId) return res.status(404).json({ error: "Workout not found" });
  await db.run(`UPDATE Workout SET status = 'completed', completedAt = ? WHERE id = ?`, nowIso(), req.params.id);
  await db.run(`UPDATE WorkoutExercise SET status = 'completed' WHERE workoutId = ? AND status = 'pending'`, req.params.id);
  return res.json({ status: "completed" });
});

const replaceSchema = z.object({ workoutExerciseId: z.string(), reason: z.enum(["no_equipment", "pain", "user_preference"]).default("no_equipment") });

workoutRouter.post("/:id/replace-exercise", async (req: AuthedRequest, res) => {
  const parsed = replaceSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid input" });
  const { workoutExerciseId, reason } = parsed.data;
  const exerciseRow = await db.get<any>(`SELECT * FROM WorkoutExercise WHERE id = ?`, workoutExerciseId);
  if (!exerciseRow || exerciseRow.workoutId !== req.params.id) return res.status(404).json({ error: "Workout exercise not found" });
  if (reason === "pain") await db.run(`UPDATE WorkoutExercise SET painReported = 1 WHERE id = ?`, workoutExerciseId);
  const equipmentRows = await db.all<{ equipmentId: string }>(`SELECT equipmentId FROM UserEquipment WHERE userId = ?`, req.userId!);
  const base = await loadExerciseWithLinks(db, exerciseRow.exerciseId);
  if (!base) return res.status(404).json({ error: "Exercise not found" });
  const candidates = await loadSubstituteCandidates(db, base.id);
  const usedRows = await db.all<{ exerciseId: string }>(`SELECT exerciseId FROM WorkoutExercise WHERE workoutId = ?`, req.params.id);
  const usedIds = new Set(usedRows.map((row) => row.exerciseId));
  const freshCandidates = candidates.filter((candidate) => !usedIds.has(candidate.id));
  const substitute = pickSubstitute(base, freshCandidates.length ? freshCandidates : candidates, new Set(equipmentRows.map((row) => row.equipmentId)));
  if (!substitute) return res.status(422).json({ error: `No performable substitute found for "${base.name}" with your current equipment. Consider adding equipment or skipping this exercise.` });
  await db.run(`UPDATE WorkoutExercise SET exerciseId = ?, replacedFromId = ?, status = 'replaced', targetSets = ?, repRangeLow = ?, repRangeHigh = ? WHERE id = ?`, substitute.id, exerciseRow.exerciseId, substitute.defaultSets, substitute.repRangeLow, substitute.repRangeHigh, workoutExerciseId);
  const reasonText = reason === "pain" ? "you reported discomfort on the original movement" : reason === "no_equipment" ? "that equipment isn't available to you right now" : "you asked for a change";
  const explanation = await getAiProvider().explainSubstitution({ originalExercise: base.name, substituteExercise: substitute.name, reason: reasonText });
  return res.json({ replaced: { from: base.name, to: substitute.name }, exercise: { exerciseId: substitute.id, name: substitute.name, primaryMuscle: substitute.primaryMuscle, instructions: substitute.instructions, sets: substitute.defaultSets, repRangeLow: substitute.repRangeLow, repRangeHigh: substitute.repRangeHigh }, explanation });
});

workoutRouter.post("/:id/skip-exercise", async (req: AuthedRequest, res) => {
  const { workoutExerciseId } = req.body || {};
  const exercise = await db.get<any>(`SELECT * FROM WorkoutExercise WHERE id = ?`, workoutExerciseId);
  if (!exercise || exercise.workoutId !== req.params.id) return res.status(404).json({ error: "Workout exercise not found" });
  await db.run(`UPDATE WorkoutExercise SET status = 'skipped' WHERE id = ?`, workoutExerciseId);
  return res.json({ status: "skipped" });
});

workoutRouter.post("/:id/report-pain", async (req: AuthedRequest, res) => {
  const { workoutExerciseId } = req.body || {};
  const exercise = await db.get<any>(`SELECT * FROM WorkoutExercise WHERE id = ?`, workoutExerciseId);
  if (!exercise || exercise.workoutId !== req.params.id) return res.status(404).json({ error: "Workout exercise not found" });
  await db.run(`UPDATE WorkoutExercise SET painReported = 1 WHERE id = ?`, workoutExerciseId);
  return res.json({ warning: "Stop performing this exercise. Pain during exercise is not something this app can assess — please consult a qualified medical professional before continuing this movement.", suggestion: "Use POST /workouts/:id/replace-exercise with reason=pain to get an alternative movement pattern." });
});
