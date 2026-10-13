import { v4 as uuidv4 } from "uuid";
import type { DatabaseLike } from "../../db/types";

export interface CompletedWorkoutCandidate {
  status: string;
  completedAt: string | null;
  durationMin: number | string;
  completedSetCount: number | string;
}

export interface GrowImpactTreeOption {
  id: string;
  name: string;
  species: string;
  image: string;
  description: string;
}

export interface HolidayDate {
  date: string;
  name: string;
  source: "public" | "gym-closure";
  excluded: boolean;
  sunday: boolean;
}

export interface GrowImpactLocation {
  key: string;
  countryCode: string;
  regionCode: string;
  countryName: string;
  regionName: string;
  timeZone: string;
  holidaysByYear: Record<string, Array<{ date: string; name: string }>>;
}

export interface GrowImpactSettings {
  location: GrowImpactLocation;
  timeZone: string;
  gymOpenOnHolidayDates: string[];
  additionalClosureDates: string[];
}

export interface MonthWindow {
  month: string;
  start: Date;
  end: Date;
  calendarDays: number;
  sundayRestDays: number;
  sundayDates: string[];
}

export interface MonthlyTargetSummary extends MonthWindow {
  countryCode: string;
  regionCode: string;
  holidayDates: HolidayDate[];
  holidayCalendarConfigured: boolean;
  holidayCount: number;
  holidaySundayCount: number;
  additionalClosureCount: number;
  eligibleDays: number;
  target: number;
  completedSessionDates: string[];
  completedSessions: number;
  remainingSessions: number;
  progressPercent: number;
  growthStageIndex: number;
  growthStageCount: number;
  growthStageLabel: string;
  nextMilestone: string;
  timeZone: string;
}

const DEFAULT_TREES: GrowImpactTreeOption[] = [
  { id: "oak", name: "Mighty Oak", species: "Quercus robur", image: "assets/grow-impact/oak.svg", description: "A long-lived native oak that supports rich woodland habitats." },
  { id: "mangrove", name: "Coastal Mangrove", species: "Rhizophora mucronata", image: "assets/grow-impact/mangrove.svg", description: "A coastal tree that helps shelter shorelines and nursery habitats." },
  { id: "neem", name: "Neem", species: "Azadirachta indica", image: "assets/grow-impact/neem.svg", description: "A hardy evergreen suited to warm climates and community planting." },
];

// Government of Gujarat GAD notification GS/22/2025/JSR/2025/509/GH, issued
// 27 Nov 2025. This is the initial default gym calendar; operators should
// adjust it for facilities that remain open on a notified public holiday.
const GUJARAT_2026_HOLIDAYS = [
  ["2026-01-14", "Makar Sankranti"], ["2026-01-26", "Republic Day"],
  ["2026-03-04", "Holi (Dhuleti)"], ["2026-03-19", "Cheti Chand"],
  ["2026-03-21", "Ramjan-Eid (Eid-Ul-Fitra)"], ["2026-03-26", "Ram Navmi"],
  ["2026-03-31", "Mahavir Janma Kalyanak"], ["2026-04-03", "Good Friday"],
  ["2026-04-14", "Dr. B. R. Ambedkar's Birthday"], ["2026-05-27", "Eid-Ul-Adha (Bakri-Eid)"],
  ["2026-06-26", "Muharram"], ["2026-08-15", "Independence Day / Parsi New Year"],
  ["2026-08-26", "Eid-e-Meeladunnabi"], ["2026-08-28", "Raksha Bandhan"],
  ["2026-09-04", "Janmashtami"], ["2026-09-15", "Samvatsari"],
  ["2026-10-02", "Mahatma Gandhi's Birthday"], ["2026-10-20", "Dusshera (Vijaya Dashmi)"],
  ["2026-10-31", "Sardar Vallabhbhai Patel's Birthday"],
  ["2026-11-10", "Vikram Samvat New Year"], ["2026-11-11", "Bhai Bij"],
  ["2026-11-24", "Guru Nanak's Birthday"], ["2026-12-25", "Christmas"],
].map(([date, name]) => ({ date, name }));

const DEFAULT_LOCATION: GrowImpactLocation = {
  key: "IN-GJ", countryCode: "IN", regionCode: "GJ", countryName: "India", regionName: "Gujarat",
  timeZone: "Asia/Kolkata", holidaysByYear: { "2026": GUJARAT_2026_HOLIDAYS },
};

function isDateOnly(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10) === value;
}

