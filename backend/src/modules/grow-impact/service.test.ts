import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  calculateMonthlyTarget,
  getDefaultImpactLocation,
  getImpactLocation,
  getMonthWindow,
  getMonthWindowForKey,
  growthProgress,
  refreshMonthlyProgress,
  uniqueCompletedSessionDates,
  virtualGrowthStage,
} from "./service";
import type { DatabaseLike } from "../../db/types";

describe("monthly target calendar", () => {
  const gujarat = getDefaultImpactLocation();
  const noOverrides = { gymOpenOnHolidayDates: [], additionalClosureDates: [] };

  it("uses actual month lengths and handles leap years and four/five Sundays", () => {
    expect(calculateMonthlyTarget("2026-02", gujarat).calendarDays).toBe(28);
    expect(calculateMonthlyTarget("2028-02", gujarat).calendarDays).toBe(29);
    expect(calculateMonthlyTarget("2026-06", gujarat).sundayRestDays).toBe(4);
    expect(calculateMonthlyTarget("2026-08", gujarat).sundayRestDays).toBe(5);
    expect(calculateMonthlyTarget("2026-08", gujarat).target).toBe(23);
  });

  it("calculates each month's Sundays and base target across three years", () => {
    const withoutHolidays = { ...gujarat, holidaysByYear: {} };
    for (const year of [2026, 2027, 2028]) {
      for (let month = 1; month <= 12; month += 1) {
        const monthKey = `${year}-${String(month).padStart(2, "0")}`;
        const calendarDays = new Date(Date.UTC(year, month, 0)).getUTCDate();
        const sundayCount = Array.from({ length: calendarDays }, (_, index) => index + 1)
          .filter((day) => new Date(Date.UTC(year, month - 1, day)).getUTCDay() === 0).length;
        const result = calculateMonthlyTarget(monthKey, withoutHolidays);
        expect(result).toMatchObject({
          calendarDays,
          sundayRestDays: sundayCount,
          target: calendarDays - sundayCount,
          holidayCalendarConfigured: false,
        });
      }
    }
  });

  it("calculates October 2026 Gujarat as 24 eligible gym days", () => {
    const result = calculateMonthlyTarget("2026-10", gujarat, "Asia/Kolkata", noOverrides);
    expect(result).toMatchObject({ calendarDays: 31, sundayRestDays: 4, holidayCount: 3, holidaySundayCount: 0, target: 24, eligibleDays: 24 });
  });

  it("identifies years whose public holiday calendar still needs administrator setup", () => {
    const result = calculateMonthlyTarget("2027-01", gujarat);
    expect(result.holidayCalendarConfigured).toBe(false);
    expect(result.target).toBe(result.calendarDays - result.sundayRestDays);
  });

  it("deduplicates holiday Sundays and overlapping user/admin closures", () => {
    const testLocation = {
      ...gujarat,
      holidaysByYear: { "2026": [
        { date: "2026-06-07", name: "Sunday holiday" },
        { date: "2026-06-08", name: "Weekday holiday" },
      ] },
    };
    const envKey = "GROW_IMPACT_GYM_CLOSURES_JSON";
    const oldEnv = process.env[envKey];
    process.env[envKey] = JSON.stringify({ "IN-GJ": ["2026-06-08", "2026-06-09"] });
    try {
      const result = calculateMonthlyTarget("2026-06", testLocation, "Asia/Kolkata", {
        gymOpenOnHolidayDates: [], additionalClosureDates: ["2026-06-09", "2026-06-10"],
      });
      expect(result.sundayRestDays).toBe(4);
      expect(result.holidayCount).toBe(2);
      expect(result.holidaySundayCount).toBe(1);
      expect(result.additionalClosureCount).toBe(2);
      expect(result.target).toBe(23); // 30 days minus the seven unique excluded dates.
    } finally {
      if (oldEnv === undefined) delete process.env[envKey];
      else process.env[envKey] = oldEnv;
    }
  });

  it("shows one entry when an open public holiday is also a gym closure", () => {
    const testLocation = {
      ...gujarat,
      holidaysByYear: { "2026": [{ date: "2026-06-08", name: "Test regional holiday" }] },
    };
    const envKey = "GROW_IMPACT_GYM_CLOSURES_JSON";
    const oldEnv = process.env[envKey];
    process.env[envKey] = JSON.stringify({ "IN-GJ": ["2026-06-08"] });
    try {
      const result = calculateMonthlyTarget("2026-06", testLocation, "Asia/Kolkata", {
        gymOpenOnHolidayDates: ["2026-06-08"], additionalClosureDates: ["2026-06-08"],
      });
      expect(result.holidayDates.filter((date) => date.date === "2026-06-08")).toEqual([
        expect.objectContaining({ source: "gym-closure", excluded: true }),
      ]);
      expect(result).toMatchObject({ additionalClosureCount: 1, target: 25, eligibleDays: 25 });
    } finally {
      if (oldEnv === undefined) delete process.env[envKey];
      else process.env[envKey] = oldEnv;
    }
  });

  it("supports separate administrator-configured calendars by Indian region and year", () => {
    const envKey = "GROW_IMPACT_LOCATION_CALENDARS_JSON";
    const oldEnv = process.env[envKey];
    process.env[envKey] = JSON.stringify({
      "IN-MH": {
        countryName: "India", regionName: "Maharashtra", timeZone: "Asia/Kolkata",
        holidaysByYear: {
          "2026": [{ date: "2026-06-19", name: "Test Maharashtra 2026 holiday" }],
          "2027": [{ date: "2027-06-19", name: "Test Maharashtra 2027 holiday" }],
        },
      },
      "IN-DL": {
        countryName: "India", regionName: "Delhi", timeZone: "Asia/Kolkata",
        holidaysByYear: { "2026": [{ date: "2026-06-20", name: "Test Delhi holiday" }] },
      },
    });
    try {
      const maharashtra = getImpactLocation("IN-MH");
      const delhi = getImpactLocation("IN-DL");
      expect(maharashtra.regionName).toBe("Maharashtra");
      expect(calculateMonthlyTarget("2026-06", maharashtra)).toMatchObject({ holidayCount: 1, holidayCalendarConfigured: true });
      expect(calculateMonthlyTarget("2027-06", maharashtra)).toMatchObject({ holidayCount: 1, holidayCalendarConfigured: true });
      expect(calculateMonthlyTarget("2026-06", delhi)).toMatchObject({ holidayCount: 1, holidayCalendarConfigured: true });
      expect(calculateMonthlyTarget("2027-06", delhi)).toMatchObject({ holidayCount: 0, holidayCalendarConfigured: false });
    } finally {
      if (oldEnv === undefined) delete process.env[envKey];
      else process.env[envKey] = oldEnv;
    }
  });

  it("uses the user's local timezone at month boundaries and for completion dates", () => {
    const window = getMonthWindow(new Date("2026-02-01T04:30:00.000Z"), "America/New_York");
    expect(window.month).toBe("2026-01");
    expect(window.start.toISOString()).toBe("2026-01-01T05:00:00.000Z");
    expect(window.end.toISOString()).toBe("2026-02-01T05:00:00.000Z");
    expect(window.calendarDays).toBe(31);

    const localFirstDay = uniqueCompletedSessionDates([
      { id: "session-1", status: "completed", completedAt: "2026-09-30T18:31:00.000Z", durationMin: 40 },
    ], "2026-10", "Asia/Kolkata");
    expect(localFirstDay).toEqual(["2026-10-01"]);
  });

  it("handles DST offset changes when constructing zoned month windows", () => {
    const window = getMonthWindowForKey("2026-10", "Europe/Berlin");
    expect(window.start.toISOString()).toBe("2026-09-30T22:00:00.000Z");
    expect(window.end.toISOString()).toBe("2026-10-31T23:00:00.000Z");
  });
});

