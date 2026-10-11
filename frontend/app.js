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

  const suggestionsHtml = "";

  area.innerHTML = `
    <div class="card">
      <div class="card-label">Detected equipment</div>
      <div style="margin-bottom:8px;">${detectionsHtml}</div>
      <button class="btn btn-mint" id="eq-scan-use-btn">Use this equipment</button>
    </div>
    ${
      suggestionsHtml.length
        ? `<div class="card"><div class="card-label">Suggested exercises with this equipment</div>${suggestionsHtml}</div>`
        : ""
    }
  `;

  $("eq-scan-use-btn").addEventListener("click", () => onResult(uniqueNames));
}

/* ---------------- Global state ---------------- */
const State = {
  equipmentList: [],
  equipmentLoaded: false,
  selectedEquipment: new Set(),
  isRegisterMode: false,
};

const AuthState = {
  status: "AUTH_LOADING",
  user: null,
  profileComplete: null,
  generation: 0,
  authenticated(user) {
    this.status = "AUTHENTICATED";
    this.user = user;
    this.profileComplete = user?.profileComplete === true;
    this.generation += 1;
  },
  unauthenticated() {
    if (this.status === "UNAUTHENTICATED") return;
    this.status = "UNAUTHENTICATED"; this.user = null; this.profileComplete = null; this.generation += 1;
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
  $("main-app").hidden = true; $("main-app").style.display = "none";
  $("bottom-nav").hidden = true; $("bottom-nav").style.display = "none";
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
  if (AuthState.status === "AUTH_LOADING") {
    showScreen("screen-intro");
    return;
  }
  if (path === "/" || path === "/login" || path === "/register") {
    if (AuthState.status === "AUTHENTICATED") { if (path !== "/homepage") navigate("/homepage", true); return; }
    State.isRegisterMode = path === "/register";
    updateAuthMode(); showScreen("screen-auth"); return;
  }
  if (path === "/verify-email" || path === "/forgot-password" || path === "/reset-password") { showScreen(publicRoutes[path]); return; }
  if (AuthState.status !== "AUTHENTICATED") { navigate("/login", true); return; }
  if (AuthState.profileComplete === false && path !== "/profile") {
    navigate("/profile", true);
    return;
  }
  if (!routeTabs[path]) { navigate("/homepage", true); return; }
  $("main-app").style.display = "flex"; $("bottom-nav").style.display = "flex";
  if (path === "/profile" || path === "/settings") {
    const needsProfile = AuthState.profileComplete === false;
    $("onboarding-account").textContent = needsProfile
      ? `Signed in as ${AuthState.user?.email || "your account"}. Complete your profile to continue.`
      : AuthState.user?.email ? `Signed in as ${AuthState.user.email}.` : "";
    banner($("onboarding-banner"), "info", needsProfile
      ? "Finish setup before generating workouts. Your workout plan and equipment selections will remain saved."
      : "");
    if (needsProfile && !$("ob-name").value && AuthState.user?.name) {
      $("ob-name").value = AuthState.user.name;
    }
    showScreen("screen-onboarding"); $("main-app").style.display = "none"; $("bottom-nav").style.display = "none";
    void loadEquipmentChips();
    return;
  }
  if (path === "/history") { showHistory(); return; }
  switchTab(routeTabs[path], false);
}
window.addEventListener("popstate", () => { if (AuthState.status === "AUTHENTICATED") { void routeCurrent(); } else { void boot(); } });
window.addEventListener("pageshow", (event) => { if (event.persisted) { AuthState.status = "AUTH_LOADING"; void boot(); } });

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
  const screen = $(id);
  if (!screen) return;
  screen.classList.add("active");

  // Keep public screens separate from the protected app shell.
  const isProtectedScreen = $("main-app").contains(screen);
  const mainApp = $("main-app");
  const bottomNav = $("bottom-nav");
  mainApp.hidden = !isProtectedScreen;
  mainApp.style.display = isProtectedScreen ? "flex" : "none";
  bottomNav.hidden = !isProtectedScreen;
  bottomNav.style.display = isProtectedScreen ? "flex" : "none";
  $("app").dataset.view = isProtectedScreen ? "protected" : "public";
}

/* ---------------- Boot ---------------- */
  async function boot() {
    const generation = ++authBootGeneration;
    AuthState.status = "AUTH_LOADING";
  window.FitOSIntroStart?.();
  showScreen("screen-intro");
  $("auth-submit").disabled = true;
  try {
    const data = await Api.get("/auth/me");
      await keepIntroVisible();
    if (generation !== authBootGeneration) return;
    if (!data.authenticated) {
      Api.clearTokens(); AuthState.status = "UNAUTHENTICATED"; clearProtectedContent();
      if (["/verify-email", "/forgot-password", "/reset-password"].includes(normalizePath(location.pathname))) await routeCurrent();
      else navigate("/login", true);
      return;
    }
    AuthState.authenticated(data.user);
    if (location.hostname === "localhost" || location.hostname === "127.0.0.1") console.info("[AUTH] session restored; redirecting to homepage");
    if (["/", "/login", "/register"].includes(normalizePath(location.pathname))) navigate("/homepage", true); else await routeCurrent();
  } catch (e) {
      await keepIntroVisible();
    if (generation !== authBootGeneration) return;
    if (e?.status === 401) Api.clearTokens();
    AuthState.status = "UNAUTHENTICATED"; AuthState.user = null; clearProtectedContent(); navigate("/login", true);
    const message = e?.status === 401
      ? "Your session has expired. Please sign in again."
      : "Couldn't check your session. Your sign-in is saved; retry the check or log in again.";
    const bannerEl = $("auth-banner");
    banner(bannerEl, "error", `${message} <button id="auth-retry-session" class="btn btn-outline" type="button">Retry session check</button>`);
    $("auth-retry-session").addEventListener("click", () => { void boot(); });
  } finally {
    if (generation === authBootGeneration) $("auth-submit").disabled = false;
  }
}

