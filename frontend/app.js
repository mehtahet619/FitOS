/* ---------------- Equipment camera scan (shared) ---------------- */
async function startEquipmentScan(containerId, onResult) {
  const area = $(containerId);
  area.innerHTML = `
    <div class="camera-panel" style="aspect-ratio: 4/3; margin-bottom: 12px;">
      <video id="eq-scan-video" autoplay playsinline muted></video>
      <div class="camera-feedback" style="display:block;">Point the camera at your equipment, then tap Capture</div>
    </div>
    <div class="btn-row" style="margin-bottom: 12px;">
      <button class="btn btn-mint" id="eq-scan-capture">Capture</button>
      <button class="btn btn-outline" id="eq-scan-cancel">Cancel</button>
    </div>
  `;
  const video = $("eq-scan-video");
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
    video.srcObject = stream;
  } catch (e) {
    area.innerHTML = `<div class="banner banner-error">Camera permission denied.</div>`;
    return;
  }

  function cleanup() {
    if (stream) stream.getTracks().forEach((t) => t.stop());
  }

  $("eq-scan-cancel").addEventListener("click", () => {
    cleanup();
    area.innerHTML = "";
  });

  $("eq-scan-capture").addEventListener("click", async () => {
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d").drawImage(video, 0, 0);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
    const base64 = dataUrl.split(",")[1];
    cleanup();
    area.innerHTML = `<div class="empty-state"><span class="spinner"></span> Detecting equipment…</div>`;
    try {
      const result = await Api.post("/equipment/detect", { imageBase64: base64 });
      renderScanResult(area, result, onResult);
    } catch (e) {
      area.innerHTML = `<div class="banner banner-error">${e.message}</div>`;
    }
  });
}

function renderScanResult(area, result, onResult) {
  if (!result.configured) {
    area.innerHTML = `<div class="banner banner-info">${result.message}</div>`;
    return;
  }
  if (result.detections.length === 0) {
    area.innerHTML = `<div class="banner banner-info">${result.message}</div>`;
    return;
  }
  const names = result.detections.map((d) => d.equipmentName);
  const uniqueNames = Array.from(new Set(names));

  const detectionsHtml = result.detections
    .map((d) => `<span class="pill" style="margin-right:6px; margin-bottom:6px;">${d.equipmentName} · ${Math.round(d.confidence * 100)}%</span>`)
    .join("");

  const suggestionsHtml = result.suggestedExercises
    .map(
      (ex) => `
      <div class="exercise-row">
        <div>
          <div class="exercise-name">${ex.name}</div>
          <div class="exercise-meta">${ex.primaryMuscle} · ${ex.sets} sets × ${ex.repRangeLow}-${ex.repRangeHigh} reps</div>
          <div class="exercise-meta">${ex.howTo}</div>
        </div>
      </div>`
    )
    .join("");

  area.innerHTML = `
    <div class="card">
      <div class="card-label">Detected equipment</div>
      <div style="margin-bottom:8px;">${detectionsHtml}</div>
      <button class="btn btn-mint" id="eq-scan-use-btn">Use this equipment</button>
    </div>
    ${
      result.suggestedExercises.length
        ? `<div class="card"><div class="card-label">Suggested exercises with this equipment</div>${suggestionsHtml}</div>`
        : ""
    }
  `;

  $("eq-scan-use-btn").addEventListener("click", () => onResult(uniqueNames));
}

/* ---------------- Global state ---------------- */
const State = {
  equipmentList: [],
  selectedEquipment: new Set(),
  isRegisterMode: false,
};

const AuthState = {
  status: "AUTH_LOADING",
  user: null,
  generation: 0,
  authenticated(user) { this.status = "AUTHENTICATED"; this.user = user; this.generation += 1; },
  unauthenticated() {
    if (this.status === "UNAUTHENTICATED") return;
    this.status = "UNAUTHENTICATED"; this.user = null; this.generation += 1;
    Api.clearTokens(); clearProtectedContent();
    if (!location.pathname.startsWith("/verify-email") && !location.pathname.startsWith("/forgot-password") && !location.pathname.startsWith("/reset-password")) navigate("/login", true);
  },
};
let authBootGeneration = 0;
window.AuthState = AuthState;

const routeTabs = { "/homepage": "today", "/today": "today", "/workout": "workout", "/workouts": "workout", "/nutrition": "diet", "/equipment": "gym-scan", "/history": "history", "/profile": "profile", "/settings": "settings" };
function normalizePath(path) { return path.length > 1 ? path.replace(/\/$/, "") : path; }
function navigate(path, replace = false) {
  if (replace) history.replaceState({}, "", path); else if (location.pathname !== path) history.pushState({}, "", path);
  void routeCurrent();
}
function clearProtectedContent() {
  ["today-content", "workout-content", "diet-content", "gym-content", "gym-scan-content"].forEach((id) => { const el = $(id); if (el) el.replaceChildren(); });
  $("main-app").style.display = "none"; $("bottom-nav").style.display = "none";
}
function maskEmail(email) { const [name, domain] = (email || "").split("@"); return `${(name || "").slice(0, 1)}***@${domain || ""}`; }
let verifyEmail = sessionStorage.getItem("pendingVerifyEmail") || "";
let resendTimer;
function showVerify(email) {
  verifyEmail = (email || "").trim().toLowerCase();
  if (verifyEmail) sessionStorage.setItem("pendingVerifyEmail", verifyEmail);
  $("verify-email-masked").textContent = maskEmail(verifyEmail);
  showScreen("screen-verify-email"); startResendCountdown(60);
}
function startResendCountdown(seconds) {
  clearInterval(resendTimer); let remaining = seconds;
  const button = $("verify-resend"); button.disabled = true;
  const paint = () => { $("verify-countdown").textContent = remaining > 0 ? `Resend available in ${remaining}s` : "You can request a new code."; button.disabled = remaining > 0; };
  paint(); resendTimer = setInterval(() => { remaining -= 1; paint(); if (remaining <= 0) clearInterval(resendTimer); }, 1000);
}
async function routeCurrent() {
  const path = normalizePath(location.pathname);
  const publicRoutes = { "/login": "screen-auth", "/register": "screen-auth", "/verify-email": "screen-verify-email", "/forgot-password": "screen-forgot-password", "/reset-password": "screen-reset-password" };
  if (AuthState.status === "AUTH_LOADING") { showScreen("screen-auth-loading"); return; }
  if (path === "/" || path === "/login" || path === "/register") {
    if (AuthState.status === "AUTHENTICATED") { if (path !== "/homepage") navigate("/homepage", true); return; }
    State.isRegisterMode = path === "/register";
    updateAuthMode(); showScreen("screen-auth"); return;
  }
  if (path === "/verify-email" || path === "/forgot-password" || path === "/reset-password") { showScreen(publicRoutes[path]); return; }
  if (AuthState.status !== "AUTHENTICATED") { navigate("/login", true); return; }
  if (!routeTabs[path]) { navigate("/homepage", true); return; }
  $("main-app").style.display = "flex"; $("bottom-nav").style.display = "flex";
  if (path === "/profile" || path === "/settings") {
    showScreen("screen-onboarding"); $("main-app").style.display = "none"; $("bottom-nav").style.display = "none"; return;
  }
  if (path === "/history") { showHistory(); return; }
  switchTab(routeTabs[path], false);
}
window.addEventListener("popstate", () => { if (AuthState.status === "AUTHENTICATED") { void routeCurrent(); } else { void boot(); } });
window.addEventListener("pageshow", (event) => { if (event.persisted) { AuthState.status = "AUTH_LOADING"; showScreen("screen-auth-loading"); void boot(); } });

function updateAuthMode() {
  const register = State.isRegisterMode;
  $("auth-title").textContent = register ? "Create your account" : "Welcome back";
  $("auth-submit").textContent = register ? "Sign up" : "Log in";
  $("auth-toggle").textContent = register ? "Already have an account? Log in" : "New here? Create an account";
  $("auth-name-label").hidden = !register; $("auth-name").hidden = !register;
  $("forgot-link").hidden = register;
}

