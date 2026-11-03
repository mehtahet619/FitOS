(() => {
  "use strict";

  // Gamification is intentionally isolated from the app boot path. Any storage,
  // browser-share, or tracking failure must never prevent FitOS from rendering.
  const KEY = "fitos_gamification_v2";
  const SHARE_MESSAGE = "Akele hi aage badhoge dost ko bhi to saath le chalo";
  const REWARDS = {
    workout: 100,
    exercise: 15,
    protein: 40,
    calories: 30,
    allSets: 20,
    weeklyTarget: 200,
    personalRecord: 75,
  };
  const safeObject = (value) => value && typeof value === "object" ? value : {};
  const localDate = () => {
    const d = new Date();
    return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")].join("-");
  };
  const weekKey = () => {
    const d = new Date();
    const day = (d.getDay() + 6) % 7;
    d.setDate(d.getDate() - day);
    return localDateFor(d);
  };
  const localDateFor = (d) => [d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")].join("-");
  function readState() {
    try {
      const value = safeObject(JSON.parse(localStorage.getItem(KEY) || "{}"));
      return {
        xp: Math.max(0, Number(value.xp) || 0),
        rewards: safeObject(value.rewards),
        workouts: safeObject(value.workouts),
        personalRecords: safeObject(value.personalRecords),
        profile: safeObject(value.profile),
        nutritionTargets: safeObject(value.nutritionTargets),
        nutritionTotals: safeObject(value.nutritionTotals),
        weeklyCompleted: safeObject(value.weeklyCompleted),
        recentRewards: Array.isArray(value.recentRewards) ? value.recentRewards.slice(-5) : [],
      };
    } catch {
      return { xp: 0, rewards: {}, workouts: {}, personalRecords: {}, profile: {}, nutritionTargets: {}, nutritionTotals: {}, weeklyCompleted: {}, recentRewards: [] };
    }
  }
  let state = readState();
  function persist() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (error) { console.warn("[FitOS gamification] Local progress could not be saved.", error); }
  }
  function award(type, amount, uniqueKey, description) {
    if (!uniqueKey) return false;
    const bucket = state.rewards[type] || (state.rewards[type] = {});
    if (bucket[uniqueKey]) return false;
    bucket[uniqueKey] = true;
    state.xp += amount;
    state.recentRewards.unshift({ type, amount, description, at: Date.now() });
    state.recentRewards = state.recentRewards.slice(0, 5);
    persist();
    render();
    return true;
  }
  function levelInfo(xp) {
    const level = Math.floor(xp / 500) + 1;
    return { level, current: xp % 500, remaining: 500 - (xp % 500) };
  }
  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function render() {
    const host = document.getElementById("today-content");
    if (!host || !host.children.length) return;
    let card = document.getElementById("fitos-gamification-card");
    if (!card) {
      card = document.createElement("section");
      card.id = "fitos-gamification-card";
      card.className = "fitos-gamification-card";
      card.setAttribute("aria-label", "FitOS XP and achievements");
      card.innerHTML = `
        <div class="fitos-gamification-top">
          <div><div class="fitos-gamification-eyebrow">FITOS REWARDS</div><div class="fitos-gamification-xp" id="fitos-gamification-xp">0 XP</div><div class="fitos-gamification-level" id="fitos-gamification-level">Level 1</div></div>
          <button type="button" class="fitos-gamification-share" id="fitos-gamification-share">Share progress</button>
        </div>
        <div class="fitos-gamification-track"><span id="fitos-gamification-progress"></span></div>
        <div class="fitos-gamification-next" id="fitos-gamification-next">500 XP to next level</div>
        <div class="fitos-gamification-recent" id="fitos-gamification-recent"></div>
        <details class="fitos-gamification-rules"><summary>How to earn XP</summary><ul>
          <li>Complete a workout <strong>+100 XP</strong></li><li>Complete an exercise <strong>+15 XP</strong></li>
          <li>Reach daily protein goal <strong>+40 XP</strong></li><li>Reach daily calorie goal <strong>+30 XP</strong></li>
          <li>Complete all planned sets <strong>+20 XP</strong></li><li>Reach weekly workout target <strong>+200 XP</strong></li>
          <li>Beat a personal record <strong>+75 XP</strong></li>
        </ul></details>
        <p class="fitos-gamification-note">Progress is saved on this device and browser.</p>`;
      host.appendChild(card);
      card.querySelector("#fitos-gamification-share").addEventListener("click", shareProgress);
    }
    const level = levelInfo(state.xp);
    card.querySelector("#fitos-gamification-xp").textContent = state.xp.toLocaleString() + " XP";
    card.querySelector("#fitos-gamification-level").textContent = "Level " + level.level;
    card.querySelector("#fitos-gamification-progress").style.width = (level.current / 500 * 100) + "%";
    card.querySelector("#fitos-gamification-next").textContent = level.remaining + " XP to next level";
    const recent = state.recentRewards[0];
    card.querySelector("#fitos-gamification-recent").textContent = recent ? "Latest: +" + recent.amount + " XP · " + recent.description : "Complete activities to start earning XP.";
  }
  async function shareProgress() {
    const message = SHARE_MESSAGE + " " + state.xp.toLocaleString() + " XP on FitOS. Join me on my fitness journey!";
    try {
      if (navigator.share) await navigator.share({ title: "My FitOS progress", text: message });
      else if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(message);
        const button = document.getElementById("fitos-gamification-share");
        if (button) button.textContent = "Copied!";
      } else window.prompt("Copy your FitOS message:", message);
    } catch (error) {
      if (error?.name !== "AbortError") console.warn("[FitOS gamification] Share failed.", error);
    }
  }
  function rememberWorkout(workoutId, data) {
    if (!workoutId || !data || !Array.isArray(data.exercises)) return;
    const workout = state.workouts[workoutId] || (state.workouts[workoutId] = { exercises: {}, completed: false, allSetsRewarded: false });
    for (const exercise of data.exercises) {
      const id = String(exercise.workoutExerciseId || "");
      if (!id) continue;
      workout.exercises[id] = {
        exerciseId: String(exercise.exerciseId || id),
        name: String(exercise.exerciseName || exercise.name || "Exercise"),
        targetSets: Math.max(1, Number(exercise.targetSets) || 1),
        completedSets: Array.isArray(workout.exercises[id]?.completedSets) ? workout.exercises[id].completedSets : [],
        bestWeight: Number(workout.exercises[id]?.bestWeight) || 0,
        bestReps: Number(workout.exercises[id]?.bestReps) || 0,
      };
    }
    persist();
  }
  function recordSet(workoutId, payload) {
    const workout = state.workouts[workoutId];
    const exercise = workout?.exercises?.[String(payload.workoutExerciseId || "")];
    if (!exercise) return;
    const setNumber = Number(payload.setNumber);
    if (!Number.isInteger(setNumber) || setNumber < 1) return;
    if (!exercise.completedSets.includes(setNumber)) exercise.completedSets.push(setNumber);
    const weight = Number(payload.weightKg) || 0;
    const reps = Number(payload.reps) || 0;
    const previous = state.personalRecords[exercise.exerciseId];
    if (!previous) {
      // The first observed lift establishes a baseline; it is not proof of a PR.
      state.personalRecords[exercise.exerciseId] = { weight, reps };
    } else {
      const improved = weight > Number(previous.weight || 0) || (weight === Number(previous.weight || 0) && reps > Number(previous.reps || 0));
      if (improved && (weight > 0 || reps > 0)) {
        state.personalRecords[exercise.exerciseId] = { weight: Math.max(weight, Number(previous.weight) || 0), reps: weight >= (Number(previous.weight) || 0) ? reps : Number(previous.reps) || 0 };
        award("personalRecord", REWARDS.personalRecord, exercise.exerciseId + ":" + localDate(), "New personal record");
      }
    }
    if (exercise.completedSets.length >= exercise.targetSets) {
      award("exercise", REWARDS.exercise, workoutId + ":" + payload.workoutExerciseId, "Exercise completed");
    }
    const allComplete = Object.keys(workout.exercises).length > 0 && Object.values(workout.exercises).every((item) => item.completedSets.length >= item.targetSets);
    if (allComplete && !workout.allSetsRewarded) {
      workout.allSetsRewarded = true;
      award("allSets", REWARDS.allSets, workoutId, "All planned sets completed");
    }
    persist();
  }
  function completeWorkout(workoutId) {
    if (!workoutId) return;
    const workout = state.workouts[workoutId] || (state.workouts[workoutId] = { exercises: {}, completed: false, allSetsRewarded: false });
    if (workout.completed) return;
    workout.completed = true;
    award("workout", REWARDS.workout, workoutId, "Workout completed");
    const week = weekKey();
    const completed = state.weeklyCompleted[week] || (state.weeklyCompleted[week] = []);
    if (!completed.includes(workoutId)) completed.push(workoutId);
    const target = Math.max(1, Number(state.profile.daysPerWeek) || 3);
    if (completed.length >= target) award("weeklyTarget", REWARDS.weeklyTarget, week, "Weekly workout target reached");
    persist();
  }
  function checkNutritionGoals(result) {
    const totals = safeObject(result?.totals);
    state.nutritionTotals = {
      caloriesKcal: Number(totals.caloriesKcal ?? totals.calories) || 0,
      proteinG: Number(totals.proteinG) || 0,
    };
    const date = localDate();
    const calorieTarget = Number(state.nutritionTargets.calorieTarget) || 0;
    const proteinTarget = Number(state.nutritionTargets.proteinTargetG) || 0;
    if (proteinTarget > 0 && state.nutritionTotals.proteinG >= proteinTarget) award("protein", REWARDS.protein, date, "Daily protein goal reached");
    if (calorieTarget > 0 && state.nutritionTotals.caloriesKcal >= calorieTarget) award("calories", REWARDS.calories, date, "Daily calorie goal reached");
    persist();
  }
  function requestBody(init) {
    try { return init?.body ? JSON.parse(init.body) : {}; } catch { return {}; }
  }
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async function (...args) {
    const input = args[0];
    const init = args[1] || {};
    const url = String(typeof input === "string" ? input : input?.url || "");
    const method = String(init.method || input?.method || "GET").toUpperCase();
    const body = requestBody(init);
    const response = await nativeFetch(...args);
    try {
      if (!response.ok) return response;
      if (method === "POST" && /\/workouts\/generate(?:\?|$)/.test(url)) {
        const data = await response.clone().json();
        if (data?.workout?.id) rememberWorkout(String(data.workout.id), data);
      }
      const setMatch = url.match(/\/workouts\/([^/?]+)\/complete-set(?:\?|$)/);
      if (method === "POST" && setMatch) recordSet(decodeURIComponent(setMatch[1]), body);
      const completeMatch = url.match(/\/workouts\/([^/?]+)\/complete(?:\?|$)/);
      if (method === "POST" && completeMatch) completeWorkout(decodeURIComponent(completeMatch[1]));
      if (method === "GET" && /\/user\/profile(?:\?|$)/.test(url)) {
        const data = await response.clone().json();
        state.profile = data.profile || data;
        state.nutritionTargets = data.nutritionTargets || state.nutritionTargets;
        persist();
      }
      if (method === "GET" && /\/nutrition\/logs(?:\?|$)/.test(url)) {
        const data = await response.clone().json();
        checkNutritionGoals(data);
      }
    } catch (error) {
      console.warn("[FitOS gamification] Activity tracking skipped.", error);
    }
    return response;
  };
  const observer = new MutationObserver(() => {
    try { render(); } catch (error) { console.warn("[FitOS gamification] UI render skipped.", error); }
  });
  function start() {
    try {
      const host = document.getElementById("today-content");
      if (host) observer.observe(host, { childList: true, subtree: true });
      render();
    } catch (error) { console.warn("[FitOS gamification] Startup skipped.", error); }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();