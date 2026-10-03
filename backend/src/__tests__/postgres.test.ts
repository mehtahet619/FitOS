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

  it("normalizes workout keys needed by the production today-workout response", () => {
    expect(normalizePostgresRow({
      planstepindex: 2,
      equipmentmode: "USER_EQUIPMENT",
      equipmentsnapshot: "[]",
      generatorversion: "csv-v1",
      exercisename: "Lat Pulldown",
      sourceexercisename: "Close Grip Lat Pulldown",
      sourcemuscle: "back",
      sourceprimarymuscle: "Back",
      sourcemachine: "Cable Machine",
    })).toEqual({
      planStepIndex: 2,
      equipmentMode: "USER_EQUIPMENT",
      equipmentSnapshot: "[]",
      generatorVersion: "csv-v1",
      exerciseName: "Lat Pulldown",
      sourceExerciseName: "Close Grip Lat Pulldown",
      sourceMuscle: "back",
      sourcePrimaryMuscle: "Back",
      sourceMachine: "Cable Machine",
    });
  });
});
