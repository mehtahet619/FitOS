(() => {
  "use strict";

  // Lightweight, UI-only gamification widget. It never intercepts fetch or
  // participates in the app's login/dashboard boot sequence.
  const STORAGE_KEY = "fitos_gamification_v2";
  const SHARE_TEXT = "Bhai abhi to gym chalne";
  const SHARE_URL = "https://adaptive-fit-web.onrender.com/";
  let inviteUrl = SHARE_URL;
  let leaderboard = null;
  const XP_PER_LEVEL = 500;

  function readXp() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
      return Math.max(0, Number(saved.xp) || 0);
    } catch {
      return 0;
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
      card.setAttribute("aria-label", "FitOS gamification");
      card.innerHTML = `
        <div class="fitos-gamification-top">
          <div>
            <div class="fitos-gamification-eyebrow">FITOS REWARDS</div>
            <div class="fitos-gamification-xp" id="fitos-gamification-xp">0 XP</div>
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
        <div class="fitos-gamification-recent">Build your streak. Every completed goal moves you forward.</div>
        <details class="fitos-gamification-rules">
          <summary>How to earn XP</summary>
          <ul>
            <li>Complete a workout <strong>+100 XP</strong></li>
            <li>Complete an exercise <strong>+15 XP</strong></li>
            <li>Reach daily protein goal <strong>+40 XP</strong></li>
            <li>Reach daily calorie goal <strong>+30 XP</strong></li>
            <li>Complete all planned sets <strong>+20 XP</strong></li>
            <li>Reach weekly workout target <strong>+200 XP</strong></li>
            <li>Beat a personal record <strong>+75 XP</strong></li>
          </ul>
        </details>`;
      host.appendChild(card);
      const board = document.createElement("section"); board.id = "fitos-private-leaderboard"; board.className = "fitos-private-leaderboard";
      const heading = document.createElement("h3"); heading.textContent = "My friends leaderboard"; board.appendChild(heading);
      const rows = document.createElement("div"); rows.id = "fitos-private-friend-rows"; rows.textContent = "Loading private leaderboard…"; board.appendChild(rows);
      // Rewards card stays first; the friends leaderboard follows it.
      host.appendChild(board);
      void Api.get("/auth/me").then(async me => { if (!me?.authenticated) return; const pending = sessionStorage.getItem("fitos_pending_invite") || new URLSearchParams(location.search).get("invite"); if (pending) { try { await Api.post("/friends/accept-invite", {code:pending}); sessionStorage.removeItem("fitos_pending_invite"); } catch (e) { if ([400,404,409].includes(e.status)) sessionStorage.removeItem("fitos_pending_invite"); } } const data = await Api.get("/friends/leaderboard");
        rows.replaceChildren();
        rows.className = "fitos-friend-grid";
        const members = Array.isArray(data.members) ? data.members : [];
        if (!members.length) {
          const empty = document.createElement("div");
          empty.className = "fitos-friends-empty";
          empty.textContent = "No leaderboard entries yet. Invite a friend to start comparing workouts.";
          rows.appendChild(empty);
        }
        members.forEach((m, i) => {
          const item = document.createElement("article");
          item.className = "fitos-friend-card" + (m.isYou ? " is-you" : "");
          const top = document.createElement("div");
          top.className = "fitos-friend-card-top";
          const rank = document.createElement("span");
          rank.className = "fitos-friend-rank";
          rank.textContent = "#" + (i + 1);
          const avatar = document.createElement("span");
          avatar.className = "fitos-friend-avatar";
          avatar.textContent = (m.name || "F").trim().charAt(0).toUpperCase();
          top.append(rank, avatar);
          const name = document.createElement("div");
          name.className = "fitos-friend-name";
          name.textContent = (m.name || "FitOS member") + (m.isYou ? " (You)" : "");
          const stats = document.createElement("div");
          stats.className = "fitos-friend-stats";
          const workouts = document.createElement("span");
          workouts.textContent = String(Number(m.weeklyWorkouts) || 0) + " workouts";
          const xp = document.createElement("strong");
          xp.textContent = (Number(m.workouts) || 0) * 100 + " XP";
          stats.append(workouts, xp);
          item.append(top, name, stats);
          rows.appendChild(item);
        }); }).catch(() => { rows.textContent = "Leaderboard unavailable. Refresh the page to retry."; });

      document.getElementById("fitos-gamification-share").addEventListener("click", async () => {
        const message = SHARE_TEXT;
        try { const data = await Api.get("/friends/leaderboard"); inviteUrl = data.inviteUrl || SHARE_URL; } catch (error) { console.warn("[FitOS] Invite link unavailable", error); }
        const button = document.getElementById("fitos-gamification-share");
        try {
          if (navigator.share) await navigator.share({ title: "AdaptiveFit", text: message, url: inviteUrl });
          else if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(message + "\
" + inviteUrl);
            button.textContent = "Copied!";
          } else window.prompt("Copy your invite:", message + "\
" + SHARE_URL);
        } catch (error) {
          if (error?.name !== "AbortError") console.warn("[FitOS] Share unavailable.", error);
        }
      });
    }

    const xp = readXp();
    const level = Math.floor(xp / XP_PER_LEVEL) + 1;
    const progress = xp % XP_PER_LEVEL;
    card.querySelector("#fitos-gamification-xp").textContent = xp.toLocaleString() + " XP";
    card.querySelector("#fitos-gamification-level").textContent = "Level " + level;
    card.querySelector("#fitos-gamification-progress").style.width = (progress / XP_PER_LEVEL * 100) + "%";
    card.querySelector("#fitos-gamification-next").textContent = (XP_PER_LEVEL - progress) + " XP to next level";
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

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();