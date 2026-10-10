import { createPool, Pool, PoolConnection } from "mysql2/promise";
import type { QueryResultRow } from "pg";
import type { DatabaseLike } from "./types";

type TiDbError = Error & { code?: string; errno?: number };

/**
 * Translate the SQLite-flavoured SQL shared by the application to TiDB's
 * MySQL-compatible dialect. Keep this conversion in one place so routes,
 * migrations, and seed scripts all use the same rules.
 */
export function toTiDbSql(sql: string): string {
  let converted = sql.replace(/^\s*--.*(?:\r?\n|$)/gm, "").trim();
  if (/^PRAGMA\b/i.test(converted)) return "";

  converted = converted.replace(/"([A-Za-z_][A-Za-z0-9_]*)"/g, "`$1`");
  converted = converted.replace(/\b(FROM|JOIN|INTO|UPDATE|REFERENCES|ON)\s+User\b/gi, "$1 `User`");
  converted = converted.replace(/\bTABLE(\s+IF\s+NOT\s+EXISTS)?\s+User\b/gi, (_match, exists: string | undefined) => `TABLE${exists ?? ""} \`User\``);
  converted = converted.replace(
    /datetime\(\s*'now'\s*,\s*'-'\s*\|\|\s*\?\s*\|\|\s*' hours'\s*\)/gi,
    "DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? HOUR)"
  );
  converted = converted.replace(
    /'cycle_'\s*\|\|\s*substr\(\s*id\s*,\s*1\s*,\s*8\s*\)/gi,
    "CONCAT('cycle_', SUBSTRING(id, 1, 8))"
  );

  // TiDB does not support SQLite/PostgreSQL expression indexes. Email writes
  // are normalized to lowercase in auth/seed code, and email lookups remain
  // case-insensitive with LOWER(email), so omit these redundant indexes.
  if (/^CREATE\s+(?:UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\s+\S+\s+ON\s+`?User`?\s*\(\s*LOWER\s*\(\s*email\s*\)\s*\)/i.test(converted)) return "";

  // TiDB/MySQL uses ON DUPLICATE KEY UPDATE instead of ON CONFLICT.
  const conflict = /\s+ON\s+CONFLICT(?:\s*\(([^)]*)\))?\s+DO\s+(NOTHING|UPDATE\s+SET\s+([\s\S]+?))\s*;?$/i.exec(converted);
  if (conflict?.index !== undefined) {
    const columns = conflict[1]?.split(",").map((column) => column.trim().replace(/[`"']/g, "")).filter(Boolean) ?? [];
    const assignments = /^NOTHING$/i.test(conflict[2])
      ? `${columns[0] ?? "id"} = ${columns[0] ?? "id"}`
      : conflict[3].replace(/\bexcluded\.([A-Za-z_][A-Za-z0-9_]*)/gi, "VALUES($1)");
    converted = `${converted.slice(0, conflict.index)} ON DUPLICATE KEY UPDATE ${assignments}`;
  }

  converted = converted.replace(/\bCREATE\s+(UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\b/gi, "CREATE $1INDEX");

  if (/^CREATE\s+TABLE\b/i.test(converted)) converted = convertCreateTableTextTypes(converted);
  else if (/^ALTER\s+TABLE\b/i.test(converted)) {
    // Text columns added by migrations are identifiers or short labels unless
    // the migration later explicitly defines a larger payload field.
    converted = converted.replace(/\b([A-Za-z_][A-Za-z0-9_]*)\s+TEXT\b/gi, (declaration, name: string) => {
      if (/^(?:equipmentjson|equipmentsnapshot|verifiedphotosjson)$/i.test(name)) {
        return declaration.replace(/\bTEXT\b/i, "VARCHAR(8192)");
      }
      if (/^(?:allergies|foodlikes|allergens)$/i.test(name)) return declaration.replace(/\bTEXT\b/i, "VARCHAR(4096)");
      if (/^instructions$/i.test(name)) return declaration.replace(/\bTEXT\b/i, "LONGTEXT");
      if (/^unitsjson$/i.test(name)) return declaration.replace(/\bTEXT\b/i, "LONGTEXT");
      return declaration.replace(/\bTEXT\b/i, "VARCHAR(191)");
    });
  }

  return converted;
}

function convertCreateTableTextTypes(sql: string): string {
  const indexableColumns = new Set<string>();
  for (const match of sql.matchAll(/\b(?:UNIQUE|PRIMARY\s+KEY)\s*\(([^)]+)\)/gi)) {
    for (const name of match[1].split(",")) indexableColumns.add(name.trim().replace(/[`"']/g, "").toLowerCase());
  }

  const converted = sql.replace(/\b([A-Za-z_][A-Za-z0-9_]*)\s+TEXT\b([^,\n]*)/gi, (declaration, name: string, rest: string) => {
    const normalizedName = name.toLowerCase();
    const constrained = indexableColumns.has(normalizedName)
      || /\b(?:PRIMARY\s+KEY|UNIQUE|REFERENCES|CHECK)\b/i.test(rest);
    const hasDefault = /\bDEFAULT\b/i.test(rest);
    let replacement = hasDefault ? "VARCHAR(4096)" : "VARCHAR(191)";

    // JSON payloads commonly exceed 191 characters but have short defaults.
    if (/^(?:equipmentjson|equipmentsnapshot|verifiedphotosjson)$/i.test(name)) replacement = "VARCHAR(8192)";
    if (/^instructions$/i.test(name) && !constrained) replacement = "LONGTEXT";
    if (/^unitsjson$/i.test(name) && !constrained) replacement = "LONGTEXT";
    return declaration.replace(/\bTEXT\b/i, replacement);
  });
  return converted;
}

function isDuplicateIndexError(error: unknown): boolean {
  const candidate = error as TiDbError;
  return candidate?.code === "ER_DUP_KEYNAME" || candidate?.errno === 1061;
}

function toConnectionOptions(connectionString: string) {
  const url = new URL(connectionString);
  if (!url.hostname || !url.username || !url.password || !url.pathname.slice(1)) {
    throw new Error("DATABASE_URL must include the TiDB host, username, password, and database");
  }

  // TiDB Cloud requires TLS for public endpoints. URL query options are
  // intentionally not copied into mysql2 options because TiDB's generated
  // connection strings use client-specific query formats.
  const ca = process.env.TIDB_CA_CERT?.replace(/\\n/g, "\n");
  return {
    host: url.hostname,
    port: Number(url.port || 4000),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.slice(1)),
    waitForConnections: true,
    connectionLimit: Math.max(1, Number(process.env.TIDB_POOL_MAX ?? 10)),
    queueLimit: 0,
    enableKeepAlive: true,
    ssl: { minVersion: "TLSv1.2" as const, rejectUnauthorized: true, ...(ca ? { ca } : {}) },
    charset: "utf8mb4",
  };
}

export class TiDbDatabase implements DatabaseLike {
  private readonly pool: Pool;

  constructor(connectionString = process.env.DATABASE_URL) {
    if (!connectionString || !/^mysql:\/\//i.test(connectionString)) {
      throw new Error("A mysql:// DATABASE_URL is required for TiDB");
    }
    this.pool = createPool(toConnectionOptions(connectionString));
  }

  async all<T extends QueryResultRow = QueryResultRow>(sql: string, ...params: unknown[]): Promise<T[]> {
    const statement = toTiDbSql(sql);
    const [rows] = await this.pool.query(statement, params as never[]);
    return rows as unknown as T[];
  }

  async get<T extends QueryResultRow = QueryResultRow>(sql: string, ...params: unknown[]): Promise<T | undefined> {
    const rows = await this.all<T>(sql, ...params);
    return rows[0];
  }

  async run(sql: string, ...params: unknown[]): Promise<{ changes: number }> {
    const statement = toTiDbSql(sql);
    const [result] = await this.pool.query(statement, params as never[]);
    return { changes: Number((result as { affectedRows?: number }).affectedRows ?? 0) };
  }

  async exec(sql: string): Promise<void> {
    const statements = splitSqlStatements(sql).map((part) => toTiDbSql(part)).filter(Boolean);
    for (const statement of statements) {
      try {
        await this.pool.query(statement);
      } catch (error) {
        // CREATE INDEX IF NOT EXISTS is translated to CREATE INDEX; ignore only
        // the duplicate-name error so repeated migrations remain idempotent.
        if (!/^CREATE\s+(?:UNIQUE\s+)?INDEX\b/i.test(statement) || !isDuplicateIndexError(error)) throw error;
      }
    }
  }

  async transaction<T>(work: (tx: DatabaseLike) => Promise<T>): Promise<T> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const result = await work(new TiDbTransaction(connection));
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

class TiDbTransaction implements DatabaseLike {
  constructor(private readonly connection: PoolConnection) {}

  async all<T extends QueryResultRow = QueryResultRow>(sql: string, ...params: unknown[]): Promise<T[]> {
    const [rows] = await this.connection.query(toTiDbSql(sql), params as never[]);
    return rows as unknown as T[];
  }

  async get<T extends QueryResultRow = QueryResultRow>(sql: string, ...params: unknown[]): Promise<T | undefined> {
    const rows = await this.all<T>(sql, ...params);
    return rows[0];
  }

  async run(sql: string, ...params: unknown[]): Promise<{ changes: number }> {
    const [result] = await this.connection.query(toTiDbSql(sql), params as never[]);
    return { changes: Number((result as { affectedRows?: number }).affectedRows ?? 0) };
  }

  async exec(sql: string): Promise<void> {
    const statements = splitSqlStatements(sql).map((part) => toTiDbSql(part)).filter(Boolean);
    for (const statement of statements) await this.connection.query(statement);
  }

  async transaction<T>(work: (tx: DatabaseLike) => Promise<T>): Promise<T> {
    return work(this);
  }
}

function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let quote: "'" | "\"" | "`" | null = null;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < sql.length; index++) {
    const current = sql[index];
    const next = sql[index + 1];
    if (lineComment) {
      if (current === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (current === "*" && next === "/") { blockComment = false; index++; }
      continue;
    }
    if (quote) {
      if (current === quote && next === quote) { index++; continue; }
      if (current === quote && sql[index - 1] !== "\\") quote = null;
      continue;
    }
    if (current === "-" && next === "-") { lineComment = true; index++; continue; }
    if (current === "/" && next === "*") { blockComment = true; index++; continue; }
    if (current === "'" || current === "\"" || current === "`") { quote = current; continue; }
    if (current === ";") {
      statements.push(sql.slice(start, index));
      start = index + 1;
    }
  }
  statements.push(sql.slice(start));
  return statements;
}
