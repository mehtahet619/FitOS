import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import { db, nowIso } from "../../db/client";
import { AuthedRequest } from "../../common/auth";
import { searchOsmCities, searchOsmGyms, getOsmRoute, OsmPlace } from "../../maps/osmProvider";

const observationSchema = z.object({
  crowdPercent: z.number().min(0).max(100),
  source: z.literal("manual").default("manual"),
  observedAt: z.string().datetime().optional(),
  occupiedCount: z.number().int().min(0).optional(),
  capacity: z.number().int().positive().optional(),
});


const OSM_DAY_INDEX: Record<string, number> = { Su: 0, Mo: 1, Tu: 2, We: 3, Th: 4, Fr: 5, Sa: 6 };
const OSM_DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function parseOsmOpeningHours(value: string | null | undefined): any | null {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const weekly = OSM_DAY_NAMES.map((day) => ({ day, intervals: [] as string[], closed: false }));
  const periods: any[] = [];
  if (raw === "24/7") {
    for (let day = 0; day < 7; day += 1) {
      weekly[day].intervals.push("00:00–24:00");
      periods.push({ open: { day, hour: 0, minute: 0 }, close: { day, hour: 24, minute: 0 } });
    }
    return { source: "openstreetmap", raw, weekly, periods };
  }
  const expandDays = (selector: string): number[] => {
    const result = new Set<number>();
    // Tokenize OSM weekday selectors without a complex regular expression.
    const tokens = selector.split(",").join(" ").trim().split(" ").filter(Boolean);
    for (const token of tokens) {
      const [startName, endName, ...unexpected] = token.split("-");
      if (unexpected.length > 0) continue;
      const start = OSM_DAY_INDEX[startName], end = OSM_DAY_INDEX[endName || startName];
      if (start === undefined || end === undefined) continue;
      let cursor = start;
      for (let count = 0; count < 7; count += 1) {
        result.add(cursor);
        if (cursor === end) break;
        cursor = (cursor + 1) % 7;
      }
    }
    if (result.size) return [...result];
    return selector.trim() ? [] : [0, 1, 2, 3, 4, 5, 6];
  };
  for (const clause of raw.split(";").map((part) => part.trim()).filter(Boolean)) {
    const timeMatch = clause.match(/\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}/);
    const selector = timeMatch ? clause.slice(0, timeMatch.index).trim() : clause.replace(/\b(off|closed|open)\b/ig, "").trim();
    const days = expandDays(selector);
    if (/\b(off|closed)\b/i.test(clause)) {
      days.forEach((day) => { weekly[day].closed = true; weekly[day].intervals = []; });
      continue;
    }
    const intervals = [...clause.matchAll(/(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/g)];
    if (!intervals.length) continue;
    for (const day of days) {
      for (const match of intervals) {
        const openHour = Number(match[1]), openMinute = Number(match[2]);
        const closeHour = Number(match[3]), closeMinute = Number(match[4]);
        if (openHour > 24 || closeHour > 24 || openMinute > 59 || closeMinute > 59) continue;
        const overnight = closeHour * 60 + closeMinute <= openHour * 60 + openMinute;
        const closeDay = overnight ? (day + 1) % 7 : day;
        weekly[day].intervals.push(`${String(openHour).padStart(2, "0")}:${String(openMinute).padStart(2, "0")}–${String(closeHour).padStart(2, "0")}:${String(closeMinute).padStart(2, "0")}`);
        periods.push({
          open: { day, hour: openHour, minute: openMinute },
          close: { day: closeDay, hour: closeHour, minute: closeMinute },
        });
      }
    }
  }
  if (!periods.length && !weekly.some((day) => day.closed)) return null;
  return { source: "openstreetmap", raw, weekly, periods };
}

async function upsertPlace(place: OsmPlace, city: string): Promise<any> {
  const placeId = place.id;
  const existing = await db.get<any>("SELECT * FROM Gym WHERE placeId = ?", placeId);
  const now = nowIso();
  const parsedHours = parseOsmOpeningHours(place.openingHours);
  const openingHoursJson = parsedHours ? JSON.stringify(parsedHours) : null;
  if (existing) {
    await db.run(
      "UPDATE Gym SET name = ?, address = ?, city = ?, latitude = ?, longitude = ?, openingHoursJson = ?, updatedAt = ? WHERE id = ?",
      place.name, place.address || "", city || place.city, place.latitude, place.longitude, openingHoursJson || existing.openingHoursJson || null, now, existing.id
    );
    return await db.get<any>("SELECT * FROM Gym WHERE id = ?", existing.id);
  }
  const id = uuidv4();
  await db.run(
    "INSERT INTO Gym (id, placeId, name, address, city, latitude, longitude, rating, ratingCount, openingHoursJson, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    id, placeId, place.name, place.address || "", city || place.city, place.latitude, place.longitude,
    null, null, openingHoursJson, now, now
  );
  return await db.get<any>("SELECT * FROM Gym WHERE id = ?", id);
}

