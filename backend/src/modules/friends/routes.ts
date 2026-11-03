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
friendsRouter.get("/leaderboard", async (req: AuthedRequest, res) => {
  await ensureTables();
  const userId = req.userId!;
  const code = await inviteCode(userId);
  const week = new Date(Date.now() - 7 * 86400000).toISOString();
  const own = await db.get<{name:string|null; workouts:number|string; weeklyWorkouts:number|string}>(`SELECT u.name, COUNT(w.id) AS workouts, SUM(CASE WHEN w.completedAt >= ? THEN 1 ELSE 0 END) AS weeklyWorkouts FROM "User" u LEFT JOIN Workout w ON w.userId=u.id AND w.status='completed' WHERE u.id=? GROUP BY u.id,u.name`, week, userId);
  const friends = await db.all<{id:string;name:string|null;workouts:number|string;weeklyWorkouts:number|string}>(`SELECT u.id,u.name,COUNT(w.id) AS workouts,SUM(CASE WHEN w.completedAt >= ? THEN 1 ELSE 0 END) AS weeklyWorkouts FROM UserFriendInvite f JOIN "User" u ON u.id=f.invitedUserId LEFT JOIN Workout w ON w.userId=u.id AND w.status='completed' WHERE f.inviterUserId=? GROUP BY u.id,u.name`, week, userId);
  const members = [{id:userId,name:own?.name || "You",isYou:true,workouts:Number(own?.workouts||0),weeklyWorkouts:Number(own?.weeklyWorkouts||0)}, ...friends.map(f=>({id:f.id,name:f.name||"FitOS member",isYou:false,workouts:Number(f.workouts||0),weeklyWorkouts:Number(f.weeklyWorkouts||0)}))].sort((a,b)=>b.weeklyWorkouts-a.weeklyWorkouts||b.workouts-a.workouts);
  res.setHeader("Cache-Control","no-store");
  res.json({inviteCode:code,inviteUrl:`${process.env.FRONTEND_PUBLIC_URL || "https://adaptive-fit-web.onrender.com"}/?invite=${code}`,members,scoring:"100 XP per completed workout. Rank is based on completed workouts in the last 7 days."});
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
