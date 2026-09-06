import { describe, expect, it } from "vitest";
import { toPostgresSql } from "../db/postgres";

describe("PostgreSQL adapter", () => {
  it("converts SQLite-style parameters to PostgreSQL parameters", () => {
    expect(toPostgresSql("SELECT * FROM Food WHERE mealSlot = ? AND dietType IN (?, ?)")).toBe(
      "SELECT * FROM Food WHERE mealSlot = $1 AND dietType IN ($2, $3)"
    );
  });
});