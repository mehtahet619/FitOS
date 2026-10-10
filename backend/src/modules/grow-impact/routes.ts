import { Router } from "express";
import rateLimit from "express-rate-limit";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import { requireAuth, AuthedRequest } from "../../common/auth";
import { db, nowIso } from "../../db/client";
import { getGrowImpactConfig, getMonthWindow, uniqueCompletedSessionDays, virtualGrowthStage } from "./service";

export const growImpactRouter = Router();
growImpactRouter.use(requireAuth);

const rewardChangesLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });

interface WorkoutRow {
  [key: string]: unknown;
  status: string;
  completedAt: string | null;
  durationMin: number;
  completedSetCount: number;
}

interface RewardRow {
  [key: string]: unknown;
  id: string;
  userId: string;
  qualifyingMonth: string;
  status: string;
  selectedSpeciesId: string | null;
  selectedSpecies: string | null;
  selectedTreeName: string | null;
  selectedTreeImage: string | null;
  confirmedAt: string | null;
  plantingStatus: string;
  plantingReference: string | null;
  plantingLocation: string | null;
  plantedAt: string | null;
  verifiedPhotosJson: string;
  photoUpdatesOptIn: number;
  nextPhotoReminderAt: string | null;
};

async function currentImpact(userId: string, now = new Date()) {
  const config = getGrowImpactConfig(now);
  const window = getMonthWindow(now, config.timeZone);
  const workouts = await db.all<WorkoutRow>(
    `SELECT w.status,w.completedAt,w.durationMin,
      (SELECT COUNT(*) FROM WorkoutExercise we JOIN WorkoutSet ws ON ws.workoutExerciseId=we.id
       WHERE we.workoutId=w.id AND ws.completed=1) AS completedSetCount
     FROM Workout w
     WHERE w.userId=? AND w.completedAt>=? AND w.completedAt<? AND w.status='completed'`,
    userId, window.start.toISOString(), window.end.toISOString()
  );
  const dates = uniqueCompletedSessionDays(workouts, window.month, config.timeZone);
  const sessionCount = dates.length;

  let reward = await db.get<RewardRow>(
    `SELECT * FROM GrowImpactReward WHERE userId=? AND qualifyingMonth=?`, userId, window.month
  );
  if (sessionCount >= config.monthlyTarget && !reward) {
    const ts = nowIso();
    await db.run(
      `INSERT INTO GrowImpactReward
        (id,userId,qualifyingMonth,status,plantingStatus,verifiedPhotosJson,photoUpdatesOptIn,createdAt,updatedAt)
       VALUES (?,?,?,'unlocked','virtual_commitment','[]',0,?,?)
       ON CONFLICT(userId,qualifyingMonth) DO NOTHING`,
      uuidv4(), userId, window.month, ts, ts
    );
    reward = await db.get<RewardRow>(
      `SELECT * FROM GrowImpactReward WHERE userId=? AND qualifyingMonth=?`, userId, window.month
    );
  }

  const elapsedStage = reward?.status === "confirmed"
    ? virtualGrowthStage(reward.confirmedAt, now)
    : null;
  const verifiedUpdates = reward
    ? await db.all<{ stageLabel: string; location: string | null; plantedAt: string | null; verifiedPhotosJson: string; verifiedAt: string }>(
      `SELECT stageLabel,location,plantedAt,verifiedPhotosJson,verifiedAt FROM GrowImpactPartnerUpdate
       WHERE rewardId=? AND verifiedAt IS NOT NULL ORDER BY verifiedAt DESC`, reward.id)
    : [];

  return {
    month: window.month,
    sessions: sessionCount,
    completedSessionDates: dates,
    target: config.monthlyTarget,
    progressPercent: Math.min(100, Math.round(sessionCount / config.monthlyTarget * 100)),
    remaining: Math.max(0, config.monthlyTarget - sessionCount),
    calendarDays: window.calendarDays,
    monthLengthDays: config.monthLengthDays,
    sundayRestDays: window.sundayRestDays,
    holidayAllowanceDays: config.holidayAllowanceDays,
    plannedWorkoutDays: Math.max(0, config.monthLengthDays - window.sundayRestDays - config.holidayAllowanceDays),
    timeZone: config.timeZone,
    trees: config.trees,
    reward: reward ? {
      id: reward.id,
      status: reward.status,
      selectedSpeciesId: reward.selectedSpeciesId,
      selectedSpecies: reward.selectedSpecies,
      selectedTreeName: reward.selectedTreeName,
      selectedTreeImage: reward.selectedTreeImage,
      confirmedAt: reward.confirmedAt,
      plantingStatus: reward.plantingStatus,
      plantingReference: reward.plantingReference,
      plantingLocation: reward.plantingLocation,
      plantedAt: reward.plantedAt,
      verifiedPhotos: parsePhotoList(reward.verifiedPhotosJson),
      virtualStage: elapsedStage,
      verifiedUpdates: verifiedUpdates.map((update) => ({
        ...update, verifiedPhotos: parsePhotoList(update.verifiedPhotosJson),
      })),
    } : null,
  };
}

function parsePhotoList(value: string | null | undefined): string[] {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch { return []; }
}

growImpactRouter.get("/", async (req: AuthedRequest, res) => {
  return res.json(await currentImpact(req.userId!));
});

const chooseTreeSchema = z.object({ speciesId: z.string().min(1).max(80) });
growImpactRouter.post("/select", rewardChangesLimiter, async (req: AuthedRequest, res) => {
  const parsed = chooseTreeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Choose one of the available trees." });
  const impact = await currentImpact(req.userId!);
  if (impact.sessions < impact.target || !impact.reward) return res.status(403).json({ error: "Complete this month's session target to unlock a tree choice." });
  if (impact.reward.status === "confirmed") return res.status(409).json({ error: "Your tree choice has already been confirmed." });
  const tree = impact.trees.find((option) => option.id === parsed.data.speciesId);
  if (!tree) return res.status(400).json({ error: "That tree option is not available." });
  await db.run(
    `UPDATE GrowImpactReward SET status='selected',selectedSpeciesId=?,selectedSpecies=?,selectedTreeName=?,selectedTreeImage=?,updatedAt=?
     WHERE userId=? AND qualifyingMonth=? AND status<>'confirmed'`,
    tree.id, tree.species, tree.name, tree.image, nowIso(), req.userId!, impact.month
  );
  return res.json({ success: true, impact: await currentImpact(req.userId!) });
});

growImpactRouter.post("/confirm", rewardChangesLimiter, async (req: AuthedRequest, res) => {
  const impact = await currentImpact(req.userId!);
  if (impact.sessions < impact.target || !impact.reward) return res.status(403).json({ error: "Complete this month's session target to unlock a tree choice." });
  if (impact.reward.status === "confirmed") return res.json({ success: true, impact });
  if (impact.reward.status !== "selected" || !impact.reward.selectedSpeciesId) return res.status(409).json({ error: "Choose a tree before confirming." });
  const ts = nowIso();
  await db.run(
    `UPDATE GrowImpactReward SET status='confirmed',confirmedAt=?,plantingStatus='virtual_commitment',updatedAt=?
     WHERE userId=? AND qualifyingMonth=? AND status='selected'`,
    ts, ts, req.userId!, impact.month
  );
  return res.json({ success: true, impact: await currentImpact(req.userId!) });
});