function parseTrees(): GrowImpactTreeOption[] {
  const raw = process.env.GROW_IMPACT_TREE_OPTIONS;
  if (!raw) return DEFAULT_TREES;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 3) throw new Error("exactly three options are required");
    const options = parsed.map((item) => {
      if (!item || typeof item !== "object") throw new Error("invalid tree option");
      const tree = item as Record<string, unknown>;
      for (const key of ["id", "name", "species", "image", "description"]) {
        if (typeof tree[key] !== "string" || !(tree[key] as string).trim()) throw new Error(`missing ${key}`);
      }
      return {
        id: (tree.id as string).trim(), name: (tree.name as string).trim(),
        species: (tree.species as string).trim(), image: (tree.image as string).trim(),
        description: (tree.description as string).trim(),
      };
    });
    if (new Set(options.map((tree) => tree.id)).size !== 3) throw new Error("tree IDs must be unique");
    return options;
  } catch (error) {
    throw new Error(`GROW_IMPACT_TREE_OPTIONS must be a JSON array of three tree options: ${error instanceof Error ? error.message : "invalid JSON"}`);
  }
}

function assertTimeZone(timeZone: string): string {
  try { new Intl.DateTimeFormat("en", { timeZone }).format(); }
  catch { throw new Error("timeZone must be a valid IANA timezone"); }
  return timeZone;
}

function parseAdminLocations(): GrowImpactLocation[] {
  const raw = process.env.GROW_IMPACT_LOCATION_CALENDARS_JSON;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return Object.entries(parsed).map(([key, rawValue]) => {
      if (!/^[A-Z]{2}-[A-Z0-9]{2,3}$/.test(key) || !rawValue || typeof rawValue !== "object") throw new Error("invalid location entry");
      const value = rawValue as Record<string, unknown>;
      const countryCode = key.split("-")[0];
      const regionCode = key.split("-")[1];
      if (typeof value.countryName !== "string" || typeof value.regionName !== "string" || typeof value.timeZone !== "string") throw new Error(`missing location names/timeZone for ${key}`);
      const holidaysByYear = (value.holidaysByYear ?? {}) as Record<string, unknown>;
      const normalized: GrowImpactLocation["holidaysByYear"] = {};
      for (const [year, entries] of Object.entries(holidaysByYear)) {
        if (!/^\d{4}$/.test(year) || !Array.isArray(entries)) throw new Error(`invalid holiday year for ${key}`);
        normalized[year] = entries.map((entry) => {
          if (!entry || typeof entry !== "object") throw new Error(`invalid holiday entry for ${key}`);
          const holiday = entry as Record<string, unknown>;
          if (!isDateOnly(holiday.date) || holiday.date.slice(0, 4) !== year || typeof holiday.name !== "string" || !holiday.name.trim()) throw new Error(`invalid holiday date/name for ${key}`);
          return { date: holiday.date, name: holiday.name.trim() };
        });
      }
      return {
        key, countryCode, regionCode, countryName: value.countryName.trim(), regionName: value.regionName.trim(),
        timeZone: assertTimeZone(value.timeZone), holidaysByYear: normalized,
      };
    });
  } catch (error) {
    throw new Error(`GROW_IMPACT_LOCATION_CALENDARS_JSON is invalid: ${error instanceof Error ? error.message : "invalid JSON"}`);
  }
}

export function getImpactLocations(): GrowImpactLocation[] {
  const locations = [DEFAULT_LOCATION, ...parseAdminLocations()];
  return [...new Map(locations.map((location) => [location.key, location])).values()];
}

export function getDefaultImpactLocation(): GrowImpactLocation {
  const wanted = process.env.GROW_IMPACT_DEFAULT_LOCATION?.trim().toUpperCase() || DEFAULT_LOCATION.key;
  return getImpactLocations().find((location) => location.key === wanted) ?? DEFAULT_LOCATION;
}

export function getImpactLocation(key: string): GrowImpactLocation {
  const location = getImpactLocations().find((candidate) => candidate.key === key.toUpperCase());
  if (!location) throw new Error("That holiday calendar is not configured. Ask an administrator to add it.");
  return location;
}

export function getGrowImpactConfig(): { trees: GrowImpactTreeOption[]; locations: GrowImpactLocation[] } {
  return { trees: parseTrees(), locations: getImpactLocations() };
}

export function dateParts(date: Date, timeZone: string): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(values.year), month: Number(values.month), day: Number(values.day),
    hour: Number(values.hour), minute: Number(values.minute), second: Number(values.second),
  };
}

