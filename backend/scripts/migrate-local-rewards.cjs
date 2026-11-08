#!/usr/bin/env node
"use strict";

/**
 * One-time, idempotent migration of completed workout records from the local
 * SQLite dev.db into the matching production TiDB account.
 *
 * Run from backend:
 *   FITOS_PRODUCTION_DATABASE_URL='tidb://...' node scripts/migrate-local-rewards.cjs --email you@example.com
 *   FITOS_PRODUCTION_DATABASE_URL='tidb://...' node scripts/migrate-local-rewards.cjs --email you@example.com --apply
 *
 * Dry-run is the default. This script never reads or copies password hashes,
 * auth sessions, OTPs, friend links, or another user's rows.
 */
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const mysql = require("mysql2/promise");
require("dotenv").config({ path: path.resolve(__dirname, "../.env.migration.local") });
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

function arg(name) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((item) => item.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function requireEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("Pass the account email with --email you@example.com");
  }
  return email;
}

function getMysqlConfig(raw) {
  if (!raw) throw new Error("FITOS_PRODUCTION_DATABASE_URL is required. Do not put it in source code.");
  const url = new URL(raw.replace(/^tidb:\/\//i, "mysql://"));
  if (!["mysql:", "mysql2:"].includes(url.protocol)) throw new Error("Production URL must use mysql:// or tidb://");
  if (!url.hostname || !url.username || !url.password || !url.pathname.slice(1)) {
    throw new Error("Production database URL is incomplete.");
  }
  return {
    host: url.hostname,
    port: Number(url.port || 4000),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.slice(1)),
    ssl: { rejectUnauthorized: true },
    connectTimeout: 15000,
    multipleStatements: false,
  };
}

function indiaDay(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date);
  const part = (type) => parts.find((item) => item.type === type)?.value || "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function xpFor(rows) {
  const days = [...new Set(rows
    .filter((row) => row.status === "completed" && row.completedAt)
    .map((row) => indiaDay(row.completedAt))
    .filter(Boolean))].sort();
  let streakBonusDays = 0;
  for (let i = 1; i < days.length; i += 1) {
    const previous = Date.parse(`${days[i - 1]}T00:00:00Z`);
    const current = Date.parse(`${days[i]}T00:00:00Z`);
    if ((current - previous) / 86400000 === 1) streakBonusDays += 1;
  }
  const completed = rows.filter((row) => row.status === "completed" && row.completedAt).length;
  return { completed, streakBonusDays, xp: completed * 100 + streakBonusDays * 25 };
}

