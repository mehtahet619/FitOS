import { describe, expect, it } from "vitest";
import { normalizePostgresRow, toPostgresSql } from "../db/postgres";

describe("PostgreSQL adapter", () => {
  it("converts SQLite-style parameters to PostgreSQL parameters", () => {
    expect(toPostgresSql("SELECT * FROM Food WHERE mealSlot = ? AND dietType IN (?, ?)")).toBe(
      "SELECT * FROM Food WHERE mealSlot = $1 AND dietType IN ($2, $3)"
    );
  });

  it("restores camelCase keys returned as lowercase by PostgreSQL", () => {
    expect(normalizePostgresRow({ proteing: 22, estpriceinr: 120, totalcalories: 320 })).toEqual({
      proteinG: 22,
      estPriceInr: 120,
      totalCalories: 320,
    });
  });
});