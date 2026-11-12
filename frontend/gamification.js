(() => {
  "use strict";

  // XP is calculated by the server (GET /friends/leaderboard) from the signed-in
  // user's completed workouts. The browser never invents or caches an XP total;
  // local workout history is only used for the live streak display.
  const SHARE_TEXT = "Bhai abhi to gym chalne";
  const SHARE_URL = "https://adaptive-fit-web.onrender.com/";
  const XP_PER_WORKOUT = 100;
  const XP_PER_CONSECUTIVE_DAY = 25;
  const XP_PER_LEVEL = 500;
  let inviteUrl = SHARE_URL;
  let currentXp = 0;
  let historyRequest = null;

  function localDateKey(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return null;
    // Match the backend's Asia/Kolkata calendar-day boundaries exactly.
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Kolkata",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
    const part = (type) => parts.find((item) => item.type === type)?.value || "";
    return part("year") + "-" + part("month") + "-" + part("day");
  }

  function dayNumber(key) {
    const [year, month, day] = key.split("-").map(Number);
    return Math.floor(Date.UTC(year, month - 1, day) / 86400000);
  }

  function calculateRewards(history) {
    const completed = (Array.isArray(history) ? history : [])
      .filter((item) => item && item.status === "completed" && item.completedAt);

    const workoutCount = completed.length;
    const uniqueDays = [...new Set(completed.map((item) => localDateKey(item.completedAt)).filter(Boolean))]
      .sort((a, b) => dayNumber(a) - dayNumber(b));

    // Award a permanent consistency bonus for each day that extends a
    // consecutive-day run. Six consecutive training days earn five bonuses.
    let consistencyBonusDays = 0;
    let currentRun = 0;
    let longestRun = 0;
    for (let i = 0; i < uniqueDays.length; i += 1) {
      if (i > 0 && dayNumber(uniqueDays[i]) - dayNumber(uniqueDays[i - 1]) === 1) {
        currentRun += 1;
      } else {
        currentRun = 1;
      }
      longestRun = Math.max(longestRun, currentRun);
      if (currentRun > 1) consistencyBonusDays += 1;
    }

    const todayNumber = dayNumber(localDateKey(new Date()));
    const daySet = new Set(uniqueDays.map(dayNumber));
    let currentStreak = 0;
    if (daySet.has(todayNumber) || daySet.has(todayNumber - 1)) {
      let cursor = daySet.has(todayNumber) ? todayNumber : todayNumber - 1;
      while (daySet.has(cursor)) {
        currentStreak += 1;
        cursor -= 1;
      }
    }

    const workoutXp = workoutCount * XP_PER_WORKOUT;
    const consistencyXp = consistencyBonusDays * XP_PER_CONSECUTIVE_DAY;
    return { workoutCount, workoutXp, consistencyXp, consistencyBonusDays, currentStreak, longestRun, totalXp: workoutXp + consistencyXp };
  }

  function updateXpDisplay(stats) {
    const card = document.getElementById("fitos-gamification-card");
    if (!card) return;
    const xp = Math.max(0, Number(stats.totalXp) || 0);
    currentXp = xp;
    const level = Math.floor(xp / XP_PER_LEVEL) + 1;
    const progress = xp % XP_PER_LEVEL;
    card.querySelector("#fitos-gamification-xp").textContent = xp.toLocaleString() + " XP";
    card.querySelector("#fitos-gamification-level").textContent = "Level " + level;
    card.querySelector("#fitos-gamification-progress").style.width = (progress / XP_PER_LEVEL * 100) + "%";
    card.querySelector("#fitos-gamification-next").textContent = (XP_PER_LEVEL - progress) + " XP to next level";
    card.querySelector("#fitos-gamification-workouts").textContent = stats.workoutCount + " completed workouts · +" + stats.workoutXp + " XP";
    card.querySelector("#fitos-gamification-consistency").textContent =
      (stats.currentStreak == null ? "Streak unavailable" : stats.currentStreak + " day current streak") +
      " · +" + stats.consistencyXp + " consistency XP earned";
  }

  async function refreshRewards(rows) {
    if (historyRequest) return historyRequest;
    historyRequest = (async () => {
      // One leaderboard response is the source of truth for both the signed-in
      // user's card and every friend's row. Both views therefore use one snapshot.
      const leaderboard = await Api.get("/friends/leaderboard");
      const members = Array.isArray(leaderboard?.members) ? leaderboard.members : [];
      const own = members.find((member) => member.isYou);
      if (!own) {
        throw new Error("Your rewards profile is missing from the friends leaderboard. XP was not replaced with a guessed value.");
      }

      const workoutCount = Math.max(0, Number(own.workouts) || 0);
      const totalXp = Math.max(0, Number(own.xp) || 0);
      const stats = {
        workoutCount,
        workoutXp: workoutCount * XP_PER_WORKOUT,
        totalXp,
        consistencyXp: Math.max(0, totalXp - workoutCount * XP_PER_WORKOUT),
        currentStreak: null,
      };

      if (rows) renderLeaderboard(leaderboard, rows);

      try {
        const response = await Api.get("/workouts/history");
        const history = Array.isArray(response) ? response : (response?.history || response?.workouts || []);
        stats.currentStreak = calculateRewards(history).currentStreak;
      } catch (historyError) {
        console.warn("[FACHS] Workout history unavailable; keeping server XP.", historyError);
        const status = document.getElementById("fitos-gamification-status");
        if (status) status.textContent = "XP is up to date. Current streak is temporarily unavailable.";
      }

      updateXpDisplay(stats);
      const status = document.getElementById("fitos-gamification-status");
      if (status && stats.currentStreak != null) status.textContent = "";
      return leaderboard;
    })()
      .catch((error) => {
        const status = document.getElementById("fitos-gamification-status");
        if (status) status.textContent = "Your rewards could not be loaded from the server. Please try again shortly.";
        console.warn("[FACHS] Could not load rewards from the server.", error);
        throw error;
      })
      .finally(() => { historyRequest = null; });
    return historyRequest;
  }

  function renderLeaderboard(data, rows) {
    const members = Array.isArray(data?.members) ? data.members : [];
    if (!rows) return data;
    rows.replaceChildren();
    rows.className = "fitos-friend-grid";
    if (!members.length) {
      const empty = document.createElement("div");
      empty.className = "fitos-friends-empty";
      empty.textContent = "No leaderboard entries yet. Invite a friend to start comparing workouts.";
      rows.appendChild(empty);
    }
    members.forEach((member, index) => {
      const item = document.createElement("article");
      item.className = "fitos-friend-card" + (member.isYou ? " is-you" : "");
      const top = document.createElement("div");
      top.className = "fitos-friend-card-top";
      const rank = document.createElement("span");
      rank.className = "fitos-friend-rank";
      rank.textContent = "#" + (index + 1);
      const avatar = document.createElement("span");
      avatar.className = "fitos-friend-avatar";
      avatar.textContent = (member.name || "F").trim().charAt(0).toUpperCase();
      top.append(rank, avatar);
      const name = document.createElement("div");
      name.className = "fitos-friend-name";
      name.textContent = (member.name || "FACHS member") + (member.isYou ? " (You)" : "");
      const stats = document.createElement("div");
      stats.className = "fitos-friend-stats";
      const workouts = document.createElement("span");
      workouts.textContent = String(Number(member.weeklyWorkouts) || 0) + " workouts this week";
      const xp = document.createElement("strong");
      xp.textContent = (Number(member.xp) || 0).toLocaleString() + " XP";
      stats.append(workouts, xp);
      item.append(top, name, stats);
      rows.appendChild(item);
    });
    return data;
  }

  async function syncFriends(rows) {
    const targetRows = rows || document.getElementById("fitos-private-friend-rows");
    if (!targetRows) return;
    try {
      const me = await Api.get("/auth/me");
      if (!me?.authenticated) return;

      const pending = sessionStorage.getItem("fitos_pending_invite") || new URLSearchParams(location.search).get("invite");
      if (pending) {
        try {
          await Api.post("/friends/accept-invite", { code: pending });
          sessionStorage.removeItem("fitos_pending_invite");
        } catch (error) {
          if ([400, 404, 409].includes(error.status)) {
            sessionStorage.removeItem("fitos_pending_invite");
            const status = document.getElementById("fitos-gamification-status");
            if (status) status.textContent = error.status === 409
              ? "This account is already linked to another invite. The existing friend link was kept."
              : "This friend invite link is invalid or no longer available.";
          } else {
            throw error;
          }
        }
      }

      await refreshRewards(targetRows);
    } catch (error) {
      targetRows.textContent = "Friends leaderboard is temporarily unavailable. Please try again.";
      console.warn("[FACHS] Could not sync the friend leaderboard.", error);
      throw error;
    }
  }

  function render() {
    const host = document.getElementById("friends-content");
    if (!host) return;

    let card = document.getElementById("fitos-gamification-card");
    if (!card) {
      card = document.createElement("section");
      card.id = "fitos-gamification-card";
      card.className = "fitos-gamification-card";
      card.setAttribute("aria-label", "FACHS gamification");
      card.innerHTML = `
        <div class="fitos-gamification-top">
          <div>
            <div class="fitos-gamification-eyebrow">FACHS REWARDS</div>
            <div class="fitos-gamification-xp" id="fitos-gamification-xp">Calculating XP…</div>
            <div class="fitos-gamification-level" id="fitos-gamification-level">Level 1</div>
          </div>
          <div class="fitos-gamification-invite">
            <div class="fitos-gamification-invite-copy">Akele hi aage badh gaya? Apne doston ko bhi saath le chalo.</div>
            <div class="fitos-gamification-friends" aria-hidden="true"><span></span><span></span><span></span></div>
            <button type="button" class="fitos-gamification-share" id="fitos-gamification-share">Invite friends</button>
          </div>
        </div>
        <div class="fitos-gamification-track"><span id="fitos-gamification-progress"></span></div>
        <div class="fitos-gamification-next" id="fitos-gamification-next">500 XP to next level</div>
        <div class="fitos-gamification-recent" id="fitos-gamification-workouts">Loading completed workouts…</div>
        <div class="fitos-gamification-recent" id="fitos-gamification-consistency">Calculating consistency…</div>
        <p class="fitos-gamification-note" id="fitos-gamification-status" aria-live="polite"></p>
        <details class="fitos-gamification-rules">
          <summary>How to earn XP</summary>
          <ul>
            <li>Complete a workout <strong>+100 XP</strong></li>
            <li>Train on a consecutive day <strong>+25 bonus XP</strong></li>
          </ul>
        </details>`;
      host.appendChild(card);

      const board = document.createElement("section");
      board.id = "fitos-private-leaderboard";
      board.className = "fitos-private-leaderboard";
      const heading = document.createElement("h3");
      heading.textContent = "My friends leaderboard";
      board.appendChild(heading);
      const rows = document.createElement("div");
      rows.id = "fitos-private-friend-rows";
      rows.textContent = "Loading private leaderboard…";
      board.appendChild(rows);
      host.appendChild(board);

      void syncFriends(rows).catch(() => {});

      document.getElementById("fitos-gamification-share").addEventListener("click", async () => {
        const message = SHARE_TEXT;
        try {
          const data = await Api.get("/friends/leaderboard");
          inviteUrl = data.inviteUrl || SHARE_URL;
        } catch (error) {
          console.warn("[FACHS] Invite link unavailable", error);
        }
        const button = document.getElementById("fitos-gamification-share");
        try {
          if (navigator.share) await navigator.share({ title: "FACHS", text: message, url: inviteUrl });
          else if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(message + "\n" + inviteUrl);
            button.textContent = "Copied!";
          } else {
            window.prompt("Copy your invite:", message + "\n" + inviteUrl);
          }
        } catch (error) {
          if (error?.name !== "AbortError") console.warn("[FACHS] Share unavailable.", error);
        }
      });


    } else {
      void syncFriends(document.getElementById("fitos-private-friend-rows")).catch(() => {});
    }
  }

  function start() {
    const host = document.getElementById("friends-content");
    if (!host) return;
    const observer = new MutationObserver(() => {
      if (!document.getElementById("fitos-gamification-card")) render();
    });
    observer.observe(host, { childList: true });
    render();
  }

  window.addEventListener("fitos:authenticated", () => {
    void syncFriends(document.getElementById("fitos-private-friend-rows")).catch(() => {});
  });
  window.addEventListener("fitos:friends-opened", () => {
    void syncFriends(document.getElementById("fitos-private-friend-rows")).catch(() => {});
  });
  window.addEventListener("focus", () => {
    if (document.getElementById("fitos-gamification-card")) void syncFriends().catch(() => {});
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && document.getElementById("fitos-gamification-card")) void syncFriends().catch(() => {});
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();