import fs from "fs";
import path from "path";
import type { QueryResultRow } from "pg";
import { MySqlDatabase } from "./mysql";

export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let quote: "'" | '"' | "`" | undefined;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];
    if (lineComment) {
      if (character === "\n" || character === "\r") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === "*" && sql[index + 1] === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (character === quote && sql[index - 1] !== "\\") quote = undefined;
      continue;
    }
    if (character === "-" && sql[index + 1] === "-" && /\s/.test(sql[index + 2] ?? " ")) {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === "/" && sql[index + 1] === "*") {
      blockComment = true;
      index += 1;
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

function identifier(value: string): string {
  return value.replace(/^[`"]|[`"]$/g, "").toLowerCase();
}

function splitTopLevel(value: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: "'" | '"' | "`" | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (character === quote && value[index - 1] !== "\\") quote = undefined;
    } else if (character === "'" || character === '"' || character === "`") {
      quote = character;
    } else if (character === "(") {
      depth += 1;
    } else if (character === ")") {
      depth -= 1;
    } else if (character === "," && depth === 0) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(value.slice(start).trim());
  return parts.filter(Boolean);
}

function tableName(sql: string): string | undefined {
  return sql.match(/\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`?([A-Za-z_][A-Za-z0-9_]*)`?/i)?.[1]; // eslint-disable-line security/detect-unsafe-regex
}

function addColumns(target: Map<string, Set<string>>, table: string, columns: string): void {
  const keyColumns = target.get(identifier(table)) ?? new Set<string>();
  for (const column of splitTopLevel(columns)) {
    // The input is a single SQL column expression; this identifier pattern is bounded by the caller.
    // eslint-disable-next-line security/detect-unsafe-regex
    const name = column.match(/`?([A-Za-z_][A-Za-z0-9_]*)`?/); // eslint-disable-line security/detect-unsafe-regex
    if (name) keyColumns.add(identifier(name[1]));
  }
  target.set(identifier(table), keyColumns);
}

function collectKeyColumns(statements: string[]): Map<string, Set<string>> {
  const keyColumns = new Map<string, Set<string>>();
  for (const statement of statements) {
    // eslint-disable-next-line security/detect-unsafe-regex
    const createTableMatch = statement.match(/\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`?([A-Za-z_][A-Za-z0-9_]*)`?\s*/i);
    const createTable = createTableMatch?.[1];
    if (createTable && createTableMatch) {
      const createTableEnd = (createTableMatch.index ?? 0) + createTableMatch[0].length;
      const openingParenthesis = statement.indexOf("(", createTableEnd);
      const closingParenthesis = statement.lastIndexOf(")");
      if (openingParenthesis !== -1 && closingParenthesis > openingParenthesis) {
        for (const definition of splitTopLevel(statement.slice(openingParenthesis + 1, closingParenthesis))) {
          const localColumn = definition.match(/^`?([A-Za-z_][A-Za-z0-9_]*)`?/i)?.[1];
          if (/\b(?:PRIMARY\s+KEY|UNIQUE|KEY|INDEX)\b/i.test(definition) && localColumn) {
            const columns = definition.match(/\(([^()]*)\)/)?.[1];
            addColumns(keyColumns, createTable, columns ?? localColumn);
          }
          // eslint-disable-next-line security/detect-unsafe-regex
          for (const reference of definition.matchAll(/\bREFERENCES\s+`?([A-Za-z_][A-Za-z0-9_]*)`?\s*\(([^()]*)\)/gi)) { // eslint-disable-line security/detect-unsafe-regex
            if (localColumn) addColumns(keyColumns, createTable, localColumn);
            addColumns(keyColumns, reference[1], reference[2]);
          }
        }
      }
    }

    const index = statement.match(/\bCREATE\s+(?:UNIQUE\s+)?INDEX(?:\s+IF\s+NOT\s+EXISTS)?\s+`?[A-Za-z_][A-Za-z0-9_]*`?\s+ON\s+`?([A-Za-z_][A-Za-z0-9_]*)`?\s*\(([^()]*)\)/i); // eslint-disable-line security/detect-unsafe-regex
    if (index) addColumns(keyColumns, index[1], index[2]);
  }
  return keyColumns;
}

function replaceTextColumns(sql: string, keyColumns: Set<string>): string {
  // eslint-disable-next-line security/detect-unsafe-regex
  const textColumnPattern = /(^|[,(\n])(\s*)(`?)([A-Za-z_][A-Za-z0-9_]*)(\3)(\s+)TEXT\b/gim;
  return sql.replace(textColumnPattern, (match, prefix: string, whitespace: string, quote: string, column: string, closingQuote: string, separator: string, offset: number) => {
    let quoteCharacter: "'" | '"' | "`" | undefined;
    let parenthesisDepth = 0;
    let hasDefault = false;

    for (let index = offset + match.length; index < sql.length; index += 1) {
      const character = sql[index];
      if (quoteCharacter) {
        if (character === quoteCharacter && sql[index - 1] !== "\\") quoteCharacter = undefined;
        continue;
      }
      if (character === "'" || character === '"' || character === "`") {
        quoteCharacter = character;
      } else if (character === "(") {
        parenthesisDepth += 1;
      } else if (character === ")" && parenthesisDepth > 0) {
        parenthesisDepth -= 1;
      } else if ((character === ")" || character === ",") && parenthesisDepth === 0) {
        break;
      } else if (parenthesisDepth === 0 && /^\bDEFAULT\b/i.test(sql.slice(index))) { // eslint-disable-line security/detect-unsafe-regex
        hasDefault = true;
        break;
      }
    }

    const type = keyColumns.has(identifier(column))
      ? "VARCHAR(191)"
      : hasDefault ? "VARCHAR(2000)" : "TEXT";
    return type === "TEXT"
      ? match
      : `${prefix}${whitespace}${quote}${column}${closingQuote}${separator}${type}`;
  });
}

export function toMysql(sql: string, additionalKeyColumns: Iterable<string> = []): string {
  const statements = splitSqlStatements(sql);
  const keyColumns = collectKeyColumns(statements);
  const additional = new Set([...additionalKeyColumns].map(identifier));
  return statements.map((statement) => {
    const table = tableName(statement);
    const columns = new Set([...(table ? keyColumns.get(identifier(table)) ?? [] : []), ...additional]);
    const converted = replaceTextColumns(statement, columns)
      .replace(/\b(CREATE\s+(?:UNIQUE\s+)?INDEX)\s+IF\s+NOT\s+EXISTS\b/gi, "$1") // eslint-disable-line security/detect-unsafe-regex
      .replace(/\bAUTOINCREMENT\b/gi, "AUTO_INCREMENT");
    return /\bCREATE\s+TABLE\b/i.test(converted)
      // eslint-disable-next-line security/detect-unsafe-regex
      ? converted.replace(/(\bCREATE\s+TABLE\s+)(?!IF\s+NOT\s+EXISTS\b)/i, "$1IF NOT EXISTS ")
      : converted;
  }).join("; ");
}

export function prepareMySqlSchema(schema: string): string[] {
  // Normalize mixed Windows/Unix line endings before removing SQLite PRAGMA
  // directives. Otherwise the multiline regex can consume LF but leave CR,
  // causing MySQL/TiDB to treat the following CREATE statement as a comment.
  const normalizedSchema = schema.replace(/\r\n?/g, "\n");
  const statements = splitSqlStatements(normalizedSchema
    .replace(/^\s*PRAGMA[^;]+;\s*/gim, "")
    .replace(/\bUser\b/g, "`User`")
    .replace(/CREATE INDEX IF NOT EXISTS idx_user_email_lower ON `User`\(LOWER\(email\)\)/g, "")
    .replace(/CREATE UNIQUE INDEX IF NOT EXISTS idx_user_email_normalized_unique ON `User`\(LOWER\(email\)\)/g, ""));
  const keyColumns = collectKeyColumns(statements);
  return statements.map((statement) => {
    const table = tableName(statement);
    return toMysql(statement, table ? keyColumns.get(identifier(table)) : []);
  });
}

function mysqlErrorDetails(error: unknown): { errno: unknown; sqlMessage: unknown } {
  if (typeof error === "object" && error !== null) {
    const details = error as { errno?: unknown; sqlMessage?: unknown };
    return { errno: details.errno, sqlMessage: details.sqlMessage };
  }
  return { errno: undefined, sqlMessage: undefined };
}

function affectedTable(statement: string): string {
  return tableName(statement)
    // eslint-disable-next-line security/detect-unsafe-regex
    ?? statement.match(/\bCREATE\s+(?:UNIQUE\s+)?INDEX(?:\s+IF\s+NOT\s+EXISTS)?\s+`?[A-Za-z_][A-Za-z0-9_]*`?\s+ON\s+`?([A-Za-z_][A-Za-z0-9_]*)`?/i)?.[1] // eslint-disable-line security/detect-unsafe-regex
    ?? statement.match(/\bALTER\s+TABLE\s+`?([A-Za-z_][A-Za-z0-9_]*)`?/i)?.[1]
    ?? "(unknown)";
}

async function executeMySqlStatement(database: MySqlDatabase, statement: string): Promise<void> {
  try {
    await database.exec(statement);
  } catch (error) {
    const { errno, sqlMessage } = mysqlErrorDetails(error);
    if (errno === 1061 && /^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\b/i.test(statement)) return; // eslint-disable-line security/detect-unsafe-regex
    console.error("MySQL migration statement failed:", {
      table: affectedTable(statement),
      statement,
      errno,
      sqlMessage,
    });
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
    await executeMySqlStatement(database, `ALTER TABLE GymEquipmentFeedback MODIFY COLUMN imageBase64 LONGTEXT NOT NULL`);

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
