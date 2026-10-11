import "dotenv/config";
import bcrypt from "bcryptjs";
import { v4 as uuidv4 } from "uuid";

async function seedOwner(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  const ownerEmail = process.env.OWNER_EMAIL?.trim().toLowerCase();
  const ownerPassword = process.env.OWNER_PASSWORD;

  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  if (
    !databaseUrl.startsWith("postgres://") &&
    !databaseUrl.startsWith("postgresql://") &&
    !databaseUrl.startsWith("mysql://") &&
    !databaseUrl.startsWith("mysql2://") &&
    !databaseUrl.startsWith("tidb://") &&
    !databaseUrl.startsWith("file:")
  ) {
    throw new Error("DATABASE_URL must use postgres://, postgresql://, mysql://, mysql2://, tidb://, or file:");
  }
  if (!ownerEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)) {
    throw new Error("OWNER_EMAIL must be a valid email address");
  }
  if (!ownerPassword || ownerPassword.length < 8 || ownerPassword.length > 128) {
    throw new Error("OWNER_PASSWORD must be between 8 and 128 characters");
  }

  const { db, nowIso } = await import("./client.js");
  const passwordHash = await bcrypt.hash(ownerPassword, 12);
  const timestamp = nowIso();
  const transaction = db.transaction?.bind(db);
  if (!transaction) throw new Error("Database transaction support is required to seed the owner");

  try {
    await transaction(async (tx: import("./types").DatabaseLike) => {
      const existing = await tx.get<{ id: string }>(
        `SELECT id FROM "User" WHERE LOWER(email)=?`,
        ownerEmail
      );

      if (existing) {
        await tx.run(
          `UPDATE "User" SET passwordHash=?,emailVerified=1,emailVerifiedAt=COALESCE(emailVerifiedAt,?),updatedAt=? WHERE id=?`,
          passwordHash,
          timestamp,
          timestamp,
          existing.id
        );
        console.info("Owner account updated.");
        return;
      }

      await tx.run(
        `INSERT INTO "User" (id,email,passwordHash,googleId,name,emailVerified,emailVerifiedAt,createdAt,updatedAt)
         VALUES (?,?,?,NULL,'Owner',1,?,?,?)`,
        uuidv4(),
        ownerEmail,
        passwordHash,
        timestamp,
        timestamp,
        timestamp
      );
      console.info("Owner account created.");
    });
  } finally {
    // Close the database pool when present so this one-shot script exits promptly.
    const closableDb = db as typeof db & { close?: () => Promise<void> };
    await closableDb.close?.();
  }
}

seedOwner().catch((error: unknown) => {
  // Never print error messages or connection details; mysql clients may include credentials in them.
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : "UNKNOWN";
  console.error(`Owner account seed failed (${code}). Check TiDB credentials, TLS/network access, and schema migrations.`);
  process.exitCode = 1;
});
