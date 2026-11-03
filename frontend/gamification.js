(() => {
  "use strict";

  const STORAGE_KEY = "fitos_gamification_v1";
  const SHARE_MESSAGE = "Akele hi aage badhoge dost ko bhi to saath le chalo";
  const WORKOUT_XP = 100;

  function readState() {
    try {
      const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
      return {
        xp: Number.isFinite(value.xp) ? value.xp : 0,
        rewardedWorkouts: Array.isArray(value.rewardedWorkouts) ? value.rewardedWorkouts : [],
      };
    } catch {
      return { xp: 0, rewardedWorkouts: [] };
    }
  }

  function writeState(state) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* Storage may be unavailable. */ }
  }

  function levelFor(xp) {
    return Math.floor(Math.max(0, xp) / 500) + 1;
  }

  function renderCard() {
    const host = document.getElementById("today-content");
    if (!host || !host.children.length) return;
    let card = document.getElementById("fitos-xp-card");
    if (!card) {
      card = document.createElement("section");
      card.id = "fitos-xp-card";
      card.setAttribute("aria-label", "FitOS activity points");
      card.style.cssText = "background:#fff;border:1px solid #e4e8e2;border-radius:20px;padding:18px;margin:16px 0;color:#202923;box-shadow:0 2px 10px rgba(25,50,35,.04)";
      card.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;gap:12px"><div><div style="font-size:12px;font-weight:800;letter-spacing:.06em;color:#68766e">FITOS POINTS</div><div id="fitos-xp-total" style="font-size:30px;font-weight:800;margin-top:4px">0 XP</div><div id="fitos-xp-level" style="font-size:13px;color:#68766e;margin-top:2px">Level 1</div></div><button id="fitos-share-progress" type="button" style="border:1px solid #bfe9d8;background:#effaf5;color:#176b50;border-radius:12px;padding:11px 14px;font-weight:700;font-size:13px">Share</button></div><div style="height:7px;background:#edf1ed;border-radius:20px;overflow:hidden;margin-top:15px"><div id="fitos-xp-progress" style="height:100%;width:0;background:#65cda5;border-radius:20px"></div></div><div id="fitos-xp-next" style="font-size:12px;color:#68766e;margin-top:7px">500 XP to next level</div><div style="font-size:12px;color:#68766e;margin-top:12px">Complete a workout to earn 100 XP.</div>';
      host.appendChild(card);
      card.querySelector("#fitos-share-progress").addEventListener("click", shareProgress);
    }
    const state = readState();
    const level = levelFor(state.xp);
    const currentLevelXp = state.xp % 500;
    card.querySelector("#fitos-xp-total").textContent = state.xp.toLocaleString() + " XP";
    card.querySelector("#fitos-xp-level").textContent = "Level " + level;
    card.querySelector("#fitos-xp-progress").style.width = (currentLevelXp / 500 * 100) + "%";
    card.querySelector("#fitos-xp-next").textContent = (500 - currentLevelXp) + " XP to next level";
  }

  async function shareProgress() {
    const state = readState();
    const message = SHARE_MESSAGE + " " + state.xp + " XP on FitOS. Join me on my fitness journey!";
    try {
      if (navigator.share) {
        await navigator.share({ title: "My FitOS progress", text: message });
      } else if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(message);
        const button = document.getElementById("fitos-share-progress");
        if (button) {
          button.textContent = "Copied";
          setTimeout(() => { if (button.isConnected) button.textContent = "Share"; }, 1800);
        }
      } else {
        window.prompt("Copy your FitOS message:", message);
      }
    } catch (error) {
      if (error && error.name !== "AbortError") console.warn("[FitOS] Share unavailable", error);
    }
  }

  function awardWorkout(workoutId) {
    if (!workoutId) return;
    const state = readState();
    if (state.rewardedWorkouts.includes(workoutId)) return;
    state.rewardedWorkouts.push(workoutId);
    state.xp += WORKOUT_XP;
    writeState(state);
    renderCard();
  }

  const originalFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const response = await originalFetch(...args);
    try {
      const requestUrl = typeof args[0] === "string" ? args[0] : args[0] && args[0].url;
      const match = String(requestUrl || "").match(/\/workouts\/([^/?]+)\/complete(?:\?|$)/);
      if (match && response.ok) awardWorkout(decodeURIComponent(match[1]));
    } catch (error) {
      console.warn("[FitOS] Could not process workout reward", error);
    }
    return response;
  };

  const observer = new MutationObserver(renderCard);
  function start() {
    const host = document.getElementById("today-content");
    if (host) observer.observe(host, { childList: true, subtree: true });
    renderCard();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();
