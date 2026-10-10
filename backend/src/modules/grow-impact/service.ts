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

export interface GrowImpactConfig {
  monthlyTarget: number;
  monthLengthDays: number;
  holidayAllowanceDays: number;
  timeZone: string;
  trees: GrowImpactTreeOption[];
}

export interface MonthWindow {
  month: string;
  start: Date;
  end: Date;
  calendarDays: number;
  sundayRestDays: number;
}

const DEFAULT_TREES: GrowImpactTreeOption[] = [
  { id: "oak", name: "Mighty Oak", species: "Quercus robur", image: "assets/grow-impact/oak.svg", description: "A long-lived native oak that supports rich woodland habitats." },
  { id: "mangrove", name: "Coastal Mangrove", species: "Rhizophora mucronata", image: "assets/grow-impact/mangrove.svg", description: "A coastal tree that helps shelter shorelines and nursery habitats." },
  { id: "neem", name: "Neem", species: "Azadirachta indica", image: "assets/grow-impact/neem.svg", description: "A hardy evergreen suited to warm climates and community planting." },
];

function integerSetting(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function configuredTrees(): GrowImpactTreeOption[] {
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

export function getGrowImpactConfig(now = new Date()): GrowImpactConfig {
  const timeZone = process.env.GROW_IMPACT_TIME_ZONE?.trim() || "UTC";
  // Validate the configured IANA timezone at startup/request time.
  new Intl.DateTimeFormat("en", { timeZone }).format(now);
  const currentMonthDays = getMonthWindow(now, timeZone).calendarDays;
  return {
    monthlyTarget: integerSetting("GROW_IMPACT_MONTHLY_TARGET", 26, 1, 366),
    monthLengthDays: integerSetting("GROW_IMPACT_MONTH_LENGTH_DAYS", currentMonthDays, 1, 366),
    holidayAllowanceDays: integerSetting("GROW_IMPACT_HOLIDAY_ALLOWANCE_DAYS", 0, 0, 31),
    timeZone,
    trees: configuredTrees(),
  };
}

function dateParts(date: Date, timeZone: string): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
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

export function getMonthWindow(now = new Date(), timeZone = "UTC"): MonthWindow {
  const localNow = dateParts(now, timeZone);
  const calendarDays = new Date(Date.UTC(localNow.year, localNow.month, 0)).getUTCDate();
  const start = zonedMidnightUtc(localNow.year, localNow.month, 1, timeZone);
  const end = zonedMidnightUtc(localNow.year, localNow.month + 1, 1, timeZone);
  let sundayRestDays = 0;
  for (let day = 1; day <= calendarDays; day++) {
    if (new Date(Date.UTC(localNow.year, localNow.month - 1, day)).getUTCDay() === 0) sundayRestDays++;
  }
  return { month: `${localNow.year}-${String(localNow.month).padStart(2, "0")}`, start, end, calendarDays, sundayRestDays };
}

export function isValidCompletedGymWorkout(workout: CompletedWorkoutCandidate): boolean {
  return workout.status === "completed" && Boolean(workout.completedAt) &&
    Number.isFinite(Number(workout.durationMin)) && Number(workout.durationMin) > 0 &&
    Number.isFinite(Number(workout.completedSetCount)) && Number(workout.completedSetCount) > 0 &&
    !Number.isNaN(Date.parse(workout.completedAt!));
}

export function uniqueCompletedSessionDays(
  workouts: CompletedWorkoutCandidate[], month: string, timeZone: string,
): string[] {
  const dates = new Set<string>();
  for (const workout of workouts) {
    if (!isValidCompletedGymWorkout(workout)) continue;
    const parts = dateParts(new Date(workout.completedAt!), timeZone);
    const date = `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
    if (date.startsWith(`${month}-`)) dates.add(date);
  }
  return [...dates].sort();
}

export function virtualGrowthStage(confirmedAt: string | null, now = new Date()): { label: string; elapsedDays: number } {
  if (!confirmedAt || Number.isNaN(Date.parse(confirmedAt))) return { label: "Choice saved", elapsedDays: 0 };
  const elapsedDays = Math.max(0, Math.floor((now.getTime() - Date.parse(confirmedAt)) / 86_400_000));
  const label = elapsedDays < 7 ? "Seed" : elapsedDays < 30 ? "Seedling" : elapsedDays < 90 ? "Young tree" : "Growing canopy";
  return { label, elapsedDays };
}
