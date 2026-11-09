import { Router, Request, Response, NextFunction } from "express";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { db, nowIso } from "../../db/client";

/**
 * Bridge between the FACHS API and the offline crowd-model pipeline (/ml/crowd).
 *
 *   GET  /gym/ml/export       -> anonymised training data (hourly arrivals + member reports)
 *   POST /gym/ml/predictions  -> forecasts produced by the trained model
 *
 * Both endpoints are machine-to-machine: they use the GYM_ML_PIPELINE_KEY secret
 * (header `x-gym-ml-key`) instead of a user session, and never expose user ids.
 */

export const HIGH_CROWD_THRESHOLD = 60;

let ready: Promise<void> | undefined;
async function ensureMlTables(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      await db.exec(`CREATE TABLE IF NOT EXISTS GymCrowdMlForecast (
        gymId VARCHAR(64) NOT NULL,
        predictedFor VARCHAR(19) NOT NULL,
        crowdPercent DOUBLE PRECISION NOT NULL,
        highProbability DOUBLE PRECISION,
        confidence VARCHAR(16) NOT NULL,
        modelVersion VARCHAR(120) NOT NULL,
        generatedAt VARCHAR(40) NOT NULL,
        PRIMARY KEY (gymId, predictedFor)
      )`);
      await db.exec(`CREATE TABLE IF NOT EXISTS GymCrowdMlRun (
        id VARCHAR(120) PRIMARY KEY,
        trainedAt VARCHAR(40) NOT NULL,
        publishedAt VARCHAR(40) NOT NULL,
        metricsJson TEXT NOT NULL
      )`);
    })().catch((error) => { ready = undefined; throw error; });
  }
  await ready;
}

export function requireMlKey(req: Request, res: Response, next: NextFunction) {
  const expected = process.env.GYM_ML_PIPELINE_KEY;
  if (!expected) return res.status(503).json({ error: "Crowd-model pipeline is not configured (GYM_ML_PIPELINE_KEY)." });
  const supplied = Buffer.from(String(req.header("x-gym-ml-key") || ""));
  const wanted = Buffer.from(expected);
  if (supplied.length !== wanted.length || !timingSafeEqual(supplied, wanted)) {
    return res.status(401).json({ error: "Invalid pipeline key." });
  }
  return next();
}

