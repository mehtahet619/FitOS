import fs from "fs";
import path from "path";
import type { QueryResultRow } from "pg";
import { MySqlDatabase } from "./mysql";

export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let quote: "'" | '"' | "`" | undefined;

  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];
    if (quote) {
      if (character === quote && sql[index - 1] !== "\\") quote = undefined;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
    } else if (character === ";") {
      const statement = sql.slice(start, index).trim();
      if (statement) statements.push(statement);
      start = index + 1;
    }
  }

  const finalStatement = sql.slice(start).trim();
  if (finalStatement) statements.push(finalStatement);
  return statements;
}

function columnNames(columns: string): string[] {
  return columns
    .split(",")
    .map((column) => column.match(/`?([A-Za-z_][A-Za-z0-9_]*)`?/)?.[1])
    .filter((column): column is string => Boolean(column));
}

function isKeyColumn(column: string): boolean {
  return /^(id|email|token|slug|code)$/i.test(column)
    || /(?:Id|Key)$/i.test(column);
}

function findKeyColumns(sql: string): Set<string> {
  const keyColumns = new Set<string>();
  const addColumns = (columns: string): void => {
    for (const column of columnNames(columns)) keyColumns.add(column.toLowerCase());
  };

  for (const match of sql.matchAll(/\b(?:PRIMARY\s+KEY|UNIQUE|FOREIGN\s+KEY)\s*\(([^)]+)\)/gi)) {
    addColumns(match[1]);
  }
  const normalizedSql = sql.trimStart().toLowerCase();
  if (normalizedSql.startsWith("create index ") || normalizedSql.startsWith("create unique index ")) {
    const openingParenthesis = sql.indexOf("(");
    const closingParenthesis = sql.indexOf(")", openingParenthesis + 1);
    if (openingParenthesis !== -1 && closingParenthesis !== -1) {
      addColumns(sql.slice(openingParenthesis + 1, closingParenthesis));
    }
  }
  for (const match of sql.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s+TEXT\b/gi)) {
    const definitionEnd = sql.slice(match.index + match[0].length).search(/[,)]/);
    const definition = sql.slice(
      match.index + match[0].length,
      definitionEnd === -1 ? sql.length : match.index + match[0].length + definitionEnd
    );
    const reference = definition.match(/\bREFERENCES\s+`?[A-Za-z_][A-Za-z0-9_]*`?\s*\(\s*`?([A-Za-z_][A-Za-z0-9_]*)`?/i);
    if (reference) addColumns(`${match[1]},${reference[1]}`);
  }
  return keyColumns;
}

