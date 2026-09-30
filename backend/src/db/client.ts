import path from "path";
import { PostgresDatabase, isPostgresUrl } from "./postgres";
import type { DatabaseLike } from "./types";

class SqliteDatabase implements DatabaseLike {
  constructor(private readonly database: { prepare(sql: string): { all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown; run(...params: unknown[]): { changes: number | bigint } }; exec(sql: string): void }) {}

  async all<T>(sql: string, ...params: unknown[]): Promise<T[]> {
    return this.database.prepare(sql).all(...params) as T[];
  }

  async get<T>(sql: string, ...params: unknown[]): Promise<T | undefined> {
    return this.database.prepare(sql).get(...params) as T | undefined;
  }

  async run(sql: string, ...params: unknown[]): Promise<{ changes: number }> {
    const result = this.database.prepare(sql).run(...params);
    return { changes: Number(result.changes) };
  }

  async exec(sql: string): Promise<void> {
    this.database.exec(sql);
  }

  async transaction<T>(work: (tx: DatabaseLike) => Promise<T>): Promise<T> {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = await work(this);
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

function createDatabase(): DatabaseLike {
  if (isPostgresUrl()) return new PostgresDatabase();

  const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
  const dbPath = process.env.DATABASE_URL?.startsWith("file:")
    ? process.env.DATABASE_URL.slice("file:".length)
    : path.join(__dirname, "../../dev.db");
  const sqlite = new DatabaseSync(dbPath);
  sqlite.exec("PRAGMA foreign_keys = ON");
  return new SqliteDatabase(sqlite);
}

export const db = createDatabase();

export function nowIso(): string {
  return new Date().toISOString();
}