/** Local wall-clock hour bucket "YYYY-MM-DDTHH:00:00" in the gym's time zone. */
export function localHourKey(value: string | Date, timeZone: string): string | null {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
    }).formatToParts(date);
  } catch {
    return null;
  }
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:00:00`;
}

export interface MlForecastRow {
  crowdPercent: number;
  highProbability: number | null;
  confidence: string;
  modelVersion: string;
}

/** Forecast rows for one gym in [fromKey, toKey). Never throws: missing table/rows => empty map. */
export async function loadMlForecast(gymId: string, fromKey: string, toKey: string): Promise<Map<string, MlForecastRow>> {
  const result = new Map<string, MlForecastRow>();
  try {
    await ensureMlTables();
    const rows = await db.all<any>(
      "SELECT predictedFor, crowdPercent, highProbability, confidence, modelVersion FROM GymCrowdMlForecast WHERE gymId = ? AND predictedFor >= ? AND predictedFor < ?",
      gymId, fromKey, toKey
    );
    for (const row of rows) {
      result.set(String(row.predictedFor).replace(" ", "T").slice(0, 19), {
        crowdPercent: Number(row.crowdPercent),
        highProbability: row.highProbability === null || row.highProbability === undefined ? null : Number(row.highProbability),
        confidence: String(row.confidence),
        modelVersion: String(row.modelVersion),
      });
    }
  } catch (error) {
    console.warn("[gym/ml] Could not load model forecasts; using baseline.", error instanceof Error ? error.message : error);
  }
  return result;
}

export async function latestMlRun(): Promise<{ id: string; trainedAt: string; metrics: unknown } | null> {
  try {
    await ensureMlTables();
    const row = await db.get<any>("SELECT id, trainedAt, metricsJson FROM GymCrowdMlRun ORDER BY publishedAt DESC LIMIT 1");
    if (!row) return null;
    let metrics: unknown = null;
    try { metrics = JSON.parse(row.metricsJson); } catch { metrics = null; }
    return { id: row.id, trainedAt: row.trainedAt, metrics };
  } catch {
    return null;
  }
}

const predictionsSchema = z.object({
  modelVersion: z.string().trim().min(3).max(120),
  trainedAt: z.string().datetime(),
  metrics: z.record(z.any()).default({}),
  predictions: z.array(z.object({
    gymId: z.string().min(1).max(64),
    predictedFor: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:00:00$/),
    crowdPercent: z.number().min(0).max(100),
    highProbability: z.number().min(0).max(1).nullable().optional(),
    confidence: z.enum(["low", "medium", "high"]),
  })).min(1).max(5000),
});

export function registerGymMlRoutes(router: Router): void {
  router.get("/ml/export", requireMlKey, async (req, res) => {
    await ensureMlTables();
    const days = Math.min(365, Math.max(7, Number(req.query.days) || 90));
    const since = new Date(Date.now() - days * 86400000).toISOString();

    const gyms = await db.all<any>(
      `SELECT g.id, g.name, g.city, g.latitude, g.longitude, g.openingHoursJson,
              COUNT(m.id) AS memberCount, MIN(m.timeZone) AS timeZone
       FROM Gym g JOIN GymMembership m ON m.gymId = g.id
       GROUP BY g.id, g.name, g.city, g.latitude, g.longitude, g.openingHoursJson
       LIMIT 500`
    );
    const zoneById = new Map<string, string>(gyms.map((g) => [g.id, g.timeZone || "Asia/Kolkata"]));

    // Aggregate on the server so no user identifiers ever leave the API.
    const checkins = await db.all<{ gymId: string; checkedInAt: string }>(
      `SELECT m.gymId AS gymId, a.checkedInAt AS checkedInAt
       FROM GymAttendance a JOIN GymMembership m ON m.userId = a.userId
       WHERE a.checkedInAt >= ?`,
      since
    );
    const arrivals = new Map<string, Map<string, number>>();
    for (const row of checkins) {
      const zone = zoneById.get(row.gymId);
      if (!zone) continue;
      const key = localHourKey(row.checkedInAt, zone);
      if (!key) continue;
      const perGym = arrivals.get(row.gymId) ?? new Map<string, number>();
      perGym.set(key, (perGym.get(key) ?? 0) + 1);
      arrivals.set(row.gymId, perGym);
    }

    const reports = await db.all<any>(
      "SELECT gymId, observedAt, crowdPercent FROM GymCrowdObservation WHERE observedAt >= ? ORDER BY observedAt ASC LIMIT 100000",
      since
    );
    const reportsByGym = new Map<string, Array<{ observedAt: string; crowdPercent: number }>>();
    for (const r of reports) {
      const list = reportsByGym.get(r.gymId) ?? [];
      list.push({ observedAt: String(r.observedAt), crowdPercent: Number(r.crowdPercent) });
      reportsByGym.set(r.gymId, list);
    }

    let openingHoursRaw = (g: any): string | null => {
      try { return g.openingHoursJson ? (JSON.parse(g.openingHoursJson)?.raw ?? null) : null; } catch { return null; }
    };
    return res.json({
      generatedAt: nowIso(),
      sinceDays: days,
      highCrowdThreshold: HIGH_CROWD_THRESHOLD,
      gyms: gyms.map((g) => ({
        id: g.id, name: g.name, city: g.city,
        latitude: g.latitude === null ? null : Number(g.latitude),
        longitude: g.longitude === null ? null : Number(g.longitude),
        timeZone: zoneById.get(g.id),
        memberCount: Number(g.memberCount),
        openingHoursRaw: openingHoursRaw(g),
        arrivals: [...(arrivals.get(g.id)?.entries() ?? [])].map(([hour, count]) => ({ hour, count })),
        reports: reportsByGym.get(g.id) ?? [],
      })),
    });
  });

  router.post("/ml/predictions", requireMlKey, async (req, res) => {
    const parsed = predictionsSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid predictions payload.", details: parsed.error.issues.slice(0, 5) });
    await ensureMlTables();
    const { modelVersion, trainedAt, metrics, predictions } = parsed.data;
    const known = new Set((await db.all<{ id: string }>("SELECT id FROM Gym")).map((g) => g.id));
    const rows = predictions.filter((p) => known.has(p.gymId));
    const generatedAt = nowIso();

    const write = async (conn: typeof db) => {
      for (const p of rows) {
        await conn.run("DELETE FROM GymCrowdMlForecast WHERE gymId = ? AND predictedFor = ?", p.gymId, p.predictedFor);
        await conn.run(
          "INSERT INTO GymCrowdMlForecast (gymId, predictedFor, crowdPercent, highProbability, confidence, modelVersion, generatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)",
          p.gymId, p.predictedFor, p.crowdPercent, p.highProbability ?? null, p.confidence, modelVersion, generatedAt
        );
      }
      await conn.run("DELETE FROM GymCrowdMlRun WHERE id = ?", modelVersion);
      await conn.run("INSERT INTO GymCrowdMlRun (id, trainedAt, publishedAt, metricsJson) VALUES (?, ?, ?, ?)",
        modelVersion, trainedAt, generatedAt, JSON.stringify(metrics));
      // Housekeeping: drop forecasts for hours that are already more than 2 days old.
      await conn.run("DELETE FROM GymCrowdMlForecast WHERE predictedFor < ?",
        new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 19));
    };
    if (db.transaction) await db.transaction(write); else await write(db);
    return res.status(202).json({ accepted: rows.length, ignoredUnknownGym: predictions.length - rows.length, modelVersion });
  });
}