function localDateAt(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function addDays(date: Date, amount: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + amount);
  return next;
}

function hourIsOpen(schedule: any | null, weekday: number, hour: number): boolean {
  const periods = Array.isArray(schedule) ? schedule : schedule?.periods;
  if (!schedule || !Array.isArray(periods)) return false; // Never invent opening hours when OSM has no schedule.
  if (periods.length === 0) return false; // A parsed schedule with no periods means no listed opening times.
  const current = weekday * 24 + hour;
  return periods.some((period: any) => {
    const openDay = Number(period.open?.day);
    const openHour = Number(period.open?.hour ?? 0);
    const openMinute = Number(period.open?.minute ?? 0);
    const closeDay = Number(period.close?.day ?? openDay);
    const closeHour = Number(period.close?.hour ?? 24);
    const closeMinute = Number(period.close?.minute ?? 0);
    const start = openDay * 24 * 60 + openHour * 60 + openMinute;
    let end = closeDay * 24 * 60 + closeHour * 60 + closeMinute;
    if (end <= start) end += 7 * 24 * 60;
    let candidateStart = current * 60;
    if (candidateStart < start) candidateStart += 7 * 24 * 60;
    const candidateEnd = candidateStart + 60;
    return candidateStart < end && candidateEnd > start;
  });
}

const gymDateFormatters = new Map<string, { weekday: Intl.DateTimeFormat; hour: Intl.DateTimeFormat }>();

function localWeekdayHour(value: string | Date, timeZone: string): { weekday: number; hour: number } {
  const date = value instanceof Date ? value : new Date(value);
  let formatters = gymDateFormatters.get(timeZone);
  if (!formatters) {
    formatters = {
      weekday: new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }),
      hour: new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", hourCycle: "h23" }),
    };
    gymDateFormatters.set(timeZone, formatters);
  }
  const weekdayName = formatters.weekday.format(date);
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekdayName);
  const hour = Number(formatters.hour.format(date));
  return { weekday, hour };
}

function coldStartBaseline(weekday: number, hour: number): number {
  const weekend = weekday === 0 || weekday === 6;
  return weekend
    ? (hour >= 8 && hour <= 11 ? 58 : hour >= 16 && hour <= 19 ? 48 : hour >= 12 && hour <= 15 ? 35 : 22)
    : (hour >= 6 && hour <= 8 ? 62 : hour >= 17 && hour <= 20 ? 72 : hour >= 9 && hour <= 11 ? 42 : hour >= 12 && hour <= 16 ? 28 : hour >= 21 && hour <= 22 ? 38 : 18);
}

async function getCrowdEvaluation(gymId: string) {
  const metrics = await db.get<any>(
    "SELECT COUNT(*) AS evaluatedCount, AVG(absoluteError) AS mae, AVG(absoluteError * absoluteError) AS mse FROM GymCrowdForecastSnapshot WHERE gymId = ? AND evaluatedAt IS NOT NULL",
    gymId
  );
  const evaluatedCount = Number(metrics?.evaluatedCount ?? 0);
  const mae = evaluatedCount ? Number(metrics.mae) : null;
  const mse = evaluatedCount ? Number(metrics.mse) : null;
  return { evaluatedCount, mae: mae === null ? null : Number(mae.toFixed(2)), rmse: mse === null ? null : Number(Math.sqrt(mse).toFixed(2)) };
}

