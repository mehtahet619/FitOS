import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import { db, nowIso } from "../../db/client";
import { AuthedRequest } from "../../common/auth";

type Place = {
  id: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  location?: { latitude?: number; longitude?: number };
  rating?: number;
  userRatingCount?: number;
  regularOpeningHours?: { periods?: Array<{ open?: { day?: number; hour?: number; minute?: number }; close?: { day?: number; hour?: number; minute?: number } }> };
};

const observationSchema = z.object({
  crowdPercent: z.number().min(0).max(100),
  source: z.literal("manual").default("manual"),
  observedAt: z.string().datetime().optional(),
  occupiedCount: z.number().int().min(0).optional(),
  capacity: z.number().int().positive().optional(),
});

function googleKey(): string | undefined {
  return process.env.GOOGLE_PLACES_API_KEY || undefined;
}

async function placesCityAutocomplete(input: string): Promise<string[]> {
  const key = googleKey();
  if (!key) return [];
  const response = await fetch("https://places.googleapis.com/v1/places:autocomplete", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key, "X-Goog-FieldMask": "suggestions.placePrediction.text.text" },
    body: JSON.stringify({ input: `${input}, India`, includedPrimaryTypes: ["(cities)"] }),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`Google Places city lookup failed (${response.status})`);
  const payload = await response.json() as { suggestions?: Array<{ placePrediction?: { text?: { text?: string } } }> };
  return [...new Set((payload.suggestions ?? []).map(item => item.placePrediction?.text?.text?.trim()).filter((value): value is string => Boolean(value)))].slice(0, 10);
}