const EQUIPMENT_ICONS = {
  "No Equipment": "🧍",
  "Dumbbells": "🏋️",
  "Barbell": "🏋️‍♂️",
  "Bench": "🛋️",
  "Pull-up Bar": "🧗",
  "Resistance Bands": "➰",
  "Cable Machine": "🔗",
  "Squat Rack": "🏗️",
  "Treadmill": "🏃",
  "Exercise Bike": "🚴",
  "Smith Machine": "⚙️",
  "Leg Press": "🦵",
  "Lat Pulldown": "⬇️",
};

/* ---------------- Helpers ---------------- */
function $(id) { return document.getElementById(id); }
function banner(el, type, msg) {
  el.innerHTML = msg ? `<div class="banner banner-${type}">${msg}</div>` : "";
}
function showScreen(id) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
  if (id === "screen-auth" || id.startsWith("screen-verify") || id.startsWith("screen-forgot") || id.startsWith("screen-reset")) {
    $("main-app").style.display = "none"; $("bottom-nav").style.display = "none";
  }
  $(id).classList.add("active");
}

/* ---------------- Boot ---------------- */
async function boot() {
  const generation = ++authBootGeneration;
  AuthState.status = "AUTH_LOADING"; showScreen("screen-auth-loading");
  try {
    const data = await Api.get("/auth/me");
    if (generation !== authBootGeneration) return;
    if (!data.authenticated) { Api.clearTokens(); AuthState.status = "UNAUTHENTICATED"; navigate("/login", true); return; }
    AuthState.authenticated(data.user);
    if (location.hostname === "localhost" || location.hostname === "127.0.0.1") console.info("[AUTH] session restored; redirecting to homepage");
    if (["/", "/login", "/register"].includes(normalizePath(location.pathname))) navigate("/homepage", true); else await routeCurrent();
  } catch (e) {
    if (generation !== authBootGeneration) return;
    Api.clearTokens(); AuthState.status = "UNAUTHENTICATED"; navigate("/login", true);
    banner($("auth-banner"), "error", e.message || "Couldn't check your session. Please try again.");
  }
}

/* ---------------- Auth screen ---------------- */
$("auth-toggle").addEventListener("click", () => {
  State.isRegisterMode = !State.isRegisterMode;
  updateAuthMode();
  history.replaceState({}, "", State.isRegisterMode ? "/register" : "/login");
});

$("auth-submit").addEventListener("click", async () => {
  const email = $("auth-email").value.trim().toLowerCase();
  const password = $("auth-password").value;
  const bannerEl = $("auth-banner");
  banner(bannerEl, "info", "");
  if (!email || !password) {
    banner(bannerEl, "error", "Enter an email and password.");
    return;
  }
  const btn = $("auth-submit");
  btn.disabled = true;
  btn.textContent = "Loading…";
  try {
    if (State.isRegisterMode) {
      const name = $("auth-name").value.trim();
      if (!name) throw new Error("Enter your name.");
      await Api.post("/auth/register/request-otp", { name, email, password });
      showVerify(email);
      return;
    }
    const data = await Api.post("/auth/login", { email, password });
    if (data.accessToken) Api.setTokens(data.accessToken, data.refreshToken);
    AuthState.authenticated(data.user);
    if (location.hostname === "localhost" || location.hostname === "127.0.0.1") console.info("[AUTH] login complete; redirecting to homepage");
    navigate("/homepage", true);
  } catch (e) {
    if (e.body?.code === "EMAIL_NOT_VERIFIED") { showVerify(email); return; }
    banner(bannerEl, "error", e.message || "Something went wrong.");
  } finally {
    btn.disabled = false;
    btn.textContent = State.isRegisterMode ? "Sign up" : "Log in";
  }
});

$("verify-submit").addEventListener("click", async () => {
  const bannerEl = $("verify-banner"); banner(bannerEl, "info", "");
  try {
    const data = await Api.post("/auth/register/verify-otp", { email: verifyEmail, otp: $("verify-otp").value.trim() });
    if (data.accessToken) Api.setTokens(data.accessToken, data.refreshToken);
    sessionStorage.removeItem("pendingVerifyEmail"); AuthState.authenticated(data.user); navigate("/homepage", true);
  } catch (e) { banner(bannerEl, "error", e.message || "Could not verify your email."); }
});
$("verify-resend").addEventListener("click", async () => {
  try { await Api.post("/auth/register/resend-otp", { email: verifyEmail }); startResendCountdown(60); banner($("verify-banner"), "success", "If verification is pending, a new code has been sent."); }
  catch (e) { if (e.status === 429) { startResendCountdown((e.body?.retryAfter || 2)); } banner($("verify-banner"), "error", e.message); }
});
$("forgot-link").addEventListener("click", () => navigate("/forgot-password"));
$("forgot-back").addEventListener("click", () => navigate("/login"));
$("forgot-submit").addEventListener("click", async () => {
  try { const email = $("forgot-email").value.trim().toLowerCase(); await Api.post("/auth/password/request-otp", { email }); sessionStorage.setItem("resetEmail", email); navigate("/reset-password"); }
  catch (e) { banner($("forgot-banner"), "error", e.message); }
});
$("reset-submit").addEventListener("click", async () => {
  try { await Api.post("/auth/password/reset", { email: sessionStorage.getItem("resetEmail"), otp: $("reset-otp").value.trim(), password: $("reset-password").value }); sessionStorage.removeItem("resetEmail"); navigate("/login", true); banner($("auth-banner"), "success", "Password reset. Please sign in."); }
  catch (e) { banner($("reset-banner"), "error", e.message); }
});

/* ---------------- Onboarding screen ---------------- */
async function loadEquipmentChips() {
  const equipment = await Api.get("/equipment");
  State.equipmentList = equipment;
  const container = $("equipment-chips");
  container.innerHTML = "";
  equipment.forEach((eq) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.dataset.equipmentName = eq.name;
    chip.textContent = `${EQUIPMENT_ICONS[eq.name] || "🔧"} ${eq.name}`;
    chip.addEventListener("click", () => {
      if (State.selectedEquipment.has(eq.name)) {
        State.selectedEquipment.delete(eq.name);
        chip.classList.remove("active");
      } else {
        State.selectedEquipment.add(eq.name);
        chip.classList.add("active");
      }
    });
    container.appendChild(chip);
  });
}

function activateEquipmentChips(names) {
  names.forEach((name) => State.selectedEquipment.add(name));
  document.querySelectorAll("#equipment-chips .chip").forEach((chip) => {
    if (names.includes(chip.dataset.equipmentName)) chip.classList.add("active");
  });
}

$("onboarding-scan-btn").addEventListener("click", () => {
  startEquipmentScan("onboarding-scan-area", (detectedNames) => {
    activateEquipmentChips(detectedNames);
    $("onboarding-scan-area").innerHTML = `<div class="banner banner-success">Added ${detectedNames.join(", ")} to your selection below.</div>`;
  });
});

$("onboarding-submit").addEventListener("click", async () => {
  const bannerEl = $("onboarding-banner");
  banner(bannerEl, "info", "");
  const payload = {
    name: $("ob-name").value.trim(),
    age: Number($("ob-age").value),
    gender: $("ob-gender").value,
    heightCm: Number($("ob-height").value),
    weightKg: Number($("ob-weight").value),
    fitnessLevel: $("ob-level").value,
    primaryGoal: $("ob-goal").value,
    daysPerWeek: Number($("ob-days").value),
    sessionMinutes: Number($("ob-duration").value),
    dietaryPref: $("ob-diet").value,
    allergies: $("ob-allergies").value.split(",").map((s) => s.trim()).filter(Boolean),
    foodLikes: [],
    dailyBudget: Number($("ob-budget").value || 0),
  };
  if (!payload.name || !payload.age || !payload.heightCm || !payload.weightKg || !payload.daysPerWeek || !payload.sessionMinutes) {
    banner(bannerEl, "error", "Please fill in all fields.");
    return;
  }
  try {
    await Api.put("/user/profile", payload);
    await Api.post("/equipment/user/equipment", { equipmentNames: Array.from(State.selectedEquipment) });
    enterMainApp();
  } catch (e) {
    banner(bannerEl, "error", e.message || "Could not save profile.");
  }
});

/* ---------------- Main app / tab nav ---------------- */
function enterMainApp() {
  if (AuthState.status !== "AUTHENTICATED") return;
  $("screen-auth").classList.remove("active");
  $("screen-onboarding").classList.remove("active");
  $("main-app").style.display = "flex";
  $("bottom-nav").style.display = "flex";
  navigate("/homepage", true);
}

