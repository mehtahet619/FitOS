import { Router } from "express";
import { randomBytes } from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import { db, nowIso } from "../../db/client";
import { AuthedRequest, requireAuth } from "../../common/auth";
import { loadXpForUsers } from "./xp";
import { canonicalFriendPair } from "./relations";

export const friendsRouter = Router();
friendsRouter.use(requireAuth);
let ready: Promise<void> | undefined;
async function ensureTables() {
  if (!ready) ready = (async () => {
    await db.exec(`CREATE TABLE IF NOT EXISTS UserInviteCode (id VARCHAR(36) PRIMARY KEY, userId VARCHAR(255) NOT NULL UNIQUE, code VARCHAR(64) NOT NULL UNIQUE, createdAt VARCHAR(40) NOT NULL)`);
    // Keep the old table readable so existing one-to-one invite links can be
    // copied forward without losing any established friendships.
    await db.exec(`CREATE TABLE IF NOT EXISTS UserFriendInvite (id VARCHAR(36) PRIMARY KEY, inviterUserId VARCHAR(255) NOT NULL, invitedUserId VARCHAR(255) NOT NULL UNIQUE, createdAt VARCHAR(40) NOT NULL, UNIQUE(inviterUserId, invitedUserId))`);
    // Friendships are undirected and many-to-many. The canonical pair avoids
    // duplicate rows regardless of which friend opened the other's invite.
    await db.exec(`CREATE TABLE IF NOT EXISTS UserFriendship (id VARCHAR(36) PRIMARY KEY, userAId VARCHAR(255) NOT NULL, userBId VARCHAR(255) NOT NULL, createdAt VARCHAR(40) NOT NULL, UNIQUE(userAId, userBId))`);

    const legacyLinks = await db.all<{ inviterUserId: string; invitedUserId: string; createdAt: string }>(
      "SELECT inviterUserId, invitedUserId, createdAt FROM UserFriendInvite"
    );
    for (const link of legacyLinks) {
      const pair = canonicalFriendPair(link.inviterUserId, link.invitedUserId);
      if (!pair) continue;
      const exists = await db.get<{ id: string }>(
        "SELECT id FROM UserFriendship WHERE userAId=? AND userBId=?",
        pair[0], pair[1]
      );
      if (!exists) {
        try {
          await db.run(
            "INSERT INTO UserFriendship (id,userAId,userBId,createdAt) VALUES (?,?,?,?)",
            uuidv4(), pair[0], pair[1], link.createdAt || nowIso()
          );
        } catch {
          // A concurrent startup may have migrated the same pair first.
          const raced = await db.get<{ id: string }>(
            "SELECT id FROM UserFriendship WHERE userAId=? AND userBId=?",
            pair[0], pair[1]
          );
          if (!raced) throw new Error("Could not migrate an existing friend link.");
        }
      }
    }
  })().catch(e => { ready = undefined; throw e; });
  await ready;
}
async function inviteCode(userId: string) {
  const found = await db.get<{code:string}>("SELECT code FROM UserInviteCode WHERE userId=?", userId);
  if (found) return found.code;
  const code = randomBytes(18).toString("hex");
  try { await db.run("INSERT INTO UserInviteCode (id,userId,code,createdAt) VALUES (?,?,?,?)", uuidv4(), userId, code, nowIso()); }
  catch { const raced = await db.get<{code:string}>("SELECT code FROM UserInviteCode WHERE userId=?", userId); if (raced) return raced.code; throw new Error("Invite code creation failed"); }
  return code;
}
friendsRouter.get("/leaderboard", async (req: AuthedRequest, res) => {
  await ensureTables();
  const userId = req.userId!;
  const code = await inviteCode(userId);
  const week = new Date(Date.now() - 7 * 86400000).toISOString();

  // Include every friendship in either direction so both accounts see each other.
  const links = await db.all<{ otherId: string }>(
    `SELECT userBId AS otherId FROM UserFriendship WHERE userAId = ?
     UNION
     SELECT userAId AS otherId FROM UserFriendship WHERE userBId = ?`,
    userId, userId
  );
  const memberIds = [userId, ...new Set(links.map((l) => l.otherId).filter((id) => id !== userId))];

  const users = await db.all<{ id: string; name: string | null }>(
    `SELECT id, name FROM "User" WHERE id IN (${memberIds.map(() => "?").join(",")})`,
    ...memberIds
  );
  const nameById = new Map(users.map((u) => [u.id, u.name]));
  const liveIds = memberIds.filter((id) => id === userId || nameById.has(id));

  const weeklyRows = await db.all<{ userId: string; weeklyWorkouts: number | string }>(
    `SELECT userId, COUNT(*) AS weeklyWorkouts FROM Workout
     WHERE userId IN (${liveIds.map(() => "?").join(",")})
       AND status = 'completed' AND completedAt IS NOT NULL AND completedAt >= ?
     GROUP BY userId`,
    ...liveIds, week
  );
  const weeklyById = new Map(weeklyRows.map((r) => [r.userId, Number(r.weeklyWorkouts) || 0]));
  const xpByUser = await loadXpForUsers(db, liveIds);

  const members = liveIds.map((id) => {
    const stats = xpByUser.get(id)!;
    const isYou = id === userId;
    return {
      id,
      name: nameById.get(id) || (isYou ? "You" : "FACHS member"),
      isYou,
      workouts: stats.workouts,
      weeklyWorkouts: weeklyById.get(id) ?? 0,
      xp: stats.xp,
    };
  }).sort((a, b) => b.xp - a.xp || b.weeklyWorkouts - a.weeklyWorkouts || a.name.localeCompare(b.name));

  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  return res.json({
    inviteCode: code,
    inviteUrl: `${process.env.FRONTEND_PUBLIC_URL || "https://adaptive-fit-web.onrender.com"}/?invite=${code}`,
    members,
    scoring: "100 XP per completed workout plus 25 XP for each additional consecutive training day (Asia/Kolkata). Ranked by total XP.",
  });
});
friendsRouter.post("/accept-invite", async (req: AuthedRequest, res) => {
  await ensureTables();
  const code = typeof req.body?.code === "string" ? req.body.code.trim() : "";
  if (!/^[a-f0-9]{36}$/i.test(code)) return res.status(400).json({error:"Invalid invite link."});
  const inviter = await db.get<{userId:string}>("SELECT userId FROM UserInviteCode WHERE code=?",code);
  if (!inviter) return res.status(404).json({error:"Invite link not found."});
  if (inviter.userId === req.userId) return res.status(400).json({error:"You cannot use your own invite link."});
  const pair = canonicalFriendPair(inviter.userId, req.userId!);
  if (!pair) return res.status(400).json({error:"Invalid friend relationship."});
  const existing = await db.get<{id:string}>(
    "SELECT id FROM UserFriendship WHERE userAId=? AND userBId=?",
    pair[0], pair[1]
  );
  if (existing) return res.json({linked:true,alreadyLinked:true});
  try {
    await db.run(
      "INSERT INTO UserFriendship (id,userAId,userBId,createdAt) VALUES (?,?,?,?)",
      uuidv4(), pair[0], pair[1], nowIso()
    );
  } catch {
    const raced = await db.get<{id:string}>(
      "SELECT id FROM UserFriendship WHERE userAId=? AND userBId=?",
      pair[0], pair[1]
    );
    if (!raced) return res.status(500).json({error:"Could not create the friend link. Please try again."});
    return res.json({linked:true,alreadyLinked:true});
  }
  res.status(201).json({linked:true});
});