function zonedMidnightUtc(year: number, month: number, day: number, timeZone: string): Date {
  const desired = Date.UTC(year, month - 1, day);
  let estimate = desired;
  for (let i = 0; i < 5; i++) {
    const local = dateParts(new Date(estimate), timeZone);
    const represented = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
    const correction = desired - represented;
    estimate += correction;
    if (correction === 0) break;
  }
  return new Date(estimate);
}

export function getMonthWindowForKey(month: string, timeZone: string): MonthWindow {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error("month must be YYYY-MM");
  const [year, monthNumber] = month.split("-").map(Number);
  const calendarDays = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const start = zonedMidnightUtc(year, monthNumber, 1, timeZone);
  const end = zonedMidnightUtc(year, monthNumber + 1, 1, timeZone);
  const sundayDates: string[] = [];
  for (let day = 1; day <= calendarDays; day++) {
    if (new Date(Date.UTC(year, monthNumber - 1, day)).getUTCDay() === 0) {
      sundayDates.push(`${month}-${String(day).padStart(2, "0")}`);
    }
  }
  return { month, start, end, calendarDays, sundayRestDays: sundayDates.length, sundayDates };
}

export function getMonthWindow(now = new Date(), timeZone = "UTC"): MonthWindow {
  const localNow = dateParts(now, timeZone);
  return getMonthWindowForKey(`${localNow.year}-${String(localNow.month).padStart(2, "0")}`, timeZone);
}

function parseDateMapSetting(name: string): Record<string, string[]> {
  const raw = process.env[name];
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(parsed).map(([key, dates]) => {
      if (!/^[A-Z]{2}-[A-Z0-9]{2,3}$/.test(key) || !Array.isArray(dates) || !dates.every(isDateOnly)) throw new Error("expected location keys mapped to YYYY-MM-DD arrays");
      return [key, [...new Set(dates as string[])]];
    }));
  } catch (error) {
    throw new Error(`${name} is invalid: ${error instanceof Error ? error.message : "invalid JSON"}`);
  }
}

export function parseDateList(value: string | string[] | null | undefined): string[] {
  try {
    const parsed = Array.isArray(value) ? value : JSON.parse(value || "[]");
    return Array.isArray(parsed) ? [...new Set(parsed.filter(isDateOnly))] : [];
  } catch { return []; }
}

export interface ImpactCalendarPreferences {
  gymOpenOnHolidayDates: string[];
  additionalClosureDates: string[];
}

export function calculateMonthlyTarget(
  month: string,
  location: GrowImpactLocation,
  timeZone = location.timeZone,
  preferences: ImpactCalendarPreferences = { gymOpenOnHolidayDates: [], additionalClosureDates: [] },
): Omit<MonthlyTargetSummary, "completedSessionDates" | "completedSessions" | "remainingSessions" | "progressPercent" | "growthStageIndex" | "growthStageCount" | "growthStageLabel" | "nextMilestone"> {
  const window = getMonthWindowForKey(month, assertTimeZone(timeZone));
  const publicHolidays = (location.holidaysByYear[month.slice(0, 4)] ?? []).filter((holiday) => holiday.date.startsWith(`${month}-`));
  const openDates = new Set(preferences.gymOpenOnHolidayDates);
  const adminClosures = new Set(parseDateMapSetting("GROW_IMPACT_GYM_CLOSURES_JSON")[location.key] ?? []);
  const userClosures = new Set(preferences.additionalClosureDates);
  const publicByDate = new Map(publicHolidays.map((holiday) => [holiday.date, holiday.name]));
  const additionalDates = new Set([...adminClosures, ...userClosures]);
  const holidayDates: HolidayDate[] = [];
  for (const [date, name] of publicByDate) {
    holidayDates.push({ date, name, source: "public", excluded: !openDates.has(date), sunday: window.sundayDates.includes(date) });
  }
  for (const date of additionalDates) {
    if (!date.startsWith(`${month}-`) || (publicByDate.has(date) && !openDates.has(date))) continue;
    holidayDates.push({ date, name: "Additional gym closure", source: "gym-closure", excluded: true, sunday: window.sundayDates.includes(date) });
  }
  const publicHolidaySet = new Set(publicHolidays.filter((holiday) => !openDates.has(holiday.date)).map((holiday) => holiday.date));
  const gymClosureSet = new Set([...additionalDates].filter((date) => date.startsWith(`${month}-`) && !publicHolidaySet.has(date)));
  const unionExclusions = new Set([...window.sundayDates, ...publicHolidaySet, ...gymClosureSet]);
  return {
    ...window,
    countryCode: location.countryCode,
    regionCode: location.regionCode,
    holidayDates: holidayDates.sort((a, b) => a.date.localeCompare(b.date)),
    holidayCalendarConfigured: Object.prototype.hasOwnProperty.call(location.holidaysByYear, month.slice(0, 4)),
    holidayCount: publicHolidaySet.size,
    holidaySundayCount: [...publicHolidaySet].filter((date) => window.sundayDates.includes(date)).length,
    additionalClosureCount: gymClosureSet.size,
    eligibleDays: Math.max(0, window.calendarDays - unionExclusions.size),
    target: Math.max(0, window.calendarDays - unionExclusions.size),
    timeZone,
  };
}