document.querySelectorAll(".nav-item").forEach((btn) => {
  btn.addEventListener("click", () => switchTab(btn.dataset.tab));
});
document.addEventListener("click", async (event) => {
  const target = event.target.closest("[data-logout]");
  if (!target) return;
  try { await Api.post("/auth/logout", {}); } catch { /* local sign-out still completes */ }
  AuthState.status = "UNAUTHENTICATED"; AuthState.user = null; Api.clearTokens(); clearProtectedContent(); navigate("/login", true);
});

function switchTab(tab, updateUrl = true) {
  if (AuthState.status !== "AUTHENTICATED") { navigate("/login", true); return; }
  const pathForTab = { today: "/homepage", workout: "/workout", diet: "/nutrition", "gym-scan": "/equipment", gym: "/today", vision: "/today" };
  if (updateUrl && pathForTab[tab] && location.pathname !== pathForTab[tab]) history.pushState({}, "", pathForTab[tab]);
  if (tab === "history") { void showHistory(); return; }
  document.querySelectorAll("#main-app .screen").forEach((s) => s.classList.remove("active"));
  $("screen-" + tab).classList.add("active");
  document.querySelectorAll(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));

  if (tab === "today") loadToday();
  if (tab === "workout") loadWorkout();
  if (tab === "diet") loadDiet();
  if (tab === "gym-scan") loadGymScan();
  if (tab === "gym") loadGym();
}

async function showHistory() {
  document.querySelectorAll(".screen").forEach((screen) => screen.classList.remove("active"));
  const screen = $("screen-history"); if (!screen) { navigate("/homepage", true); return; }
  screen.classList.add("active"); screen.innerHTML = '<div class="header"><h1>Workout history</h1></div><div id="history-content"><div class="empty-state">Loading...</div></div>';
  try {
    const result = await Api.get("/workouts/history");
    const items = Array.isArray(result) ? result : (result.workouts || result.history || []);
    $("history-content").innerHTML = items.length ? items.map((item) => `<div class="card"><div class="card-label">${item.name || item.focus || "Workout"}</div><div class="card-sub">${new Date(item.completedAt || item.createdAt).toLocaleDateString()}</div></div>`).join("") : '<div class="empty-state">No completed workouts yet.</div>';
  } catch (error) { $("history-content").textContent = error.message; }
}

/* ================= TODAY ================= */
async function loadToday() {
  const el = $("today-content");
  el.innerHTML = `<div class="empty-state">Loading…</div>`;
  try {
    const [dashboard, profile, plan] = await Promise.all([
      Api.get("/progress/dashboard"),
      Api.get("/user/profile"),
      Api.get("/workouts/plan"),
    ]);
    $("today-greeting").textContent = `Hi, ${profile.name.split(" ")[0]}`;

    let nutrition = null;
    try { nutrition = await Api.get("/nutrition/today"); } catch (_) {}

    let gym = null;
    try { gym = await Api.get("/gym/today"); } catch (_) {}

    const activePlanLabel = plan?.activePlan?.structureLabel || plan?.activePlan || null;
    const nextWod = plan?.nextWorkout?.label || null;
    const statusInfo = activePlanLabel
      ? `${activePlanLabel} · ${plan.cycleStatus}${nextWod ? " · Next: " + nextWod : ""}`
      : "Choose a workout structure in the Workout tab";

    el.innerHTML = `
      <div class="card">
        <div class="card-label">🏋️ Today's Workout Plan</div>
        <div class="card-value">${plan?.nextWorkout?.label || (plan?.cycleStatus === "COMPLETED" ? "Cycle complete — new cycle or switch plan" : "No active plan")}</div>
        <div class="card-sub">${statusInfo}</div>
        ${plan?.recentlyTrainedMuscles?.length
          ? `<div class="card-sub">Recently trained: ${plan.recentlyTrainedMuscles.map((m) => m.muscle).join(", ")}</div>`
          : ""}
        ${plan?.planSwitchAllowed === false && plan?.activePlan
          ? `<div class="banner banner-info" style="margin-top:8px;">🔒 Plan switching locked — finish all ${plan.units?.length || 0} workouts in this cycle first.</div>`
          : ""}
        ${plan?.decision?.warning
          ? `<div class="banner banner-info" style="margin-top:8px;">⚠️ ${plan.decision.warning}</div>`
          : ""}
      </div>
      <div class="card-grid-2">
        <div class="card">
          <div class="card-label">🔥 Calories</div>
          <div class="card-value">${nutrition ? nutrition.totals.calories : "—"}</div>
          <div class="card-sub">${nutrition ? "planned today" : "no plan yet"}</div>
        </div>
        <div class="card">
          <div class="card-label">🍽️ Nearby food</div>
          <div class="card-value">${nutrition ? nutrition.meals.length : 0}</div>
          <div class="card-sub">meals to find nearby</div>
        </div>
      </div>
      <div class="card-grid-2">
        <div class="card">
          <div class="card-label">📊 Weekly Volume</div>
          <div class="card-value">${dashboard.progress.weeklyVolumeKg}kg</div>
          <div class="card-sub">${dashboard.progress.workoutsThisWeek} workouts this week</div>
        </div>
        <div class="card">
          <div class="card-label">📇 Gym</div>
          <div class="card-value">${gym && gym.checkedIn ? "✓" : "—"}</div>
          <div class="card-sub">${gym && gym.checkedIn ? "checked in today" : "not checked in"}</div>
        </div>
      </div>
    `;
  } catch (e) {
    el.innerHTML = `<div class="empty-state">Couldn't load your summary: ${e.message}</div>`;
  }
}

/* ================= WORKOUT ================= */
async function loadWorkout() {
  renderWorkoutScanButton();
  const el = $("workout-content");
  el.innerHTML = `<div class="empty-state">Loading…</div>`;
  try {
    const plan = await Api.get("/workouts/plan");
    let workout;
    try {
      workout = await Api.get("/workouts/today");
    } catch (_) { workout = null; }
    if (workout) {
      renderWorkout(workout, plan);
    } else {
      await renderGenerateWorkoutPrompt(plan);
    }
  } catch (e) {
    el.innerHTML = `<div class="empty-state">${e.message}</div>`;
  }
}

function renderWorkoutScanButton() {
  const scanArea = $("workout-scan-area");
  scanArea.innerHTML = `<button class="btn btn-outline" id="workout-scan-btn" style="margin-bottom:14px;">📷 Scan my equipment</button>`;
  $("workout-scan-btn").addEventListener("click", () => {
    scanArea.innerHTML = "";
    startEquipmentScan("workout-scan-area", async (detectedNames) => {
      scanArea.innerHTML = `<div class="empty-state"><span class="spinner"></span> Generating with scanned equipment…</div>`;
      try {
        await Api.post("/workouts/generate", { equipmentMode: "SCANNED", detectedEquipmentNames: detectedNames });
        await loadWorkout();
      } catch (e) {
        scanArea.innerHTML = `<div class="banner banner-error">${e.message}</div>`;
      }
    });
  });
}

/**
 * Render a circular progress indicator showing cycle completion status
 */
function renderCircularProgress(plan) {
  if (!plan?.units || plan.units.length === 0) return "";
  
  const total = plan.units.length;
  const completed = plan.completedUnits?.length || 0;
  const currentIndex = plan.currentIndex;
  const cycleStatus = plan.cycleStatus;
  const isComplete = cycleStatus === "COMPLETED";
  
  const progressPercent = total > 0 ? (completed / total) * 100 : 0;
  const circumference = 2 * Math.PI * 45; // 2 * PI * r (r=45)
  const dashOffset = circumference * (1 - progressPercent / 100);
  
  const currentUnit = plan.units[currentIndex];
  const currentLabel = currentUnit ? currentUnit.label : (isComplete ? "Complete" : "Ready");
  
  return `
    <div class="circular-progress-container" style="text-align: center; margin-bottom: 16px;">
      <div class="circular-progress">
        <svg viewBox="0 0 100 100">
          <circle class="circular-progress-bg" cx="50" cy="50" r="45" />
          <circle class="circular-progress-fill" 
                  cx="50" cy="50" r="45"
                  style="stroke-dashoffset: ${dashOffset};" />
          ${currentIndex < plan.units.length ? `
            <circle class="circular-progress-current"
                    cx="50" cy="50" r="45"
                    style="stroke-dashoffset: ${circumference * (1 - (currentIndex + 1) / plan.units.length * 100)};" />
          ` : ''}
        </svg>
        <div class="circular-progress-text">
          <div class="circular-progress-done">${completed}/${total}</div>
          <div class="circular-progress-label">${isComplete ? "Cycle Complete" : currentLabel}</div>
        </div>
      </div>
      <div class="circular-progress-legend">
        <span class="circular-legend-item">
          <span class="circular-legend-dot done"></span>
          <span>${completed}/${total} Done</span>
        </span>
        ${!isComplete ? `
        <span class="circular-legend-item">
          <span class="circular-legend-dot current"></span>
          <span>Current</span>
        </span>
        ` : ''}
        <span class="circular-legend-item">
          <span class="circular-legend-dot remaining"></span>
          <span>${total - completed} Left</span>
        </span>
      </div>
    </div>
  `;
}