export function toMysql(sql: string, additionalKeyColumns: Iterable<string> = []): string {
  const keyColumns = findKeyColumns(sql);
  for (const column of additionalKeyColumns) keyColumns.add(column.toLowerCase());

  return sql
    .replace(
      /(^|[,(\n])(\s*)(`?)([A-Za-z_][A-Za-z0-9_]*)(\3)(\s+)TEXT\b(?=[^,)]*\bDEFAULT\b)/gim,
      "$1$2$3$4$5$6VARCHAR(2000)"
    )
    .replace(
      /(^|,)(\s*)(`?)([A-Za-z_][A-Za-z0-9_]*)(\3)(\s+)TEXT\b/gim,
      (match, prefix: string, whitespace: string, quote: string, column: string, closingQuote: string, separator: string) => (
        keyColumns.has(column.toLowerCase()) || isKeyColumn(column)
          ? `${prefix}${whitespace}${quote}${column}${closingQuote}${separator}VARCHAR(191)`
          : match
      )
    )
    .replace(/\bAUTOINCREMENT\b/gi, "AUTO_INCREMENT");
}

export function prepareMySqlSchema(schema: string): string[] {
  const statements = splitSqlStatements(schema
    .replace(/^\s*PRAGMA[^;]+;\s*/gim, "")
    .replace(/\bUser\b/g, "`User`")
    .replace(/CREATE INDEX IF NOT EXISTS idx_user_email_lower ON `User`\(LOWER\(email\)\)/g, "")
    .replace(/CREATE UNIQUE INDEX IF NOT EXISTS idx_user_email_normalized_unique ON `User`\(LOWER\(email\)\)/g, ""));
  const keyColumns = new Set<string>();
  for (const statement of statements) {
    for (const column of findKeyColumns(statement)) keyColumns.add(column);
  }
  return statements.map((statement) => toMysql(statement, keyColumns));
}

function mysqlErrorDetails(error: unknown): { errno: unknown; sqlMessage: unknown } {
  if (typeof error === "object" && error !== null) {
    const details = error as { errno?: unknown; sqlMessage?: unknown };
    return { errno: details.errno, sqlMessage: details.sqlMessage };
  }
  return { errno: undefined, sqlMessage: undefined };
}

async function executeMySqlStatement(database: MySqlDatabase, statement: string): Promise<void> {
  try {
    await database.exec(statement);
  } catch (error) {
    const { errno, sqlMessage } = mysqlErrorDetails(error);
    console.error("MySQL migration statement failed:", statement);
    console.error("MySQL error:", { errno, sqlMessage });
    throw error;
  }
}

async function main(): Promise<void> {
  const database = new MySqlDatabase();
  try {
    const configuredDatabase = new URL(
      (process.env.DATABASE_URL ?? "").replace(/^tidb:\/\//, "mysql://")
    ).pathname.slice(1);
    const [selectedDatabase] = await database.all<{ databaseName: string | null }>(
      "SELECT DATABASE() AS databaseName"
    );
    if (!configuredDatabase || selectedDatabase?.databaseName !== configuredDatabase) {
      throw new Error(
        `MySQL/TiDB selected database mismatch: expected ${configuredDatabase || "(missing)"}`
      );
    }

    const schemaPath = path.resolve(__dirname, "../../src/db/schema.sql");
    const schema = fs.readFileSync(schemaPath, "utf8");
    for (const statement of prepareMySqlSchema(schema)) {
      if (statement) await executeMySqlStatement(database, statement);
    }

    await executeMySqlStatement(database, `
      ALTER TABLE Workout ADD COLUMN IF NOT EXISTS planStepIndex INTEGER,
      ADD COLUMN IF NOT EXISTS cycleId TEXT,
      ADD COLUMN IF NOT EXISTS equipmentMode VARCHAR(2000) NOT NULL DEFAULT 'USER_EQUIPMENT',
      ADD COLUMN IF NOT EXISTS equipmentSnapshot VARCHAR(2000) NOT NULL DEFAULT '[]',
      ADD COLUMN IF NOT EXISTS generatorVersion TEXT
    `);
    await executeMySqlStatement(database, `
      ALTER TABLE WorkoutExercise
        ADD COLUMN IF NOT EXISTS sourceExerciseName TEXT,
        ADD COLUMN IF NOT EXISTS sourceMuscle TEXT,
        ADD COLUMN IF NOT EXISTS sourcePrimaryMuscle TEXT,
        ADD COLUMN IF NOT EXISTS sourceMachine TEXT
    `);
    await executeMySqlStatement(database, `ALTER TABLE NutritionRecommendation ADD COLUMN IF NOT EXISTS source VARCHAR(2000) NOT NULL DEFAULT 'general-nutrition'`);
    await executeMySqlStatement(database, `ALTER TABLE Equipment ADD COLUMN IF NOT EXISTS normalizedName TEXT, ADD COLUMN IF NOT EXISTS category TEXT`);
    await executeMySqlStatement(database, `ALTER TABLE Exercise ADD COLUMN IF NOT EXISTS imageUrl TEXT, ADD COLUMN IF NOT EXISTS requiresEquipment INTEGER NOT NULL DEFAULT 1`);

    const rows = await database.all<QueryResultRow>("SHOW TABLES");
    const tableNames = rows.flatMap((row) => Object.values(row).filter((value): value is string => typeof value === "string"));
    if (tableNames.length === 0) {
      throw new Error("MySQL/TiDB migration created zero tables");
    }
    for (const tableName of tableNames) console.log(tableName);
  } finally {
    await database.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