async function keepIntroVisible() {
  const sceneReady = window.FitOSIntroReady || Promise.resolve();
  const sceneTimeout = new Promise((resolve) => setTimeout(resolve, 3200));
  await Promise.race([sceneReady, sceneTimeout]);
  if (typeof window.FitOSIntroFinishWhenReady === "function") {
    const finishAnimation = window.FitOSIntroFinishWhenReady();
    const finishTimeout = new Promise((resolve) => setTimeout(resolve, 7400));
    await Promise.race([finishAnimation, finishTimeout]);
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
  if (State.isRegisterMode) btn.textContent = "Sending code…";
  else btn.textContent = "Signing in…";
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
  const container = $("equipment-chips");
  if (!container) return;
  container.textContent = "Loading equipment...";
  let equipment;
  let savedEquipment;
  try {
    [equipment, savedEquipment] = await Promise.all([
      Api.get("/equipment"),
      Api.get("/equipment/user/equipment"),
    ]);
    State.equipmentLoaded = true;
  } catch (error) {
    State.equipmentLoaded = false;
    container.replaceChildren();
    const message = document.createElement("p");
    message.className = "card-sub";
    message.textContent = "Could not load equipment. You can retry or continue without selecting equipment.";
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "btn btn-outline";
    retry.textContent = "Retry loading equipment";
    retry.addEventListener("click", () => { void loadEquipmentChips(); });
    container.append(message, retry);
    banner($("onboarding-banner"), "error", error.message || "Could not load equipment.");
    return;
  }
  State.equipmentList = (Array.isArray(equipment) ? equipment : []).filter((eq) => eq.name !== "No Equipment");
  State.selectedEquipment = new Set((Array.isArray(savedEquipment) ? savedEquipment : [])
    .map((eq) => eq.name)
    .filter((name) => name !== "No Equipment"));
  container.replaceChildren();
  State.equipmentList.forEach((eq) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = `chip${State.selectedEquipment.has(eq.name) ? " active" : ""}`;
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
    sessionMinutes: 60,
    dietaryPref: $("ob-diet").value,
    allergies: $("ob-allergies").value.split(",").map((s) => s.trim()).filter(Boolean),
    foodLikes: [],
    dailyBudget: Number($("ob-budget").value || 0),
  };
  if (!payload.name || !payload.age || !payload.heightCm || !payload.weightKg || !payload.daysPerWeek) {
    banner(bannerEl, "error", "Please fill in all fields.");
    return;
  }
  try {
    await Api.put("/user/profile", payload);
    if (State.equipmentLoaded) {
      await Api.post("/equipment/user/equipment", { equipmentNames: Array.from(State.selectedEquipment) });
    }
    enterMainApp();
  } catch (e) {
    banner(bannerEl, "error", e.message || "Could not save profile.");
  }
});

/* ---------------- Main app / tab nav ---------------- */
function enterMainApp() {
  if (AuthState.status !== "AUTHENTICATED") return;
  AuthState.profileComplete = true;
  if (AuthState.user) AuthState.user.profileComplete = true;
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
  AuthState.status = "UNAUTHENTICATED"; AuthState.user = null; AuthState.profileComplete = null; Api.clearTokens(); clearProtectedContent(); navigate("/login", true);
});

function switchTab(tab, updateUrl = true) {
  if (AuthState.status !== "AUTHENTICATED") { navigate("/login", true); return; }
  const pathForTab = { today: "/homepage", workout: "/workout", diet: "/nutrition", "gym-scan": "/equipment", gym: "/today", vision: "/today" };
  if (updateUrl && pathForTab[tab] && location.pathname !== pathForTab[tab]) history.pushState({}, "", pathForTab[tab]);
  if (tab === "history") { void showHistory(); return; }
  showScreen("screen-" + tab);
  document.querySelectorAll(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));

  if (tab === "today") loadToday();
  if (tab === "workout") loadWorkout();
  if (tab === "diet") loadDiet();
  if (tab === "gym-scan") loadGymScan();
  if (tab === "gym") loadGym();
}

async function showHistory() {
  const screen = $("screen-history"); if (!screen) { navigate("/homepage", true); return; }
  showScreen("screen-history");
  screen.innerHTML = '<div class="header"><h1>Workout history</h1></div><div id="history-content"><div class="empty-state">Loading...</div></div>';
  try {
    const result = await Api.get("/workouts/history");
    const items = Array.isArray(result) ? result : (result.workouts || result.history || []);
    $("history-content").innerHTML = items.length ? items.map((item) => `<div class="card"><div class="card-label">${item.name || item.focus || "Workout"}</div><div class="card-sub">${new Date(item.completedAt || item.createdAt).toLocaleDateString()}</div></div>`).join("") : '<div class="empty-state">No completed workouts yet.</div>';
  } catch (error) { $("history-content").textContent = error.message; }
}

/* ================= TODAY ================= */
let todayLoadGeneration = 0;
let todayRequest = null;

function loadToday() {
  if (todayRequest) return todayRequest;
  const generation = ++todayLoadGeneration;
  todayRequest = loadTodayData(generation).finally(() => {
    if (generation === todayLoadGeneration) todayRequest = null;
  });
  return todayRequest;
}

async function loadTodayData(generation) {
  const el = $("today-content");
  const greetingEl = $("today-greeting");
  el.dataset.loadState = "loading";
  el.innerHTML = `<div class="empty-state">Loading your day…</div>`;

  try {
    const [dashboard, profile, plan] = await Promise.all([
      Api.get("/progress/dashboard"),
      Api.get("/user/profile"),
      Api.get("/workouts/plan"),
    ]);
    if (generation !== todayLoadGeneration) return;

    greetingEl.textContent = `Hi, ${profile.name?.split(" ")[0] || "there"}`;

    const [nutritionResult, gymResult, growImpactResult] = await Promise.allSettled([
      Api.get("/nutrition/today"),
      Api.get("/gym/today"),
      Api.get("/grow-impact/"),
    ]);
    if (generation !== todayLoadGeneration) return;

    const nutritionData = nutritionResult.status === "fulfilled" ? nutritionResult.value : null;
    const gymData = gymResult.status === "fulfilled" ? gymResult.value : null;
    const growImpactData = growImpactResult.status === "fulfilled" ? growImpactResult.value : null;

    renderTodaySuccess(el, dashboard, plan, nutritionData, gymData, growImpactData);
    el.dataset.loadState = "success";
  } catch (e) {
    if (generation === todayLoadGeneration) handleTodayError(el, e);
  } finally {
    if (generation === todayLoadGeneration && el.dataset.loadState === "loading") {
      renderTodayError(el, "Unable to load today's data. Please try again.");
    }
  }
}