const BRO_DEFAULT_UNITS = [
  { label: "Chest + Triceps", muscles: ["chest", "triceps"] },
  { label: "Back + Biceps", muscles: ["back", "biceps"] },
  { label: "Legs + Shoulders", muscles: ["quads", "hamstrings", "glutes", "calves", "shoulders"] },
];
const BRO_MUSCLE_OPTIONS = ["chest", "back", "biceps", "triceps", "shoulders", "quads", "hamstrings", "glutes", "calves"];

function renderPlanStructurePrompt() {
  const dayEditors = BRO_DEFAULT_UNITS.map((unit, dayIdx) => `
    <div class="card-sub" style="margin-top:10px;"><strong>Day ${dayIdx + 1}:</strong> ${unit.label}</div>
    <div class="chip-group bro-day" data-day="${dayIdx}">
      ${BRO_MUSCLE_OPTIONS.map((muscle) => `
        <button type="button" class="chip ${unit.muscles.includes(muscle) ? "active" : ""}" data-muscle="${muscle}">${muscle}</button>
      `).join("")}
    </div>
  `).join("");
  return `
    <div class="card">
      <div class="card-label">Step 1: Choose your workout structure</div>
      <div class="card-sub">FitOS will enforce this structure until you complete a full cycle. You cannot jump to another plan mid-cycle.</div>
      <div class="chip-group" id="plan-chips" style="margin-top:10px; margin-bottom:10px;">
        <button class="chip active" data-plan="PPL">
          <strong>Push-Pull-Legs</strong><br>
          <span class="card-sub" style="font-size:11px;">Push → Pull → Legs</span>
        </button>
        <button class="chip" data-plan="INDIVIDUAL">
          <strong>Individual Muscle Split</strong><br>
          <span class="card-sub" style="font-size:11px;">Chest → Back → Biceps → Triceps → Shoulders → Legs</span>
        </button>
        <button class="chip" data-plan="BRO">
          <strong>Bro / Multi-Muscle</strong><br>
          <span class="card-sub" style="font-size:11px;">Chest+Tri · Back+Bi · Legs+Shoulders</span>
        </button>
      </div>
      <div id="bro-custom" style="display:none;">
        <div class="card-sub">Configure each multi-muscle day. These become the locked cycle.</div>
        ${dayEditors}
      </div>
      <button class="btn btn-primary" id="select-plan-btn">Start this plan</button>
    </div>
  `;
}

function renderActivePlanCard(plan) {
  const nextWod = plan.nextWorkout;
  const lockBadge = plan.planSwitchAllowed
    ? `<span class="pill pill-success" style="margin-left:6px;">🔓 Switching unlocked</span>`
    : `<span class="pill pill-muted" style="margin-left:6px;">🔒 Switching locked</span>`;
  const cycleDone = plan.cycleStatus === "COMPLETED";
  const cycleLabel = cycleDone ? "Complete ✓" : `${plan.completedUnits?.length || 0} / ${plan.units?.length || 0} done`;

  let actionButtons = "";
  if (cycleDone) {
    actionButtons = `
      <div class="btn-row">
        <button class="btn btn-primary" id="start-new-cycle-btn">🔄 Start next ${plan.activePlan.structureLabel} cycle</button>
        <button class="btn btn-outline" id="switch-plan-btn">🔀 Switch to a different structure</button>
      </div>
    `;
  } else if (nextWod) {
    actionButtons = `<button class="btn btn-primary" id="generate-workout-btn">Generate ${nextWod.label} workout →</button>`;
  }

  const completedList = plan.completedUnits?.length
    ? `<div class="card-sub">Completed: ${plan.completedUnits.map((u) => u.label).join(" · ")}</div>`
    : "";
  const remainingList = plan.remainingWorkouts?.length
    ? `<div class="card-sub">Remaining workouts: ${plan.remainingWorkouts.map((u) => u.label).join(" · ")}</div>`
    : `<div class="card-sub">Remaining workouts: none</div>`;
  const nextLine = nextWod
    ? `<div class="card-value" style="margin-top:10px; margin-bottom:6px;">Next workout: ${nextWod.label}</div>
       <div class="card-sub">Target muscles: ${nextWod.muscles.join(", ")}</div>`
    : `<div class="card-value" style="margin-top:10px;">Next workout: new cycle — plan switching unlocked</div>`;

  return `
    <div class="card">
      <div class="card-label">Active Plan: ${plan.activePlan?.structureLabel || plan.activePlan}${lockBadge}</div>
      <div class="card-sub" style="margin-bottom:8px;">
        Cycle <code style="font-size:11px;">${plan.cycleId}</code> · ${cycleLabel}
      </div>
      ${renderCircularProgress(plan)}
      ${renderCycleProgress(plan)}
      ${completedList}
      ${remainingList}
      ${nextLine}
      <div class="card-sub" style="margin-top:6px;">Plan switching: ${plan.planSwitchAllowed ? "UNLOCKED" : "LOCKED"}</div>
      ${plan.recentlyTrainedMuscles?.length
        ? `<div class="card-sub" style="margin-top:8px;">Recently trained (last 48h): ${plan.recentlyTrainedMuscles.map((m) => m.muscle).join(", ")}</div>`
        : ""}
      ${plan.decision?.warning
        ? `<div class="banner banner-info" style="margin-top:10px;">⚠️ ${plan.decision.warning}</div>`
        : ""}
      <div style="margin-top:14px;">${actionButtons}</div>
    </div>
  `;
}

async function renderGenerateWorkoutPrompt(plan) {
  const labelText = plan?.activePlan
    ? `${plan.activePlan.structureLabel || plan.activePlan} · ${plan.cycleStatus}`
    : "Choose a workout structure";
  $("workout-focus-label").textContent = labelText;
  const el = $("workout-content");

  if (!plan?.activePlan) {
    el.innerHTML = renderPlanStructurePrompt();
    wirePlanSelection();
    return;
  }

  el.innerHTML = renderActivePlanCard(plan);
  wirePlanActions(plan);

  if (plan.nextWorkout && plan.cycleStatus === "IN_PROGRESS") {
    try {
      const rec = await Api.get("/workouts/exercises-for-next");
      const names = (rec.exercises || []).map((ex) => ex.name).slice(0, 8);
      const recCard = document.createElement("div");
      recCard.className = "card";
      recCard.style.marginTop = "12px";
      recCard.innerHTML = `
        <div class="card-label">Step 2: Exercises for ${rec.workoutUnit?.label || plan.nextWorkout.label}</div>
        <div class="card-sub">Workout unit is already locked. Equipment only filters these movements.</div>
        <div class="card-sub" style="margin-top:8px;">${names.length ? names.join(" · ") : "Add gym equipment to unlock more exercise options for this unit."}</div>
      `;
      el.appendChild(recCard);
    } catch (_) { /* preview is optional */ }
  }
}

function collectBroCustomUnits() {
  const days = Array.from(document.querySelectorAll(".bro-day"));
  return days.map((group, idx) => {
    const muscles = Array.from(group.querySelectorAll(".chip.active")).map((chip) => chip.dataset.muscle);
    const label = muscles.length
      ? muscles.map((m) => m.charAt(0).toUpperCase() + m.slice(1)).join(" + ")
      : BRO_DEFAULT_UNITS[idx].label;
    return { label, muscles: muscles.length ? muscles : BRO_DEFAULT_UNITS[idx].muscles };
  }).filter((unit) => unit.muscles.length > 0);
}

