import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getGrowImpactConfig, getMonthWindow, uniqueCompletedSessionDays, virtualGrowthStage } from "./service";

describe("Grow Your Impact calendar month boundaries", () => {
  it("keeps target, month length, and holiday allowance configurable", () => {
    const keys = ["GROW_IMPACT_MONTHLY_TARGET", "GROW_IMPACT_MONTH_LENGTH_DAYS", "GROW_IMPACT_HOLIDAY_ALLOWANCE_DAYS"] as const;
    const original = keys.map((key) => process.env[key]);
    try {
      process.env.GROW_IMPACT_MONTHLY_TARGET = "22";
      process.env.GROW_IMPACT_MONTH_LENGTH_DAYS = "30";
      process.env.GROW_IMPACT_HOLIDAY_ALLOWANCE_DAYS = "2";
      expect(getGrowImpactConfig(new Date("2026-06-15T12:00:00.000Z"))).toMatchObject({
        monthlyTarget: 22, monthLengthDays: 30, holidayAllowanceDays: 2,
      });
    } finally {
      keys.forEach((key, index) => {
        if (original[index] === undefined) delete process.env[key];
        else process.env[key] = original[index];
      });
    }
  });

  it("keeps a late UTC timestamp in the user's previous calendar month", () => {
    const window = getMonthWindow(new Date("2026-02-01T04:30:00.000Z"), "America/New_York");
    expect(window.month).toBe("2026-01");
    expect(window.start.toISOString()).toBe("2026-01-01T05:00:00.000Z");
    expect(window.end.toISOString()).toBe("2026-02-01T05:00:00.000Z");
    expect(window.calendarDays).toBe(31);
  });

  it("uses the daylight-saving offset at both sides of a month window", () => {
    const window = getMonthWindow(new Date("2026-10-15T12:00:00.000Z"), "Europe/Berlin");
    expect(window.month).toBe("2026-10");
    expect(window.start.toISOString()).toBe("2026-09-30T22:00:00.000Z");
    expect(window.end.toISOString()).toBe("2026-10-31T23:00:00.000Z");
  });

  it("treats Sundays as rest days and uses the real calendar month length", () => {
    const window = getMonthWindow(new Date("2026-02-15T12:00:00.000Z"), "UTC");
    expect(window.calendarDays).toBe(28);
    expect(window.sundayRestDays).toBe(4);
  });
});

describe("verified monthly workout sessions", () => {
  const valid = (completedAt: string) => ({ status: "completed", completedAt, durationMin: 40, completedSetCount: 1 });

  it("counts no more than one verified session per local calendar day", () => {
    const days = uniqueCompletedSessionDays([
      valid("2026-06-03T09:00:00.000Z"),
      valid("2026-06-03T20:00:00.000Z"),
      valid("2026-06-04T07:30:00.000Z"),
      valid("2026-05-31T21:00:00.000Z"),
    ], "2026-06", "America/Los_Angeles");
    expect(days).toEqual(["2026-06-03", "2026-06-04"]);
  });

  it("ignores incomplete or invalid workouts while counting a completed Sunday workout once", () => {
    const days = uniqueCompletedSessionDays([
      valid("2026-06-07T10:00:00.000Z"),
      { ...valid("2026-06-08T10:00:00.000Z"), status: "pending" },
      { ...valid("2026-06-09T10:00:00.000Z"), durationMin: 0 },
      { ...valid("2026-06-10T10:00:00.000Z"), completedSetCount: 0 },
      { ...valid("2026-06-11T10:00:00.000Z"), completedAt: null },
    ], "2026-06", "UTC");
    expect(days).toEqual(["2026-06-07"]);
  });
});

describe("virtual reward stage", () => {
  it("uses elapsed time only for the explicitly virtual journey", () => {
    expect(virtualGrowthStage("2026-01-01T00:00:00.000Z", new Date("2026-02-15T00:00:00.000Z")))
      .toEqual({ label: "Young tree", elapsedDays: 45 });
  });

  it("enforces one reward per user and qualifying month in the migrated schema", () => {
    const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
    const database = new DatabaseSync(":memory:");
    try {
      const schema = fs.readFileSync(path.resolve(__dirname, "../../db/schema.sql"), "utf8");
      database.exec(schema);
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