describe("verified monthly workout sessions", () => {
  const valid = (id: string, completedAt: string) => ({ id, status: "completed", completedAt, durationMin: 40 });

  it("counts each completed log ID once, including multiple sessions on one local day", () => {
    const dates = uniqueCompletedSessionDates([
      valid("session-1", "2026-06-03T09:00:00.000Z"), valid("session-2", "2026-06-03T20:00:00.000Z"),
      valid("session-2", "2026-06-03T20:00:00.000Z"), valid("session-3", "2026-06-04T07:30:00.000Z"),
      valid("session-4", "2026-05-31T21:00:00.000Z"),
    ], "2026-06", "America/Los_Angeles");
    expect(dates).toEqual(["2026-06-03", "2026-06-03", "2026-06-04"]);
  });

  it("ignores incomplete, superseded, failed, missing-date, and invalid-duration logs", () => {
    const dates = uniqueCompletedSessionDates([
      valid("session-1", "2026-06-07T10:00:00.000Z"),
      { ...valid("session-2", "2026-06-08T10:00:00.000Z"), status: "pending" },
      { ...valid("session-3", "2026-06-09T10:00:00.000Z"), status: "superseded" },
      { ...valid("session-4", "2026-06-10T10:00:00.000Z"), status: "failed" },
      { ...valid("session-5", "2026-06-11T10:00:00.000Z"), durationMin: 0 },
      { ...valid("session-6", "2026-06-12T10:00:00.000Z"), completedAt: null },
    ], "2026-06", "UTC");
    expect(dates).toEqual(["2026-06-07"]);
  });

  it("persists per-user/month progress from workout rows and unlocks one reward only once", async () => {
    const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(fs.readFileSync(path.resolve(__dirname, "../../db/schema.sql"), "utf8"));
      database.prepare(`INSERT INTO "User" (id,email,createdAt,updatedAt) VALUES (?,?,?,?)`)
        .run("member-1", "member@example.test", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
      const insertWorkout = database.prepare(`INSERT INTO Workout (id,userId,focus,status,durationMin,createdAt,completedAt) VALUES (?,?,?,?,?,?,?)`);
      const eligible = calculateMonthlyTarget("2026-10", getDefaultImpactLocation()).holidayDates
        .filter((holiday) => holiday.excluded).map((holiday) => holiday.date);
      const sundays = getMonthWindowForKey("2026-10", "Asia/Kolkata").sundayDates;
      const excluded = new Set([...eligible, ...sundays]);
      const eligibleDates = Array.from({ length: 31 }, (_, index) => `2026-10-${String(index + 1).padStart(2, "0")}`).filter((date) => !excluded.has(date));
      expect(eligibleDates).toHaveLength(24);
      for (const [index, day] of eligibleDates.entries()) {
        const completedAt = `${day}T12:00:00.000Z`;
        const workoutId = `workout-${index}`;
        insertWorkout.run(workoutId, "member-1", "chest", "completed", 40, completedAt, completedAt);
      }
      const adapter: DatabaseLike = {
        all: async <T extends import("pg").QueryResultRow = import("pg").QueryResultRow>(sql: string, ...params: unknown[]) => database.prepare(sql).all(...params) as T[],
        get: async <T extends import("pg").QueryResultRow = import("pg").QueryResultRow>(sql: string, ...params: unknown[]) => database.prepare(sql).get(...params) as T | undefined,
        run: async (sql: string, ...params: unknown[]) => {
          const result = database.prepare(sql).run(...params);
          return { changes: Number(result.changes) };
        },
        exec: async (sql: string) => { database.exec(sql); },
        transaction: async <T>(work: (tx: DatabaseLike) => Promise<T>) => work(adapter),
      };
      const first = await refreshMonthlyProgress(adapter, "member-1", "2026-10", "Asia/Kolkata", new Date("2026-10-31T18:00:00.000Z"));
      const second = await refreshMonthlyProgress(adapter, "member-1", "2026-10", "Asia/Kolkata", new Date("2026-10-31T18:01:00.000Z"));
      expect(first).toMatchObject({ target: 24, completedSessions: 24, remainingSessions: 0, growthStageIndex: first.growthStageCount });
      expect(second.completedSessions).toBe(24);
      expect(database.prepare(`SELECT COUNT(*) AS count FROM GrowImpactMonthlyProgress WHERE userId='member-1' AND qualifyingMonth='2026-10'`).get()).toMatchObject({ count: 1 });
      expect(database.prepare(`SELECT monthlyTarget,completedSessions FROM GrowImpactMonthlyProgress WHERE userId='member-1' AND qualifyingMonth='2026-10'`).get()).toMatchObject({ monthlyTarget: 24, completedSessions: 24 });
      expect(database.prepare(`SELECT COUNT(*) AS count FROM GrowImpactReward WHERE userId='member-1' AND qualifyingMonth='2026-10'`).get()).toMatchObject({ count: 1 });

      const november = await refreshMonthlyProgress(adapter, "member-1", "2026-11", "Asia/Kolkata", new Date("2026-11-01T00:00:00.000Z"));
      expect(november.completedSessions).toBe(0);
      expect(database.prepare(`SELECT COUNT(*) AS count FROM GrowImpactMonthlyProgress WHERE userId='member-1'`).get()).toMatchObject({ count: 2 });
    } finally {
      database.close();
    }
  });
});

