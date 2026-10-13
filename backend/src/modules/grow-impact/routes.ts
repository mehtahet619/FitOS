import { Router } from "express";
import rateLimit from "express-rate-limit";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import { requireAuth, AuthedRequest } from "../../common/auth";
import { db, nowIso } from "../../db/client";
import {
  getGrowImpactConfig,
  getImpactLocation,
  getMonthWindow,
  getUserImpactSettings,
  refreshMonthlyProgress,
  virtualGrowthStage,
} from "./service";

export const growImpactRouter = Router();
growImpactRouter.use(requireAuth);

const rewardChangesLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });

interface RewardRow {
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

async function currentImpact(userId: string, requestedMonth?: string, now = new Date()) {
  const userSettings = await getUserImpactSettings(db, userId);
  const config = getGrowImpactConfig();
  const timeZone = userSettings.timeZone;
  const month = requestedMonth || getMonthWindow(now, timeZone).month;
  const progress = await refreshMonthlyProgress(db, userId, month, timeZone, now, userSettings);
  const sessionCount = progress.completedSessions;
  const target = progress.target;
  let reward = await db.get<RewardRow>(
    `SELECT * FROM GrowImpactReward WHERE userId=? AND qualifyingMonth=?`, userId, month
  );

  const elapsedStage = reward?.status === "confirmed"
    ? virtualGrowthStage(reward.confirmedAt, now)
    : null;
  const verifiedUpdates = reward
    ? await db.all<{ stageLabel: string; location: string | null; plantedAt: string | null; verifiedPhotosJson: string; verifiedAt: string }>(
      `SELECT stageLabel,location,plantedAt,verifiedPhotosJson,verifiedAt FROM GrowImpactPartnerUpdate
       WHERE rewardId=? AND verifiedAt IS NOT NULL ORDER BY verifiedAt DESC`, reward.id)
    : [];

  return {
    month,
    year: Number(month.slice(0, 4)),
    location: {
      key: progress.location.key,
      countryCode: progress.location.countryCode,
      regionCode: progress.location.regionCode,
      countryName: progress.location.countryName,
      regionName: progress.location.regionName,
      timeZone: progress.timeZone,
    },
    sessions: sessionCount,
    completedSessionDates: progress.completedSessionDates,
    target,
    progressPercent: progress.progressPercent,
    remaining: progress.remainingSessions,
    calendarDays: progress.calendarDays,
    sundayRestDays: progress.sundayRestDays,
    sundayDates: progress.sundayDates,
    holidayCount: progress.holidayCount,
    holidayCalendarConfigured: progress.holidayCalendarConfigured,
    holidaySundayCount: progress.holidaySundayCount,
    additionalClosureCount: progress.additionalClosureCount,
    holidayDates: progress.holidayDates,
    eligibleDays: progress.eligibleDays,
    growthStageIndex: progress.growthStageIndex,
    growthStageCount: progress.growthStageCount,
    growthStageLabel: progress.growthStageLabel,
    nextMilestone: progress.nextMilestone,
    timeZone: progress.timeZone,
    settings: {
      gymOpenOnHolidayDates: progress.settings.gymOpenOnHolidayDates,
      additionalClosureDates: progress.settings.additionalClosureDates,
    },
    locations: config.locations.map((location) => ({
      key: location.key, countryCode: location.countryCode, regionCode: location.regionCode,
      countryName: location.countryName, regionName: location.regionName, timeZone: location.timeZone,
    })),
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
  const month = typeof req.query.month === "string" ? req.query.month : undefined;
  if (month && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return res.status(400).json({ error: "Month must use YYYY-MM format." });
  return res.json(await currentImpact(req.userId!, month));
});

const dateListSchema = z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).max(100);
const settingsSchema = z.object({
  locationKey: z.string().regex(/^[A-Z]{2}-[A-Z0-9]{2,3}$/),
  gymOpenOnHolidayDates: dateListSchema,
  additionalClosureDates: dateListSchema,
});

growImpactRouter.put("/settings", rewardChangesLimiter, async (req: AuthedRequest, res) => {
  const parsed = settingsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Check the location and gym closure dates." });
  let location;
  try { location = getImpactLocation(parsed.data.locationKey); }
  catch (error) { return res.status(400).json({ error: error instanceof Error ? error.message : "Unsupported location." }); }
  const knownHolidayDates = new Set(Object.values(location.holidaysByYear).flat().map((holiday) => holiday.date));
  if (parsed.data.gymOpenOnHolidayDates.some((date) => !knownHolidayDates.has(date))) {
    return res.status(400).json({ error: "Only dates in this location's public holiday calendar can be marked open." });
  }
  const validDates = (dates: string[]) => dates.every((date) => {
    const [year, month, day] = date.split("-").map(Number);
    return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10) === date;
  });
  if (!validDates(parsed.data.gymOpenOnHolidayDates) || !validDates(parsed.data.additionalClosureDates)) {
    return res.status(400).json({ error: "Closure dates must be valid calendar dates." });
  }
  const ts = nowIso();
  await db.run(
    `INSERT INTO GrowImpactSettings
      (id,userId,countryCode,regionCode,timeZone,gymOpenOnHolidayDatesJson,additionalClosureDatesJson,createdAt,updatedAt)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(userId) DO UPDATE SET countryCode=excluded.countryCode,regionCode=excluded.regionCode,
      timeZone=excluded.timeZone,gymOpenOnHolidayDatesJson=excluded.gymOpenOnHolidayDatesJson,
      additionalClosureDatesJson=excluded.additionalClosureDatesJson,updatedAt=excluded.updatedAt`,
    uuidv4(), req.userId!, location.countryCode, location.regionCode, location.timeZone,
    JSON.stringify([...new Set(parsed.data.gymOpenOnHolidayDates)]),
    JSON.stringify([...new Set(parsed.data.additionalClosureDates)]), ts, ts,
  );
  return res.json({ success: true, impact: await currentImpact(req.userId!) });
});

const qualifyingMonthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const chooseTreeSchema = z.object({
  speciesId: z.string().min(1).max(80), month: qualifyingMonthSchema.optional(),
});
growImpactRouter.post("/select", rewardChangesLimiter, async (req: AuthedRequest, res) => {
  const parsed = chooseTreeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Choose one of the available trees." });
  const impact = await currentImpact(req.userId!, parsed.data.month);
  if (impact.target === 0 || impact.sessions < impact.target || !impact.reward) return res.status(403).json({ error: "Complete this month's session target to unlock a tree choice." });
  if (impact.reward.status === "confirmed") return res.status(409).json({ error: "Your tree choice has already been confirmed." });
  const tree = impact.trees.find((option) => option.id === parsed.data.speciesId);
  if (!tree) return res.status(400).json({ error: "That tree option is not available." });
  await db.run(
    `UPDATE GrowImpactReward SET status='selected',selectedSpeciesId=?,selectedSpecies=?,selectedTreeName=?,selectedTreeImage=?,updatedAt=?
     WHERE userId=? AND qualifyingMonth=? AND status<>'confirmed'`,
    tree.id, tree.species, tree.name, tree.image, nowIso(), req.userId!, impact.month
  );
  return res.json({ success: true, impact: await currentImpact(req.userId!, impact.month) });
});

const confirmTreeSchema = z.object({ month: qualifyingMonthSchema.optional() });
growImpactRouter.post("/confirm", rewardChangesLimiter, async (req: AuthedRequest, res) => {
  const parsed = confirmTreeSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "Month must use YYYY-MM format." });
  const impact = await currentImpact(req.userId!, parsed.data.month);
  if (impact.target === 0 || impact.sessions < impact.target || !impact.reward) return res.status(403).json({ error: "Complete this month's session target to unlock a tree choice." });
  if (impact.reward.status === "confirmed") return res.json({ success: true, impact });
  if (impact.reward.status !== "selected" || !impact.reward.selectedSpeciesId) return res.status(409).json({ error: "Choose a tree before confirming." });
  const ts = nowIso();
  await db.run(
    `UPDATE GrowImpactReward SET status='confirmed',confirmedAt=?,plantingStatus='virtual_commitment',updatedAt=?
     WHERE userId=? AND qualifyingMonth=? AND status='selected'`,
    ts, ts, req.userId!, impact.month
  );
  return res.json({ success: true, impact: await currentImpact(req.userId!, impact.month) });
});
