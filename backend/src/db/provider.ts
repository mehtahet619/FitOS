import { isMySqlUrl } from "./mysql";
import { isPostgresUrl } from "./postgres";

export type DatabaseProvider = "sqlite" | "mysql" | "postgres";

export function getDatabaseProvider(databaseUrl = process.env.DATABASE_URL): DatabaseProvider {
  if (isPostgresUrl(databaseUrl)) return "postgres";
  if (isMySqlUrl(databaseUrl)) return "mysql";
  if (!databaseUrl || databaseUrl.startsWith("file:")) return "sqlite";

  throw new Error(`Unsupported DATABASE_URL scheme: ${databaseUrl.split(":")[0]}`);
}