async function placesTextSearch(textQuery: string): Promise<Place[]> {
  const key = googleKey();
  if (!key) return [];
  const response = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": key,
      "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress,places.location,places.rating,places.userRatingCount,places.regularOpeningHours",
    },
    body: JSON.stringify({ textQuery, pageSize: 20 }),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Google Places request failed (${response.status}): ${detail.slice(0, 300)}`);
  }
  const payload = await response.json() as { places?: Place[] };
  return payload.places ?? [];
}

async function upsertPlace(place: Place, city: string): Promise<any> {
  const placeId = place.id;
  const existing = await db.get<any>("SELECT * FROM Gym WHERE placeId = ?", placeId);
  const now = nowIso();
  const name = place.displayName?.text?.trim() || "Gym";
  const address = place.formattedAddress || "";
  const latitude = place.location?.latitude ?? null;
  const longitude = place.location?.longitude ?? null;
  const hours = place.regularOpeningHours?.periods ? JSON.stringify(place.regularOpeningHours.periods) : null;
  if (existing) {
    await db.run(
      "UPDATE Gym SET name = ?, address = ?, city = ?, latitude = ?, longitude = ?, rating = ?, ratingCount = ?, openingHoursJson = COALESCE(?, openingHoursJson), updatedAt = ? WHERE id = ?",
      name, address, city, latitude, longitude, place.rating ?? null, place.userRatingCount ?? null, hours, now, existing.id
    );
    return await db.get<any>("SELECT * FROM Gym WHERE id = ?", existing.id);
  }
  const id = uuidv4();
  await db.run(
    "INSERT INTO Gym (id, placeId, name, address, city, latitude, longitude, rating, ratingCount, openingHoursJson, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    id, placeId, name, address, city, latitude, longitude, place.rating ?? null, place.userRatingCount ?? null, hours, now, now
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

function hourIsOpen(periods: any[] | null, weekday: number, hour: number): boolean {
  if (!periods?.length) return true; // Unknown schedule: return a full-day forecast with openingHoursKnown=false.
  const current = weekday * 24 + hour;
  return periods.some((period) => {
    const openDay = Number(period.open?.day);
    const openHour = Number(period.open?.hour ?? 0);
    const closeDay = Number(period.close?.day ?? openDay);
    const closeHour = Number(period.close?.hour ?? 24);
    const start = openDay * 24 + openHour;
    let end = closeDay * 24 + closeHour;
    if (end <= start) end += 168;
    const candidate = current < start ? current + 168 : current;
    return candidate >= start && candidate < end;
  });
}

async function predictGymWeek(gym: any, timeZone: string) {
  const history = await db.all<any>(
    "SELECT observedAt, crowdPercent FROM GymCrowdObservation WHERE gymId = ? ORDER BY observedAt DESC LIMIT 5000",
    gym.id
  );
  const globalRows = await db.all<any>("SELECT observedAt, crowdPercent FROM GymCrowdObservation ORDER BY observedAt DESC LIMIT 10000");
  const globalSlots = new Map<string, { sum: number; count: number }>();
  for (const row of globalRows) {
    const date = new Date(row.observedAt);
    if (!Number.isFinite(date.getTime())) continue;
    const weekdayName = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(date);
    const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekdayName);
    const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", hourCycle: "h23" }).format(date));
    const key = `${weekday}:${hour}`;
    const slot = globalSlots.get(key) ?? { sum: 0, count: 0 };
    slot.sum += Number(row.crowdPercent); slot.count += 1; globalSlots.set(key, slot);
  }
  const bySlot = new Map<string, { sum: number; count: number }>();
  for (const row of history) {
    const date = new Date(row.observedAt);
    if (!Number.isFinite(date.getTime())) continue;
    const weekdayName = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(date);
    const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekdayName);
    const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", hourCycle: "h23" }).format(date));
    const key = `${weekday}:${hour}`;
    const slot = bySlot.get(key) ?? { sum: 0, count: 0 };
    slot.sum += Number(row.crowdPercent);
    slot.count += 1;
    bySlot.set(key, slot);
  }
  const periods = gym.openingHoursJson ? JSON.parse(gym.openingHoursJson) : null;
  const now = new Date();
  const output: any[] = [];
  for (let offset = 0; offset < 7; offset += 1) {
    const date = addDays(now, offset);
    const dateKey = localDateAt(date, timeZone);
    const weekday = new Date(`${dateKey}T12:00:00Z`).getUTCDay();
    for (let hour = 0; hour < 24; hour += 1) {
      if (!hourIsOpen(periods, weekday, hour)) continue;
      const key = `${weekday}:${hour}`;
      const local = bySlot.get(key);
      const globalPrior = globalSlots.get(key);
      const localAverage = local && local.count ? local.sum / local.count : null;
      const globalAverage = globalPrior && globalPrior.count >= 5 ? globalPrior.sum / globalPrior.count : 50;
      const localWeight = local ? Math.min(0.9, local.count / (local.count + 8)) : 0;
      const predicted = Math.max(0, Math.min(100, Math.round(localAverage === null ? globalAverage : localAverage * localWeight + globalAverage * (1 - localWeight))));
      const confidence = local && local.count >= 20 ? "high" : local && local.count >= 5 ? "medium" : "low";
      const label = predicted >= 80 ? "very_busy" : predicted >= 60 ? "busy" : predicted >= 35 ? "moderate" : "quiet";
      const id = uuidv4();
      const predictedFor = `${dateKey}T${String(hour).padStart(2, "0")}:00:00`;
      const existing = await db.get<any>("SELECT id FROM GymCrowdPrediction WHERE gymId = ? AND predictedFor = ?", gym.id, predictedFor);
      if (existing) {
        await db.run("UPDATE GymCrowdPrediction SET crowdPercent = ?, crowdLevel = ?, confidence = ?, generatedAt = ?, modelVersion = ? WHERE id = ?", predicted, label, confidence, nowIso(), "global-prior-gym-calibrated-v1", existing.id);
      } else {
        await db.run("INSERT INTO GymCrowdPrediction (id, gymId, predictedFor, crowdPercent, crowdLevel, confidence, generatedAt, modelVersion) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", id, gym.id, predictedFor, predicted, label, confidence, nowIso(), "global-prior-gym-calibrated-v1");
      }
      output.push({ date: dateKey, hour, predictedFor, crowdPercent: predicted, crowdLevel: label, confidence, samples: local?.count ?? 0 });
    }
  }
  const days = [...new Set(output.map((item) => item.date))].map((date) => ({
    date,
    hours: output.filter((item) => item.date === date),
  }));
  return { days, predictions: output, timezone: timeZone, openingHoursKnown: Boolean(periods?.length), observationsUsed: history.length, modelVersion: "global-prior-gym-calibrated-v1" };
}

export function registerGymIntelligenceRoutes(router: Router): void {
  router.get("/cities", async (req, res) => {
    const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (query.length < 2) return res.json({ configured: Boolean(googleKey()), cities: [] });
    if (!googleKey()) return res.status(503).json({ configured: false, error: "Gym discovery requires GOOGLE_PLACES_API_KEY." });
    const cities = await placesCityAutocomplete(query);
    return res.json({ configured: true, cities });
  });

  router.get("/search", async (req, res) => {
    const city = typeof req.query.city === "string" ? req.query.city.trim() : "";
    const query = typeof req.query.q === "string" ? req.query.q.trim() : "gyms";
    if (city.length < 2) return res.status(400).json({ error: "Select a city before searching for gyms." });
    if (!googleKey()) return res.status(503).json({ configured: false, error: "Gym discovery requires GOOGLE_PLACES_API_KEY." });
    const places = await placesTextSearch(`${query || "gyms"} in ${city}, India`);
    const gyms: any[] = [];
    for (const place of places) {
      if (!place.id || !place.displayName?.text) continue;
      const gym = await upsertPlace(place, city);
      gyms.push(gym);
    }
    return res.json({ configured: true, city, gyms });
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

  router.post("/:gymId/observations", async (req: AuthedRequest, res) => {
    const parsed = observationSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "crowdPercent must be between 0 and 100; source must be manual." });
    const membership = await db.get<any>("SELECT gymId FROM GymMembership WHERE userId = ?", req.userId!);
    if (!membership || membership.gymId !== req.params.gymId) return res.status(403).json({ error: "You must be a member of this gym to submit an observation." });
    const observedAt = nowIso();
    const hourStart = new Date(observedAt); hourStart.setMinutes(0, 0, 0);
    const hourEnd = new Date(hourStart.getTime() + 60 * 60 * 1000).toISOString();
    const previous = await db.get<any>("SELECT id FROM GymCrowdObservation WHERE gymId = ? AND userId = ? AND observedAt >= ? AND observedAt < ?", req.params.gymId, req.userId!, hourStart.toISOString(), hourEnd);
    if (previous) {
      await db.run("UPDATE GymCrowdObservation SET crowdPercent = ?, occupiedCount = ?, capacity = ?, createdAt = ? WHERE id = ?", parsed.data.crowdPercent, parsed.data.occupiedCount ?? null, parsed.data.capacity ?? null, observedAt, previous.id);
    } else {
      await db.run("INSERT INTO GymCrowdObservation (id, gymId, userId, observedAt, crowdPercent, occupiedCount, capacity, source, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", uuidv4(), req.params.gymId, req.userId!, observedAt, parsed.data.crowdPercent, parsed.data.occupiedCount ?? null, parsed.data.capacity ?? null, parsed.data.source, observedAt);
    }
    return res.status(201).json({ accepted: true, message: "Observation added. The next forecast request will recalculate predictions using this observation." });
  });
}
