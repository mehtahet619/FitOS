import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { db, nowIso } from "../../db/client";
import { requireAuth, AuthedRequest } from "../../common/auth";

export const progressRouter = Router();
progressRouter.use(requireAuth);

progressRouter.get("/dashboard", async (req: AuthedRequest, res) => {
  const userId = req.userId!;

  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const startOfWeek = new Date();
  startOfWeek.setDate(startOfWeek.getDate() - 7);

  const todayWorkout = await db.get<any>(
    `SELECT * FROM Workout WHERE userId = ? AND createdAt >= ? ORDER BY createdAt DESC LIMIT 1`,
    userId,
    startOfDay.toISOString()
  );

  const personalRecords = await db.all<any>(
    `SELECT pr.*, e.name as exerciseName FROM PersonalRecord pr JOIN Exercise e ON e.id = pr.exerciseId WHERE pr.userId = ?`,
    userId
  );

  const weekHistory = await db.all<any>(
    `SELECT * FROM WorkoutHistory WHERE userId = ? AND recordedAt >= ?`,
    userId,
    startOfWeek.toISOString()
  );

  const workoutsThisWeek = (await db.get<{ c: number }>(
    `SELECT COUNT(*) as c FROM Workout WHERE userId = ? AND createdAt >= ?`,
    userId,
    startOfWeek.toISOString()
  ))?.c ?? 0;

  const weeklyVolumeKg = weekHistory.reduce((sum, h) => sum + (h.volumeKg ?? 0), 0);

  const muscleVolume: Record<string, number> = {};
  for (const h of weekHistory) {
    const exercise = await db.get<{ primaryMuscle: string }>(`SELECT primaryMuscle FROM Exercise WHERE id = ?`, h.exerciseId);
    if (!exercise) continue;
    muscleVolume[exercise.primaryMuscle] = (muscleVolume[exercise.primaryMuscle] ?? 0) + (h.volumeKg ?? 0);
  }

  return res.json({
    todaysPlan: todayWorkout
      ? {
          workoutId: todayWorkout.id,
          focus: todayWorkout.focus,
          durationMin: todayWorkout.durationMin,
          status: todayWorkout.status,
        }
      : null,
    progress: {
      weeklyVolumeKg: Math.round(weeklyVolumeKg),
      muscleGroupVolumeKg: muscleVolume,
      workoutsThisWeek,
      personalRecords: personalRecords.map((pr) => ({
        exercise: pr.exerciseName,
        weightKg: pr.weightKg,
        reps: pr.reps,
        estOneRepMax: pr.estOneRepMax,
      })),
    },
  });
});

progressRouter.post("/metric", async (req: AuthedRequest, res) => {
  const { metric, value } = req.body || {};
  if (!metric || typeof value !== "number") return res.status(400).json({ error: "metric and numeric value required" });
  const id = uuidv4();
  const ts = nowIso();
  await db.run(`INSERT INTO ProgressMetric (id, userId, metric, value, recordedAt) VALUES (?, ?, ?, ?, ?)`,
    id,
    req.userId!,
    metric,
    value,
    ts
  );
  const row = await db.get(`SELECT * FROM ProgressMetric WHERE id = ?`, id);
  return res.status(201).json(row);
});