function wirePlanSelection() {
  let selectedPlan = "PPL";
  const broBox = $("bro-custom");
  document.querySelectorAll("#plan-chips .chip").forEach((chip) => chip.addEventListener("click", () => {
    document.querySelectorAll("#plan-chips .chip").forEach((item) => item.classList.remove("active"));
    chip.classList.add("active");
    selectedPlan = chip.dataset.plan;
    if (broBox) broBox.style.display = selectedPlan === "BRO" ? "block" : "none";
  }));
  document.querySelectorAll(".bro-day .chip").forEach((chip) => {
    chip.addEventListener("click", () => chip.classList.toggle("active"));
  });
  const btn = $("select-plan-btn");
  if (!btn) return;
  btn.addEventListener("click", async () => {
    const el = $("workout-content");
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span> Starting plan…`;
    try {
      const body = { structureKey: selectedPlan };
      if (selectedPlan === "BRO") body.customUnits = collectBroCustomUnits();
      await Api.post("/workouts/plan", body);
      await loadWorkout();
    } catch (error) {
      el.innerHTML = `<div class="banner banner-error">${error.message}</div>` + el.innerHTML;
      btn.disabled = false;
      btn.textContent = "Start this plan";
    }
  });
}

function wirePlanActions(plan) {
  const genBtn = $("generate-workout-btn");
  if (genBtn) {
    genBtn.addEventListener("click", async () => {
      genBtn.disabled = true;
      genBtn.innerHTML = `<span class="spinner"></span> Generating…`;
      const el = $("workout-content");
      try {
        await Api.post("/workouts/generate", { equipmentMode: "FULL_GYM" });
        await loadWorkout();
      } catch (e) {
        el.innerHTML = `<div class="banner banner-error">${e.message}</div>` + el.innerHTML;
        genBtn.disabled = false;
        genBtn.textContent = `Generate ${plan.nextWorkout?.label || ""} workout →`;
      }
    });
  }

  const restartBtn = $("start-new-cycle-btn");
  if (restartBtn) {
    restartBtn.addEventListener("click", async () => {
      restartBtn.disabled = true;
      restartBtn.innerHTML = `<span class="spinner"></span> Starting cycle…`;
      try {
        await Api.post("/workouts/plan/start-cycle", {});
        await loadWorkout();
      } catch (e) {
        $("workout-content").innerHTML = `<div class="banner banner-error">${e.message}</div>` + $("workout-content").innerHTML;
        restartBtn.disabled = false;
        restartBtn.textContent = `🔄 Start next ${plan.activePlan.structureLabel} cycle`;
      }
    });
  }

  const switchBtn = $("switch-plan-btn");
  if (switchBtn) {
    switchBtn.addEventListener("click", () => {
      if (!plan.planSwitchAllowed) {
        $("workout-content").innerHTML = `<div class="banner banner-error">Plan switching is locked until this cycle is complete.</div>` + $("workout-content").innerHTML;
        return;
      }
      $("workout-content").innerHTML = renderPlanStructurePrompt() + $("workout-content").innerHTML;
      wirePlanSelection();
    });
  }
}

function renderWorkout(workout, plan) {
  $("workout-focus-label").textContent = `${workout.focus} · ${workout.durationMin} min · ${workout.status}`;
  const el = $("workout-content");

  const contextCard = plan
    ? `<div class="card" style="margin-bottom:12px;">
         <div class="card-label">Plan Context</div>
         <div class="card-sub">Active: ${plan.activePlan?.structureLabel || plan.activePlan} · Cycle: ${plan.cycleId}</div>
         <div class="card-sub">This workout corresponds to: <strong>${plan.nextWorkout?.label || workout.focus}</strong> in your plan order.</div>
         ${plan.planSwitchAllowed ? "" : `<div class="card-sub" style="margin-top:6px;">🔒 Plan switching remains locked until cycle completion.</div>`}
       </div>`
    : "";

  el.innerHTML = `
    ${contextCard}
    <div class="card" id="exercise-list"></div>
    <div class="card-sub" style="margin-top:8px; margin-bottom:8px;">
      💡 Decision flow: Active plan → Next workout → Target muscles → Available equipment → Recommended exercises
    </div>
    ${workout.status !== "completed" ? `<button class="btn btn-primary" id="complete-workout-btn">Mark workout complete</button>` : ""}
  `;
  const listEl = $("exercise-list");
  workout.exercises.forEach((ex) => {
    const row = document.createElement("div");
    row.className = "exercise-row";
    const isBodyweight = !ex.requiresEquipment;
    row.innerHTML = `
      <div>
        <div class="exercise-name">${ex.name}</div>
        <div class="exercise-meta">${ex.primaryMuscle} · ${ex.targetSets} sets × ${ex.repRangeLow}-${ex.repRangeHigh} reps</div>
        <div class="exercise-meta">${ex.status}${ex.painReported ? " · ⚠️ pain reported" : ""}${isBodyweight ? " · 🏋️ Bodyweight" : ""}</div>
      </div>
      <div class="btn-row" style="width:auto;">
        ${!isBodyweight ? `<button class="btn btn-outline" style="width:auto; padding:8px 12px;" data-action="swap" data-id="${ex.workoutExerciseId}">No equipment?</button>` : ''}
      </div>
    `;
    listEl.appendChild(row);
  });

  listEl.querySelectorAll('[data-action="swap"]').forEach((btn) => {
    btn.addEventListener("click", async () => {
      const ex = workout.exercises.find((e) => e.workoutExerciseId === btn.dataset.id);
      if (ex && !ex.requiresEquipment) {
        el.innerHTML = `<div class="banner banner-error">This exercise is bodyweight and does not require equipment.</div>` + el.innerHTML;
        return;
      }
      btn.disabled = true;
      btn.textContent = "Swapping…";
      try {
        const result = await Api.post(`/workouts/${workout.id}/replace-exercise`, {
          workoutExerciseId: btn.dataset.id,
          reason: "no_equipment",
        });
        el.innerHTML = `<div class="banner banner-success">${result.explanation}</div>` + el.innerHTML;
        await loadWorkout();
      } catch (e) {
        el.innerHTML = `<div class="banner banner-error">${e.message}</div>` + el.innerHTML;
      } finally {
        btn.disabled = false;
        btn.textContent = "No equipment?";
      }
    });
  });

  const completeBtn = $("complete-workout-btn");
  if (completeBtn) {
    completeBtn.addEventListener("click", async () => {
      completeBtn.disabled = true;
      completeBtn.innerHTML = `<span class="spinner"></span> Saving…`;
      try {
        const result = await Api.post(`/workouts/${workout.id}/complete`, {});
        if (result?.cycle) {
          if (result.cycle.cycleCompleted) {
            el.innerHTML = `<div class="banner banner-success">🎉 Cycle complete! You can now start another cycle or switch to a different workout structure.</div>` + el.innerHTML;
          } else if (result.cycle.nextUnit) {
            el.innerHTML = `<div class="banner banner-success">✅ Saved. Next up in your plan: ${result.cycle.nextUnit.label}.</div>` + el.innerHTML;
          }
        }
        await loadWorkout();
      } catch (e) {
        el.innerHTML = `<div class="banner banner-error">${e.message}</div>` + el.innerHTML;
        completeBtn.disabled = false;
        completeBtn.textContent = "Mark workout complete";
      }
    });
  }
}

/* ================= DIET ================= */
async function loadDiet() {
  const el = $("diet-content");
  el.innerHTML = `<div class="food-finder-empty"><div class="food-orbit">🥗</div><h2>Hungry for something healthy?</h2><p>We'll search nearby restaurants and find the healthiest dishes available right now.</p><button class="btn btn-primary" id="find-healthy-btn">✨ Find Healthy Food Near Me</button></div>`;
  $("find-healthy-btn").addEventListener("click", findHealthyFood);
}

async function findHealthyFood() {
  const el = $("diet-content");
  el.innerHTML = healthyFinderLoaderMarkup();
  const stop = startHealthyFinderLoader();
  try {
    const position = await new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, () => reject(new Error("Allow location access to find healthy food nearby."))));
    const data = await Api.post("/food/healthy-nearby", { latitude: position.coords.latitude, longitude: position.coords.longitude });
    stop(true); renderHealthyFood(data);
  } catch (error) {
    stop(false);
    const details = error.body && error.body.stage
      ? `${error.body.error} (${error.body.stage}: ${error.body.restaurantsFound} restaurants, ${error.body.rawMenuRecordsFound} raw menu records, ${error.body.normalizedDishesFound} dishes)`
      : error.message;
    el.innerHTML = `<div class="meal-plan-error"><strong>😅 We couldn't find exact dishes right now.</strong><span>${details}</span><button class="btn btn-primary" id="try-healthy-again">Try Again</button></div>`;
    $("try-healthy-again").addEventListener("click", findHealthyFood);
  }
}