async function main() {
  const email = requireEmail(arg("email"));
  const apply = process.argv.includes("--apply");
  const sourcePath = path.resolve(__dirname, "../dev.db");
  if (!fs.existsSync(sourcePath)) throw new Error(`Local database not found: ${sourcePath}`);

  const source = new DatabaseSync(sourcePath, { readOnly: true });
  let target;
  try {
    const localUser = source.prepare('SELECT id, email FROM "User" WHERE lower(email)=?').get(email);
    if (!localUser) throw new Error("That email does not exist in the local SQLite database.");
    const localWorkouts = source.prepare(
      "SELECT id, focus, status, durationMin, createdAt, completedAt, planStepIndex, cycleId, equipmentMode, equipmentSnapshot, generatorVersion FROM Workout WHERE userId=? AND status='completed' AND completedAt IS NOT NULL ORDER BY completedAt, id"
    ).all(localUser.id);
    if (!localWorkouts.length) throw new Error("No completed local workouts were found for this account.");
    const sourceStats = xpFor(localWorkouts);

    target = await mysql.createConnection(getMysqlConfig(process.env.FITOS_PRODUCTION_DATABASE_URL));
    const [dbRows] = await target.query("SELECT DATABASE() AS databaseName");
    const expectedDatabase = getMysqlConfig(process.env.FITOS_PRODUCTION_DATABASE_URL).database;
    if (dbRows[0]?.databaseName !== expectedDatabase) throw new Error("Production database identity check failed.");

    const [users] = await target.execute('SELECT id, email FROM `User` WHERE lower(email)=? LIMIT 2', [email]);
    if (users.length !== 1) throw new Error("Production account match is missing or ambiguous. No data was changed.");
    const productionUserId = users[0].id;

    const [existing] = await target.execute(
      "SELECT id, focus, status, durationMin, createdAt, completedAt FROM Workout WHERE userId=? AND status='completed' AND completedAt IS NOT NULL",
      [productionUserId]
    );
    const existingById = new Map(existing.map((row) => [String(row.id), row]));
    const existingSignature = new Set(existing.map((row) =>
      [row.focus, row.status, Number(row.durationMin), row.completedAt].join("\\u001f")
    ));

    const toInsert = [];
    let alreadyPresent = 0;
    for (const row of localWorkouts) {
      const sameId = existingById.get(String(row.id));
      if (sameId) {
        if (String(sameId.completedAt) !== String(row.completedAt) || sameId.focus !== row.focus) {
          throw new Error("A workout ID already exists in production with different details. Migration stopped safely.");
        }
        alreadyPresent += 1;
        continue;
      }
      const signature = [row.focus, row.status, Number(row.durationMin), row.completedAt].join("\\u001f");
      if (existingSignature.has(signature)) {
        alreadyPresent += 1;
        continue;
      }
      toInsert.push(row);
    }

    const mergedPreview = [...existing, ...toInsert];
    const before = xpFor(existing);
    const after = xpFor(mergedPreview);
    console.log(JSON.stringify({
      mode: apply ? "APPLY" : "DRY_RUN",
      sourceCompletedWorkouts: localWorkouts.length,
      sourceExpectedXp: sourceStats.xp,
      sourceConsistencyBonusDays: sourceStats.streakBonusDays,
      productionCompletedWorkoutsBefore: before.completed,
      alreadyPresentOrDuplicate: alreadyPresent,
      recordsToInsert: toInsert.length,
      expectedProductionCompletedWorkoutsAfter: after.completed,
      expectedProductionXpAfter: after.xp,
      note: "Only completed Workout rows for the exact matching email are considered. No credentials or other users' data are copied.",
    }, null, 2));

    if (!apply) {
      console.log("Dry run only. Re-run with --apply to commit this exact account-scoped migration.");
      return;
    }

    await target.beginTransaction();
    try {
      const insertSql = `INSERT INTO Workout
        (id,userId,workoutPlanId,focus,status,durationMin,createdAt,completedAt,planStepIndex,cycleId,equipmentMode,equipmentSnapshot,generatorVersion)
        VALUES (?,?,NULL,?,?,?,?,?,?,?,?,?,?)`;
      for (const row of toInsert) {
        await target.execute(insertSql, [
          row.id, productionUserId, row.focus, row.status, row.durationMin,
          row.createdAt, row.completedAt, row.planStepIndex ?? null, row.cycleId ?? null,
          row.equipmentMode || "USER_EQUIPMENT", row.equipmentSnapshot || "[]",
          row.generatorVersion ?? null,
        ]);
      }
      const [verified] = await target.execute(
        "SELECT id, focus, status, durationMin, createdAt, completedAt FROM Workout WHERE userId=? AND status='completed' AND completedAt IS NOT NULL",
        [productionUserId]
      );
      const verifiedXp = xpFor(verified);
      if (verifiedXp.completed !== after.completed || verifiedXp.xp !== after.xp) {
        throw new Error("Post-insert verification did not match the expected workout count and XP. Rolling back.");
      }
      await target.commit();
      console.log(JSON.stringify({
        result: "COMMITTED_AND_VERIFIED",
        inserted: toInsert.length,
        productionCompletedWorkouts: verifiedXp.completed,
        productionXp: verifiedXp.xp,
      }, null, 2));
    } catch (error) {
      await target.rollback();
      throw error;
    }
  } finally {
    source.close();
    if (target) await target.end();
  }
}

main().catch((error) => {
  console.error("Migration stopped safely:", error.message);
  process.exitCode = 1;
});
