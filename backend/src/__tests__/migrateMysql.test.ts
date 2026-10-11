import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { prepareMySqlSchema, splitSqlStatements, toMysql } from "../db/migrate-mysql";

describe("MySQL migration schema execution", () => {
  it("splits complete SQL while preserving semicolons in quoted values", () => {
    expect(splitSqlStatements("CREATE TABLE A (name TEXT DEFAULT 'a;b'); CREATE TABLE B (id TEXT);"))
      .toEqual(["CREATE TABLE A (name TEXT DEFAULT 'a;b')", "CREATE TABLE B (id TEXT)"]);
  });

  it("does not split SQL statements at semicolons in line comments", () => {
    expect(splitSqlStatements("-- comment; still a comment\nCREATE TABLE Example (id TEXT);"))
      .toEqual(["-- comment; still a comment\nCREATE TABLE Example (id TEXT)"]);
  });

  it("removes SQLite-only statements and prepares all schema statements", () => {
    const statements = prepareMySqlSchema(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS User (id TEXT PRIMARY KEY);
      CREATE INDEX IF NOT EXISTS idx_user_email_lower ON User(LOWER(email));
      CREATE TABLE IF NOT EXISTS Workout (id TEXT PRIMARY KEY);
    `);

    expect(statements).toEqual([
      "CREATE TABLE IF NOT EXISTS `User` (id VARCHAR(191) PRIMARY KEY)",
      "CREATE TABLE IF NOT EXISTS Workout (id VARCHAR(191) PRIMARY KEY)",
    ]);
  });

  it("normalizes CRLF before removing PRAGMA lines after SQL comments", () => {
    const statements = prepareMySqlSchema(
      "-- schema header\r\n-- SQLite source\r\nPRAGMA foreign_keys = ON;\r\n\r\nCREATE TABLE User (id TEXT PRIMARY KEY);"
    );

    expect(statements[0]).toContain("CREATE TABLE IF NOT EXISTS `User`");
    expect(statements[0]).not.toContain("\rCREATE TABLE");
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
    expect(converted).toMatch(/familyKey TEXT[\s\S]*workoutExerciseId VARCHAR\(191\)[\s\S]*email VARCHAR\(191\)[\s\S]*token VARCHAR\(191\)[\s\S]*name TEXT[\s\S]*createdAt TEXT/);
  });

  it("converts TEXT columns with defaults while preserving default-free TEXT", () => {
    const converted = toMysql(`
      CREATE TABLE Example (
        allergies TEXT NOT NULL DEFAULT '',
        equipment TEXT DEFAULT '[]',
        notes TEXT NOT NULL
      );
    `);

    expect(converted).toContain("allergies VARCHAR(2000) NOT NULL DEFAULT ''");
    expect(converted).toContain("equipment VARCHAR(2000) DEFAULT '[]'");
    expect(converted).toContain("notes TEXT NOT NULL");
  });

  it("converts every TEXT default in the schema without changing default-free TEXT", () => {
    const schema = fs.readFileSync(path.resolve(__dirname, "../db/schema.sql"), "utf8");
    const converted = toMysql(schema);

    expect(converted).not.toMatch(/\bTEXT\b[^,;\n)]*\bDEFAULT\b/i);
    expect(converted).toContain("allergies VARCHAR(2000) NOT NULL DEFAULT ''");
    expect(converted).toContain("foodLikes VARCHAR(2000) NOT NULL DEFAULT ''");
    expect(converted).toContain("equipmentJson VARCHAR(2000) NOT NULL DEFAULT '[]'");
    expect(converted).toContain("secondaryMuscles VARCHAR(2000) NOT NULL DEFAULT ''");
    expect(converted).toContain("status VARCHAR(2000) NOT NULL DEFAULT 'pending'");
    expect(converted).toContain("equipmentMode VARCHAR(2000) NOT NULL DEFAULT 'USER_EQUIPMENT'");
    expect(converted).toContain("equipmentSnapshot VARCHAR(2000) NOT NULL DEFAULT '[]'");
    expect(converted).toContain("cycleStatus VARCHAR(2000) NOT NULL DEFAULT 'IN_PROGRESS'");
    expect(converted).toContain("allergens VARCHAR(2000) NOT NULL DEFAULT ''");
    expect(converted).toContain("source VARCHAR(2000) NOT NULL DEFAULT 'general-nutrition'");
    expect(converted).toContain("passwordHash TEXT,");
  });

  it("converts every schema key column away from TEXT and BLOB", () => {
    const schema = fs.readFileSync(path.resolve(__dirname, "../db/schema.sql"), "utf8");
    const converted = toMysql(schema);
    const keyedColumnPattern = /(^|[,(\n])\s*`?([A-Za-z_][A-Za-z0-9_]*)`?\s+(?:TEXT|BLOB)\b[^,;)]*\b(?:PRIMARY\s+KEY|UNIQUE|KEY|INDEX|REFERENCES)\b/gi;

    expect(converted).not.toMatch(keyedColumnPattern);
    expect(converted).toMatch(/CREATE TABLE IF NOT EXISTS GymAttendance \([\s\S]*\bid VARCHAR\(191\) PRIMARY KEY/);
  });

  it("converts a first column with a default on the same line", () => {
    expect(toMysql("CREATE TABLE Example (value TEXT NOT NULL DEFAULT '')"))
      .toBe("CREATE TABLE IF NOT EXISTS Example (value VARCHAR(2000) NOT NULL DEFAULT '')");
  });

  it("converts TEXT defaults containing commas without affecting later columns", () => {
    expect(toMysql("CREATE TABLE Example (value TEXT NOT NULL DEFAULT 'a,b', notes TEXT NOT NULL)"))
      .toBe("CREATE TABLE IF NOT EXISTS Example (value VARCHAR(2000) NOT NULL DEFAULT 'a,b', notes TEXT NOT NULL)");
  });

  it("translates SQLite autoincrement spelling", () => {
    expect(toMysql("CREATE TABLE Example (id INTEGER PRIMARY KEY AUTOINCREMENT)"))
      .toBe("CREATE TABLE IF NOT EXISTS Example (id INTEGER PRIMARY KEY AUTO_INCREMENT)");
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

  it("uses external indexes to convert arbitrary column names", () => {
    const statements = prepareMySqlSchema(`
    CREATE TABLE Example (id TEXT PRIMARY KEY, name TEXT, notes TEXT);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_example_name ON Example(name);
    `);
    expect(statements[0]).toContain("name VARCHAR(191)");
    expect(statements[0]).toContain("notes TEXT");
    expect(statements[1]).toBe("CREATE UNIQUE INDEX idx_example_name ON Example(name)");
  });
});