export function isValidCompletedGymWorkout(workout: CompletedWorkoutCandidate): boolean {
  return workout.status === "completed" && Boolean(workout.completedAt) &&
    Number.isFinite(Number(workout.durationMin)) && Number(workout.durationMin) > 0 &&
    Number.isFinite(Number(workout.completedSetCount)) && Number(workout.completedSetCount) > 0 &&
    !Number.isNaN(Date.parse(workout.completedAt!));
}

export function uniqueCompletedSessionDays(workouts: CompletedWorkoutCandidate[], month: string, timeZone: string): string[] {
  const dates = new Set<string>();
  for (const workout of workouts) {
    if (!isValidCompletedGymWorkout(workout)) continue;
    const parts = dateParts(new Date(workout.completedAt!), timeZone);
    const date = `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
    if (date.startsWith(`${month}-`)) dates.add(date);
  }
  return [...dates].sort();
}

export function growthProgress(sessions: number, target: number): { growthStageIndex: number; growthStageCount: number; growthStageLabel: string; nextMilestone: string } {
  // Stage 1 is the seed; each qualified session unlocks the next stage.
  // Normal calendar targets produce 25–28 stages (seed plus eligible days).
  const growthStageCount = target > 0 ? Math.max(2, Math.min(31, target + 1)) : 25;
  const boundedSessions = Math.max(0, sessions);
  const growthStageIndex = target > 0
    ? Math.min(growthStageCount, 1 + Math.min(boundedSessions, target))
    : 1;
  const ratio = (growthStageIndex - 1) / (growthStageCount - 1);
  const growthStageLabel = ratio < 0.04 ? "Seed" : ratio < 0.16 ? "Roots taking hold" : ratio < 0.32 ? "First sprout" : ratio < 0.52 ? "Leaves unfolding" : ratio < 0.74 ? "Strong stem and branches" : ratio < 1 ? "Growing canopy" : "Mature tree";
  const nextMilestone = target > 0 && boundedSessions >= target
    ? "Monthly target reached · mature tree"
    : ratio < 0.16 ? "Next: roots take hold" : ratio < 0.32 ? "Next: first sprout" : ratio < 0.52 ? "Next: leaves unfold" : ratio < 0.74 ? "Next: branches strengthen" : "Next: full canopy";
  return { growthStageIndex, growthStageCount, growthStageLabel, nextMilestone };
}

export interface StoredImpactSettings {
  countryCode: string;
  regionCode: string;
  timeZone: string;
  gymOpenOnHolidayDatesJson: string | null;
  additionalClosureDatesJson: string | null;
}

export async function getUserImpactSettings(database: DatabaseLike, userId: string): Promise<GrowImpactSettings> {
  const row = await database.get<StoredImpactSettings>(
    `SELECT countryCode,regionCode,timeZone,gymOpenOnHolidayDatesJson,additionalClosureDatesJson FROM GrowImpactSettings WHERE userId=?`, userId,
  );
  const defaultLocation = getDefaultImpactLocation();
  const location = row ? getImpactLocation(`${row.countryCode}-${row.regionCode}`) : defaultLocation;
  return {
    location,
    timeZone: assertTimeZone(row?.timeZone || location.timeZone),
    gymOpenOnHolidayDates: parseDateList(row?.gymOpenOnHolidayDatesJson),
    additionalClosureDates: parseDateList(row?.additionalClosureDatesJson),
  };
}

export interface StoredMonthlyProgress extends MonthlyTargetSummary {
  location: GrowImpactLocation;
  settings: GrowImpactSettings;
}

export async function refreshMonthlyProgress(
  database: DatabaseLike,
  userId: string,
  month: string,
  timeZoneOverride?: string,
  now = new Date(),
): Promise<StoredMonthlyProgress> {
  const settings = await getUserImpactSettings(database, userId);
  const timeZone = assertTimeZone(timeZoneOverride || settings.timeZone);
  const calendar = calculateMonthlyTarget(month, settings.location, timeZone, settings);
  const workouts = await database.all<CompletedWorkoutCandidate>(
    `SELECT w.status,w.completedAt,w.durationMin,
      (SELECT COUNT(*) FROM WorkoutExercise we JOIN WorkoutSet ws ON ws.workoutExerciseId=we.id
       WHERE we.workoutId=w.id AND ws.completed=1) AS completedSetCount
     FROM Workout w WHERE w.userId=? AND w.completedAt>=? AND w.completedAt<? AND w.status='completed'`,
    userId, calendar.start.toISOString(), calendar.end.toISOString(),
  );
  const completedSessionDates = uniqueCompletedSessionDays(workouts, month, timeZone);
  const completedSessions = completedSessionDates.length;
  const growth = growthProgress(completedSessions, calendar.target);
  const updatedAt = now.toISOString();
  await database.run(
    `INSERT INTO GrowImpactMonthlyProgress
      (id,userId,qualifyingMonth,countryCode,regionCode,timeZone,calendarDays,sundayRestDays,holidayCount,holidaySundayCount,holidayCalendarConfigured,eligibleDays,monthlyTarget,completedSessions,growthStageIndex,growthStageCount,completedSessionDatesJson,computedAt,createdAt,updatedAt)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(userId,qualifyingMonth) DO UPDATE SET
      countryCode=excluded.countryCode,regionCode=excluded.regionCode,timeZone=excluded.timeZone,
      calendarDays=excluded.calendarDays,sundayRestDays=excluded.sundayRestDays,holidayCount=excluded.holidayCount,
      holidaySundayCount=excluded.holidaySundayCount,holidayCalendarConfigured=excluded.holidayCalendarConfigured,
      eligibleDays=excluded.eligibleDays,monthlyTarget=excluded.monthlyTarget,
      completedSessions=excluded.completedSessions,growthStageIndex=excluded.growthStageIndex,
      growthStageCount=excluded.growthStageCount,completedSessionDatesJson=excluded.completedSessionDatesJson,
      computedAt=excluded.computedAt,updatedAt=excluded.updatedAt`,
    uuidv4(), userId, month, settings.location.countryCode, settings.location.regionCode, timeZone,
    calendar.calendarDays, calendar.sundayRestDays, calendar.holidayCount, calendar.holidaySundayCount, Number(calendar.holidayCalendarConfigured),
    calendar.eligibleDays, calendar.target, completedSessions, growth.growthStageIndex, growth.growthStageCount,
    JSON.stringify(completedSessionDates), updatedAt, updatedAt, updatedAt,
  );

  // One durable reward row also serves as the single in-app completion notice.
  // The unique user/month key prevents duplicate rewards when requests race.
  if (calendar.target > 0 && completedSessions >= calendar.target) {
    await database.run(
      `INSERT INTO GrowImpactReward (id,userId,qualifyingMonth,status,plantingStatus,verifiedPhotosJson,photoUpdatesOptIn,createdAt,updatedAt)
       VALUES (?,?,?,'unlocked','virtual_commitment','[]',0,?,?)
       ON CONFLICT(userId,qualifyingMonth) DO NOTHING`,
      uuidv4(), userId, month, updatedAt, updatedAt,
    );
  }

  return {
    ...calendar,
    completedSessionDates,
    completedSessions,
    remainingSessions: Math.max(0, calendar.target - completedSessions),
    progressPercent: calendar.target > 0 ? Math.min(100, Math.round(completedSessions / calendar.target * 100)) : 0,
    ...growth,
    location: settings.location,
    settings,
  };
}

export async function refreshProgressForCompletedWorkout(database: DatabaseLike, userId: string, completedAt: string): Promise<void> {
  const settings = await getUserImpactSettings(database, userId);
  const parts = dateParts(new Date(completedAt), settings.timeZone);
  const month = `${parts.year}-${String(parts.month).padStart(2, "0")}`;
  await refreshMonthlyProgress(database, userId, month, settings.timeZone, new Date(completedAt));
}

export function virtualGrowthStage(confirmedAt: string | null, now = new Date()): { label: string; elapsedDays: number } {
  if (!confirmedAt || Number.isNaN(Date.parse(confirmedAt))) return { label: "Choice saved", elapsedDays: 0 };
  const elapsedDays = Math.max(0, Math.floor((now.getTime() - Date.parse(confirmedAt)) / 86_400_000));
  const label = elapsedDays < 7 ? "Seed" : elapsedDays < 30 ? "Seedling" : elapsedDays < 90 ? "Young tree" : "Growing canopy";
  return { label, elapsedDays };
}
