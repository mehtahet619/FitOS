import { Router } from "express";
import { randomBytes } from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import { db, nowIso } from "../../db/client";
import { AuthedRequest, requireAuth } from "../../common/auth";

export const friendsRouter = Router();
friendsRouter.use(requireAuth);
let ready: Promise<void> | undefined;
async function ensureTables() {
  if (!ready) ready = (async () => {
    await db.exec(`CREATE TABLE IF NOT EXISTS UserInviteCode (id VARCHAR(36) PRIMARY KEY, userId VARCHAR(255) NOT NULL UNIQUE, code VARCHAR(64) NOT NULL UNIQUE, createdAt VARCHAR(40) NOT NULL)`);
    await db.exec(`CREATE TABLE IF NOT EXISTS UserFriendInvite (id VARCHAR(36) PRIMARY KEY, inviterUserId VARCHAR(255) NOT NULL, invitedUserId VARCHAR(255) NOT NULL UNIQUE, createdAt VARCHAR(40) NOT NULL, UNIQUE(inviterUserId, invitedUserId))`);
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
function indiaDateKey(value: string): string | null {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function dayNumber(key: string): number {
  const [year, month, day] = key.split("-").map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / 86400000);
}

async function calculateMemberXp(userId: string): Promise<{ workouts: number; xp: number }> {
  const completed = await db.all<{ completedAt: string }>(
    `SELECT completedAt FROM Workout
     WHERE userId = ? AND status = 'completed' AND completedAt IS NOT NULL
     ORDER BY completedAt ASC`,
    userId
  );
  const uniqueDays = [...new Set(
    completed.map((row) => indiaDateKey(row.completedAt)).filter((value): value is string => Boolean(value))
  )].sort((a, b) => dayNumber(a) - dayNumber(b));

  let consistencyBonusDays = 0;
  for (let index = 1; index < uniqueDays.length; index += 1) {
    if (dayNumber(uniqueDays[index]) - dayNumber(uniqueDays[index - 1]) === 1) {
      consistencyBonusDays += 1;
    }
  }

  return {
    workouts: completed.length,
    xp: completed.length * 100 + consistencyBonusDays * 25,
  };
}

friendsRouter.get("/leaderboard", async (req: AuthedRequest, res) => {
  await ensureTables();
  const userId = req.userId!;
  const code = await inviteCode(userId);
  const week = new Date(Date.now() - 7 * 86400000).toISOString();

  const own = await db.get<{ name: string | null; weeklyWorkouts: number | string }>(
    `SELECT u.name,
       SUM(CASE WHEN w.completedAt >= ? AND w.completedAt IS NOT NULL THEN 1 ELSE 0 END) AS weeklyWorkouts
     FROM "User" u
     LEFT JOIN Workout w ON w.userId = u.id AND w.status = 'completed'
     WHERE u.id = ?
     GROUP BY u.id, u.name`,
    week, userId
  );
  const friends = await db.all<{ id: string; name: string | null; weeklyWorkouts: number | string }>(
    `SELECT u.id, u.name,
       SUM(CASE WHEN w.completedAt >= ? AND w.completedAt IS NOT NULL THEN 1 ELSE 0 END) AS weeklyWorkouts
     FROM UserFriendInvite f
     JOIN "User" u ON u.id = f.invitedUserId
     LEFT JOIN Workout w ON w.userId = u.id AND w.status = 'completed'
     WHERE f.inviterUserId = ?
     GROUP BY u.id, u.name`,
    week, userId
  );

  const memberIds = [userId, ...friends.map((friend) => friend.id)];
  const xpByUser = new Map<string, { workouts: number; xp: number }>();
  await Promise.all(memberIds.map(async (id) => {
    xpByUser.set(id, await calculateMemberXp(id));
  }));

  const ownStats = xpByUser.get(userId) ?? { workouts: 0, xp: 0 };
  const members = [
    {
      id: userId,
      name: own?.name || "You",
      isYou: true,
      workouts: ownStats.workouts,
      weeklyWorkouts: Number(own?.weeklyWorkouts || 0),
      xp: ownStats.xp,
    },
    ...friends.map((friend) => {
      const stats = xpByUser.get(friend.id) ?? { workouts: 0, xp: 0 };
      return {
        id: friend.id,
        name: friend.name || "FitOS member",
        isYou: false,
        workouts: stats.workouts,
        weeklyWorkouts: Number(friend.weeklyWorkouts || 0),
        xp: stats.xp,
      };
    }),
  ].sort((a, b) => b.weeklyWorkouts - a.weeklyWorkouts || b.xp - a.xp);

  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  return res.json({
    inviteCode: code,
    inviteUrl: `${process.env.FRONTEND_PUBLIC_URL || "https://adaptive-fit-web.onrender.com"}/?invite=${code}`,
    members,
    scoring: "100 XP per completed workout plus 25 XP for each additional consecutive training day (Asia/Kolkata).",
  });
});
friendsRouter.post("/accept-invite", async (req: AuthedRequest, res) => {
  await ensureTables();
  const code = typeof req.body?.code === "string" ? req.body.code.trim() : "";
  if (!/^[a-f0-9]{36}$/i.test(code)) return res.status(400).json({error:"Invalid invite link."});
  const inviter = await db.get<{userId:string}>("SELECT userId FROM UserInviteCode WHERE code=?",code);
  if (!inviter) return res.status(404).json({error:"Invite link not found."});
  if (inviter.userId === req.userId) return res.status(400).json({error:"You cannot use your own invite link."});
  const existing = await db.get<{inviterUserId:string}>("SELECT inviterUserId FROM UserFriendInvite WHERE invitedUserId=?",req.userId!);
  if (existing) return existing.inviterUserId === inviter.userId ? res.json({linked:true,alreadyLinked:true}) : res.status(409).json({error:"This account is already linked to another inviter."});
  try { await db.run("INSERT INTO UserFriendInvite (id,inviterUserId,invitedUserId,createdAt) VALUES (?,?,?,?)",uuidv4(),inviter.userId,req.userId!,nowIso()); }
  catch { return res.status(409).json({error:"This account is already linked to another inviter."}); }
  res.status(201).json({linked:true});
});