function getCurrentOpeningStatus(schedule: any | null, timeZone: string) {
  if (!schedule || !Array.isArray(schedule.periods)) {
    return { status: "unknown", isOpen: null, checkedAt: nowIso(), source: "openstreetmap_opening_hours", reason: "No verified opening-hours schedule is available for this gym." };
  }
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value || "";
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  const hour = Number(get("hour"));
  const minute = Number(get("minute"));
  const current = weekday * 1440 + hour * 60 + minute;
  const week = 7 * 1440;
  const isOpen = schedule.periods.some((period: any) => {
    const open = period.open || {};
    const close = period.close || {};
    const start = Number(open.day) * 1440 + Number(open.hour || 0) * 60 + Number(open.minute || 0);
    let end = Number(close.day ?? open.day) * 1440 + Number(close.hour ?? 24) * 60 + Number(close.minute || 0);
    if (end <= start) end += week;
    return [current, current + week].some((candidate) => candidate >= start && candidate < end);
  });
  return {
    status: isOpen ? "open" : "closed",
    isOpen,
    checkedAt: nowIso(),
    source: "openstreetmap_opening_hours",
    timezone: timeZone,
  };
}

async function predictGymWeek(gym: any, timeZone: string) {
  // Only authorized official records train the model. Reuse Intl formatters
  // instead of constructing new formatters for every historical observation.
  const trainingRows = await db.all<any>(
    "SELECT observedAt, crowdPercent, 'official_dataset' AS source FROM GymCrowdOfficialObservation WHERE gymId = ? UNION ALL SELECT observedAt, crowdPercent, 'member_observation' AS source FROM GymCrowdObservation WHERE gymId = ? ORDER BY observedAt DESC LIMIT 20000",
    gym.id, gym.id
  );
  const bySlot = new Map<string, { weightedSum: number; weight: number; count: number; latestAt: number }>();
  const now = new Date();
  const nowMs = now.getTime();
  for (const row of trainingRows) {
    const date = new Date(row.observedAt);
    if (!Number.isFinite(date.getTime())) continue;
    const { weekday, hour } = localWeekdayHour(date, timeZone);
    const key = `${weekday}:${hour}`;
    const ageDays = Math.max(0, (nowMs - date.getTime()) / 86400000);
    const weight = Math.pow(0.5, ageDays / 45);
    const slot = bySlot.get(key) ?? { weightedSum: 0, weight: 0, count: 0, latestAt: 0, sources: {} as Record<string, number> };
    const source = String(row.source || "official_dataset");
    slot.sources[source] = (slot.sources[source] || 0) + 1;
    slot.weightedSum += Number(row.crowdPercent) * weight;
    slot.weight += weight;
    slot.count += 1;
    slot.latestAt = Math.max(slot.latestAt, date.getTime());
    bySlot.set(key, slot);
  }
  const latestTrainingAt = trainingRows.reduce((latest, row) => Math.max(latest, new Date(row.observedAt).getTime() || 0), 0);
  const modelVersion = `fitos-osm-member-hourly-v5-${trainingRows.length}-${latestTrainingAt || "coldstart"}`;
  let schedule: any = null;
  try { schedule = gym.openingHoursJson ? JSON.parse(gym.openingHoursJson) : null; } catch { schedule = null; }
  const openingHoursKnown = Boolean(
    (Array.isArray(schedule) && schedule.length > 0) ||
    (schedule && typeof schedule.raw === "string" && Array.isArray(schedule.weekly))
  );

  const baseLocalDate = localDateAt(now, timeZone);
  const baseDate = new Date(`${baseLocalDate}T12:00:00.000Z`);
  const days: any[] = [];
  const output: any[] = [];
  const pendingSnapshots: Array<{ id: string; gymId: string; predictedFor: string; predictedCrowdPercent: number; modelVersion: string; generatedAt: string }> = [];

  for (let offset = 0; offset < 7; offset += 1) {
    const date = addDays(baseDate, offset);
    const dateKey = date.toISOString().slice(0, 10);
    const weekday = date.getUTCDay();
    const hours: any[] = [];
    for (let hour = 0; hour < 24; hour += 1) {
      if (!hourIsOpen(schedule, weekday, hour)) continue;
      const slot = bySlot.get(`${weekday}:${hour}`);
      const baseline = coldStartBaseline(weekday, hour);
      const learnedAverage = slot && slot.weight > 0 ? slot.weightedSum / slot.weight : null;
      const sampleWeight = slot ? Math.min(0.95, slot.count / (slot.count + 4)) : 0;
      const predicted = Math.max(0, Math.min(100, Math.round(
        learnedAverage === null ? baseline : learnedAverage * sampleWeight + baseline * (1 - sampleWeight)
      )));
      const ageDays = slot?.latestAt ? (nowMs - slot.latestAt) / 86400000 : Infinity;
      const confidence = slot && slot.count >= 30 && ageDays <= 21 ? "high"
        : slot && slot.count >= 8 && ageDays <= 45 ? "medium" : "low";
      const label = predicted >= 80 ? "very_busy" : predicted >= 60 ? "busy" : predicted >= 35 ? "moderate" : "quiet";
      const predictedFor = `${dateKey}T${String(hour).padStart(2, "0")}:00:00`;
      const item = { date: dateKey, hour, predictedFor, crowdPercent: predicted, crowdLevel: label, confidence, samples: slot?.count ?? 0, trainingSource: slot?.sources ? Object.keys(slot.sources) : [] };
      hours.push(item);
      output.push(item);
    }
    const daySchedule = schedule?.weekly?.[weekday] || null;
    days.push({
      date: dateKey,
      weekday: OSM_DAY_NAMES[weekday],
      isOpen: openingHoursKnown ? hours.length > 0 : null,
      openingIntervals: daySchedule?.intervals || [],
      hours,
    });
  }

  // Load snapshots in one query. Never rewrite an existing prediction: its
  // value must remain fixed so later member reports evaluate what was shown.
  const rangeEnd = addDays(baseDate, 7).toISOString().slice(0, 10);
  const existingSnapshots = await db.all<any>(
    "SELECT predictedFor FROM GymCrowdForecastSnapshot WHERE gymId = ? AND predictedFor >= ? AND predictedFor < ?",
    gym.id, `${baseLocalDate}T00:00:00`, `${rangeEnd}T00:00:00`
  );
  const existingKeys = new Set(existingSnapshots.map((row) => String(row.predictedFor).replace(" ", "T").slice(0, 19)));
  const todayKey = localDateAt(now, timeZone);
  const currentHour = localWeekdayHour(now, timeZone).hour;
  const generatedAt = nowIso();

  for (const item of output) {
    const isFuture = item.date > todayKey || (item.date === todayKey && item.hour > currentHour);
    if (!isFuture || existingKeys.has(item.predictedFor)) continue;
    pendingSnapshots.push({
      id: uuidv4(), gymId: gym.id, predictedFor: item.predictedFor,
      predictedCrowdPercent: item.crowdPercent, modelVersion, generatedAt,
    });
  }

  // Keep batches below SQLite's common bind-parameter limit; the same SQL
  // works with SQLite, PostgreSQL and TiDB/MySQL adapters.
  for (let offset = 0; offset < pendingSnapshots.length; offset += 80) {
    const batch = pendingSnapshots.slice(offset, offset + 80);
    const values: unknown[] = [];
    const tuples = batch.map((snapshot) => {
      values.push(snapshot.id, snapshot.gymId, snapshot.predictedFor, snapshot.predictedCrowdPercent, snapshot.modelVersion, snapshot.generatedAt);
      return "(?, ?, ?, ?, ?, ?)";
    });
    await db.run(
      `INSERT INTO GymCrowdForecastSnapshot (id, gymId, predictedFor, predictedCrowdPercent, modelVersion, generatedAt) VALUES ${tuples.join(", ")}`,
      ...values
    );
  }

  const recommendationDay = days.find((day) =>
    day.hours.some((item: any) => day.date > todayKey || item.hour > currentHour)
  );
  const recommendationHours = (recommendationDay?.hours || []).filter((item: any) =>
    recommendationDay.date > todayKey || item.hour > currentHour
  );
  const leastCrowded = [...recommendationHours].sort((a, b) => a.crowdPercent - b.crowdPercent)[0] || null;
  const busiest = [...recommendationHours].sort((a, b) => b.crowdPercent - a.crowdPercent)[0] || null;
  const evaluation = await getCrowdEvaluation(gym.id);

  return {
    days,
    predictions: output,
    timezone: timeZone,
    openingHoursKnown,
    currentStatus: getCurrentOpeningStatus(schedule, timeZone),
    openingSchedule: schedule?.weekly || null,
    openingHoursText: schedule?.raw || null,
    trainingSamples: trainingRows.length,
    trainingSampleBreakdown: { officialDataset: trainingRows.filter((row: any) => row.source === "official_dataset").length, memberObservations: trainingRows.filter((row: any) => row.source === "member_observation").length },
    trainingSource: "authorized_dataset_and_fitOS_member_observations",
    modelVersion,
    recommendations: {
      date: recommendationDay?.date || null,
      leastCrowded: leastCrowded ? { hour: leastCrowded.hour, crowdPercent: leastCrowded.crowdPercent, confidence: leastCrowded.confidence } : null,
      busiest: busiest ? { hour: busiest.hour, crowdPercent: busiest.crowdPercent, confidence: busiest.confidence } : null,
    },
    evaluation,
  };
}

