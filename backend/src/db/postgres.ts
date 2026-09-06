import { Pool, PoolClient, QueryResultRow } from "pg";
import type { DatabaseLike } from "./types";

export function toPostgresSql(sql: string): string {
  let parameter = 0;
  return sql.replace(/\?/g, () => `$${++parameter}`);
}

export class PostgresDatabase implements DatabaseLike {
  private readonly pool: Pool;

  constructor(connectionString = process.env.DATABASE_URL) {
    if (!connectionString || !connectionString.startsWith("postgres")) {
      throw new Error("A PostgreSQL DATABASE_URL is required");
    }

    this.pool = new Pool({
      connectionString,
      max: Number(process.env.PG_POOL_MAX ?? 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      ssl: process.env.PGSSL === "disable" ? false : { rejectUnauthorized: false },
    });
  }

  async all<T extends QueryResultRow = QueryResultRow>(sql: string, ...params: unknown[]): Promise<T[]> {
    const result = await this.pool.query<T>(toPostgresSql(sql), params);
    return result.rows;
  }

  async get<T extends QueryResultRow = QueryResultRow>(sql: string, ...params: unknown[]): Promise<T | undefined> {
    const rows = await this.all<T>(sql, ...params);
    return rows[0];
  }

  async run(sql: string, ...params: unknown[]): Promise<{ changes: number }> {
    const result = await this.pool.query(toPostgresSql(sql), params);
    return { changes: result.rowCount ?? 0 };
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async transaction<T>(work: (client: PostgresTransaction) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    const transaction = new PostgresTransaction(client);
    try {
      await client.query("BEGIN");
      const result = await work(transaction);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export class PostgresTransaction {
  constructor(private readonly client: PoolClient) {}

  async all<T extends QueryResultRow = QueryResultRow>(sql: string, ...params: unknown[]): Promise<T[]> {
    const result = await this.client.query<T>(toPostgresSql(sql), params);
    return result.rows;
  }

  async get<T extends QueryResultRow = QueryResultRow>(sql: string, ...params: unknown[]): Promise<T | undefined> {
    const rows = await this.all<T>(sql, ...params);
    return rows[0];
  }

  async run(sql: string, ...params: unknown[]): Promise<{ changes: number }> {
    const result = await this.client.query(toPostgresSql(sql), params);
    return { changes: result.rowCount ?? 0 };
  }
}

export function isPostgresUrl(value = process.env.DATABASE_URL): boolean {
  return Boolean(value?.startsWith("postgres"));
}