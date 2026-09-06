import { DatabaseSync } from "node:sqlite";
import path from "path";
import { PostgresDatabase, isPostgresUrl } from "./postgres";
import type { DatabaseLike } from "./types";

class SqliteDatabase implements DatabaseLike {
  constructor(private readonly database: DatabaseSync) {}

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
}

function createDatabase(): DatabaseLike {
  if (isPostgresUrl()) return new PostgresDatabase();

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