function healthyFinderLoaderMarkup() { return `<div class="meal-plan-loader" aria-live="polite"><div class="floating-food">🍎 🥗 🍗 🥦 🍕 🍌</div><div class="loader-orbit">🥗</div><div class="loader-progress-label">Finding healthy food... <strong id="healthy-progress">10%</strong></div><div class="loader-progress"><span id="healthy-progress-bar"></span></div><div class="loader-stage"><strong id="healthy-stage-title">📍 Finding restaurants near you</strong><span id="healthy-stage-copy">Looking for delicious options nearby...</span></div><div class="meal-fact"><strong id="healthy-fact-title">💡 Did you know?</strong><span id="healthy-fact-copy">High-protein meals can help you stay full longer.</span></div><div class="meal-skeletons"><div class="meal-skeleton"><i>HEALTHY DISH</i><b></b><b></b><small>Calories · Protein</small></div><div class="meal-skeleton"><i>HEALTHY DISH</i><b></b><b></b><small>Calories · Protein</small></div></div></div>`; }
function startHealthyFinderLoader() {
  const stages = [["📍 Finding restaurants near you", "Looking for delicious options nearby...", 22], ["🍽️ Discovering available dishes", "Exploring menus and cuisines...", 42], ["📖 Reading menus", "Collecting real dishes from nearby restaurants...", 58], ["🧠 AI is analyzing nutrition", "Ranking real dishes only...", 74], ["🥗 Finding the healthiest options", "Comparing nutrition and ingredients...", 84], ["✨ Ranking your best choices", "Almost ready...", 90]];
  const facts = [["💡 Did you know?", "High-protein meals can help you stay full longer."], ["💧 Hydration tip", "Water supports performance and recovery."], ["🥦 Nutrition fact", "Vegetable-rich meals add fibre and micronutrients."]]; let step = 0; let fact = 0;
  const timer = setInterval(() => { const s = stages[Math.min(step++, stages.length - 1)]; if ($("healthy-stage-title")) { $("healthy-stage-title").textContent = s[0]; $("healthy-stage-copy").textContent = s[1]; $("healthy-progress").textContent = `${s[2]}%`; $("healthy-progress-bar").style.width = `${s[2]}%`; } }, 1500);
  const factTimer = setInterval(() => { fact = (fact + 1) % facts.length; if ($("healthy-fact-title")) { $("healthy-fact-title").textContent = facts[fact][0]; $("healthy-fact-copy").textContent = facts[fact][1]; } }, 3500);
  return (success) => { clearInterval(timer); clearInterval(factTimer); if (success && $("healthy-progress")) { $("healthy-progress").textContent = "100%"; $("healthy-progress-bar").style.width = "100%"; } };
}
function renderHealthyFood(data) {
  const el = $("diet-content");
  el.innerHTML = `<div class="food-results-head"><div><h2>🥗 Healthy options near you</h2><p>✓ Found ${data.restaurantsFound} restaurants · ✓ Found ${data.dishesFound} available dishes</p></div></div><div class="food-filters"><button class="pill filter active" data-filter="all">All</button><button class="pill filter" data-filter="low">🔥 Low Calorie</button><button class="pill filter" data-filter="protein">💪 High Protein</button><button class="pill filter" data-filter="veg">🥗 Vegetarian</button><button class="pill filter" data-filter="budget">💰 Budget</button></div><div id="healthy-dishes"></div><button class="btn btn-outline" id="show-more-dishes">✨ Show More Healthy Options</button><div class="banner banner-info" style="margin-top:14px;">Approximate estimates, not medical advice.</div>`;
  const cards = data.recommendations; let visible = 5; const render = () => { const filter = document.querySelector(".filter.active")?.dataset.filter || "all"; const filtered = cards.filter((d) => filter === "all" || filter === "low" && (d.calories || 999) <= 500 || filter === "protein" && (d.proteinG || 0) >= 20 || filter === "budget" && (d.priceInr || 9999) <= 300 || filter === "veg" && !/chicken|mutton|fish|prawn|meat/i.test(d.dishName || d.name)); $("healthy-dishes").innerHTML = filtered.slice(0, visible).map((d, i) => `<article class="healthy-dish-card" tabindex="0"><div class="dish-rank">${i < 3 ? ["🥇","🥈","🥉"][i] : `#${i + 1}`} Best Choice</div><h3>${d.name}</h3><strong>${d.restaurantName}</strong><div class="dish-score">⭐ Health Score: ${d.healthScore}/100</div><div class="dish-nutrition">🔥 ~${d.calories || "?"} kcal · 💪 ~${d.proteinG || "?"}g Protein · 💰 ₹${d.priceInr || "?"}</div><div class="dish-reasons">${d.reasons.map((reason) => `<span>✓ ${reason}</span>`).join("")}</div><p>${d.nutritionConfidence === "estimated" ? "Nutrition confidence: Estimated" : "Nutrition confidence: Verified"}</p><button class="btn btn-outline">📍 Find Restaurant</button></article>`).join(""); }; render(); document.querySelectorAll(".filter").forEach((button) => button.addEventListener("click", () => { document.querySelectorAll(".filter").forEach((b) => b.classList.remove("active")); button.classList.add("active"); render(); })); $("show-more-dishes").addEventListener("click", () => { visible += 5; render(); }); }

const MEAL_FACTS = [
  ["🥦 Fun fact", "Protein helps repair and build muscle after workouts."],
  ["🍌 Did you know?", "Bananas are a great source of quick energy before a workout."],
  ["💧 Hydration tip", "Drinking enough water can improve workout performance."],
  ["🍚 Nutrition fact", "Carbohydrates are your body's preferred energy source for intense exercise."],
  ["🥚 Protein fact", "Eggs contain all nine essential amino acids."],
  ["🥜 Smart snack", "Combining protein and carbohydrates can help with post-workout recovery."],
];

function mealPlanLoaderMarkup() {
  return `<div class="meal-plan-loader" aria-live="polite">
    <div class="floating-food" aria-hidden="true">🍎 🥗 🍗 🥦 🍕 🍌</div>
    <div class="loader-orbit">🍽️</div>
    <div class="loader-progress-label">Generating your meal plan... <strong id="meal-progress">10%</strong></div>
    <div class="loader-progress"><span id="meal-progress-bar"></span></div>
    <div class="loader-stage"><strong id="meal-stage-title">🔍 Finding restaurants near you</strong><span id="meal-stage-copy">Looking for delicious options nearby...</span></div>
    <div class="meal-fact"><strong id="meal-fact-title">🥦 Fun fact</strong><span id="meal-fact-copy">Protein helps repair and build muscle after workouts.</span></div>
    <div class="meal-skeletons"><div class="meal-skeleton"><i>BREAKFAST</i><b></b><b></b><small>Calories · Protein</small></div><div class="meal-skeleton"><i>LUNCH</i><b></b><b></b><small>Calories · Protein</small></div><div class="meal-skeleton"><i>DINNER</i><b></b><b></b><small>Calories · Protein</small></div></div>
  </div>`;
}

function startMealPlanLoader() {
  const stages = [
    ["🔍 Finding restaurants near you", "Looking for delicious options nearby...", 25],
    ["🍽️ Checking available food options", "Exploring menus and cuisines...", 45],
    ["🧠 Building your personalized meal plan", "Matching meals with your fitness goals...", 65],
    ["📊 Estimating nutrition", "Calculating calories and protein...", 80],
    ["✨ Almost ready", "Putting together today's perfect meals...", 90],
  ];
  let stage = 0;
  let fact = 0;
  const update = () => {
    const current = stages[stage];
    const title = $("meal-stage-title");
    const copy = $("meal-stage-copy");
    if (!title || !copy) return;
    title.textContent = current[0]; copy.textContent = current[1];
    $("meal-progress").textContent = `${current[2]}%`;
    $("meal-progress-bar").style.width = `${current[2]}%`;
    stage = Math.min(stage + 1, stages.length - 1);
  };
  const stageTimer = setInterval(update, 1800);
  const factTimer = setInterval(() => {
    fact = (fact + 1) % MEAL_FACTS.length;
    $("meal-fact-title").textContent = MEAL_FACTS[fact][0];
    $("meal-fact-copy").textContent = MEAL_FACTS[fact][1];
  }, 3500);
  update();
  return (success) => {
    clearInterval(stageTimer); clearInterval(factTimer);
    if (success && $("meal-progress")) { $("meal-progress").textContent = "100%"; $("meal-progress-bar").style.width = "100%"; }
  };
}

function findNearby(foodId, foodName) {
  const resultsEl = $("nearby-results");
  resultsEl.innerHTML = `<div class="empty-state">Getting your location…</div>`;
  if (!navigator.geolocation) {
    resultsEl.innerHTML = `<div class="banner banner-error">Geolocation isn't available in this browser.</div>`;
    return;
  }
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      try {
        const { latitude, longitude } = pos.coords;
        const data = await Api.get(`/food/nearby?lat=${latitude}&lng=${longitude}&foodId=${foodId}`);
        renderNearby(data, foodName);
      } catch (e) {
        resultsEl.innerHTML = `<div class="banner banner-error">${e.message}</div>`;
      }
    },
    () => {
      resultsEl.innerHTML = `<div class="banner banner-error">Location permission denied — can't search nearby places.</div>`;
    }
  );
}

function renderNearby(data, foodName) {
  const el = $("nearby-results");
  if (!data.configured) {
    el.innerHTML = `
      <div class="card">
        <div class="card-label">Nearby for "${foodName}"</div>
        <div class="empty-state">${data.message}</div>
      </div>
    `;
    return;
  }
  if (data.places.length === 0) {
    el.innerHTML = `<div class="card"><div class="empty-state">No matches found nearby.</div></div>`;
    return;
  }
  const rows = data.places
    .map(
      (r) => `
      <div class="restaurant-row">
        <div class="restaurant-name">${r.place.name}</div>
        <div class="restaurant-meta">${r.place.distanceKm.toFixed(1)} km · ⭐ ${r.place.rating} · ${r.place.isOpenNow ? "Open" : "Closed"}</div>
      </div>`
    )
    .join("");
  el.innerHTML = `<div class="card"><div class="card-label">Nearby for "${foodName}"</div>${rows}</div>`;
}

/* ================= GYM ================= */
async function loadGym() {
  const el = $("gym-content");
  el.innerHTML = `<div class="empty-state">Loading…</div>`;
  try {
    const [status, history] = await Promise.all([Api.get("/gym/today"), Api.get("/gym/history")]);
    renderGym(status, history);
  } catch (e) {
    el.innerHTML = `<div class="empty-state">${e.message}</div>`;
  }
}

function renderGym(status, history) {
  const el = $("gym-content");
  const checkedIn = status.checkedIn;
  el.innerHTML = `
    <div class="card">
      <div class="card-label">📇 Attendance</div>
      ${
        checkedIn
          ? `<div class="banner banner-success">Checked in today at ${new Date(status.attendance.checkedInAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} (${status.attendance.method})</div>`
          : `<div class="card-sub">Not checked in yet today.</div>`
      }
    </div>
    <div class="btn-row" style="margin-bottom:14px;">
      <button class="btn btn-mint" id="scan-btn" ${checkedIn ? "disabled" : ""}>Scan QR</button>
      <button class="btn btn-outline" id="manual-btn" ${checkedIn ? "disabled" : ""}>Mark manually</button>
    </div>
    <div id="scan-area"></div>
    <div class="card">
      <div class="card-label">History (last 30)</div>
      ${
        history.length === 0
          ? `<div class="empty-state">No attendance yet.</div>`
          : history.map((h) => `<div class="exercise-row"><div class="exercise-name">${h.date}</div><span class="pill pill-muted">${h.method}</span></div>`).join("")
      }
    </div>
  `;

  $("manual-btn").addEventListener("click", async () => {
    try {
      await Api.post("/gym/checkin", { method: "manual" });
      await loadGym();
    } catch (e) {
      el.innerHTML = `<div class="banner banner-error">${e.message}</div>` + el.innerHTML;
    }
  });

  $("scan-btn").addEventListener("click", () => startQrScan());
}

async function startQrScan() {
  const area = $("scan-area");
  area.innerHTML = `
    <div class="camera-panel" style="aspect-ratio: 1/1; margin-bottom: 14px;">
      <video id="qr-video" autoplay playsinline muted></video>
      <canvas id="qr-canvas" style="display:none;"></canvas>
      <div class="camera-feedback" id="qr-feedback" style="display:block;">Point camera at the gym's check-in QR code</div>
    </div>
    <button class="btn btn-outline" id="qr-cancel">Cancel</button>
  `;
  const video = $("qr-video");
  const canvas = $("qr-canvas");
  const ctx = canvas.getContext("2d");
  let stream;
  let stop = false;

  $("qr-cancel").addEventListener("click", () => {
    stop = true;
    if (stream) stream.getTracks().forEach((t) => t.stop());
    area.innerHTML = "";
  });

  if (typeof jsQR === "undefined") {
    $("qr-feedback").textContent = "QR scanning library failed to load — use manual check-in instead.";
    return;
  }

  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
    video.srcObject = stream;
  } catch (e) {
    $("qr-feedback").textContent = "Camera permission denied. Use manual check-in instead.";
    return;
  }

  function tick() {
    if (stop) return;
    if (video.readyState === video.HAVE_ENOUGH_DATA) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code = jsQR(imageData.data, imageData.width, imageData.height);
      if (code) {
        stop = true;
        stream.getTracks().forEach((t) => t.stop());
        confirmQrCheckin();
        return;
      }
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

async function confirmQrCheckin() {
  const area = $("scan-area");
  area.innerHTML = `<div class="empty-state">QR detected — checking in…</div>`;
  try {
    await Api.post("/gym/checkin", { method: "qr" });
  } catch (e) {
    area.innerHTML = `<div class="banner banner-error">${e.message}</div>`;
    return;
  }
  await loadGym();
}

/* ================= GYM SCAN ================= */
async function loadGymScan() {
  const el = $("gym-scan-content");
  el.innerHTML = `<div class="empty-state">Loading…</div>`;
  try {
    const [equipment, plan] = await Promise.all([
      Api.get("/equipment"),
      Api.get("/workouts/plan"),
    ]);
    renderGymScan(equipment, plan);
  } catch (e) {
    el.innerHTML = `<div class="empty-state">${e.message}</div>`;
  }
}

function renderGymScan(equipment, plan) {
  const el = $("gym-scan-content");
  const hasActivePlan = plan?.activePlan;
  const nextWorkout = plan?.nextWorkout?.label || null;
  
  const equipmentHtml = equipment
    .filter(eq => eq.name !== "No Equipment")
    .map(eq => `
      <label class="chip" style="flex:1; justify-content:center; margin:4px;">
        <input type="checkbox" name="gym-equipment" value="${eq.name}" style="display:none;">
        <span style="pointer-events:none;">${eq.name}</span>
      </label>
    `).join("");

  el.innerHTML = `
    <div class="card">
      <div class="card-label">📷 Scan Your Gym</div>
      <p class="card-sub" style="margin-bottom:16px;">Point your camera at the gym equipment to auto-detect what's available.</p>
      <div class="camera-panel" style="aspect-ratio: 4/3; margin-bottom: 16px; border-radius: 12px; overflow: hidden;">
        <video id="gym-scan-video" autoplay playsinline muted style="width:100%; height:100%; object-fit:cover;"></video>
        <div class="camera-feedback" id="gym-scan-feedback" style="display:block; position:absolute; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.5); color:white; display:flex; align-items:center; justify-content:center; font-size:14px; padding:20px;">
          Tap "Start Scan" to begin
        </div>
      </div>
      <div class="btn-row" style="margin-bottom:16px;">
        <button class="btn btn-primary" id="gym-scan-start">📷 Start Scan</button>
        <button class="btn btn-outline" id="gym-scan-cancel" style="display:none;">Cancel</button>
      </div>
      <div id="gym-scan-results" style="display:none; margin-top:16px;"></div>
    </div>

    <div class="card" style="margin-top:16px;">
      <div class="card-label">✏️ Or Select Equipment Manually</div>
      <p class="card-sub" style="margin-bottom:12px;">Toggle equipment you have access to, then generate a workout.</p>
      <div class="chip-group" style="flex-wrap:wrap; gap:8px;">${equipmentHtml}</div>
      <div class="btn-row" style="margin-top:16px;">
        <button class="btn btn-primary" id="gym-scan-generate" ${!hasActivePlan ? "disabled" : ""}>
          ${hasActivePlan ? `Generate ${nextWorkout || "Workout"}` : "Select a plan first in Workout tab"}
        </button>
      </div>
    </div>

    ${hasActivePlan ? `
      <div class="card" style="margin-top:16px; background:#fff8e1; border-color:#ffe0b2;">
        <div class="card-label">📋 Active Plan: ${plan.activePlan?.structureLabel || plan.activePlan}</div>
        <div class="card-sub">Next: ${nextWorkout || "New cycle available"}</div>
        <div class="card-sub">Cycle: ${plan.cycleStatus}</div>
      </div>
    ` : ""}
  `;

  // Setup event listeners
  const video = $("gym-scan-video");
  const feedback = $("gym-scan-feedback");
  const startBtn = $("gym-scan-start");
  const cancelBtn = $("gym-scan-cancel");
  const resultsDiv = $("gym-scan-results");
  const generateBtn = $("gym-scan-generate");
  let stream = null;
  let detecting = false;

  startBtn.addEventListener("click", async () => {
    if (detecting) return;
    
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      video.srcObject = stream;
      video.style.display = "block";
      feedback.textContent = "Scanning... point camera at equipment";
      feedback.style.display = "flex";
      startBtn.style.display = "none";
      cancelBtn.style.display = "inline-flex";
      detecting = true;
      resultsDiv.style.display = "none";
      resultsDiv.innerHTML = "";

      // Start detection loop
      detectLoop();
    } catch (e) {
      feedback.textContent = "Camera permission denied";
      feedback.style.display = "flex";
    }
  });

  cancelBtn.addEventListener("click", () => {
    detecting = false;
    if (stream) stream.getTracks().forEach(t => t.stop());
    video.style.display = "none";
    feedback.style.display = "none";
    startBtn.style.display = "inline-flex";
    cancelBtn.style.display = "none";
  });

  async function detectLoop() {
    if (!detecting) return;
    
    if (video.readyState === video.HAVE_ENOUGH_DATA) {
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext("2d").drawImage(video, 0, 0);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.8);
      const base64 = dataUrl.split(",")[1];
      
      try {
        const result = await Api.post("/equipment/detect", { imageBase64: base64 });
        if (result.configured && result.detections.length > 0) {
          renderDetectionResults(result.detections, result.suggestedExercises);
        }
      } catch (e) {
        console.error("Detection error:", e);
      }
    }
    
    if (detecting) requestAnimationFrame(detectLoop);
  }

  function renderDetectionResults(detections, suggestedExercises) {
    const uniqueDetections = new Map();
    detections.forEach(d => {
      const existing = uniqueDetections.get(d.equipmentName);
      if (!existing || d.confidence > existing.confidence) {
        uniqueDetections.set(d.equipmentName, d);
      }
    });
    
    const detectionHtml = Array.from(uniqueDetections.values()).map(d => `
      <div class="exercise-row" style="padding:12px; border-radius:12px; background:#f8f9fa; margin-bottom:8px;">
        <div style="flex:1;">
          <div style="font-weight:600;">${d.equipmentName}</div>
          <div style="font-size:12px; color:#666;">${Math.round(d.confidence * 100)}% confidence</div>
        </div>
        <input type="checkbox" name="detected-equipment" value="${d.equipmentName}" checked 
          style="width:20px; height:20px; accent-color:#86e3c4;">
      </div>
    `).join("");
    
    const suggestionsHtml = (suggestedExercises || []).slice(0, 4).map(ex => `
      <div class="exercise-row" style="padding:8px 12px; border-radius:8px; background:#fff;">
        <div style="flex:1;">
          <div style="font-weight:600; font-size:13px;">${ex.name}</div>
          <div style="font-size:11px; color:#666;">${ex.primaryMuscle} · ${ex.sets}×${ex.repRangeLow}-${ex.repRangeHigh}</div>
        </div>
      </div>
    `).join("") || "<p class='card-sub' style='margin-top:8px;'>No exercises matched</p>";
    
    resultsDiv.innerHTML = `
      <div class="card">
        <div class="card-label">✅ Detected Equipment</div>
        <p class="card-sub" style="margin-bottom:8px;">Uncheck any incorrect detections, then confirm.</p>
        <div style="max-height:200px; overflow-y:auto;">${detectionHtml}</div>
        <div class="btn-row" style="margin-top:12px;">
          <button class="btn btn-primary" id="gym-scan-confirm">Confirm & Add to Gym</button>
          <button class="btn btn-outline" id="gym-scan-rescan">Rescan</button>
        </div>
      </div>
      ${suggestedExercises && suggestedExercises.length > 0 ? `
        <div class="card" style="margin-top:12px;">
          <div class="card-label">💡 Suggested Exercises</div>
          ${suggestionsHtml}
        </div>
      ` : ""}
    `;
    
    resultsDiv.style.display = "block";
    feedback.style.display = "none";
    cancelBtn.style.display = "none";
    
    // Confirm button
    const confirmBtn = $("gym-scan-confirm");
    const rescanBtn = $("gym-scan-rescan");
    
    confirmBtn.addEventListener("click", async () => {
      const checkboxes = resultsDiv.querySelectorAll('input[name="detected-equipment"]:checked');
      const confirmedNames = Array.from(checkboxes).map(cb => cb.value);
      
      if (confirmedNames.length === 0) {
        alert("Please select at least one equipment");
        return;
      }
      
      confirmBtn.disabled = true;
      confirmBtn.innerHTML = `<span class="spinner"></span> Saving...`;
      
      try {
        await Api.post("/equipment/confirm", { 
          detections: confirmedNames.map(name => ({ equipmentName: name, confidence: 1 })),
          sessionId: `gym-scan-${Date.now()}`
        });
        
        // Update manual equipment checkboxes
        confirmedNames.forEach(name => {
          const cb = el.querySelector(`input[name="gym-equipment"][value="${name}"]`);
          if (cb) cb.checked = true;
        });
        
        resultsDiv.innerHTML = `<div class="banner banner-success">✅ Added ${confirmedNames.join(", ")} to your gym!</div>`;
        setTimeout(() => { resultsDiv.style.display = "none"; }, 3000);
      } catch (e) {
        resultsDiv.innerHTML = `<div class="banner banner-error">${e.message}</div>`;
      } finally {
        confirmBtn.disabled = false;
        confirmBtn.textContent = "Confirm & Add to Gym";
        detecting = false;
        if (stream) stream.getTracks().forEach(t => t.stop());
        video.style.display = "none";
        startBtn.style.display = "inline-flex";
      }
    });
    
    rescanBtn.addEventListener("click", () => {
      resultsDiv.style.display = "none";
      detecting = true;
      feedback.style.display = "flex";
      feedback.textContent = "Scanning... point camera at equipment";
      detectLoop();
    });
  }

  // Manual equipment generation
  generateBtn.addEventListener("click", async () => {
    if (!hasActivePlan) return;
    
    const checkboxes = el.querySelectorAll('input[name="gym-equipment"]:checked');
    const equipmentNames = Array.from(checkboxes).map(cb => cb.value);
    
    if (equipmentNames.length === 0) {
      alert("Please select at least one equipment");
      return;
    }
    
    generateBtn.disabled = true;
    generateBtn.innerHTML = `<span class="spinner"></span> Generating...`;
    
    try {
      await Api.post("/equipment/user/equipment", { equipmentNames });
      // Switch to workout tab and generate
      await Api.post("/workouts/generate", { equipmentMode: "SCANNED", detectedEquipmentNames: equipmentNames });
      switchTab("workout");
    } catch (e) {
      el.innerHTML = `<div class="banner banner-error">${e.message}</div>` + el.innerHTML;
    } finally {
      generateBtn.disabled = false;
      generateBtn.textContent = `Generate ${nextWorkout || "Workout"}`;
    }
  });
}

/* ---------------- Kickoff ---------------- */
void boot();