function renderTodaySuccess(el, dashboard, plan, nutrition, gym, growImpact) {
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
    ${growImpact ? renderGrowImpact(growImpact) : ""}
  `;
  bindGrowImpactActions(el);
}

function escapeImpactText(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function renderGrowImpact(impact) {
  const percent = Math.max(0, Math.min(100, Number(impact.progressPercent) || 0));
  const count = Number(impact.sessions) || 0;
  const target = Number(impact.target) || 26;
  const encouragement = count >= target
    ? "You reached your monthly goal. Choose a tree to mark your consistency."
    : count === 0 ? "Every completed workout is a step toward a greener future."
      : impact.remaining === 1 ? "One more session to unlock your tree choice. Keep going."
        : "Your consistency is adding up. Sundays are rest days.";
  const reward = impact.reward;
  const tree = impact.trees?.find((option) => option.id === reward?.selectedSpeciesId) || (reward?.selectedSpeciesId ? {
    id: reward.selectedSpeciesId,
    name: reward.selectedTreeName || "Your selected tree",
    species: reward.selectedSpecies || reward.selectedSpeciesId,
    image: reward.selectedTreeImage || "",
    description: "",
  } : null);
  let rewardPanel = "";

  if (!reward && count >= target) {
    rewardPanel = `<p class="grow-impact-unlocked">Your tree reward is ready. Pick one of three trees below.</p>
      <div class="grow-impact-options">${(impact.trees || []).map((option) => renderTreeOption(option, null)).join("")}</div>`;
  } else if (reward?.status === "unlocked") {
    rewardPanel = `<p class="grow-impact-unlocked">Your tree reward is ready. Pick one of three trees below.</p>
      <div class="grow-impact-options">${(impact.trees || []).map((option) => renderTreeOption(option, null)).join("")}</div>`;
  } else if (reward?.status === "selected" && tree) {
    rewardPanel = `<div class="grow-impact-choice-preview">
      <img src="${escapeImpactText(tree.image)}" alt="Illustration of ${escapeImpactText(tree.name)}" loading="lazy" />
      <div><strong>${escapeImpactText(tree.name)}</strong><span>${escapeImpactText(tree.species)}</span>
      <small>${escapeImpactText(tree.description)}</small></div>
      </div><p class="grow-impact-virtual-label">Pilot reward · a virtual commitment; this does not represent a planted tree.</p>
      <button class="btn btn-primary grow-impact-confirm" type="button">Confirm this tree</button>
      <div class="grow-impact-options">${(impact.trees || []).map((option) => renderTreeOption(option, tree.id)).join("")}</div>`;
  } else if (reward?.status === "confirmed" && tree) {
    const isVerified = reward.plantingStatus === "planted_verified";
    const stage = reward.virtualStage || { label: "Choice saved", elapsedDays: 0 };
    const latestUpdate = reward.verifiedUpdates?.[0];
    const stagePercent = isVerified
      ? partnerStagePercent(latestUpdate?.stageLabel)
      : Math.min(100, Math.round((stage.elapsedDays / 90) * 100));
    const plantingLocation = latestUpdate?.location || reward.plantingLocation;
    const plantedAt = latestUpdate?.plantedAt || reward.plantedAt;
    const verifiedPhotos = isVerified
      ? (latestUpdate?.verifiedPhotos?.length ? latestUpdate.verifiedPhotos : reward.verifiedPhotos || [])
      : [];
    rewardPanel = `<div class="grow-impact-tree-card">
      <img src="${escapeImpactText(tree.image)}" alt="Illustration of ${escapeImpactText(tree.name)}" loading="lazy" />
      <div class="grow-impact-tree-copy"><strong>${escapeImpactText(tree.name)}</strong><span>${escapeImpactText(tree.species)}</span>
        <small>${isVerified ? "Planting verified by the partner" : "Virtual growth journey · illustrative milestones only"}</small>
      </div></div>
      <div class="grow-impact-stage"><div class="grow-impact-stage-line"><span>${isVerified && latestUpdate ? escapeImpactText(latestUpdate.stageLabel) : escapeImpactText(stage.label)}</span>
        <span>${isVerified ? "Partner update" : `${stage.elapsedDays} virtual days`}</span></div>
        <div class="grow-impact-stage-track" role="progressbar" aria-label="Virtual growth journey" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${stagePercent}"><span style="width:${stagePercent}%"></span></div>
      </div>
      ${isVerified && plantingLocation ? `<p class="grow-impact-partner-note">Verified location: ${escapeImpactText(plantingLocation)}${plantedAt ? ` · ${escapeImpactText(plantedAt)}` : ""}</p>` : ""}
      ${!isVerified ? `<p class="grow-impact-virtual-label">Pilot reward · no planting partner is connected, so no real tree planting is claimed.</p>` : ""}
      ${verifiedPhotos.length ? `<div class="grow-impact-photos">${verifiedPhotos.map((src) => `<img src="${escapeImpactText(src)}" alt="Verified planting partner update" loading="lazy" />`).join("")}</div>` : ""}`;
  }

  return `<section class="card grow-impact-card" aria-labelledby="grow-impact-title">
    <div class="grow-impact-heading"><div><div class="card-label">🌱 Grow Your Impact</div><h2 id="grow-impact-title">${count} <span>of ${target} sessions</span></h2></div>
      <span class="grow-impact-month">${escapeImpactText(impact.month)}</span></div>
    <div class="grow-impact-progress" role="progressbar" aria-label="Monthly gym session progress" aria-valuemin="0" aria-valuemax="${target}" aria-valuenow="${Math.min(count, target)}"><span style="width:${percent}%"></span></div>
    <p class="grow-impact-encouragement">${escapeImpactText(encouragement)}</p>
    <p class="grow-impact-rest-note">Only completed workouts with a logged set count. Each calendar day counts once. Sundays are rest days.</p>
    <p class="grow-impact-feedback" role="status" aria-live="polite"></p>
    ${rewardPanel}
  </section>`;
}

function partnerStagePercent(stageLabel) {
  const stage = String(stageLabel || "").toLowerCase();
  if (/mature|canopy/.test(stage)) return 100;
  if (/young tree/.test(stage)) return 75;
  if (/sapling/.test(stage)) return 55;
  if (/seedling/.test(stage)) return 35;
  if (/plant/.test(stage)) return 15;
  return 0;
}

function renderTreeOption(option, selectedId) {
  const selected = selectedId === option.id;
  return `<button class="grow-impact-option${selected ? " is-selected" : ""}" type="button" data-grow-tree="${escapeImpactText(option.id)}" aria-pressed="${selected}">
    <img src="${escapeImpactText(option.image)}" alt="" loading="lazy" />
    <span><strong>${escapeImpactText(option.name)}</strong><small><i>${escapeImpactText(option.species)}</i></small></span>
    <span class="grow-impact-option-check" aria-hidden="true">${selected ? "✓" : "＋"}</span>
  </button>`;
}

function bindGrowImpactActions(root) {
  root.querySelectorAll("[data-grow-tree]").forEach((button) => button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await Api.post("/grow-impact/select", { speciesId: button.dataset.growTree });
      todayRequest = null;
      await loadToday();
    } catch (error) {
      const feedback = root.querySelector(".grow-impact-feedback");
      if (feedback) feedback.textContent = error?.message || "Could not save your tree choice.";
      button.disabled = false;
    }
  }));
  const confirmButton = root.querySelector(".grow-impact-confirm");
  confirmButton?.addEventListener("click", async () => {
    confirmButton.disabled = true;
    try {
      await Api.post("/grow-impact/confirm", {});
      todayRequest = null;
      await loadToday();
    } catch (error) {
      const feedback = root.querySelector(".grow-impact-feedback");
      if (feedback) feedback.textContent = error?.message || "Could not confirm your tree choice.";
      confirmButton.disabled = false;
    }
  });
}

function handleTodayError(el, error) {
  const isAuthError = error?.status === 401;

  if (isAuthError) {
    el.dataset.loadState = "error";
    return;
  }

  let message = "Unable to load today's data.";
  if (error?.status === 429) message = "Too many requests. Please wait a moment and try again.";
  else if (error?.timedOut || error?.message?.includes("too long") || error?.message?.includes("timed out")) message = "The request timed out. Please try again.";
  renderTodayError(el, message);
}

function renderTodayError(el, message) {
  el.dataset.loadState = "error";
  el.innerHTML = `
    <div class="empty-state">
      <div style="margin-bottom: 12px;">${message}</div>
      <button class="btn btn-primary" onclick="loadToday()">Retry</button>
    </div>
  `;
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
    } catch (error) {
      if (error?.status !== 404) throw error;
      workout = null;
    }
    if (workout) {
      if (workout.needsRegeneration && workout.canRegenerate) {
        renderLegacyWorkoutRefresh(workout, plan);
        return;
      }
      renderWorkout(workout, plan);
    } else {
      await renderGenerateWorkoutPrompt(plan);
    }
  } catch (e) {
    el.innerHTML = `<div class="empty-state">${e.message}</div>`;
  }
}

function renderGeneratedWorkout(generated, plan) {
  if (!generated?.workout || !Array.isArray(generated.exercises) || generated.exercises.length === 0) {
    throw new Error("FitOS did not return a workout. Please try again.");
  }
  renderWorkout({
    ...generated.workout,
    exercises: generated.exercises.map((exercise) => ({
      ...exercise,
      status: "pending",
      completedSets: [],
    })),
  }, plan);
}

function isWorkoutDurationValid(input) {
  return Number.isInteger(input.valueAsNumber) && input.valueAsNumber >= 15 && input.valueAsNumber <= 180;
}

function showWorkoutDurationError(input, feedback) {
  feedback.className = "banner banner-error";
  feedback.textContent = "Choose how many minutes you have today (15–180).";
  input.focus();
}

function renderLegacyWorkoutRefresh(workout, plan) {
  const el = $("workout-content");
  const focus = plan?.nextWorkout?.label || workout.focus || "today's plan";
  const muscles = plan?.nextWorkout?.muscles?.length
    ? plan.nextWorkout.muscles.join(", ")
    : focus;
  const completedSetCount = (workout.exercises || []).reduce(
    (total, exercise) => total + (Array.isArray(exercise.completedSets) ? exercise.completedSets.length : 0),
    0,
  );
  $("workout-focus-label").textContent = `${workout.focus} · ${Number(workout.durationMin) || 0} min`;
  el.innerHTML = `
    <section class="card">
      <div class="card-label">Refresh today's workout</div>
      <p class="card-sub">FitOS will build your ${escapeWorkoutText(focus)} session for ${escapeWorkoutText(muscles)}, using the duration you choose today and today's equipment.${completedSetCount ? ` ${completedSetCount} logged set${completedSetCount === 1 ? " stays" : "s stay"} in your history.` : ""}</p>
      <div class="field"><label for="refresh-workout-duration">How long can you train today? (minutes)</label><input id="refresh-workout-duration" type="number" min="15" max="180" step="1" placeholder="Choose today's duration" required /></div>
      <button class="btn btn-primary" id="refresh-plan-workout">Build workout for this plan</button>
      <div id="refresh-plan-workout-feedback" aria-live="polite"></div>
    </section>
  `;
  const button = $("refresh-plan-workout");
  const durationInput = $("refresh-workout-duration");
  button.addEventListener("click", async () => {
    if (!isWorkoutDurationValid(durationInput)) {
      showWorkoutDurationError(durationInput, $("refresh-plan-workout-feedback"));
      return;
    }
    button.disabled = true;
    button.textContent = "Building your workout…";
    try {
      const equipmentMode = workout.equipmentMode || "USER_EQUIPMENT";
      const request = { focus, durationMinutes: durationInput.valueAsNumber, replaceExisting: true, equipmentMode };
      if (Array.isArray(workout.availableEquipmentNames)) {
        if (equipmentMode === "SCANNED") request.detectedEquipmentNames = workout.availableEquipmentNames;
        if (equipmentMode === "USER_EQUIPMENT") request.availableEquipmentNames = workout.availableEquipmentNames;
      }
      const generated = await Api.post("/workouts/generate", request);
      renderGeneratedWorkout(generated, plan);
    } catch (error) {
      const feedback = $("refresh-plan-workout-feedback");
      feedback.className = "banner banner-error";
      feedback.textContent = error.message || "Could not build today's workout.";
      button.disabled = false;
      button.textContent = "Build workout for this plan";
    }
  });
}

function renderWorkoutScanButton() {
  const scanArea = $("workout-scan-area");
  scanArea.innerHTML = `<button class="btn btn-outline" id="workout-scan-btn" style="margin-bottom:14px;">Scan my equipment</button>`;
  $("workout-scan-btn").addEventListener("click", () => {
    scanArea.innerHTML = "";
    startEquipmentScan("workout-scan-area", async (detectedNames) => {
      scanArea.innerHTML = `<div class="empty-state"><span class="spinner"></span> Adding detected equipment to today's choices…</div>`;
      try {
        const existing = await Api.get("/equipment/user/equipment");
        const equipmentNames = Array.from(new Set([
          ...(Array.isArray(existing) ? existing.map((item) => item.name) : []),
          ...detectedNames,
        ].filter((name) => name && name !== "No Equipment")));
        await Api.post("/equipment/user/equipment", { equipmentNames });
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
    await renderWorkoutEquipmentPicker(plan, el);
  }
}

