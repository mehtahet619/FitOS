import { Router } from "express";
import { db } from "../../db/client";
import { requireAuth, AuthedRequest } from "../../common/auth";
import { muscleRecoveryService } from "../workouts/muscleRecovery";

export const musclesRouter = Router();
musclesRouter.use(requireAuth);

// Get muscle readiness status for all muscles
musclesRouter.get("/status", async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const { hours = "168" } = req.query;

  const readiness = await muscleRecoveryService.getAllMuscleReadiness(
    db,
    userId,
    parseInt(hours as string, 10)
  );

  return res.json({ readiness });
});

// Get muscle readiness for a specific muscle
musclesRouter.get("/status/:muscleId", async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const { muscleId } = req.params;
  const { hours = "168" } = req.query;

  const readiness = await muscleRecoveryService.getMuscleReadiness(
    db,
    userId,
    muscleId,
    parseInt(hours as string, 10)
  );

  return res.json(readiness);
});

// Get muscle history for a user
musclesRouter.get("/history", async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const { hours = "168", muscleId } = req.query;

  let query = `
    SELECT mh.*, m.name as muscleName, e.name as exerciseName
    FROM MuscleHistory mh
    JOIN Muscle m ON m.id = mh.muscleId
    LEFT JOIN Exercise e ON e.id = mh.exerciseId
    WHERE mh.userId = ? AND mh.trainedAt >= datetime('now', '-' || ? || ' hours')
  `;
  const params: any[] = [userId, hours];

  if (muscleId) {
    query += ` AND mh.muscleId = ?`;
    params.push(muscleId);
  }

  query += ` ORDER BY mh.trainedAt DESC`;

  const history = await db.all(query, ...params);
  return res.json({ history });
});