describe("growth stages and virtual reward", () => {
  it("shows distinct sequential stages and reaches mature tree at target", () => {
    expect(growthProgress(0, 24)).toMatchObject({ growthStageIndex: 1, growthStageCount: 25, growthStageLabel: "Seed" });
    expect(growthProgress(1, 24).growthStageIndex).toBe(2);
    expect(growthProgress(7, 20).growthStageIndex).toBe(8);
    expect(growthProgress(24, 24)).toMatchObject({ growthStageIndex: 25, growthStageLabel: "Mature tree" });
  });

  it("uses elapsed time only for the explicitly virtual journey", () => {
    expect(virtualGrowthStage("2026-01-01T00:00:00.000Z", new Date("2026-02-15T00:00:00.000Z")))
      .toEqual({ label: "Young tree", elapsedDays: 45 });
  });

  it("enforces one reward per user and qualifying month in the migrated schema", () => {
    const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(fs.readFileSync(path.resolve(__dirname, "../../db/schema.sql"), "utf8"));
      database.prepare(`INSERT INTO "User" (id,email,createdAt,updatedAt) VALUES (?,?,?,?)`)
        .run("user-1", "member@example.test", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
      const insert = database.prepare(`INSERT INTO GrowImpactReward (id,userId,qualifyingMonth,createdAt,updatedAt) VALUES (?,?,?,?,?)`);
      insert.run("reward-1", "user-1", "2026-01", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
      expect(() => insert.run("reward-2", "user-1", "2026-01", "2026-01-02T00:00:00.000Z", "2026-01-02T00:00:00.000Z")).toThrow();
    } finally {
      database.close();
    }
  });
});