async function renderWorkoutEquipmentPicker(plan, parent) {
  const card = document.createElement("section");
  card.className = "card equipment-picker-card";
  const heading = document.createElement("div");
  heading.className = "card-label";
  heading.textContent = "Step 2: What equipment can you use today?";
  const description = document.createElement("div");
  description.className = "card-sub";
  description.textContent = `Choose the machines and equipment available for ${plan.nextWorkout.label}. FitOS will only recommend exercises you can do with these choices.`;
  const durationField = document.createElement("div");
  durationField.className = "field";
  const durationLabel = document.createElement("label");
  durationLabel.htmlFor = "workout-duration-minutes";
  durationLabel.textContent = "How long can you train today? (minutes)";
  const durationInput = document.createElement("input");
  durationInput.id = "workout-duration-minutes";
  durationInput.type = "number";
  durationInput.min = "15";
  durationInput.max = "180";
  durationInput.step = "1";
  durationInput.placeholder = "Choose today's duration";
  durationInput.required = true;
  durationField.append(durationLabel, durationInput);
  const chipGroup = document.createElement("div");
  chipGroup.className = "chip-group equipment-picker-options";
  const selectionSummary = document.createElement("div");
  selectionSummary.className = "card-sub equipment-selection-summary";
  const feedback = document.createElement("div");
  const buildButton = document.createElement("button");
  buildButton.type = "button";
  buildButton.className = "btn btn-primary";
  buildButton.textContent = "Show my exercises";
  buildButton.disabled = true;
  selectionSummary.textContent = "Loading your equipment...";
  card.append(heading, description, durationField, chipGroup, selectionSummary, feedback, buildButton);
  parent.appendChild(card);

  let equipment;
  let selected;
  try {
    const [catalog, saved] = await Promise.all([
      Api.get("/equipment"),
      Api.get("/equipment/user/equipment"),
    ]);
    equipment = (Array.isArray(catalog) ? catalog : []).filter((item) => item.name !== "No Equipment");
    selected = new Set((Array.isArray(saved) ? saved : [])
      .map((item) => item.name)
      .filter((name) => name !== "No Equipment"));
  } catch (error) {
    selectionSummary.textContent = "Equipment could not be loaded.";
    feedback.className = "banner banner-error";
    feedback.textContent = error.message || "Could not load your equipment list.";
    buildButton.disabled = true;
    const retryButton = document.createElement("button");
    retryButton.type = "button";
    retryButton.className = "btn btn-outline";
    retryButton.textContent = "Retry loading equipment";
    retryButton.addEventListener("click", () => {
      retryButton.disabled = true;
      retryButton.textContent = "Retrying…";
      void loadWorkout();
    });
    card.appendChild(retryButton);
    return;
  }

  const bodyweightButton = document.createElement("button");
  bodyweightButton.type = "button";
  bodyweightButton.className = "chip";
  bodyweightButton.textContent = "Bodyweight only";
  bodyweightButton.addEventListener("click", () => {
    selected.clear();
    paintSelection();
  });
  chipGroup.appendChild(bodyweightButton);

  const optionButtons = [];
  equipment.forEach((item) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "chip";
    button.textContent = item.name;
    button.addEventListener("click", () => {
      if (selected.has(item.name)) selected.delete(item.name);
      else selected.add(item.name);
      paintSelection();
    });
    optionButtons.push({ button, name: item.name });
    chipGroup.appendChild(button);
  });

  function paintSelection() {
    optionButtons.forEach(({ button, name }) => {
      const active = selected.has(name);
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    bodyweightButton.classList.toggle("active", selected.size === 0);
    bodyweightButton.setAttribute("aria-pressed", String(selected.size === 0));
    selectionSummary.textContent = selected.size
      ? `${selected.size} item${selected.size === 1 ? "" : "s"} selected`
      : "No machines selected - FitOS will build a bodyweight workout.";
  }
  paintSelection();
  buildButton.disabled = false;

  buildButton.addEventListener("click", async () => {
    if (!isWorkoutDurationValid(durationInput)) {
      showWorkoutDurationError(durationInput, feedback);
      return;
    }
    buildButton.disabled = true;
    buildButton.textContent = "Building your workout...";
    feedback.className = "";
    feedback.textContent = "";
    let failedDuring = "generating your workout";
    try {
      const generated = await Api.post("/workouts/generate", {
        focus: plan.nextWorkout.label,
        durationMinutes: durationInput.valueAsNumber,
        equipmentMode: "USER_EQUIPMENT",
        availableEquipmentNames: Array.from(selected),
      });
      renderGeneratedWorkout(generated, plan);
    } catch (error) {
      if (error?.status === 400 && error.message?.includes("Complete onboarding")) {
        AuthState.profileComplete = false;
        navigate("/profile", true);
        return;
      }
      feedback.className = "banner banner-error";
      feedback.textContent = `${failedDuring}: ${error.message || "Could not build a workout from this equipment."}`;
      buildButton.disabled = false;
      buildButton.textContent = "Show my exercises";
    }
  });
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

function escapeWorkoutText(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function renderWorkout(workout, plan) {
  const exercises = Array.isArray(workout.exercises) ? workout.exercises : [];
  const el = $("workout-content");
  const missingExerciseName = exercises.find((exercise) =>
    typeof exercise.exerciseName !== "string" || exercise.exerciseName.trim() === "");
  if (missingExerciseName) {
    console.error("Workout API returned an exercise without its canonical exerciseName.", missingExerciseName);
    el.innerHTML = `<div class="banner banner-error">Workout data is incomplete because an exercise name is missing. Refresh or generate a fresh workout.</div>`;
    return;
  }
  const progress = exercises.map((exercise) => {
    const targetSets = Math.max(1, Number(exercise.targetSets) || 1);
    const completedSetRows = Array.isArray(exercise.completedSets) ? exercise.completedSets : [];
    const completedSetNumbers = new Set(completedSetRows.map((set) => Number(set.setNumber)));
    const nextSetNumber = Array.from({ length: targetSets }, (_, index) => index + 1)
      .find((setNumber) => !completedSetNumbers.has(setNumber));
    return { exercise, targetSets, completedSetRows, completedSetNumbers, nextSetNumber };
  });
  const totalSets = progress.reduce((sum, item) => sum + item.targetSets, 0);
  const loggedSets = progress.reduce((sum, item) => sum + item.completedSetRows.length, 0);
  const progressPercent = totalSets ? Math.min(100, Math.round((loggedSets / totalSets) * 100)) : 0;
  const activeIndex = workout.status === "completed" ? -1 : progress.findIndex((item) =>
    item.exercise.status !== "skipped" && item.exercise.status !== "completed" && item.nextSetNumber !== undefined
  );
  const active = activeIndex >= 0 ? progress[activeIndex] : null;
  const workoutName = escapeWorkoutText(workout.focus || "Strength workout");
  const duration = Number(workout.durationMin) || 0;
  const completedWorkout = workout.status === "completed";
  const planName = plan?.activePlan?.structureLabel || plan?.activePlan || "";
  const nextPlanWorkout = plan?.nextWorkout?.label;
  const equipmentLine = (exercise) => exercise.machine || (exercise.requiresEquipment
    ? (exercise.equipmentRequired || []).join(", ") || exercise.equipmentName || "Gym equipment"
    : "Bodyweight");
  const canChangeDuration = !completedWorkout && loggedSets === 0 && Boolean(plan?.nextWorkout);
  const changeDurationPanel = canChangeDuration
    ? `<section class="card workout-duration-card">
        <div class="card-label">Change today's session length</div>
        <p class="card-sub">Choose how long you have. FitOS will rebuild this ${escapeWorkoutText(workout.focus || "workout")} exercise list to fit that time. You can change it until you log your first set.</p>
        <div class="field"><label for="active-workout-duration">Available time today (minutes)</label><input id="active-workout-duration" type="number" min="15" max="180" step="1" placeholder="Choose today's duration" required /></div>
        <button class="btn btn-outline" id="change-workout-duration">Update workout duration</button>
        <div id="change-workout-duration-feedback" aria-live="polite"></div>
      </section>`
    : "";

  $("workout-focus-label").textContent = `${workout.focus} · ${duration} min`;
  const activeExerciseCard = active
    ? (() => {
      const exercise = active.exercise;
      const low = Number(exercise.repRangeLow) || 1;
      const high = Math.max(low, Number(exercise.repRangeHigh) || low);
      const reps = Math.round((low + high) / 2);
      const isBodyweight = !exercise.requiresEquipment;
      const equipment = equipmentLine(exercise);
      return `
        <section class="workout-next-card" aria-live="polite">
          <div class="workout-next-top"><span class="workout-eyebrow">UP NEXT</span><span>Exercise ${activeIndex + 1} of ${progress.length}</span></div>
          <h2>${escapeWorkoutText(exercise.exerciseName)}</h2>
          <div class="workout-tags"><span>Muscle: ${escapeWorkoutText(exercise.muscle || exercise.primaryMuscle || "Full body")}</span><span>Machine: ${escapeWorkoutText(equipment)}</span></div>
          <div class="workout-target"><strong>${active.targetSets} sets</strong><span>${low}–${high} reps each</span><span>Set ${active.nextSetNumber} of ${active.targetSets}</span></div>
          ${exercise.instructions ? `<p class="workout-instructions">${escapeWorkoutText(exercise.instructions)}</p>` : ""}
          <div class="workout-set-log">
            <div class="workout-eyebrow">LOG SET ${active.nextSetNumber}</div>
            <p>Choose your reps${isBodyweight ? "; weight is optional." : " and the weight you used."}</p>
            <div class="workout-set-inputs">
              <label>Reps<input id="workout-set-reps" type="number" inputmode="numeric" min="0" max="100" value="${reps}" /></label>
              <label>Weight (kg)<input id="workout-set-weight" type="number" inputmode="decimal" min="0" step="0.5" placeholder="Optional" /></label>
            </div>
            <button class="btn btn-primary" id="log-workout-set">Log set · show me what's next</button>
          </div>
        </section>`;
    })()
    : completedWorkout
      ? `<section class="workout-complete-card"><div class="workout-complete-mark">✓</div><h2>Workout complete</h2><p>${loggedSets} of ${totalSets} planned sets logged. Nice work.</p>${nextPlanWorkout ? `<div class="workout-next-hint">Next in your plan: <strong>${escapeWorkoutText(nextPlanWorkout)}</strong></div>` : ""}</section>`
      : `<section class="workout-next-card" aria-live="polite"><div class="workout-eyebrow">UP NEXT</div><h2>All planned sets are done</h2><p>Finish your workout to save it and move your plan forward.</p></section>`;

  const exerciseRows = progress.map((item, index) => {
    const exercise = item.exercise;
    const skipped = exercise.status === "skipped";
    const isDone = skipped || exercise.status === "completed" || item.nextSetNumber === undefined;
    const isActive = index === activeIndex;
    const stateLabel = skipped ? "SKIPPED" : isDone ? "DONE" : isActive ? "UP NEXT" : "COMING UP";
    const stateClass = skipped ? "skipped" : isDone ? "done" : isActive ? "active" : "later";
    const setLabel = `${item.completedSetRows.length}/${item.targetSets} sets`;
    const repLabel = `${Number(exercise.repRangeLow) || 1}–${Number(exercise.repRangeHigh) || Number(exercise.repRangeLow) || 1} reps`;
    const hasLoggedSets = item.completedSetRows.length > 0;
    const swapButton = !hasLoggedSets && exercise.status !== "completed" && exercise.status !== "skipped" && workout.status !== "completed"
      ? `<button class="btn btn-outline workout-swap-btn" data-action="swap" data-id="${escapeWorkoutText(exercise.workoutExerciseId)}">Swap</button>`
      : "";
    return `<article class="workout-exercise-row ${stateClass}">
      <span class="workout-exercise-number">${isDone && !skipped ? "✓" : index + 1}</span>
      <div class="workout-exercise-copy"><strong>${escapeWorkoutText(exercise.exerciseName)}</strong><span>${escapeWorkoutText(exercise.muscle || exercise.primaryMuscle || "Full body")} · ${escapeWorkoutText(equipmentLine(exercise))} · ${setLabel} · ${repLabel}</span></div>
      <span class="workout-exercise-state">${stateLabel}</span>${swapButton}
    </article>`;
  }).join("");

  el.innerHTML = `
    ${planName ? `<div class="workout-plan-line"><span>YOUR PLAN</span><strong>${escapeWorkoutText(planName)}</strong>${plan?.nextWorkout?.label ? `<span>· ${escapeWorkoutText(plan.nextWorkout.label)}</span>` : ""}</div>` : ""}
    <section class="workout-session-card">
      <div class="workout-session-top"><span class="workout-eyebrow">TODAY'S SESSION</span><span>${completedWorkout ? "COMPLETE" : "IN PROGRESS"}</span></div>
      <h2>${workoutName}</h2>
      <div class="workout-session-meta">${duration} min <span>·</span> ${progress.length} exercises <span>·</span> ${loggedSets}/${totalSets} sets</div>
      <div class="workout-progress-track" role="progressbar" aria-label="Workout set progress" aria-valuemin="0" aria-valuemax="${totalSets}" aria-valuenow="${loggedSets}"><span style="width:${progressPercent}%"></span></div>
    </section>
    ${changeDurationPanel}
    ${activeExerciseCard}
    <section class="workout-exercise-list">
      <div class="workout-list-heading"><div><span class="workout-eyebrow">YOUR WORKOUT</span><h3>Exercise order</h3></div><span>${progress.length} movements</span></div>
      ${exerciseRows || `<p class="card-sub">No exercises were added to this workout.</p>`}
    </section>
    ${completedWorkout && plan ? renderActivePlanCard(plan) : ""}
    ${!completedWorkout ? `<div class="workout-finish-note">You can finish early. Sets you haven't logged won't be added to your training history.</div><button class="btn btn-primary" id="complete-workout-btn">Finish workout</button>` : ""}
  `;

  const changeDurationButton = $("change-workout-duration");
  if (changeDurationButton) {
    const durationInput = $("active-workout-duration");
    const feedback = $("change-workout-duration-feedback");
    changeDurationButton.addEventListener("click", async () => {
      if (!isWorkoutDurationValid(durationInput)) {
        showWorkoutDurationError(durationInput, feedback);
        return;
      }
      changeDurationButton.disabled = true;
      changeDurationButton.textContent = "Updating workout…";
      feedback.className = "";
      feedback.textContent = "";
      try {
        const equipmentMode = workout.equipmentMode || "USER_EQUIPMENT";
        const request = {
          focus: plan.nextWorkout.label,
          durationMinutes: durationInput.valueAsNumber,
          replaceExisting: true,
          equipmentMode,
        };
        if (Array.isArray(workout.availableEquipmentNames)) {
          if (equipmentMode === "SCANNED") request.detectedEquipmentNames = workout.availableEquipmentNames;
          if (equipmentMode === "USER_EQUIPMENT") request.availableEquipmentNames = workout.availableEquipmentNames;
        }
        const generated = await Api.post("/workouts/generate", request);
        renderGeneratedWorkout(generated, plan);
      } catch (error) {
        feedback.className = "banner banner-error";
        feedback.textContent = error.message || "Could not update the workout duration.";
        changeDurationButton.disabled = false;
        changeDurationButton.textContent = "Update workout duration";
      }
    });
  }

  const logSetButton = $("log-workout-set");
  if (logSetButton && active) {
    logSetButton.addEventListener("click", async () => {
      const repsInput = $("workout-set-reps");
      const weightInput = $("workout-set-weight");
      const reps = Number(repsInput.value);
      const weightKg = weightInput.value === "" ? undefined : Number(weightInput.value);
      if (!Number.isInteger(reps) || reps < 0 || (weightKg !== undefined && (!Number.isFinite(weightKg) || weightKg < 0))) {
        showWorkoutNotice("Enter a valid rep count and a non-negative weight.", "error");
        return;
      }
      logSetButton.disabled = true;
      logSetButton.innerHTML = `<span class="spinner"></span> Saving set…`;
      try {
        await Api.post(`/workouts/${workout.id}/complete-set`, {
          workoutExerciseId: active.exercise.workoutExerciseId,
          setNumber: active.nextSetNumber,
          reps,
          ...(weightKg === undefined ? {} : { weightKg }),
        });
        await loadWorkout();
      } catch (error) {
        showWorkoutNotice(error.message, "error");
        logSetButton.disabled = false;
        logSetButton.textContent = "Log set · show me what's next";
      }
    });
  }

  el.querySelectorAll('[data-action="swap"]').forEach((button) => {
    button.addEventListener("click", async () => {
      button.disabled = true;
      button.textContent = "Swapping…";
      try {
        const result = await Api.post(`/workouts/${workout.id}/replace-exercise`, {
          workoutExerciseId: button.dataset.id,
          reason: "user_preference",
        });
        const slotId = result.workoutExerciseId;
        const replacement = result.exercise;
        const updatedWorkout = {
          ...workout,
          exercises: workout.exercises.map((exercise) => exercise.workoutExerciseId === slotId
            ? { ...exercise, ...replacement }
            : exercise),
        };
        renderWorkout(updatedWorkout, plan);
        showWorkoutNotice(result.explanation || "Exercise updated to match your available equipment.", "success");
      } catch (error) {
        showWorkoutNotice(error.message, "error");
        button.disabled = false;
        button.textContent = "Swap";
      }
    });
  });

  const completeBtn = $("complete-workout-btn");
  if (completeBtn) {
    completeBtn.addEventListener("click", async () => {
      completeBtn.disabled = true;
      completeBtn.innerHTML = `<span class="spinner"></span> Saving workout…`;
      try {
        await Api.post(`/workouts/${workout.id}/complete`, {});
        await loadWorkout();
      } catch (error) {
        showWorkoutNotice(error.message, "error");
        completeBtn.disabled = false;
        completeBtn.textContent = "Finish workout";
      }
    });
  }
  if (plan && completedWorkout) wirePlanActions(plan);
}

function showWorkoutNotice(message, tone) {
  const notice = document.createElement("div");
  notice.className = `banner banner-${tone === "success" ? "success" : "error"}`;
  notice.textContent = message;
  $("workout-content").prepend(notice);
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
    const [equipment, plan, profile] = await Promise.all([
      Api.get("/equipment"),
      Api.get("/workouts/plan"),
      Api.get("/equipment/gym-profile"),
    ]);
    renderGymTour(equipment, plan, profile);
  } catch (e) {
    el.innerHTML = `<div class="empty-state">${e.message}</div>`;
  }
}

function renderGymTour(equipment, plan, savedProfile) {
  const el = $("gym-scan-content");
  const equipmentNames = equipment.filter((item) => item.name !== "No Equipment").map((item) => item.name);
  let profile = savedProfile;
  let stream = null;
  let running = false;
  let paused = false;
  let detectionInFlight = false;
  let frameHandle = null;
  const evidence = new Map();

  const render = () => {
    const profileReady = profile?.gymTourCompleted === true;
    const known = Array.isArray(profile?.equipment) ? profile.equipment : [];
    el.innerHTML = `
      <div class="card">
        <div class="card-label">${profileReady ? "Gym equipment profile" : "One-time gym tour"}</div>
        <p class="card-sub">${profileReady ? "Your saved equipment is used for workouts at this gym." : "Record the whole gym once so FitOS can build your equipment profile."}</p>
        ${profileReady ? `
          <div class="banner banner-success">Gym tour completed${profile.lastScanAt ? ` · ${new Date(profile.lastScanAt).toLocaleDateString()}` : ""}</div>
          <div class="card-sub" style="margin-bottom:10px;">Are you at the same gym?</div>
          <div class="btn-row"><button class="btn btn-mint" id="same-gym-yes">Yes, use saved equipment</button><button class="btn btn-outline" id="same-gym-no">No, start a new tour</button></div>
          <button class="btn btn-outline" id="gym-tour-rescan" style="margin-top:10px;">Rescan Gym</button>
          <div class="chip-group" style="margin-top:14px;">${known.map((name) => `<span class="pill">${name}</span>`).join("")}</div>
        ` : `
          <p style="margin:14px 0 0;">Start Gym Tour to continuously detect equipment while you move around the gym.</p>
          <button class="btn btn-primary" id="gym-tour-start" style="margin-top:14px;">Start Gym Tour</button>
        `}
      </div>
      <div id="gym-tour-workspace"></div>
    `;
    if (profileReady) {
      $("same-gym-yes").addEventListener("click", () => {
        $("gym-tour-workspace").innerHTML = `<div class="banner banner-success">Saved equipment profile selected for today's workout.</div>`;
      });
      $("same-gym-no").addEventListener("click", () => {
        profile = { gymTourCompleted: false, equipment: [] };
        render();
        startTour();
      });
      $("gym-tour-rescan").addEventListener("click", () => {
        profile = { gymTourCompleted: false, equipment: [] };
        render();
        startTour();
      });
    } else {
      $("gym-tour-start").addEventListener("click", startTour);
    }
  };

  const stopStream = () => {
    running = false;
    if (frameHandle) cancelAnimationFrame(frameHandle);
    if (stream) stream.getTracks().forEach((track) => track.stop());
    stream = null;
  };

  const renderEvidence = (workspace, status) => {
    const rows = [...evidence.entries()].sort((a, b) => b[1].confidence - a[1].confidence)
      .map(([name, item]) => `<div class="exercise-row"><div><strong>${name}</strong><div class="exercise-meta">${Math.round(item.confidence * 100)}% confidence · ${item.frames} frames</div></div><span class="pill">${item.frames >= 2 ? "Reliable" : "Checking"}</span></div>`).join("");
    workspace.querySelector("#gym-tour-detections").innerHTML = rows || `<div class="empty-state">Move around the gym to collect detections.</div>`;
    workspace.querySelector("#gym-tour-count").textContent = status.startsWith("Model not configured")
      ? "Model not configured"
      : `${evidence.size} equipment types detected`;
    workspace.querySelector("#gym-tour-status").textContent = status;
  };

  const startTour = async () => {
    const workspace = $("gym-tour-workspace");
    workspace.innerHTML = `
      <div class="card">
        <div class="camera-panel" style="aspect-ratio:4/3;"><video id="gym-tour-video" autoplay playsinline muted style="width:100%;height:100%;object-fit:cover;"></video><div class="camera-feedback" id="gym-tour-status" style="display:flex;align-items:center;justify-content:center;">Starting camera…</div></div>
        <div class="btn-row"><button class="btn btn-mint" id="gym-tour-pause">Pause</button><button class="btn btn-outline" id="gym-tour-stop">Stop</button></div>
        <div class="card-sub" id="gym-tour-count" style="margin-top:12px;">Waiting for local model…</div>
        <div id="gym-tour-detections" style="margin-top:8px;"></div>
      </div>
    `;
    const video = $("gym-tour-video");
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      video.srcObject = stream;
      running = true;
      paused = false;
      evidence.clear();
      $("gym-tour-pause").addEventListener("click", () => {
        paused = !paused;
        $("gym-tour-pause").textContent = paused ? "Resume" : "Pause";
        $("gym-tour-status").textContent = paused ? "Paused" : "Recording and detecting equipment…";
      });
      $("gym-tour-stop").addEventListener("click", () => finishTour(workspace));
      const detectFrame = async () => {
        if (!running) return;
        if (!paused && !detectionInFlight && video.readyState === video.HAVE_ENOUGH_DATA) {
          detectionInFlight = true;
          const canvas = document.createElement("canvas");
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          canvas.getContext("2d").drawImage(video, 0, 0);
          try {
            const result = await Api.post("/equipment/detect", { imageBase64: canvas.toDataURL("image/jpeg", 0.8).split(",")[1] });
            if (result.error === "MODEL_NOT_CONFIGURED") {
              renderEvidence(workspace, "Model not configured. Add a trained local YOLO model to the backend.");
              stopStream();
              return;
            }
            for (const detection of result.detections || []) {
              const current = evidence.get(detection.equipmentName) || { confidence: 0, frames: 0 };
              current.frames += 1;
              current.confidence = Math.max(current.confidence, Number(detection.confidence) || 0);
              evidence.set(detection.equipmentName, current);
            }
            renderEvidence(workspace, "Recording and detecting equipment…");
          } catch (error) {
            renderEvidence(workspace, `Detection paused: ${error.message || "try another angle"}`);
          } finally {
            detectionInFlight = false;
          }
        }
        frameHandle = requestAnimationFrame(detectFrame);
      };
      renderEvidence(workspace, "Recording and detecting equipment…");
      detectFrame();
    } catch (error) {
      workspace.innerHTML = `<div class="banner banner-error">Camera permission denied. ${error.message || ""}</div>`;
    }
  };

  const finishTour = async (workspace) => {
    stopStream();
    const reliable = [...evidence.entries()].filter(([, item]) => item.frames >= 2 && item.confidence >= 0.5);
    workspace.innerHTML = `
      <div class="card">
        <div class="card-label">Gym tour analyzed</div>
        <p class="card-sub">${reliable.length} equipment types have sufficient evidence.</p>
        <div class="card-sub" style="margin:12px 0;">Are you done recording your whole gym?</div>
        <div class="btn-row"><button class="btn btn-mint" id="gym-tour-done">Yes</button><button class="btn btn-outline" id="gym-tour-continue">No, continue recording</button></div>
        <div class="chip-group" style="margin-top:14px;">${reliable.map(([name]) => `<span class="pill">${name}</span>`).join("") || "No reliable equipment yet."}</div>
      </div>`;
    $("gym-tour-done").addEventListener("click", async () => {
      const button = $("gym-tour-done");
      button.disabled = true;
      try {
        const saved = await Api.post("/equipment/gym-tour", { completed: true, detections: reliable.map(([equipmentName, item]) => ({ equipmentName, confidence: item.confidence, evidenceFrames: item.frames })) });
        profile = saved;
        render();
      } catch (error) {
        workspace.innerHTML = `<div class="banner banner-error">${error.message || "Could not save the gym profile."}</div>`;
      }
    });
    $("gym-tour-continue").addEventListener("click", startTour);
  };

  render();
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
      <p class="card-sub" style="margin-bottom:12px;">Save what your gym has, then choose what is available for today's workout.</p>
      <div class="chip-group" style="flex-wrap:wrap; gap:8px;">${equipmentHtml}</div>
      <div class="btn-row" style="margin-top:16px;">
        <button class="btn btn-primary" id="gym-scan-generate" ${!hasActivePlan ? "disabled" : ""}>
          ${hasActivePlan ? "Choose equipment for workout" : "Select a plan first in Workout tab"}
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
    
    const suggestionsHtml = "";

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
      ${suggestionsHtml ? `
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
    
    generateBtn.disabled = true;
    generateBtn.innerHTML = `<span class="spinner"></span> Saving equipment...`;
    
    try {
      await Api.post("/equipment/user/equipment", { equipmentNames });
      // The workout tab confirms today's equipment before exercise generation.
      switchTab("workout");
    } catch (e) {
      el.innerHTML = `<div class="banner banner-error">${e.message}</div>` + el.innerHTML;
    } finally {
      generateBtn.disabled = false;
      generateBtn.textContent = "Choose equipment for workout";
    }
  });
}

/* ---------------- Kickoff ---------------- */
void boot();