export function registerGymIntelligenceRoutes(router: Router): void {
  router.get("/cities", async (req, res) => {
    const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (query.length < 2) return res.json({ configured: true, provider: "photon_openstreetmap", cities: [] });
    const cities = await searchOsmCities(query);
    return res.json({ configured: true, provider: "photon_openstreetmap", attribution: "© OpenStreetMap contributors", cities });
  });

  router.get("/search", async (req, res) => {
    const city = typeof req.query.city === "string" ? req.query.city.trim() : "";
    const query = typeof req.query.q === "string" ? req.query.q.trim() : "gyms";
    if (city.length < 2) return res.status(400).json({ error: "Select a city before searching for gyms." });
    try {
      const places = await searchOsmGyms(city, query || "gyms");
      const gyms: any[] = [];
      for (const place of places) {
        const gym = await upsertPlace(place, city);
        gyms.push({ ...gym, distanceKm: place.distanceKm, source: "openstreetmap", latitude: place.latitude, longitude: place.longitude, openingHoursText: place.openingHours });
      }
      return res.json({ configured: true, provider: "overpass_openstreetmap", attribution: "© OpenStreetMap contributors", city, gyms });
    } catch (providerError) {
      // Public Overpass instances can time out or rate-limit requests. Do not
      // fail the entire gym search when FitOS already has gyms saved locally.
      console.warn("[gym/search] OpenStreetMap discovery unavailable; using saved gyms.", providerError);
      const savedGyms = await db.all<any>(
        "SELECT * FROM Gym WHERE LOWER(city) = LOWER(?) ORDER BY name ASC LIMIT 50",
        city
      );
      return res.json({
        configured: true,
        provider: "database_fallback",
        attribution: "© OpenStreetMap contributors",
        city,
        gyms: savedGyms.map((gym) => ({
          ...gym,
          distanceKm: null,
          source: "fitos_database",
          latitude: gym.latitude ?? null,
          longitude: gym.longitude ?? null,
          openingHoursText: null,
        })),
        warning: "Live gym discovery is temporarily unavailable. Showing gyms already saved in FitOS.",
      });
    }
  });

  router.get("/route", async (req, res) => {
    const fromLat = Number(req.query.fromLat), fromLng = Number(req.query.fromLng);
    const toLat = Number(req.query.toLat), toLng = Number(req.query.toLng);
    const profile = typeof req.query.profile === "string" ? req.query.profile : "driving";
    if (!["driving", "walking", "cycling"].includes(profile)) return res.status(400).json({ error: "profile must be driving, walking or cycling." });
    try {
      const route = await getOsmRoute({ fromLat, fromLng, toLat, toLng, profile: profile as "driving" | "walking" | "cycling" });
      return res.json({ ...route, attribution: "Routing by OSRM; map data © OpenStreetMap contributors" });
    } catch (error) {
      return res.status(503).json({ error: error instanceof Error ? error.message : "Routing service unavailable.", provider: "osrm" });
    }
  });

  router.post("/create", async (req: AuthedRequest, res) => {
    const parsed = z.object({ name: z.string().trim().min(2).max(120), city: z.string().trim().min(2).max(100), address: z.string().trim().max(300).default(""), timeZone: z.string().trim().min(1).max(80).default("Asia/Kolkata") }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Gym name and city are required." });
    const id = uuidv4();
    const now = nowIso();
    await db.run("INSERT INTO Gym (id, placeId, name, address, city, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)", id, `custom:${id}`, parsed.data.name, parsed.data.address, parsed.data.city, now, now);
    await db.run("INSERT INTO GymMembership (id, userId, gymId, timeZone, createdAt) VALUES (?, ?, ?, ?, ?)", uuidv4(), req.userId!, id, parsed.data.timeZone, now);
    const gym = await db.get<any>("SELECT * FROM Gym WHERE id = ?", id);
    return res.status(201).json({ gym, datasetReused: false, message: "Gym created. Its forecast will improve as validated observations arrive." });
  });
  router.post("/select", async (req: AuthedRequest, res) => {
    const parsed = z.object({ gymId: z.string().min(1), timeZone: z.string().min(1).max(80).default("Asia/Kolkata") }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "A valid gymId is required." });
    const gym = await db.get<any>("SELECT * FROM Gym WHERE id = ?", parsed.data.gymId);
    if (!gym) return res.status(404).json({ error: "Gym not found. Search for the gym again." });
    const existingMembership = await db.get<any>("SELECT id FROM GymMembership WHERE userId = ?", req.userId!);
    if (existingMembership) {
      await db.run("UPDATE GymMembership SET gymId = ?, timeZone = ? WHERE userId = ?", gym.id, parsed.data.timeZone, req.userId!);
    } else {
      await db.run("INSERT INTO GymMembership (id, userId, gymId, timeZone, createdAt) VALUES (?, ?, ?, ?, ?)", uuidv4(), req.userId!, gym.id, parsed.data.timeZone, nowIso());
    }
    const members = await db.get<any>("SELECT COUNT(*) AS count FROM GymMembership WHERE gymId = ?", gym.id);
    return res.json({ gym, memberCount: Number(members?.count ?? 0), datasetReused: Number(members?.count ?? 0) > 1 });
  });

  router.get("/selected", async (req: AuthedRequest, res) => {
    const membership = await db.get<any>("SELECT g.*, m.timeZone FROM GymMembership m JOIN Gym g ON g.id = m.gymId WHERE m.userId = ?", req.userId!);
    return res.json({ gym: membership ?? null });
  });

  router.get("/:gymId/forecast", async (req: AuthedRequest, res) => {
    const gym = await db.get<any>("SELECT g.*, m.timeZone FROM Gym g LEFT JOIN GymMembership m ON m.gymId = g.id AND m.userId = ? WHERE g.id = ?", req.userId!, req.params.gymId);
    if (!gym) return res.status(404).json({ error: "Gym not found." });
    const result = await predictGymWeek(gym, gym.timeZone || "Asia/Kolkata");
    return res.json({ gym: { id: gym.id, name: gym.name, city: gym.city, openingHoursKnown: result.openingHoursKnown }, ...result, refreshedAt: nowIso() });
  });

  // Import only independently licensed or otherwise authorized official datasets.
  // Third-party map and crowd estimates are not accepted as model-training sources.
  router.post("/dataset/import", async (req, res) => {
    const ingestKey = process.env.GYM_CROWD_DATASET_INGEST_KEY;
    if (!ingestKey || req.header("x-gym-dataset-key") !== ingestKey) {
      return res.status(401).json({ error: "Dataset ingestion is not authorized." });
    }
    const parsed = z.object({
      gymId: z.string().min(1),
      sourceName: z.string().trim().min(2).max(120),
      sourceReference: z.string().trim().min(2).max(500),
      license: z.string().trim().min(5).max(500),
      records: z.array(z.object({
        observedAt: z.string().datetime(),
        crowdPercent: z.number().min(0).max(100),
        recordId: z.string().trim().min(1).max(160),
      })).min(1).max(5000),
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid dataset payload. Provide gymId, source metadata, license, and up to 5000 timestamped crowd records." });
    if (/google|maps|popular.?times/i.test(`${parsed.data.sourceName} ${parsed.data.sourceReference}`)) {
      return res.status(400).json({ error: "Google Maps/Popular Times content cannot be imported or stored as model-training data. Use an independently licensed dataset." });
    }
    const gym = await db.get<any>("SELECT id FROM Gym WHERE id = ?", parsed.data.gymId);
    if (!gym) return res.status(404).json({ error: "Gym not found." });
    let inserted = 0;
    for (const record of parsed.data.records) {
      const existing = await db.get<any>("SELECT id FROM GymCrowdOfficialObservation WHERE gymId = ? AND sourceReference = ? AND sourceRecordId = ?", parsed.data.gymId, parsed.data.sourceReference, record.recordId);
      if (existing) continue;
      await db.run(
        "INSERT INTO GymCrowdOfficialObservation (id, gymId, observedAt, crowdPercent, sourceName, sourceReference, license, sourceRecordId, importedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        uuidv4(), parsed.data.gymId, record.observedAt, record.crowdPercent, parsed.data.sourceName, parsed.data.sourceReference, parsed.data.license, record.recordId, nowIso()
      );
      inserted += 1;
    }
    const total = await db.get<any>("SELECT COUNT(*) AS count FROM GymCrowdOfficialObservation WHERE gymId = ?", parsed.data.gymId);
    return res.status(202).json({
      accepted: true,
      inserted,
      totalTrainingSamples: Number(total?.count ?? 0),
      retraining: "next_forecast_request",
      message: "Official dataset rows saved. The next forecast request rebuilds the model using this dataset only; member reports are excluded from training.",
    });
  });

  router.post("/:gymId/observations", async (req: AuthedRequest, res) => {
    const parsed = observationSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "crowdPercent must be between 0 and 100; source must be manual." });
    const membership = await db.get<any>("SELECT gymId, timeZone FROM GymMembership WHERE userId = ?", req.userId!);
    if (!membership || membership.gymId !== req.params.gymId) return res.status(403).json({ error: "You must be a member of this gym to submit an observation." });
    const observedAt = nowIso();
    const hourStart = new Date(observedAt);
    hourStart.setMinutes(0, 0, 0);
    const timeZone = membership.timeZone || "Asia/Kolkata";
    const localObservedDate = localDateAt(hourStart, timeZone);
    const localObservedHour = localWeekdayHour(hourStart, timeZone).hour;
    const observedHour = `${localObservedDate}T${String(localObservedHour).padStart(2, "0")}:00:00`;
    const snapshot = await db.get<any>("SELECT * FROM GymCrowdForecastSnapshot WHERE gymId = ? AND predictedFor = ?", req.params.gymId, observedHour);
    const absoluteError = snapshot ? Math.abs(Number(snapshot.predictedCrowdPercent) - parsed.data.crowdPercent) : null;
    if (snapshot && !snapshot.evaluatedAt) {
      await db.run(
        "UPDATE GymCrowdForecastSnapshot SET actualCrowdPercent = ?, actualSource = 'member_report', absoluteError = ?, evaluatedAt = ? WHERE id = ?",
        parsed.data.crowdPercent, absoluteError, observedAt, snapshot.id
      );
    }
    const hourEnd = new Date(hourStart.getTime() + 60 * 60 * 1000).toISOString();
    const previous = await db.get<any>("SELECT id FROM GymCrowdObservation WHERE gymId = ? AND userId = ? AND observedAt >= ? AND observedAt < ?", req.params.gymId, req.userId!, hourStart.toISOString(), hourEnd);
    if (previous) {
      await db.run("UPDATE GymCrowdObservation SET crowdPercent = ?, occupiedCount = ?, capacity = ?, createdAt = ? WHERE id = ?", parsed.data.crowdPercent, parsed.data.occupiedCount ?? null, parsed.data.capacity ?? null, observedAt, previous.id);
    } else {
      await db.run("INSERT INTO GymCrowdObservation (id, gymId, userId, observedAt, crowdPercent, occupiedCount, capacity, source, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", uuidv4(), req.params.gymId, req.userId!, observedAt, parsed.data.crowdPercent, parsed.data.occupiedCount ?? null, parsed.data.capacity ?? null, parsed.data.source, observedAt);
    }
    const evaluation = await getCrowdEvaluation(req.params.gymId);
    return res.status(201).json({
      accepted: true,
      evaluated: Boolean(snapshot && !snapshot.evaluatedAt),
      predictedCrowdPercent: snapshot ? Number(snapshot.predictedCrowdPercent) : null,
      actualCrowdPercent: parsed.data.crowdPercent,
      absoluteError,
      evaluation,
      trainingImpact: "none_member_reports_are_evaluation_only",
      message: snapshot
        ? "Actual crowd report compared with the saved forecast. This feedback updates evaluation metrics, not training data."
        : "Actual crowd report saved. No forecast snapshot existed for this hour, so no prediction error could be calculated.",
    });
  });

  router.get("/:gymId/evaluation", async (req: AuthedRequest, res) => {
    const membership = await db.get<any>("SELECT gymId FROM GymMembership WHERE userId = ?", req.userId!);
    if (!membership || membership.gymId !== req.params.gymId) return res.status(403).json({ error: "You must be a member of this gym." });
    return res.json({ gymId: req.params.gymId, ...(await getCrowdEvaluation(req.params.gymId)) });
  });
}