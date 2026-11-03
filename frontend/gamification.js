(() => {
  "use strict";

  // Lightweight, UI-only gamification widget. It never intercepts fetch or
  // participates in the app's login/dashboard boot sequence.
  const STORAGE_KEY = "fitos_gamification_v2";
  const SHARE_TEXT = "Bhai abhi to gym chalne";
  const SHARE_URL = "https://adaptive-fit-web.onrender.com/";
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
    const host = document.getElementById("today-content");
    if (!host || !host.children.length) return;

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

      card.querySelector("#fitos-gamification-share").addEventListener("click", async () => {
        const message = SHARE_TEXT;
        const button = card.querySelector("#fitos-gamification-share");
        try {
          if (navigator.share) await navigator.share({ title: "AdaptiveFit", text: message, url: SHARE_URL });
          else if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(message + "\\n" + SHARE_URL);
            button.textContent = "Copied!";
          } else window.prompt("Copy your invite:", message + "\\n" + SHARE_URL);
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
    const host = document.getElementById("today-content");
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