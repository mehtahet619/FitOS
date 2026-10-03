import { Pool, PoolClient, QueryResultRow } from "pg";
import type { DatabaseLike } from "./types";

const camelCaseColumns: Record<string, string> = {
  passwordhash: "passwordHash",
  googleid: "googleId",
  createdat: "createdAt",
  updatedat: "updatedAt",
  userid: "userId",
  heightcm: "heightCm",
  weightkg: "weightKg",
  fitnesslevel: "fitnessLevel",
  primarygoal: "primaryGoal",
  daysperweek: "daysPerWeek",
  sessionminutes: "sessionMinutes",
  dietarypref: "dietaryPref",
  foodlikes: "foodLikes",
  dailybudget: "dailyBudget",
  iscustom: "isCustom",
  secondarymuscles: "secondaryMuscles",
  movementpattern: "movementPattern",
  defaultsets: "defaultSets",
  reprangelow: "repRangeLow",
  reprangehigh: "repRangeHigh",
  requiredequipmentids: "requiredEquipmentIds",
  equipmentid: "equipmentId",
  exerciseid: "exerciseId",
  baseexerciseid: "baseExerciseId",
  substituteid: "substituteId",
  orderindex: "orderIndex",
  targetsets: "targetSets",
  replacedfromid: "replacedFromId",
  painreported: "painReported",
  workoutid: "workoutId",
  workoutplanid: "workoutPlanId",
  durationmin: "durationMin",
  completedat: "completedAt",
  workoutexerciseid: "workoutExerciseId",
  setnumber: "setNumber",
  nutritionprofileid: "nutritionProfileId",
  calorietarget: "calorieTarget",
  proteintargetg: "proteinTargetG",
  carbtargetg: "carbTargetG",
  fattargetg: "fatTargetG",
  mealslot: "mealSlot",
  proteing: "proteinG",
  carbsg: "carbsG",
  fatg: "fatG",
  estpriceinr: "estPriceInr",
  nutritionrecommendationid: "nutritionRecommendationId",
  totalcalories: "totalCalories",
  totalproteing: "totalProteinG",
  totalcarbsg: "totalCarbsG",
  totalfatg: "totalFatG",
  isopennow: "isOpenNow",
  userlocationid: "userLocationId",
  recordedat: "recordedAt",
  checkedinat: "checkedInAt",
  structurekey: "structureKey",
  cycleid: "cycleId",
  planstepindex: "planStepIndex",
  equipmentmode: "equipmentMode",
  equipmentsnapshot: "equipmentSnapshot",
  generatorversion: "generatorVersion",
  cyclestatus: "cycleStatus",
  currentindex: "currentIndex",
  unitsjson: "unitsJson",
  activeworkoutid: "activeWorkoutId",
  lasttrainedat: "lastTrainedAt",
  startedat: "startedAt",
  primarymuscle: "primaryMuscle",
  exercisename: "exerciseName",
  familykey: "familyKey",
  sourceexercisename: "sourceExerciseName",
  sourcemuscle: "sourceMuscle",
  sourceprimarymuscle: "sourcePrimaryMuscle",
  sourcemachine: "sourceMachine",
  emailverified: "emailVerified",
  emailverifiedat: "emailVerifiedAt",
  otphash: "otpHash",
  otpexpiresat: "otpExpiresAt",
  otpattempts: "otpAttempts",
  refreshtokenhash: "refreshTokenHash",
  revokedat: "revokedAt",
  lastusedat: "lastUsedAt",
};

export function normalizePostgresRow<T extends QueryResultRow>(row: T): T {
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    normalized[camelCaseColumns[key] || key] = value;
  }
  return normalized as T;
}

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
      connectionTimeoutMillis: 5_000,
      query_timeout: 10_000,
      // PostgreSQL enforces this on the server, so a locked or expensive query
      // releases its pool slot instead of leaving the request pending forever.
      options: "-c statement_timeout=8000 -c lock_timeout=3000",
      ssl: process.env.PGSSL === "disable" ? false : { rejectUnauthorized: false },
    });

    this.pool.on("error", () => {
      // Never include connection details or query parameters in runtime logs.
      console.error("[DB] idle PostgreSQL connection error");
    });
  }

  async all<T extends QueryResultRow = QueryResultRow>(sql: string, ...params: unknown[]): Promise<T[]> {
    const result = await this.pool.query<T>(toPostgresSql(sql), params);
    return result.rows.map(normalizePostgresRow);
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

  async transaction<T>(work: (client: DatabaseLike) => Promise<T>): Promise<T> {
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

export class PostgresTransaction implements DatabaseLike {
  constructor(private readonly client: PoolClient) {}

  async all<T extends QueryResultRow = QueryResultRow>(sql: string, ...params: unknown[]): Promise<T[]> {
    const result = await this.client.query<T>(toPostgresSql(sql), params);
    return result.rows.map(normalizePostgresRow);
  }

  async get<T extends QueryResultRow = QueryResultRow>(sql: string, ...params: unknown[]): Promise<T | undefined> {
    const rows = await this.all<T>(sql, ...params);
    return rows[0];
  }

  async run(sql: string, ...params: unknown[]): Promise<{ changes: number }> {
    const result = await this.client.query(toPostgresSql(sql), params);
    return { changes: result.rowCount ?? 0 };
  }

  async exec(sql: string): Promise<void> {
    await this.client.query(sql);
  }

  async transaction<T>(work: (tx: DatabaseLike) => Promise<T>): Promise<T> {
    return work(this);
  }
}

export function isPostgresUrl(value = process.env.DATABASE_URL): boolean {
  return Boolean(value?.startsWith("postgres"));
}
