import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { createPool, Pool, PoolConnection } from "mysql2/promise";
import type { QueryResultRow } from "pg";
import type { DatabaseLike } from "./types";

function toMySqlSql(sql: string): string {
  const firstInsertColumn = sql.match(/INSERT\s+INTO\s+\S+\s*\(\s*`?([A-Za-z0-9_]+)`?/i)?.[1] ?? "id";
  return sql
    .replace(/"User"/g, "`User`")
    .replace(/excluded\.([A-Za-z0-9_]+)/g, "VALUES($1)")
    .replace(/ON CONFLICT\s*\(([^)]+)\)\s*DO NOTHING/gi, `ON DUPLICATE KEY UPDATE ${firstInsertColumn}=${firstInsertColumn}`)
    .replace(/ON CONFLICT\s*\(([^)]+)\)\s*DO UPDATE SET/gi, "ON DUPLICATE KEY UPDATE")
    .replace(/ON CONFLICT\s+DO NOTHING/gi, `ON DUPLICATE KEY UPDATE ${firstInsertColumn}=${firstInsertColumn}`);
}

function normalizeRows<T extends QueryResultRow>(rows: RowDataPacket[]): T[] {
  return rows as unknown as T[];
}

export class MySqlDatabase implements DatabaseLike {
  private readonly pool: Pool;

  constructor(connectionString = process.env.DATABASE_URL) {
    if (!connectionString || !isMySqlUrl(connectionString)) {
      throw new Error("A MySQL/TiDB DATABASE_URL is required");
    }

    this.pool = createPool({
      uri: connectionString.replace(/^tidb:\/\//, "mysql://"),
      waitForConnections: true,
      connectionLimit: Number(process.env.MYSQL_POOL_MAX ?? 10),
      connectTimeout: 5_000,
      enableKeepAlive: true,
      multipleStatements: true,
    });
  }

  async all<T extends QueryResultRow = QueryResultRow>(sql: string, ...params: unknown[]): Promise<T[]> {
    const [rows] = await this.pool.query<RowDataPacket[]>(toMySqlSql(sql), params);
    return normalizeRows<T>(rows);
  }

  async get<T extends QueryResultRow = QueryResultRow>(sql: string, ...params: unknown[]): Promise<T | undefined> {
    const rows = await this.all<T>(sql, ...params);
    return rows[0];
  }

  async run(sql: string, ...params: unknown[]): Promise<{ changes: number }> {
    const [result] = await this.pool.query<ResultSetHeader>(toMySqlSql(sql), params);
    return { changes: result.affectedRows };
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(toMySqlSql(sql));
  }

  async transaction<T>(work: (client: DatabaseLike) => Promise<T>): Promise<T> {
    const connection = await this.pool.getConnection();
    const transaction = new MySqlTransaction(connection);
    try {
      await connection.beginTransaction();
      const result = await work(transaction);
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

class MySqlTransaction implements DatabaseLike {
  constructor(private readonly connection: PoolConnection) {}

  async all<T extends QueryResultRow = QueryResultRow>(sql: string, ...params: unknown[]): Promise<T[]> {
    const [rows] = await this.connection.query<RowDataPacket[]>(toMySqlSql(sql), params);
    return normalizeRows<T>(rows);
  }

  async get<T extends QueryResultRow = QueryResultRow>(sql: string, ...params: unknown[]): Promise<T | undefined> {
    const rows = await this.all<T>(sql, ...params);
    return rows[0];
  }

  async run(sql: string, ...params: unknown[]): Promise<{ changes: number }> {
    const [result] = await this.connection.query<ResultSetHeader>(toMySqlSql(sql), params);
    return { changes: result.affectedRows };
  }

  async exec(sql: string): Promise<void> {
    await this.connection.query(toMySqlSql(sql));
  }

  async transaction<T>(work: (tx: DatabaseLike) => Promise<T>): Promise<T> {
    return work(this);
  }
}

export function isMySqlUrl(value = process.env.DATABASE_URL): boolean {
  return Boolean(value?.startsWith("mysql://") || value?.startsWith("mysql2://") || value?.startsWith("tidb://"));
}
