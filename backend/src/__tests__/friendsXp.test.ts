import { describe, expect, it } from "vitest";
import { computeXp, loadXpForUsers } from "../modules/friends/xp";

describe("leaderboard XP", () => {
  it("awards 100 per workout and 25 per consecutive-day extension (IST days)", () => {
    // 11 workouts on 10 days with exactly one consecutive pair => 1,125 XP
    const days = [1, 3, 5, 7, 9, 11, 13, 15, 17, 19].map((d) => `2026-10-${String(d).padStart(2, "0")}T06:00:00.000Z`);
    days.push("2026-10-20T06:00:00.000Z"); // consecutive with the 19th
    days.push("2026-10-20T08:00:00.000Z"); // second workout same day, no extra bonus
    const r = computeXp(days.slice(0, 11));
    expect(r.workouts).toBe(11);
    expect(r.consistencyBonusDays).toBe(1);
    expect(r.xp).toBe(1125);
  });

  it("uses Asia/Kolkata day boundaries", () => {
    // 19:00Z and 20:00Z on the 1st are 00:30 and 01:30 IST on the 2nd -> same day
    expect(computeXp(["2026-10-01T19:00:00Z", "2026-10-01T20:00:00Z"]).consistencyBonusDays).toBe(0);
    // 17:00Z on the 1st is 22:30 IST on the 1st; 19:00Z is the 2nd IST -> consecutive
    expect(computeXp(["2026-10-01T17:00:00Z", "2026-10-01T19:00:00Z"]).consistencyBonusDays).toBe(1);
  });

  it("scopes XP per user from one query and returns 0 for users with no workouts", async () => {
    const fake = {
      all: async (_sql: string, ...params: unknown[]) => {
        expect(params).toEqual(["a", "b", "c"]);
        return [
          { userId: "a", completedAt: "2026-10-01T06:00:00Z" },
          { userId: "a", completedAt: "2026-10-02T06:00:00Z" },
          { userId: "b", completedAt: "2026-10-01T06:00:00Z" },
        ] as any[];
      },
    };
    const m = await loadXpForUsers(fake as any, ["a", "b", "c", "a"]);
    expect(m.get("a")!.xp).toBe(225);
    expect(m.get("b")!.xp).toBe(100);
    expect(m.get("c")!.xp).toBe(0);
  });
});
