import type { DatabaseLike } from "../../db/types";

export const XP_PER_WORKOUT = 100;
export const XP_PER_CONSECUTIVE_DAY = 25;
const IST = "Asia/Kolkata";

export interface MemberXp {
  workouts: number;
  consistencyBonusDays: number;
  xp: number;
}

const dayFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: IST,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function indiaDateKey(value: string): string | null {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = dayFormatter.formatToParts(date);
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function dayNumber(key: string): number {
  const [year, month, day] = key.split("-").map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / 86400000);
}

/** Pure XP calculation: the single definition used everywhere on the server. */
export function computeXp(completedAtValues: string[]): MemberXp {
  const days = [...new Set(
    completedAtValues.map(indiaDateKey).filter((v): v is string => Boolean(v))
  )].sort((a, b) => dayNumber(a) - dayNumber(b));

  let consistencyBonusDays = 0;
  for (let i = 1; i < days.length; i += 1) {
    if (dayNumber(days[i]) - dayNumber(days[i - 1]) === 1) consistencyBonusDays += 1;
  }
  const workouts = completedAtValues.length;
  return {
    workouts,
    consistencyBonusDays,
    xp: workouts * XP_PER_WORKOUT + consistencyBonusDays * XP_PER_CONSECUTIVE_DAY,
  };
}

/**
 * XP for many users from ONE query against the Workout table of the database
 * this server is connected to. Every requested user gets an entry (0 if none),
 * and each user's XP only ever depends on rows where Workout.userId = that user.
 */
export async function loadXpForUsers(
  database: Pick<DatabaseLike, "all">,
  userIds: string[]
): Promise<Map<string, MemberXp>> {
  const result = new Map<string, MemberXp>();
  const ids = [...new Set(userIds)];
  for (const id of ids) result.set(id, computeXp([]));
  if (!ids.length) return result;

  const rows = await database.all<{ userId: string; completedAt: string }>(
    `SELECT userId, completedAt FROM Workout
     WHERE userId IN (${ids.map(() => "?").join(",")})
       AND status = 'completed' AND completedAt IS NOT NULL`,
    ...ids
  );
  const grouped = new Map<string, string[]>();
  for (const row of rows) {
    const list = grouped.get(row.userId) ?? [];
    list.push(String(row.completedAt));
    grouped.set(row.userId, list);
  }
  for (const [id, list] of grouped) result.set(id, computeXp(list));
  return result;
}
