import { describe, expect, it } from "vitest";
import { prepareMySqlSchema, splitSqlStatements, toMysql } from "../db/migrate-mysql";

describe("MySQL migration schema execution", () => {
  it("splits complete SQL while preserving semicolons in quoted values", () => {
    expect(splitSqlStatements("CREATE TABLE A (name TEXT DEFAULT 'a;b'); CREATE TABLE B (id TEXT);"))
      .toEqual(["CREATE TABLE A (name TEXT DEFAULT 'a;b')", "CREATE TABLE B (id TEXT)"]);
  });

  it("removes SQLite-only statements and prepares all schema statements", () => {
    const statements = prepareMySqlSchema(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS User (id TEXT PRIMARY KEY);
      CREATE INDEX IF NOT EXISTS idx_user_email_lower ON User(LOWER(email));
      CREATE TABLE IF NOT EXISTS Workout (id TEXT PRIMARY KEY);
    `);

    expect(statements).toEqual([
      "CREATE TABLE IF NOT EXISTS `User` (id TEXT PRIMARY KEY)",
      "CREATE TABLE IF NOT EXISTS Workout (id TEXT PRIMARY KEY)",
    ]);
  });

  it("converts TEXT columns used by keys, indexes, and foreign keys only", () => {
    const converted = toMysql(`
      CREATE TABLE Example (
        id TEXT PRIMARY KEY,
        familyKey TEXT,
        workoutExerciseId TEXT REFERENCES WorkoutExercise(id),
        email TEXT UNIQUE,
        token TEXT,
        name TEXT,
        createdAt TEXT
      );
      CREATE UNIQUE INDEX idx_example_token ON Example(token);
    `);
    expect(converted).toContain("id VARCHAR(191) PRIMARY KEY");
    expect(converted).toMatch(/familyKey VARCHAR\(191\)[\s\S]*workoutExerciseId VARCHAR\(191\)[\s\S]*email VARCHAR\(191\)[\s\S]*token VARCHAR\(191\)[\s\S]*name TEXT[\s\S]*createdAt TEXT/);
  });

  it("translates SQLite autoincrement spelling", () => {
    expect(toMysql("CREATE TABLE Example (id INTEGER PRIMARY KEY AUTOINCREMENT)"))
      .toBe("CREATE TABLE Example (id INTEGER PRIMARY KEY AUTO_INCREMENT)");
  });

  it("carries standalone index columns back to their table declaration", () => {
    expect(prepareMySqlSchema(`
      CREATE TABLE Example (id TEXT PRIMARY KEY, alias TEXT, name TEXT);
      CREATE INDEX idx_example_alias ON Example(alias);
    `)[0]).toContain("alias VARCHAR(191)");
    expect(prepareMySqlSchema(`
      CREATE TABLE Example (id TEXT PRIMARY KEY, alias TEXT, name TEXT);
      CREATE INDEX idx_example_alias ON Example(alias);
    `)[0]).toContain("name TEXT");
  });
});
