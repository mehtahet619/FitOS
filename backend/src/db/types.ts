import type { QueryResultRow } from "pg";

export interface DatabaseLike {
  all<T extends QueryResultRow = QueryResultRow>(sql: string, ...params: unknown[]): Promise<T[]>;
  get<T extends QueryResultRow = QueryResultRow>(sql: string, ...params: unknown[]): Promise<T | undefined>;
  run(sql: string, ...params: unknown[]): Promise<{ changes: number }>;
  exec(sql: string): Promise<void>;
  transaction?<T>(work: (tx: DatabaseLike) => Promise<T>): Promise<T>;
}
