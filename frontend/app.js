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
let workoutExerciseCatalogPromise;

function normalizeWorkoutExerciseName(value) {
  return String(value || "").normalize("NFKC").toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ")
    .split(" ").map((word) => word.length > 3 && word.endsWith("ies")
      ? `${word.slice(0, -3)}y`
      : word.length > 2 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word).join(" ");
}

function loadWorkoutExerciseCatalog() {
  if (!workoutExerciseCatalogPromise) {
    workoutExerciseCatalogPromise = Api.get("/exercises").catch((error) => {
      workoutExerciseCatalogPromise = null;
      throw error;
    });
  }
  return workoutExerciseCatalogPromise;
}

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
    if (normalizePath(location.pathname) === "/") void routeCurrent();
    else if (!location.pathname.startsWith("/verify-email") && !location.pathname.startsWith("/verify-login") && !location.pathname.startsWith("/forgot-password") && !location.pathname.startsWith("/reset-password")) navigate("/login", true);
  },
};
let authBootGeneration = 0;
window.AuthState = AuthState;

const routeTabs = { "/homepage": "today", "/today": "today", "/workout": "workout", "/workouts": "workout", "/nutrition": "diet", "/equipment": "gym-scan", "/gym": "gym", "/vision": "vision", "/history": "history", "/profile": "profile", "/settings": "settings" };
const publicSiteUrl = window.PUBLIC_SITE_URL || "https://adaptive-fit-web.onrender.com";
const routeMetadata = {
  "/": ["AI Workout Planner Based on Gym Equipment | FitOS", "Build personalized gym workouts around your available equipment, training goals, workout split and time. Explore exercise alternatives and nearby food with FitOS."],
  "/login": ["Log in to FitOS | Personalized Workout Planner", "Log in to your FitOS account to continue your workout and nutrition plan."],
  "/register": ["Create your FitOS account | Adaptive Workout Planner", "Create a FitOS account to build an equipment-aware training plan around your goals."],
  "/verify-email": ["Verify your email | FitOS", "Verify your email address to finish setting up your FitOS account."],
  "/verify-login": ["Verify sign-in code | FitOS", "Enter your one-time sign-in code to access your FitOS account."],
  "/forgot-password": ["Reset your FitOS password | FitOS", "Request a secure password reset code for your FitOS account."],
  "/reset-password": ["Choose a new password | FitOS", "Set a new password for your FitOS account."],
  "/homepage": ["Your training dashboard | FitOS", "Your FitOS training, workout history, and fitness plan."],
  "/today": ["Today’s training | FitOS", "Review today’s training plan and progress in FitOS."],
  "/workout": ["Your workout plan | FitOS", "Build and follow a workout based on your goals and available equipment."],
  "/workouts": ["Your workouts | FitOS", "View and manage your FitOS workout plan."],
  "/nutrition": ["Food and nutrition planner | FitOS", "Explore meal planning and nearby food discovery in FitOS."],
  "/equipment": ["Gym equipment planner | FitOS", "Review equipment and build workouts for your gym setup."],
  "/gym": ["Gym check-in | FitOS", "Check in to your gym and review gym attendance in FitOS."],
  "/vision": ["Workout vision coach | FitOS", "Use the camera-based workout vision tools in FitOS."],
  "/history": ["Workout history | FitOS", "Review your logged FitOS training history."],
  "/profile": ["Your profile and training goals | FitOS", "Manage your FitOS fitness profile, goals, and equipment."],
  "/settings": ["FitOS settings | FitOS", "Manage your FitOS profile and preferences."],
};
function updateRouteMetadata(path) {
  const [title, description] = routeMetadata[path] || ["FitOS | Your adaptive fitness planner", "Equipment-aware workouts and training support from FitOS."];
  document.title = title;
  const descriptionTag = document.querySelector('meta[name="description"]');
  const robotsTag = document.querySelector('meta[name="robots"]');
  const canonicalTag = document.querySelector('link[rel="canonical"]');
  const canonicalUrl = `${publicSiteUrl}${path === "/" ? "/" : path}`;
  if (descriptionTag) descriptionTag.content = description;
  if (robotsTag) robotsTag.content = path === "/" ? "index, follow, max-image-preview:large" : "noindex, nofollow";
  if (canonicalTag) canonicalTag.href = canonicalUrl;
  document.querySelector('meta[property="og:title"]')?.setAttribute("content", title);
  document.querySelector('meta[property="og:description"]')?.setAttribute("content", description);
  document.querySelector('meta[property="og:url"]')?.setAttribute("content", canonicalUrl);
}
function trackMarketingEvent(eventName, placement) {
  window.dispatchEvent(new CustomEvent("fitos:conversion", { detail: { eventName, placement } }));
}
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
let loginOtpEmail = sessionStorage.getItem("loginOtpEmail") || "";
let resendTimer;
function showVerify(email) {
  verifyEmail = (email || "").trim().toLowerCase();
  if (verifyEmail) sessionStorage.setItem("pendingVerifyEmail", verifyEmail);
  $("verify-email-masked").textContent = maskEmail(verifyEmail);
  showScreen("screen-verify-email"); startResendCountdown(60);
}
function showLoginOtp(email) {
  loginOtpEmail = (email || "").trim().toLowerCase();
  if (loginOtpEmail) sessionStorage.setItem("loginOtpEmail", loginOtpEmail);
  $("login-otp-email-masked").textContent = maskEmail(loginOtpEmail);
  showScreen("screen-login-otp"); startResendCountdown(60, "login-otp-resend", "login-otp-countdown");
}
function startResendCountdown(seconds, buttonId = "verify-resend", countdownId = "verify-countdown") {
  clearInterval(resendTimer); let remaining = seconds;
  const button = $(buttonId); button.disabled = true;
  const paint = () => { $(countdownId).textContent = remaining > 0 ? `Resend available in ${remaining}s` : "You can request a new code."; button.disabled = remaining > 0; };
  paint(); resendTimer = setInterval(() => { remaining -= 1; paint(); if (remaining <= 0) clearInterval(resendTimer); }, 1000);
}
async function routeCurrent() {
  const path = normalizePath(location.pathname);
  updateRouteMetadata(path);
  const publicRoutes = { "/login": "screen-auth", "/register": "screen-auth", "/verify-email": "screen-verify-email", "/verify-login": "screen-login-otp", "/forgot-password": "screen-forgot-password", "/reset-password": "screen-reset-password" };
  const knownRoutes = new Set(["/", ...Object.keys(routeTabs), ...Object.keys(publicRoutes)]);
  if (!knownRoutes.has(path)) { showScreen("screen-not-found"); return; }
  if (AuthState.status === "AUTH_LOADING") {
    showScreen(path === "/" ? "screen-landing" : "screen-intro");
    return;
  }
  if (path === "/") {
    // The marketing homepage is public even when a user is signed in.
    showScreen("screen-landing");
    return;
  }
  if (path === "/login" || path === "/register") {
    if (AuthState.status === "AUTHENTICATED") { navigate("/homepage", true); return; }
    State.isRegisterMode = path === "/register";
    updateAuthMode(); showScreen("screen-auth"); return;
  }
  if (path === "/verify-login") {
    if (!loginOtpEmail) { navigate("/login", true); return; }
    $("login-otp-email-masked").textContent = maskEmail(loginOtpEmail);
    showScreen(publicRoutes[path]); return;
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
  $("login-otp-link").hidden = register;
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
  const isLandingRoute = normalizePath(location.pathname) === "/";
  updateRouteMetadata(normalizePath(location.pathname));
  if (isLandingRoute) showScreen("screen-landing");
  else { window.FitOSIntroStart?.(); showScreen("screen-intro"); }
  $("auth-submit").disabled = true;
  try {
    const data = await Api.get("/auth/me");
      if (!isLandingRoute) await keepIntroVisible();
    if (generation !== authBootGeneration) return;
    if (!data.authenticated) {
      Api.clearTokens(); AuthState.status = "UNAUTHENTICATED"; clearProtectedContent();
      if (["/verify-email", "/forgot-password", "/reset-password"].includes(normalizePath(location.pathname))) await routeCurrent();
      else if (normalizePath(location.pathname) === "/") await routeCurrent();
      else navigate("/login", true);
      return;
    }
    AuthState.authenticated(data.user);
    if (location.hostname === "localhost" || location.hostname === "127.0.0.1") console.info("[AUTH] session restored; redirecting to homepage");
    if (["/login", "/register"].includes(normalizePath(location.pathname))) navigate("/homepage", true); else await routeCurrent();
  } catch (e) {
      if (!isLandingRoute) await keepIntroVisible();
    if (generation !== authBootGeneration) return;
    if (e?.status === 401) Api.clearTokens();
    AuthState.status = "UNAUTHENTICATED"; AuthState.user = null; clearProtectedContent();
    if (isLandingRoute) { await routeCurrent(); return; }
    navigate("/login", true);
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

$("login-otp-link").addEventListener("click", async () => {
  const email = $("auth-email").value.trim().toLowerCase();
  const bannerEl = $("auth-banner"); banner(bannerEl, "info", "");
  if (!email) { banner(bannerEl, "error", "Enter your email address first."); return; }
  const button = $("login-otp-link"); button.disabled = true; button.textContent = "Sending code…";
  try {
    await Api.post("/auth/login/request-otp", { email });
    $("login-otp").value = "";
    history.pushState({}, "", "/verify-login");
    showLoginOtp(email);
  } catch (e) {
    banner(bannerEl, "error", e.message || "Could not send a sign-in code.");
  } finally {
    button.disabled = false; button.textContent = "Email me a sign-in code";
  }
});

$("login-otp-submit").addEventListener("click", async () => {
  const bannerEl = $("login-otp-banner"); banner(bannerEl, "info", "");
  try {
    const data = await Api.post("/auth/login/verify-otp", { email: loginOtpEmail, otp: $("login-otp").value.trim() });
    if (data.accessToken) Api.setTokens(data.accessToken, data.refreshToken);
    sessionStorage.removeItem("loginOtpEmail"); AuthState.authenticated(data.user); navigate("/homepage", true);
  } catch (e) { banner(bannerEl, "error", e.message || "Could not verify the sign-in code."); }
});

$("login-otp-resend").addEventListener("click", async () => {
  const button = $("login-otp-resend"); button.disabled = true;
  try {
    await Api.post("/auth/login/request-otp", { email: loginOtpEmail });
    startResendCountdown(60, "login-otp-resend", "login-otp-countdown");
    banner($("login-otp-banner"), "success", "If the account exists, a new sign-in code has been sent.");
  } catch (e) {
    if (e.status === 429) startResendCountdown(e.body?.retryAfter || 60, "login-otp-resend", "login-otp-countdown");
    else button.disabled = false;
    banner($("login-otp-banner"), "error", e.message || "Could not resend the sign-in code.");
  }
});
$("login-otp-back").addEventListener("click", () => { sessionStorage.removeItem("loginOtpEmail"); loginOtpEmail = ""; navigate("/login"); });

$("verify-submit").addEventListener("click", async () => {
  const bannerEl = $("verify-banner"); banner(bannerEl, "info", "");
  try {
    const data = await Api.post("/auth/register/verify-otp", { email: verifyEmail, otp: $("verify-otp").value.trim() });
    if (data.accessToken) Api.setTokens(data.accessToken, data.refreshToken);
    trackMarketingEvent("signup_verified", "email_otp");
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
$("today-profile-btn")?.addEventListener("click", () => navigate("/profile"));
document.addEventListener("click", async (event) => {
  const target = event.target.closest("[data-logout]");
  if (!target) return;
  try { await Api.post("/auth/logout", {}); } catch { /* local sign-out still completes */ }
  AuthState.status = "UNAUTHENTICATED"; AuthState.user = null; AuthState.profileComplete = null; Api.clearTokens(); clearProtectedContent(); navigate("/login", true);
});

function switchTab(tab, updateUrl = true) {
  if (AuthState.status !== "AUTHENTICATED") { navigate("/login", true); return; }
  const pathForTab = { today: "/homepage", workout: "/workout", diet: "/nutrition", "gym-scan": "/equipment", gym: "/gym", vision: "/vision" };
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

const TODAY_ICON_PATHS = {
  calories: '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 17c1.4 0 2.5-1.1 2.5-2.5 0-1.1-.6-1.8-1.5-2.5.2 1-.5 1.5-1 1.5-.8 0-1.5-.7-1.5-1.5 0-1.7 1.5-2.4 1.5-4.5 2.5 1.7 4 4.5 4 7.5a6 6 0 0 1-12 0c0-2.6 1.3-4.8 3.5-6.5-.2 2.3 2 3 2 5.5Z"/>',
  food: '<path d="M3 2v7a4 4 0 0 0 4 4h1V2M7 2v20M21 15V2a5 5 0 0 0-5 5v6a2 2 0 0 0 2 2h3Zm-3 0v7"/>',
  volume: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  gym: '<path d="M6.5 6.5v11m11-11v11M3 9v6m18-6v6M6.5 12h11"/>',
  lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  alert: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4m0 4h.01"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/>',
};

function todayIcon(name, size = 16) {
  return `<svg class="today-icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${TODAY_ICON_PATHS[name] || ""}</svg>`;
}

function dateKeyInTimeZone(timeZone, date = new Date()) {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: timeZone || undefined,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function daysRemainingInMonth(month, calendarDays, timeZone) {
  const today = dateKeyInTimeZone(timeZone);
  const currentMonth = today.slice(0, 7);
  if (month < currentMonth) return 0;
  if (month > currentMonth) return Number(calendarDays) || 0;
  return Math.max(0, (Number(calendarDays) || 0) - Number(today.slice(8, 10)));
}

function currentWorkoutStreak(sessionDates, history, month, timeZone) {
  const today = dateKeyInTimeZone(timeZone);
  if (month !== today.slice(0, 7)) return null;
  const completedDates = new Set((sessionDates || []).filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)));
  for (const workout of history || []) {
    if (workout.status === "completed" && workout.completedAt) {
      completedDates.add(dateKeyInTimeZone(timeZone, new Date(workout.completedAt)));
    }
  }
  let cursor = Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1, Number(today.slice(8, 10)));
  if (!completedDates.has(today)) cursor -= 86_400_000;
  let streak = 0;
  while (completedDates.has(new Date(cursor).toISOString().slice(0, 10))) {
    streak += 1;
    cursor -= 86_400_000;
  }
  return streak >= 30 && history?.length >= 30 ? `${streak}+` : streak;
}

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

    const [nutritionResult, gymResult, growImpactResult, historyResult, attendanceResult] = await Promise.allSettled([
      Api.get("/nutrition/today"),
      Api.get("/gym/today"),
      Api.get("/grow-impact/"),
      Api.get("/workouts/history"),
      Api.get("/gym/history"),
    ]);
    if (generation !== todayLoadGeneration) return;

    const nutritionData = nutritionResult.status === "fulfilled" ? nutritionResult.value : null;
    const gymData = gymResult.status === "fulfilled" ? gymResult.value : null;
    const growImpactData = growImpactResult.status === "fulfilled" ? growImpactResult.value : null;
    const growImpactError = growImpactResult.status === "rejected";
    const workoutHistory = historyResult.status === "fulfilled" ? historyResult.value?.history || [] : [];
    const gymAttendanceHistory = attendanceResult.status === "fulfilled" && Array.isArray(attendanceResult.value) ? attendanceResult.value : null;

    renderTodaySuccess(el, dashboard, plan, nutritionData, gymData, growImpactData, growImpactError, workoutHistory, gymAttendanceHistory);
    el.dataset.loadState = "success";
  } catch (e) {
    if (generation === todayLoadGeneration) handleTodayError(el, e);
  } finally {
    if (generation === todayLoadGeneration && el.dataset.loadState === "loading") {
      renderTodayError(el, "Unable to load today's data. Please try again.");
    }
  }
}

function renderTodaySuccess(el, dashboard, plan, nutrition, gym, growImpact, growImpactError = false, workoutHistory = [], gymAttendanceHistory = []) {
  const activePlanLabel = plan?.activePlan?.structureLabel || plan?.activePlan || null;
  const workoutName = dashboard?.todaysPlan?.focus || plan?.nextWorkout?.label || (plan?.cycleStatus === "COMPLETED" ? "Cycle complete" : "No active plan");
  const statusLabel = dashboard?.todaysPlan?.status === "completed" ? "Completed" : plan?.cycleStatus === "IN_PROGRESS" ? "In progress" : plan?.cycleStatus === "COMPLETED" ? "Cycle complete" : "Not started";
  const nextWorkout = plan?.nextWorkout?.label || "No workout scheduled";
  const recentlyTrained = plan?.recentlyTrainedMuscles?.[0]?.muscle || "No recent training";
  const unitCount = Array.isArray(plan?.units) ? plan.units.length : 0;
  const calories = nutrition?.totals?.calories;
  const nearbyFoodCount = nutrition?.meals?.length;
  const weeklyVolume = dashboard?.progress?.weeklyVolumeKg ?? 0;
  const workoutsThisWeek = dashboard?.progress?.workoutsThisWeek ?? 0;

  el.innerHTML = `
    <section class="today-workout-card" aria-labelledby="today-workout-title">
      <div class="today-section-label">Today's workout</div>
      <div class="today-workout-heading">
        <h2 id="today-workout-title">${escapeImpactText(workoutName)}</h2>
        <span class="today-workout-status"><span aria-hidden="true"></span>${statusLabel}</span>
      </div>
      <p class="today-workout-split">${escapeImpactText(typeof activePlanLabel === "string" ? activePlanLabel : "Choose a workout structure in Workout")}</p>
      <div class="today-workout-context">
        <div><span>Recently trained</span><strong>${escapeImpactText(recentlyTrained)}</strong></div>
        <div><span>Next workout</span><strong>${escapeImpactText(nextWorkout)}</strong></div>
        ${plan?.planSwitchAllowed === false && plan?.activePlan
          ? `<div class="today-plan-lock">${todayIcon("lock", 15)}<span><strong>Plan switching locked</strong><small>Complete all ${unitCount || "remaining"} workouts in this cycle to switch plans.</small></span></div>`
          : ""}
      </div>
      ${plan?.decision?.warning ? `<p class="today-workout-warning">${todayIcon("alert", 15)}<span>${escapeImpactText(plan.decision.warning)}</span></p>` : ""}
    </section>
    <section class="today-stats-grid" aria-label="Today's fitness summary">
      <article class="today-stat-card">
        <div class="today-stat-heading">${todayIcon("calories")}<span>Calories</span></div>
        <strong class="today-stat-value">${calories ?? "—"}</strong>
        <span class="today-stat-sub">${nutrition ? "planned today" : "not available"}</span>
      </article>
      <article class="today-stat-card">
        <div class="today-stat-heading">${todayIcon("food")}<span>Nearby food</span></div>
        <strong class="today-stat-value">${nearbyFoodCount ?? "—"}</strong>
        <span class="today-stat-sub">${nutrition ? "meals available" : "not available"}</span>
      </article>
      <article class="today-stat-card">
        <div class="today-stat-heading">${todayIcon("volume")}<span>Weekly volume</span></div>
        <strong class="today-stat-value">${escapeImpactText(weeklyVolume)}<small>kg</small></strong>
        <span class="today-stat-sub">${workoutsThisWeek} workouts this week</span>
      </article>
      <article class="today-stat-card">
        <div class="today-stat-heading">${todayIcon("gym")}<span>Gym check-in</span></div>
        <strong class="today-stat-value">${gym ? gym.checkedIn ? "Yes" : "No" : "—"}</strong>
        <span class="today-stat-sub">${gym ? gym.checkedIn ? "checked in today" : "not checked in" : "not available"}</span>
      </article>
    </section>
    ${growImpact ? renderGrowImpact(growImpact, workoutHistory, gymAttendanceHistory) : renderGrowImpactUnavailable(growImpactError)}
  `;
  bindGrowImpactActions(el, workoutHistory);
}

function renderGrowImpactUnavailable(failed) {
  return `<section class="today-grow-card" aria-labelledby="grow-impact-title" role="status">
    <div class="today-grow-card-heading"><span class="today-section-label">Monthly consistency</span><h2 id="grow-impact-title">Grow Your Impact</h2></div>
    <p class="today-grow-message">${failed ? "Your monthly progress could not be loaded." : "Loading your monthly progress…"}</p>
    ${failed ? '<button class="today-retry-button" type="button" data-retry-grow-impact>Try again</button>' : ""}
  </section>`;
}

function escapeImpactText(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function renderGrowImpact(impact, workoutHistory = [], gymAttendanceHistory = []) {
  const percent = Math.max(0, Math.min(100, Number(impact.progressPercent) || 0));
  const count = Number(impact.sessions) || 0;
  const target = Math.max(0, Number(impact.target) || 0);
  const completed = count >= target && target > 0;
  const attendanceDays = Array.isArray(gymAttendanceHistory)
    ? new Set(gymAttendanceHistory.map((attendance) => attendance.date).filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date))).size
    : null;
  const remainingDays = daysRemainingInMonth(impact.month, impact.calendarDays, impact.timeZone);
  const streak = currentWorkoutStreak(impact.completedSessionDates, workoutHistory, impact.month, impact.timeZone);
  const reward = impact.reward;
  const tree = impact.trees?.find((option) => option.id === reward?.selectedSpeciesId) || (reward?.selectedSpeciesId ? {
    id: reward.selectedSpeciesId,
    name: reward.selectedTreeName || "Your selected tree",
    species: reward.selectedSpecies || reward.selectedSpeciesId,
    image: reward.selectedTreeImage || "",
    description: "",
  } : null);
  let rewardPanel = "";

  if (!reward && completed) {
    rewardPanel = `<p class="grow-impact-unlocked">Your virtual tree reward is ready. Pick one of three trees below.</p>
      <div class="grow-impact-options">${(impact.trees || []).map((option) => renderTreeOption(option, null)).join("")}</div>`;
  } else if (reward?.status === "unlocked" && completed) {
    rewardPanel = `<p class="grow-impact-unlocked">Your virtual tree reward is ready. Pick one of three trees below.</p>
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

  const holidayOptions = (impact.holidayDates || []).filter((holiday) => holiday.source === "public").map((holiday) => {
    const openOnHoliday = (impact.settings?.gymOpenOnHolidayDates || []).includes(holiday.date);
    return `<label class="grow-impact-holiday"><input type="checkbox" data-impact-open-holiday value="${escapeImpactText(holiday.date)}" ${openOnHoliday ? "checked" : ""} />
      <span>${escapeImpactText(holiday.date)} · ${escapeImpactText(holiday.name)}${holiday.sunday ? " · Sunday" : ""}</span></label>`;
  }).join("");
  const closures = (impact.settings?.additionalClosureDates || []).filter((date) => date.startsWith(`${impact.month}-`)).map((date) =>
    `<li><span>${escapeImpactText(date)}</span><button type="button" data-remove-impact-closure="${escapeImpactText(date)}" aria-label="Remove closure on ${escapeImpactText(date)}">Remove</button></li>`
  ).join("");
  const locations = (impact.locations || []).map((location) =>
    `<option value="${escapeImpactText(location.key)}" ${location.key === impact.location?.key ? "selected" : ""}>${escapeImpactText(location.regionName)}, ${escapeImpactText(location.countryName)}</option>`
  ).join("");
  return `<section class="today-grow-card grow-impact-card" aria-labelledby="grow-impact-title"
    data-open-holiday-dates="${escapeImpactText(JSON.stringify(impact.settings?.gymOpenOnHolidayDates || []))}"
    data-additional-closure-dates="${escapeImpactText(JSON.stringify(impact.settings?.additionalClosureDates || []))}">
    <header class="today-grow-header">
      <div class="today-grow-card-heading"><span class="today-section-label">Monthly consistency</span><h2 id="grow-impact-title">Grow Your Impact</h2></div>
      <label class="today-month-select" aria-label="Choose a calendar month">${todayIcon("calendar", 16)}<input class="grow-impact-month" type="month" data-impact-month value="${escapeImpactText(impact.month)}" /></label>
    </header>
    <div class="today-grow-stage-progress">
      ${attendanceDays === null ? '<span class="grow-impact-attendance-unavailable" role="status">Attendance data unavailable</span>' : renderImpactPlant(attendanceDays)}
      <div class="today-grow-stage-progress-main">
        <div class="today-grow-progress-copy"><strong>${count}</strong><span>of ${target} sessions completed</span></div>
        <div class="today-grow-progress" role="progressbar" aria-label="Monthly workout progress" aria-valuemin="0" aria-valuemax="${Math.max(1, target)}" aria-valuenow="${Math.min(count, target)}"><span style="width:${percent}%"></span></div>
      </div>
    </div>
    <div class="today-grow-metrics" aria-label="Monthly workout summary">
      <div><span>Days remaining</span><strong>${remainingDays}</strong></div>
      <div><span>Workouts this month</span><strong>${count}</strong></div>
      <div><span>Current streak</span><strong>${streak === null ? "—" : streak}</strong></div>
    </div>
    ${completed ? '<p class="today-grow-complete" role="status">Monthly goal reached</p>' : ""}
    <p class="today-grow-feedback grow-impact-feedback" role="status" aria-live="polite"></p>
    <details class="today-grow-details">
      <summary>Calendar settings and rewards</summary>
      <div class="today-grow-details-content">
        <div class="today-grow-calendar-summary">
          <span><strong>${impact.eligibleDays}</strong> eligible gym days</span>
          <span><strong>${impact.remaining}</strong> sessions remaining</span>
          <span><strong>${impact.holidayCount}</strong> public holidays</span>
          <span><strong>${impact.additionalClosureCount || 0}</strong> additional closures</span>
        </div>
        <p class="grow-impact-location-line">${escapeImpactText(impact.location?.regionName)}, ${escapeImpactText(impact.location?.countryName)} · ${escapeImpactText(impact.timeZone)}</p>
        ${impact.holidayCalendarConfigured === false ? `<p class="grow-impact-calendar-warning" role="status">No public holiday calendar is configured for ${escapeImpactText(impact.year)}. This target excludes Sundays and configured gym closures only.</p>` : ""}
        <details class="today-grow-calendar-settings">
          <summary>Gym calendar</summary>
          <label class="grow-impact-setting-label">Holiday location<select data-impact-location>${locations}</select></label>
          <p>Public holidays are excluded by default. Check a holiday if your gym stays open. Add dates when it is closed.</p>
          ${holidayOptions ? `<div class="grow-impact-holiday-list">${holidayOptions}</div>` : `<p>No public holidays are configured for this month.</p>`}
          <label class="grow-impact-setting-label">Additional gym closure<input type="date" data-impact-new-closure /></label>
          <button type="button" class="btn btn-secondary grow-impact-add-closure">Add closure date</button>
          ${closures ? `<ul class="grow-impact-closure-list">${closures}</ul>` : ""}
          <button type="button" class="btn btn-primary grow-impact-save-settings">Save calendar settings</button>
        </details>
        ${rewardPanel}
        <p class="grow-impact-virtual-label">Pilot reward · virtual commitment only. FitOS does not claim that a real tree has been planted.</p>
      </div>
    </details>
  </section>`;
}

function renderImpactPlant(attendanceDays) {
  const dayCount = Math.max(0, Number(attendanceDays) || 0);
  const stages = [
    { min: 25, name: "mature plant", height: 62, width: 4.8, leaves: [.16, .34, .52, .7, .86], leafSize: 1 },
    { min: 15, name: "strong young plant", height: 54, width: 4.2, leaves: [.22, .44, .66, .86], leafSize: .92 },
    { min: 10, name: "young plant", height: 46, width: 3.5, leaves: [.28, .55, .82], leafSize: .82 },
    { min: 5, name: "developed seedling", height: 36, width: 2.8, leaves: [.36, .72], leafSize: .72 },
    { min: 3, name: "seedling with first leaves", height: 26, width: 2.2, leaves: [.56], leafSize: .6 },
    { min: 2, name: "emerging sprout", height: 13, width: 1.8, leaves: [.72], leafSize: .38 },
    { min: 0, name: "seed", height: 0, width: 0, leaves: [], leafSize: 0 },
  ];
  const stage = stages.find((candidate) => dayCount >= candidate.min);
  const soilY = 78;
  const topY = soilY - stage.height;
  const leafMarkup = stage.leaves.flatMap((position, index) => {
    const y = topY + stage.height * position;
    const size = stage.leafSize * (0.82 + index * 0.035);
    const color = index % 2 ? "#668d55" : "#789c61";
    return [-1, 1].map((side) => `<path d="M0 0 C${side * 5} -${8 * size} ${side * 17} -${10 * size} ${side * 23} -${5 * size} C${side * 18} ${2 * size} ${side * 7} ${4 * size} 0 0Z" transform="translate(90 ${y})" fill="${color}"/>`);
  }).join("");
  const stem = stage.height > 0
    ? `<path d="M90 ${soilY + 1} C${88 - stage.height * .03} ${soilY - stage.height * .32} ${92 + stage.height * .025} ${soilY - stage.height * .72} 90 ${topY}" fill="none" stroke="#567a4e" stroke-width="${stage.width}" stroke-linecap="round"/>`
    : "";
  const seed = dayCount < 3
    ? '<path d="M83 79c1-5 7-8 13-6 2 1 3 3 2 5-2 4-8 6-12 4-2-1-3-2-3-3Z" fill="#876343" stroke="#694a34" stroke-width="1"/><path d="M86 79c3-2 6-3 10-3" fill="none" stroke="#b08a5d" stroke-width="1" stroke-linecap="round"/>'
    : "";
  const water = dayCount === 2
    ? '<path d="M70 67c-2 4-3 5-3 7a3 3 0 0 0 6 0c0-2-1-3-3-7Zm39 2c-2 3-2 4-2 6a2.5 2.5 0 0 0 5 0c0-2-1-3-3-6Z" fill="#8fb8a1" opacity=".9"/>'
    : "";
  const accessibleStage = dayCount < 1 ? "seed, no attendance recorded" : `${stage.name}, ${dayCount} gym attendance ${dayCount === 1 ? "day" : "days"}`;

  return `<svg class="grow-impact-plant-art" viewBox="0 0 180 112" role="img" aria-label="${accessibleStage}" xmlns="http://www.w3.org/2000/svg">
    <ellipse cx="90" cy="91" rx="49" ry="5" fill="#263328" opacity=".08"/>
    <path d="M42 81c9-4 18-3 25-1 12-4 20-2 27 0 13-4 25-2 44 1v15H42Z" fill="#795c43"/>
    <path d="M42 81c9-4 18-3 25-1 12-4 20-2 27 0 13-4 25-2 44 1" fill="none" stroke="#a17b58" stroke-width="2" stroke-linecap="round"/>
    <path d="M53 87h5m8 5h4m41-6h5m13 6h4m-55-9 2 1m31 11 2-1" stroke="#c09a70" stroke-width="1.5" stroke-linecap="round" opacity=".75"/>
    ${water}${leafMarkup}${stem}${seed}
  </svg>`;
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

function bindGrowImpactActions(root, workoutHistory = []) {
  root.querySelector("[data-retry-grow-impact]")?.addEventListener("click", () => {
    todayRequest = null;
    void loadToday();
  });

  root.querySelectorAll("[data-grow-tree]").forEach((button) => button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      const month = root.querySelector("[data-impact-month]")?.value;
      await Api.post("/grow-impact/select", { speciesId: button.dataset.growTree, month });
      await refreshCard(month);
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
      const month = root.querySelector("[data-impact-month]")?.value;
      await Api.post("/grow-impact/confirm", { month });
      await refreshCard(month);
    } catch (error) {
      const feedback = root.querySelector(".grow-impact-feedback");
      if (feedback) feedback.textContent = error?.message || "Could not confirm your tree choice.";
      confirmButton.disabled = false;
    }
  });

  const refreshCard = async (month, settingsPayload) => {
    const feedback = root.querySelector(".grow-impact-feedback");
    try {
      if (settingsPayload) await Api.put("/grow-impact/settings", settingsPayload);
      const query = new URLSearchParams();
      if (month) query.set("month", month);
      const impact = await Api.get(`/grow-impact/?${query.toString()}`);
      const card = root.querySelector(".grow-impact-card");
      if (card) card.outerHTML = renderGrowImpact(impact, workoutHistory);
      bindGrowImpactActions(root, workoutHistory);
    } catch (error) {
      if (feedback) feedback.textContent = error?.message || "Could not update the monthly calendar.";
    }
  };

  const monthInput = root.querySelector("[data-impact-month]");
  monthInput?.addEventListener("change", () => {
    if (/^\d{4}-(0[1-9]|1[0-2])$/.test(monthInput.value)) void refreshCard(monthInput.value);
  });

  const buildSettingsPayload = (clearOpenHolidayDates = false) => {
    const card = root.querySelector(".grow-impact-card");
    const locationKey = card?.querySelector("[data-impact-location]")?.value;
    const month = card?.querySelector("[data-impact-month]")?.value;
    const currentOpenDates = card?.querySelectorAll("[data-impact-open-holiday]:checked") || [];
    const shownPublicDates = [...(card?.querySelectorAll("[data-impact-open-holiday]") || [])].map((input) => input.value);
    const savedOpenDates = card?.dataset.openHolidayDates ? JSON.parse(card.dataset.openHolidayDates) : [];
    const openDates = clearOpenHolidayDates ? [] : [
      ...savedOpenDates.filter((date) => !date.startsWith(`${month}-`) && !shownPublicDates.includes(date)),
      ...[...currentOpenDates].map((input) => input.value),
    ];
    const closureDates = card?.dataset.additionalClosureDates ? JSON.parse(card.dataset.additionalClosureDates) : [];
    return { locationKey, gymOpenOnHolidayDates: [...new Set(openDates)], additionalClosureDates: closureDates };
  };

  const locationSelect = root.querySelector("[data-impact-location]");
  locationSelect?.addEventListener("change", () => {
    const payload = buildSettingsPayload(true);
    void refreshCard(root.querySelector("[data-impact-month]")?.value, payload);
  });

  root.querySelector(".grow-impact-save-settings")?.addEventListener("click", () => {
    const payload = buildSettingsPayload(false);
    void refreshCard(root.querySelector("[data-impact-month]")?.value, payload);
  });

  root.querySelector(".grow-impact-add-closure")?.addEventListener("click", () => {
    const card = root.querySelector(".grow-impact-card");
    const date = card?.querySelector("[data-impact-new-closure]")?.value;
    if (!date) return;
    const payload = buildSettingsPayload(false);
    payload.additionalClosureDates = [...new Set([...payload.additionalClosureDates, date])];
    void refreshCard(card?.querySelector("[data-impact-month]")?.value, payload);
  });

  root.querySelectorAll("[data-remove-impact-closure]").forEach((button) => button.addEventListener("click", () => {
    const card = root.querySelector(".grow-impact-card");
    const payload = buildSettingsPayload(false);
    payload.additionalClosureDates = payload.additionalClosureDates.filter((date) => date !== button.dataset.removeImpactClosure);
    void refreshCard(card?.querySelector("[data-impact-month]")?.value, payload);
  }));
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
      const generated = await Api.post("/workouts/generate", request, { timeoutMs: 30000 });
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
    const savedEquipment = Array.isArray(saved) ? saved : [];
    const savedNames = new Set(savedEquipment.map((item) => item.name).filter((name) => name && name !== "No Equipment"));
    const catalogItems = (Array.isArray(catalog) ? catalog : []).filter((item) => item.name !== "No Equipment");
    const catalogNames = new Set(catalogItems.map((item) => item.name));
    equipment = [...catalogItems, ...savedEquipment.filter((item) => !catalogNames.has(item.name))];
    selected = savedNames;
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
      }, { timeoutMs: 30000 });
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

let youtubeIframeApiPromise = null;

// Upper bounds so a blocked script or a stalled player can never leave the UI
// on "Loading demonstration…" indefinitely.
const YOUTUBE_IFRAME_API_TIMEOUT_MS = 10000;
const EXERCISE_DEMO_PLAYER_TIMEOUT_MS = 8000;

function loadYouTubeIframeApi() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (youtubeIframeApiPromise) return youtubeIframeApiPromise;
  youtubeIframeApiPromise = new Promise((resolve) => {
    let settled = false;
    const finish = (api) => {
      if (settled) return;
      settled = true;
      resolve(api?.Player ? api : null);
    };
    const previousReady = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      if (typeof previousReady === "function") previousReady();
      finish(window.YT);
    };
    // This promise must always settle. The timeout is armed before the script is
    // touched so a blocked script, a throwing injection, or an API that never
    // calls onYouTubeIframeAPIReady all resolve to null instead of hanging.
    window.setTimeout(() => finish(window.YT), YOUTUBE_IFRAME_API_TIMEOUT_MS);
    try {
      let script = document.querySelector('script[data-youtube-iframe-api]');
      if (!script) {
        script = document.createElement("script");
        script.src = "https://www.youtube.com/iframe_api";
        script.async = true;
        script.dataset.youtubeIframeApi = "true";
        script.addEventListener("error", () => finish(null), { once: true });
        document.head.append(script);
      }
    } catch {
      finish(null);
    }
  });
  return youtubeIframeApiPromise;
}

function exerciseDemoInstructions(exercise, demo) {
  const name = String(exercise?.exerciseName || demo?.title || "Exercise");
  const exerciseKey = name.toLowerCase();
  const eccentricRow = /eccentric emphasis/.test(exerciseKey) && /seated cable row|row/.test(exerciseKey);
  const storedInstructions = String(demo?.instructions || exercise?.instructions || "").trim();
  if (storedInstructions) {
    return eccentricRow && !/3 seconds|three seconds|slowly/i.test(storedInstructions)
      ? `${storedInstructions} Emphasize the return by extending your arms over about 3 seconds while keeping the cable under tension.`
      : storedInstructions;
  }
  const patterns = {
    horizontal_push: "Brace your torso, press the resistance away from your chest, then return it under control.",
    vertical_push: "Brace your torso and press the resistance overhead through a comfortable range, then lower it under control.",
    horizontal_pull: "Brace your torso and pull the resistance toward your ribs, then extend your arms under control.",
    vertical_pull: "Keep your torso steady, pull down with your elbows toward your sides, then return overhead under control.",
    squat: "Keep your whole foot grounded, sit your hips down and back with knees tracking over toes, then stand with control.",
    hinge: "Keep a soft bend in your knees, hinge at your hips with the load close, then extend your hips to stand.",
    lunge: "Use a stable split stance, lower with control while keeping your front knee aligned over your foot, then return to standing.",
    elbow_flexion: "Keep your upper arms steady, flex your elbows to raise the resistance, then lower it slowly.",
    elbow_extension: "Keep your upper arms steady, extend your elbows against the resistance, then return slowly.",
    abduction: "Keep your torso steady, move the working limb away from your midline, then return slowly.",
    plantarflexion: "Rise through the balls of your feet, pause, then lower your heels slowly through a comfortable range.",
    anti_extension: "Brace your abdomen and keep your spine neutral while resisting movement through your trunk.",
    flexion: "Brace your trunk and curl through a comfortable range without swinging, then return slowly.",
    rotation: "Brace your hips and rotate through your trunk under control, then return to the starting position.",
  };
  const equipment = (exercise?.equipmentRequired || []).filter(Boolean);
  const setup = equipment.length ? `Set up ${name} with ${equipment.join(" and ")}.` : `Set up for ${name} using bodyweight.`;
  const movementPattern = String(exercise?.movementPattern || "").toLowerCase();
  const isRow = movementPattern === "horizontal_pull" || /\brow\b|pulldown|pull-up/.test(exerciseKey);
  if (eccentricRow) {
    return `${setup} Sit tall with your feet braced. Pull the handle toward your lower ribs, then extend your arms back over about 3 seconds while keeping tension on the cable. Avoid rocking your torso.`;
  }
  const inferredPattern = isRow ? "horizontal_pull"
    : /press|push-up/.test(exerciseKey) ? "horizontal_push"
      : /curl/.test(exerciseKey) ? "elbow_flexion"
        : /squat/.test(exerciseKey) ? "squat"
          : /deadlift|hinge/.test(exerciseKey) ? "hinge"
            : movementPattern;
  const movement = patterns[inferredPattern]
    || "Move through a comfortable range with controlled tempo, then return to the starting position without swinging.";
  const target = exercise?.primaryMuscle || exercise?.muscle;
  return [setup, movement, target ? `Focus on ${target}.` : "Keep the target muscles engaged.", "Stop if you feel pain."]
    .join(" ");
}

function showUnavailableExerciseDemo(player, exercise, demo, message) {
  delete player.dataset.loading;
  const fallback = document.createElement("div");
  fallback.className = "exercise-demo-fallback exercise-demo-unavailable";
  const heading = document.createElement("strong");
  heading.textContent = `${exercise.exerciseName} · Written guide`;
  const instructions = document.createElement("p");
  instructions.textContent = exerciseDemoInstructions(exercise, demo);
  const hint = document.createElement("span");
  hint.className = "exercise-demo-fallback-hint";
  hint.textContent = message || "Use the exercise chat below if you need more detail.";
  fallback.append(heading, instructions, hint);
  player.replaceChildren(fallback);
}

async function requestRefreshedExerciseDemo(exercise, excludeVideoId) {
  if (!exercise?.exerciseId) return null;
  try {
    const params = new URLSearchParams({ refresh: "1" });
    if (excludeVideoId) params.set("exclude", excludeVideoId);
    const result = await Api.get(`/exercises/${encodeURIComponent(exercise.exerciseId)}/demo-video?${params.toString()}`);
    const demo = result?.demoVideo;
    return demo && demo.kind === "video" ? demo : null;
  } catch {
    // A failed refresh lookup simply keeps the exercise-specific written guide.
    return null;
  }
}

async function startExerciseDemoPlayer(player, button, exercise) {
  const demo = exercise?.demoVideo;
  if (!demo || demo.kind !== "video" || !demo.videoId) {
    if (exercise) showUnavailableExerciseDemo(player, exercise, demo);
    return;
  }
  player.hidden = false;
  player.dataset.loading = "true";
  button.disabled = true;
  player.textContent = "Loading demonstration…";
  const api = await loadYouTubeIframeApi();
  if (api) {
    const host = document.createElement("div");
    player.replaceChildren(host);
    let settled = false;
    let timer = null;
    // One settle point so onReady, onError and the init timeout can never run the
    // fallback or the one-time refresh more than once.
    const settle = () => {
      if (settled) return false;
      settled = true;
      if (timer !== null) window.clearTimeout(timer);
      return true;
    };
    try {
      new api.Player(host, {
        width: "100%",
        height: "100%",
        videoId: demo.videoId,
        playerVars: { autoplay: 0, controls: 1, enablejsapi: 1, playsinline: 1, rel: 0 },
        events: {
          onReady: () => {
            if (!settle()) return;
            delete player.dataset.loading;
            button.disabled = false;
            button.hidden = true;
          },
          onError: () => {
            if (!settle()) return;
            fallbackExerciseDemoPlayback(player, button, exercise, demo);
          },
        },
      });
    } catch {
      // A player that throws during construction falls back immediately.
      if (settle()) fallbackExerciseDemoPlayback(player, button, exercise, demo);
      return;
    }
    // If the player never reports ready or error (blocked embed, stalled
    // network), stop the loading state and fall back instead of hanging.
    if (!settled) {
      timer = window.setTimeout(() => {
        if (settle()) fallbackExerciseDemoPlayback(player, button, exercise, demo);
      }, EXERCISE_DEMO_PLAYER_TIMEOUT_MS);
    }
    return;
  }
  fallbackExerciseDemoPlayback(player, button, exercise, demo);
}

async function fallbackExerciseDemoPlayback(player, button, exercise, demo) {
  delete player.dataset.loading;
  button.disabled = false;
  button.hidden = false;
  // The cached lookup returned a video that cannot actually be embedded here, so
  // ask the backend for a fresh one (excluding it) exactly once.
  if (!button.dataset.refreshed) {
    button.dataset.refreshed = "true";
    const refreshed = await requestRefreshedExerciseDemo(exercise, demo?.videoId);
    if (refreshed) {
      exercise.demoVideo = refreshed;
      await startExerciseDemoPlayer(player, button, exercise);
      return;
    }
  }
  showUnavailableExerciseDemo(player, exercise, exercise?.demoVideo || demo,
    "Demonstration currently unavailable.");
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
  const targetMuscles = [...new Map((workout.targetMuscles || [])
    .filter((muscle) => typeof muscle === "string" && muscle.trim())
    .map((muscle) => [muscle.trim().toLowerCase(), muscle.trim()])).values()];
  const equipmentChoices = [...new Set([
    "Bodyweight",
    ...(Array.isArray(workout.availableEquipmentNames) ? workout.availableEquipmentNames : []),
    ...exercises.map((exercise) => exercise.machine).filter(Boolean),
  ].filter((name) => name !== "FULL_GYM"))];
  const canEditWorkout = !completedWorkout && loggedSets === 0;
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
    const equipment = equipmentLine(exercise);
    const skipped = exercise.status === "skipped";
    const isDone = skipped || exercise.status === "completed" || item.nextSetNumber === undefined;
    const isActive = index === activeIndex;
    const stateLabel = skipped ? "SKIPPED" : isDone ? "DONE" : isActive ? "UP NEXT" : "COMING UP";
    const stateClass = skipped ? "skipped" : isDone ? "done" : isActive ? "active" : "later";
    const setLabel = `${item.completedSetRows.length}/${item.targetSets} sets`;
    const repLabel = `${Number(exercise.repRangeLow) || 1}–${Number(exercise.repRangeHigh) || Number(exercise.repRangeLow) || 1} reps`;
    const hasLoggedSets = item.completedSetRows.length > 0;
    const swapButton = canEditWorkout && !hasLoggedSets && exercise.status !== "completed" && exercise.status !== "skipped"
      ? `<button class="btn btn-outline workout-swap-btn" data-action="swap" data-id="${escapeWorkoutText(exercise.workoutExerciseId)}">Swap</button>`
      : "";
    const dragHandle = canEditWorkout
      ? `<button class="workout-drag-handle" type="button" data-index="${index}" aria-label="Reorder ${escapeWorkoutText(exercise.exerciseName)}" title="Drag to reorder"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 5h10M3 11h10" /></svg></button>`
      : `<span class="workout-exercise-number">${isDone && !skipped ? "✓" : index + 1}</span>`;
    const controls = canEditWorkout
      ? `<div class="workout-exercise-actions">
          <button class="btn btn-outline" data-action="edit-exercise" data-id="${escapeWorkoutText(exercise.workoutExerciseId)}">Edit exercise</button>
          ${swapButton}
        </div>
        <form class="workout-edit-form" data-id="${escapeWorkoutText(exercise.workoutExerciseId)}" data-original-exercise-id="${escapeWorkoutText(exercise.exerciseId || "")}" data-confirmed-exercise-id="${escapeWorkoutText(exercise.exerciseId || "")}" hidden>
          <label>Exercise name<input name="exerciseName" maxlength="100" required value="${escapeWorkoutText(exercise.exerciseName)}"></label>
          <label>Target muscle<select name="targetMuscle" required>${targetMuscles.map((muscle) => `<option value="${escapeWorkoutText(muscle)}" ${muscle.toLowerCase() === String(exercise.primaryMuscle || "").toLowerCase() ? "selected" : ""}>${escapeWorkoutText(muscle)}</option>`).join("")}</select></label>
          <label>Equipment<input name="equipmentName" list="workout-equipment-options" maxlength="80" required value="${escapeWorkoutText(equipment)}"></label>
          <button class="btn btn-primary" type="submit">Save and rebalance workout</button>
          <div class="workout-edit-suggestions" hidden></div>
          <button class="btn btn-outline" type="button" data-action="cancel-edit">Cancel</button>
          <small>FitOS will rebuild the other exercises to cover the remaining workout targets.</small>
        </form>`
      : swapButton;
    const demo = exercise.demoVideo || { kind: "instructions", title: `${exercise.exerciseName} instructions` };
    const hasDemoVideo = demo.kind === "video" && Boolean(demo.videoId);
    // Always render a demonstration entry. The exercise-specific video is
    // resolved on demand from the backend when it is not already in the workout payload.
    const demonstration = `<section class="exercise-demonstration" aria-label="Exercise Demonstration">
      <div class="exercise-demonstration-label">Exercise Demonstration</div>
      <div class="exercise-demo" data-video-id="${escapeWorkoutText(exercise.exerciseId || "")}">
        <button class="exercise-demo-preview" type="button" data-action="play-demo" aria-label="Load ${escapeWorkoutText(exercise.exerciseName)} demonstration">
          ${hasDemoVideo && demo.thumbnailUrl
            ? `<img src="${escapeWorkoutText(demo.thumbnailUrl)}" alt="${escapeWorkoutText(exercise.exerciseName)} demonstration video thumbnail" loading="lazy" />`
            : `<span class="exercise-demo-thumbnail-fallback">${hasDemoVideo ? "Play demonstration" : "Load demonstration"}</span>`}
          <span class="exercise-demo-play" aria-hidden="true">▶</span>
        </button>
        <button class="btn btn-mint" type="button" data-action="watch-exercise">Watch Exercise</button>
        <div class="exercise-demo-meta"><span>${escapeWorkoutText(demo.sourceName || "Exercise guide")} · ${hasDemoVideo ? "Inline demonstration" : "Find exercise demonstration"}</span></div>
        <p class="exercise-demo-unavailable-note" hidden>Demonstration currently unavailable.</p>
        <div class="exercise-demo-player" hidden aria-live="polite"></div>
      </div>
    </section>`;
    const exerciseSupport = `<div class="workout-exercise-support">
      <button class="btn btn-outline exercise-chat-toggle" type="button" data-action="ask-exercise" ${exercise.exerciseId ? "" : "disabled"}>Ask about this exercise</button>
      <form class="exercise-chat-form" data-exercise-id="${escapeWorkoutText(exercise.exerciseId || "")}" hidden>
        <label>Ask about ${escapeWorkoutText(exercise.exerciseName)}<textarea name="question" maxlength="500" rows="2" required placeholder="Form, setup, breathing, common mistakes, or alternatives"></textarea></label>
        <button class="btn btn-primary" type="submit">Ask</button>
        <div class="exercise-chat-answer" aria-live="polite" hidden></div>
      </form>
    </div>`;
    return `<article class="workout-exercise-row ${stateClass}" data-index="${index}">
      ${dragHandle}
      <div class="workout-exercise-copy"><strong>${escapeWorkoutText(exercise.exerciseName)}</strong><span>${escapeWorkoutText(exercise.muscle || exercise.primaryMuscle || "Full body")} · ${escapeWorkoutText(equipmentLine(exercise))} · ${setLabel} · ${repLabel}</span></div>
      <span class="workout-exercise-state">${stateLabel}</span>${demonstration}${controls}${exerciseSupport}
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
      <datalist id="workout-equipment-options">${equipmentChoices.map((name) => `<option value="${escapeWorkoutText(name)}"></option>`).join("")}</datalist>
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
        const generated = await Api.post("/workouts/generate", request, { timeoutMs: 30000 });
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

  const saveExerciseOrder = async (from, to) => {
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0
      || from >= workout.exercises.length || to >= workout.exercises.length || from === to) return;
    const reordered = [...workout.exercises];
    const [moved] = reordered.splice(from, 1);
    reordered.splice(to, 0, moved);
    try {
      await Api.post(`/workouts/${workout.id}/reorder-exercises`, {
        workoutExerciseIds: reordered.map((exercise) => exercise.workoutExerciseId),
      });
      renderWorkout({ ...workout, exercises: reordered }, plan);
    } catch (error) {
      showWorkoutNotice(error.message || "Could not reorder exercises.", "error");
    }
  };
  el.querySelectorAll(".workout-drag-handle").forEach((handle) => {
    handle.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      event.preventDefault();
      const from = Number(handle.dataset.index);
      void saveExerciseOrder(from, from + (event.key === "ArrowUp" ? -1 : 1));
    });
  });
  let activeDrag = null;
  const clearDragMarks = () => {
    el.querySelectorAll(".workout-exercise-row.is-dragging, .workout-exercise-row.is-drop-target")
      .forEach((row) => row.classList.remove("is-dragging", "is-drop-target"));
  };
  const finishDrag = (event, cancelled = false) => {
    if (!activeDrag || (event && event.pointerId !== activeDrag.pointerId)) return;
    const { from, to } = activeDrag;
    activeDrag = null;
    document.removeEventListener("pointermove", moveDrag);
    document.removeEventListener("pointerup", finishDrag);
    document.removeEventListener("pointercancel", cancelDrag);
    clearDragMarks();
    if (!cancelled) void saveExerciseOrder(from, to);
  };
  const cancelDrag = (event) => finishDrag(event, true);
  const moveDrag = (event) => {
    if (!activeDrag || event.pointerId !== activeDrag.pointerId) return;
    event.preventDefault();
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest(".workout-exercise-row");
    const nextIndex = Number(target?.dataset.index);
    if (!target || !el.contains(target) || !Number.isInteger(nextIndex)
      || nextIndex < 0 || nextIndex >= workout.exercises.length) return;
    el.querySelectorAll(".workout-exercise-row.is-drop-target").forEach((row) => row.classList.remove("is-drop-target"));
    target.classList.add("is-drop-target");
    activeDrag.to = nextIndex;
  };
  el.querySelectorAll(".workout-drag-handle").forEach((handle) => {
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || activeDrag) return;
      event.preventDefault();
      const row = handle.closest(".workout-exercise-row");
      const from = Number(handle.dataset.index);
      if (!row || !Number.isInteger(from)) return;
      activeDrag = { pointerId: event.pointerId, from, to: from };
      row.classList.add("is-dragging");
      handle.setPointerCapture?.(event.pointerId);
      document.addEventListener("pointermove", moveDrag, { passive: false });
      document.addEventListener("pointerup", finishDrag);
      document.addEventListener("pointercancel", cancelDrag);
    });
  });

  el.querySelectorAll('[data-action="edit-exercise"]').forEach((button) => {
    button.addEventListener("click", () => {
      const form = button.closest(".workout-exercise-row")?.querySelector(".workout-edit-form");
      if (form) form.hidden = !form.hidden;
    });
  });
  el.querySelectorAll(".exercise-demo-preview img").forEach((image) => {
    image.addEventListener("error", () => {
      const preview = image.closest(".exercise-demo-preview");
      if (!preview || preview.querySelector(".exercise-demo-thumbnail-fallback")) return;
      image.hidden = true;
      const fallback = document.createElement("span");
      fallback.className = "exercise-demo-thumbnail-fallback";
      fallback.textContent = "Video preview unavailable";
      preview.append(fallback);
    }, { once: true });
  });
  el.querySelectorAll('[data-action="play-demo"]').forEach((button) => {
    button.addEventListener("click", async () => {
      const row = button.closest(".workout-exercise-row");
      const exerciseId = row?.querySelector(".exercise-demo")?.dataset.videoId;
      const exercise = exercises.find((item) => item.exerciseId === exerciseId);
      const player = row?.querySelector(".exercise-demo-player");
      if (!exercise || !player || player.dataset.loading === "true" || player.querySelector("iframe")) return;
      if (!exercise.demoVideo || exercise.demoVideo.kind !== "video" || !exercise.demoVideo.videoId) {
        player.hidden = false;
        player.dataset.loading = "true";
        player.textContent = "Finding a demonstration for this exercise…";
        button.disabled = true;
        try {
          const result = await Api.get(`/exercises/${encodeURIComponent(exercise.exerciseId)}/demo-video`, { timeoutMs: 12000 });
          exercise.demoVideo = result?.demoVideo || null;
          const demo = exercise.demoVideo;
          if (demo?.kind === "video" && demo.videoId) {
            const demoRoot = row.querySelector(".exercise-demo");
            if (demoRoot) demoRoot.dataset.videoId = exercise.exerciseId;
            const image = button.querySelector("img");
            if (image && demo.thumbnailUrl) image.src = demo.thumbnailUrl;
            const meta = row.querySelector(".exercise-demo-meta span");
            if (meta) meta.textContent = `${demo.sourceName || "Exercise guide"} · Inline demonstration`;
            delete player.dataset.loading;
            button.disabled = false;
            await startExerciseDemoPlayer(player, button, exercise);
          } else {
            delete player.dataset.loading;
            button.disabled = false;
            showUnavailableExerciseDemo(player, exercise, demo, "A video demonstration isn't available right now. Follow the exercise instructions instead.");
          }
        } catch {
          delete player.dataset.loading;
          button.disabled = false;
          player.textContent = "Demonstration temporarily unavailable. Please try again.";
        }
        return;
      }
      await startExerciseDemoPlayer(player, button, exercise);
    });
  });

  el.querySelectorAll('[data-action="watch-exercise"]').forEach((button) => {
    button.addEventListener("click", async () => {
      const row = button.closest(".workout-exercise-row");
      const exerciseId = row?.querySelector(".exercise-demo")?.dataset.videoId;
      const exercise = exercises.find((item) => item.exerciseId === exerciseId);
      if (!exercise) return;

      switchTab("vision");

      const demoPlayer = $("vision-demo-player");
      const demoButton = $("vision-demo-btn");
      if (demoPlayer && demoButton) {
        demoPlayer.replaceChildren();
        demoPlayer.hidden = false;
        demoPlayer.textContent = "Finding a demonstration for this exercise…";
        delete demoButton.dataset.refreshed;
        demoButton.hidden = false;
        demoButton.disabled = true;
        try {
          if (!exercise.demoVideo || exercise.demoVideo.kind !== "video" || !exercise.demoVideo.videoId) {
            const result = await Api.get(`/exercises/${encodeURIComponent(exercise.exerciseId)}/demo-video`, { timeoutMs: 12000 });
            exercise.demoVideo = result?.demoVideo || null;
          }
          demoButton.disabled = false;
          if (exercise.demoVideo?.kind === "video" && exercise.demoVideo.videoId) {
            await startExerciseDemoPlayer(demoPlayer, demoButton, exercise);
          } else {
            showUnavailableExerciseDemo(demoPlayer, exercise, exercise.demoVideo, "A video demonstration isn't available right now. Follow the exercise instructions instead.");
          }
        } catch {
          demoButton.disabled = false;
          demoPlayer.textContent = "Demonstration temporarily unavailable. Please try again.";
        }
      }

      if (window.VisionCoach?.openFor) {
        await window.VisionCoach.openFor(exercise);
      } else {
        const status = $("camera-placeholder");
        if (status) status.textContent = "Live coaching could not be initialized. Please reload FitOS and try again.";
      }
    });
  });
  el.querySelectorAll('[data-action="ask-exercise"]').forEach((button) => {
    button.addEventListener("click", () => {
      const form = button.closest(".workout-exercise-row")?.querySelector(".exercise-chat-form");
      if (!form) return;
      form.hidden = !form.hidden;
      if (!form.hidden) form.elements.question.focus();
    });
  });
  el.querySelectorAll(".exercise-chat-form").forEach((form) => {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const button = form.querySelector('[type="submit"]');
      const answer = form.querySelector(".exercise-chat-answer");
      const question = form.elements.question.value.trim();
      if (!question) return;
      button.disabled = true;
      button.textContent = "Thinking…";
      answer.hidden = false;
      answer.textContent = "Preparing exercise-specific guidance…";
      try {
        const result = await Api.post(`/exercises/${encodeURIComponent(form.dataset.exerciseId)}/ask`, { question }, { timeoutMs: 20000 });
        answer.textContent = result.answer;
      } catch (error) {
        answer.textContent = error.message || "Exercise chat is temporarily unavailable. Please try again later.";
      } finally {
        button.disabled = false;
        button.textContent = "Ask";
      }
    });
  });
  el.querySelectorAll('[data-action="cancel-edit"]').forEach((button) => {
    button.addEventListener("click", () => {
      const form = button.closest(".workout-edit-form");
      if (form) {
        form.reset();
        form.hidden = true;
        form.dataset.confirmedExerciseId = form.dataset.originalExerciseId || "";
        delete form.dataset.validateWithAi;
        const suggestions = form.querySelector(".workout-edit-suggestions");
        if (suggestions) { suggestions.hidden = true; suggestions.replaceChildren(); }
      }
    });
  });
  el.querySelectorAll(".workout-edit-form").forEach((form) => {
    const nameInput = form.elements.exerciseName;
    const equipmentInput = form.elements.equipmentName;
    const syncCatalogSelection = async () => {
      const catalog = await loadWorkoutExerciseCatalog();
      const key = normalizeWorkoutExerciseName(nameInput.value);
      const matches = catalog.filter((exercise) => normalizeWorkoutExerciseName(exercise.name) === key);
      if (matches.length !== 1) return;
      const [exercise] = matches;
      nameInput.value = exercise.name;
      form.dataset.confirmedExerciseId = exercise.id;
      delete form.dataset.validateWithAi;
      const required = Array.isArray(exercise.equipmentRequired) ? exercise.equipmentRequired : [];
      if (required.length) equipmentInput.value = required[0];
      else if (!exercise.requiresEquipment) equipmentInput.value = "Bodyweight";
    };
    nameInput.addEventListener("input", () => {
      delete form.dataset.confirmedExerciseId;
      delete form.dataset.validateWithAi;
      const suggestions = form.querySelector(".workout-edit-suggestions");
      if (suggestions) { suggestions.hidden = true; suggestions.replaceChildren(); }
      void syncCatalogSelection().catch(() => {});
    });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      try { await syncCatalogSelection(); } catch { /* The server remains the authoritative catalog validator. */ }
      const submitButton = form.querySelector('[type="submit"]');
      const body = {
        workoutExerciseId: form.dataset.id,
        exerciseName: form.elements.exerciseName.value,
        targetMuscle: form.elements.targetMuscle.value,
        equipmentName: form.elements.equipmentName.value,
        ...(form.dataset.confirmedExerciseId ? { confirmedExerciseId: form.dataset.confirmedExerciseId } : {}),
        ...(form.dataset.validateWithAi === "true" ? { validateWithAi: true } : {}),
      };
      submitButton.disabled = true;
      submitButton.textContent = "Rebalancing workout…";
      try {
        const result = await Api.post(`/workouts/${workout.id}/edit-exercise`, body, { timeoutMs: 30000 });
        await loadWorkout();
        showWorkoutNotice(`Exercise updated. FitOS refreshed ${result.rebalancedExerciseCount} other movement${result.rebalancedExerciseCount === 1 ? "" : "s"} for workout coverage.`, "success");
      } catch (error) {
        if (error.body?.code === "EXERCISE_CONFIRMATION_REQUIRED" && Array.isArray(error.body.suggestions)) {
          const suggestions = form.querySelector(".workout-edit-suggestions");
          const select = document.createElement("select");
          select.setAttribute("aria-label", "Choose a matching exercise");
          select.required = true;
          select.innerHTML = `<option value="">Choose a matching exercise</option>`;
          error.body.suggestions.forEach((candidate) => {
            const option = document.createElement("option");
            option.value = candidate.id;
            option.textContent = candidate.aiValidated
              ? `${candidate.name} (AI validated)`
              : `${candidate.name} (${candidate.score}% match)`;
            option.dataset.name = candidate.name;
            option.dataset.equipment = candidate.equipmentRequired?.[0] || (candidate.aiValidated ? "Bodyweight" : "");
            select.append(option);
          });
          const confirm = document.createElement("button");
          confirm.type = "button";
          confirm.className = "btn btn-outline";
          confirm.textContent = "Use selected exercise";
          confirm.addEventListener("click", () => {
            const option = select.selectedOptions[0];
            if (!option?.value) { select.focus(); return; }
            nameInput.value = option.dataset.name;
            form.dataset.confirmedExerciseId = option.value;
            if (option.dataset.equipment) equipmentInput.value = option.dataset.equipment;
            delete form.dataset.validateWithAi;
            suggestions.hidden = true;
            form.requestSubmit();
          });
          const validateNew = document.createElement("button");
          validateNew.type = "button";
          validateNew.className = "btn btn-outline";
          validateNew.textContent = "None of these? Validate as a new exercise";
          validateNew.hidden = error.body.suggestions.some((candidate) => candidate.aiValidated);
          validateNew.addEventListener("click", () => {
            delete form.dataset.confirmedExerciseId;
            form.dataset.validateWithAi = "true";
            suggestions.hidden = true;
            form.requestSubmit();
          });
          suggestions.replaceChildren(
            document.createTextNode(error.body.suggestions.some((candidate) => candidate.aiValidated)
              ? "FitOS validated this exercise and added it to the catalogue. Confirm to use it in this workout."
              : "Did you mean one of these catalogue exercises?"),
            select,
            confirm,
            validateNew,
          );
          suggestions.hidden = false;
        } else {
          showWorkoutNotice(error.body?.code === "EXERCISE_NOT_FOUND" || error.body?.code === "EXERCISE_CATALOG_ENTRY_MISSING"
            ? "We couldn't find that exercise. Choose an exercise from the suggestions or keep your current exercise."
            : error.message || "Could not edit the exercise.", "error");
        }
        submitButton.disabled = false;
        submitButton.textContent = "Save and rebalance workout";
      }
    });
  });

  el.querySelectorAll('[data-action="swap"]').forEach((button) => {
    button.addEventListener("click", async () => {
      button.disabled = true;
      button.textContent = "Swapping…";
      try {
        const result = await Api.post(`/workouts/${workout.id}/replace-exercise`, {
          workoutExerciseId: button.dataset.id,
          reason: "user_preference",
        });
        await loadWorkout();
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
  // The Diet screen is rendered by food-tracker.js. Keep this legacy mount empty
  // so the old duplicate food-discovery card is not inserted above the tracker.
  const host = $("diet-content");
  if (host) host.replaceChildren();
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
  const cards = data.recommendations; let visible = 5;
  const render = () => {
    const filter = document.querySelector(".filter.active")?.dataset.filter || "all";
    const filtered = cards.filter((d) => filter === "all"
      || filter === "low" && Number.isFinite(d.calories) && d.calories <= 500
      || filter === "protein" && Number.isFinite(d.proteinG) && d.proteinG >= 20
      || filter === "budget" && Number.isFinite(d.priceInr) && d.priceInr > 0 && d.priceInr <= 300
      || filter === "veg" && d.isVeg === true);
    $("healthy-dishes").innerHTML = filtered.slice(0, visible).map((d, i) => {
      const calories = Number.isFinite(d.calories) ? `~${d.calories} kcal` : "Calories not available";
      const protein = Number.isFinite(d.proteinG) ? `~${d.proteinG} g protein` : "Protein not available";
      const price = Number.isFinite(d.priceInr) && d.priceInr > 0 ? `₹${d.priceInr}` : "Price unavailable";
      const score = Number.isFinite(d.healthScore) ? `${d.healthScore}/100` : "Unavailable";
      const reasons = (Array.isArray(d.reasons) ? d.reasons : []).map((reason) => `<span>✓ ${reason}</span>`).join("");
      const confidence = d.nutritionConfidence === "verified" ? "Verified by source" : d.nutritionConfidence === "llm_estimated" ? "AI estimate; not verified" : "Estimated/unverified";
      const restaurantLink = typeof d.restaurantUrl === "string" && /^https?:\/\//i.test(d.restaurantUrl) ? d.restaurantUrl : "";
      return `<article class="healthy-dish-card" tabindex="0"><div class="dish-rank">${i < 3 ? ["🥇","🥈","🥉"][i] : `#${i + 1}`} Recommendation</div><h3>${d.name}</h3><strong>${d.restaurantName}</strong><div class="dish-score">⭐ Health Score: ${score}</div><div class="dish-nutrition">🔥 ${calories} · 💪 ${protein} · 💰 ${price}</div><div class="dish-reasons">${reasons}</div><p>Nutrition confidence: ${confidence}</p>${restaurantLink ? `<a class="btn btn-outline" href="${restaurantLink}" target="_blank" rel="noopener noreferrer">📍 Open Restaurant Listing</a>` : `<span class="card-sub">Restaurant listing unavailable</span>`}</article>`;
    }).join("") || `<div class="empty-state">No dishes match this filter with the available data. Try All or check the restaurant menu.</div>`;
  };
  render();
  document.querySelectorAll(".filter").forEach((button) => button.addEventListener("click", () => { document.querySelectorAll(".filter").forEach((b) => b.classList.remove("active")); button.classList.add("active"); render(); }));
  $("show-more-dishes").addEventListener("click", () => { visible += 5; render(); });
}

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
    const today = new Date().toLocaleDateString("en-CA");
    const needsSameGymCheck = profileReady && profile.lastConfirmedDate !== today;
    const escaped = (value) => String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
    el.innerHTML = `
      <div class="card">
        <div class="card-label">${profileReady ? "Gym equipment profile" : "One-time gym tour"}</div>
        <p class="card-sub">${profileReady ? "Your saved equipment is used for workouts at this gym." : "Record the whole gym once so FitOS can build your equipment profile."}</p>
        ${profileReady ? `
          <div class="banner banner-success">Gym equipment saved${profile.lastScanAt ? ` · scanned ${new Date(profile.lastScanAt).toLocaleDateString()}` : ""}</div>
          ${needsSameGymCheck ? `
            <div class="card-sub" style="margin:12px 0 8px;">Are you using the same gym and equipment today?</div>
            <div class="btn-row"><button class="btn btn-mint" id="same-gym-yes">Yes, same gym</button><button class="btn btn-outline" id="same-gym-no">No, different gym</button></div>
          ` : `<div class="card-sub" style="margin-top:10px;">Your saved gym equipment is active for today. We won't ask again today.</div>`}
          <button class="btn btn-outline" id="gym-tour-rescan" style="margin-top:10px;">Scan / update gym equipment</button>
          <div class="chip-group" style="margin-top:14px;">${known.map((name) => `<span class="pill">${escaped(name)}</span>`).join("") || "No equipment saved yet."}</div>
        ` : `
          <p style="margin:14px 0 0;">Start Gym Tour to continuously detect equipment while you move around the gym.</p>
          <button class="btn btn-primary" id="gym-tour-start" style="margin-top:14px;">Start Gym Tour</button>
        `}
      </div>
      <div id="gym-tour-workspace"></div>
      <div class="card" style="margin-top:14px;">
        <div class="card-label">✏️ Manage equipment manually</div>
        <p class="card-sub">Add or remove equipment any time. Scanned and manually selected equipment share the same saved gym profile.</p>
        <div class="chip-group" id="gym-manual-equipment" style="flex-wrap:wrap;gap:8px;"></div>
        <div class="field" style="margin-top:12px;">
          <label for="gym-custom-equipment-name">Add equipment not listed</label>
          <div class="btn-row">
            <input id="gym-custom-equipment-name" type="text" maxlength="120" placeholder="e.g. Pendulum squat machine">
            <button class="btn btn-outline" id="gym-custom-equipment-add" type="button">Add</button>
          </div>
        </div>
        <button class="btn btn-primary" id="gym-manual-save" style="margin-top:12px;">Save equipment selection</button>
      </div>
    `;
    const manualGroup = $("gym-manual-equipment");
    [...new Set([...equipmentNames, ...known])].forEach((name) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `chip ${known.includes(name) ? "active" : ""}`;
      button.textContent = name;
      button.setAttribute("aria-pressed", String(known.includes(name)));
      button.addEventListener("click", () => {
        const active = button.classList.toggle("active");
        button.setAttribute("aria-pressed", String(active));
      });
      manualGroup.appendChild(button);
    });
    $("gym-custom-equipment-add").addEventListener("click", () => {
      const input = $("gym-custom-equipment-name");
      const name = input.value.trim();
      if (!name) return;
      const existing = Array.from(manualGroup.querySelectorAll(".chip")).find((item) => item.textContent.trim().toLocaleLowerCase() === name.toLocaleLowerCase());
      if (existing) {
        existing.classList.add("active");
        existing.setAttribute("aria-pressed", "true");
      } else {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "chip active";
        button.textContent = name;
        button.setAttribute("aria-pressed", "true");
        button.addEventListener("click", () => {
          const active = button.classList.toggle("active");
          button.setAttribute("aria-pressed", String(active));
        });
        manualGroup.appendChild(button);
      }
      input.value = "";
    });
    $("gym-manual-save").addEventListener("click", async () => {
      const button = $("gym-manual-save");
      const selectedNames = Array.from(manualGroup.querySelectorAll(".chip.active")).map((item) => item.textContent.trim());
      button.disabled = true;
      button.textContent = "Saving…";
      try {
        await Api.post("/equipment/user/equipment", { equipmentNames: selectedNames });
        await Api.post("/equipment/gym-profile/confirm-same", { confirmedDate: new Date().toLocaleDateString("en-CA") });
        const refreshed = await Api.get("/equipment/gym-profile");
        profile = refreshed;
        render();
      } catch (error) {
        button.disabled = false;
        button.textContent = "Save equipment selection";
        $("gym-tour-workspace").innerHTML = `<div class="banner banner-error">${escaped(error.message || "Could not save equipment.")}</div>`;
      }
    });
    if (profileReady) {
      if (needsSameGymCheck) {
        $("same-gym-yes").addEventListener("click", async () => {
          const button = $("same-gym-yes");
          button.disabled = true;
          try {
            const confirmed = await Api.post("/equipment/gym-profile/confirm-same", { confirmedDate: today });
            profile.lastConfirmedDate = confirmed.lastConfirmedDate;
            render();
          } catch (error) {
            button.disabled = false;
            $("gym-tour-workspace").innerHTML = `<div class="banner banner-error">${escaped(error.message || "Could not save gym confirmation.")}</div>`;
          }
        });
        $("same-gym-no").addEventListener("click", () => {
          profile = { gymTourCompleted: false, equipment: [] };
          render();
          startTour();
        });
      }
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
    if (frameHandle) clearTimeout(frameHandle);
    if (stream) stream.getTracks().forEach((track) => track.stop());
    stream = null;
  };

  const renderEvidence = (workspace, status) => {
    const escapeLabel = (value) => String(value).replace(/[&<>"']/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[character]);
    const entries = [...evidence.entries()].sort((a, b) => b[1].confidence - a[1].confidence);
    const rows = entries.map(([name, item]) => {
      const label = escapeLabel(name);
      const state = item.status === "CONFIRMED"
        ? '<span class="pill" style="background:#d1fae5;color:#065f46;">Added to gym</span>'
        : item.status === "REJECTED"
          ? `<span class="pill" style="background:#fee2e2;color:#991b1b;">Corrected: ${escapeLabel(item.correctedLabel || "Rejected")}</span>`
          : `<div class="btn-row" style="gap:8px;margin-top:8px;">
              <button class="btn btn-mint gym-equipment-confirm" data-equipment="${label}" type="button" aria-label="Confirm ${label}">✓ Correct</button>
              <button class="btn btn-outline gym-equipment-reject" data-equipment="${label}" type="button" aria-label="Reject ${label}">✕ Wrong</button>
            </div>`;
      return `<div class="exercise-row" style="align-items:flex-start;"><div style="flex:1;min-width:0;"><strong>${label}</strong><div class="exercise-meta">${Math.round(item.confidence * 100)}% confidence · ${item.frames} frames</div>${state}</div></div>`;
    }).join("");
    const visibleCount = entries.filter(([, item]) => item.status !== "REJECTED").length;
    const confirmedCount = entries.filter(([, item]) => item.status === "CONFIRMED").length;
    workspace.querySelector("#gym-tour-detections").innerHTML = rows || '<div class="empty-state">Move the camera slowly across the gym to collect detections.</div>';
    workspace.querySelector("#gym-tour-count").textContent = status.startsWith("Model not configured")
      ? "Model not configured"
      : `${visibleCount} detections · ${confirmedCount} confirmed`;
    workspace.querySelector("#gym-tour-status").textContent = status;

    workspace.querySelectorAll(".gym-equipment-confirm").forEach((button) => button.addEventListener("click", async () => {
      const name = button.dataset.equipment;
      const item = evidence.get(name);
      if (!item || item.status) return;
      button.disabled = true;
      try {
        await Api.post("/equipment/feedback", {
          predictedLabel: name, verdict: "CONFIRMED", confidence: item.confidence,
          imageBase64: item.imageBase64
        });
        item.status = "CONFIRMED";
        renderEvidence(workspace, "Equipment confirmed and added to this gym.");
      } catch (error) {
        button.disabled = false;
        renderEvidence(workspace, `Could not save confirmation: ${error.message || "try again"}`);
      }
    }));
    workspace.querySelectorAll(".gym-equipment-reject").forEach((button) => button.addEventListener("click", async () => {
      const name = button.dataset.equipment;
      const item = evidence.get(name);
      if (!item || item.status) return;
      const correctedLabel = window.prompt(`FitOS detected "${name}". What equipment is this actually?`);
      if (!correctedLabel?.trim()) return;
      button.disabled = true;
      try {
        await Api.post("/equipment/feedback", {
          predictedLabel: name, correctedLabel: correctedLabel.trim(), verdict: "REJECTED",
          confidence: item.confidence, imageBase64: item.imageBase64
        });
        item.status = "REJECTED";
        item.correctedLabel = correctedLabel.trim();
        renderEvidence(workspace, "Correction saved for the FitOS training dataset.");
      } catch (error) {
        button.disabled = false;
        renderEvidence(workspace, `Could not save correction: ${error.message || "try again"}`);
      }
    }));
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
          const scale = Math.min(1, 640 / Math.max(video.videoWidth, video.videoHeight));
          canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
          canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
          canvas.getContext("2d", { alpha: false }).drawImage(video, 0, 0, canvas.width, canvas.height);
          const frameBase64 = canvas.toDataURL("image/jpeg", 0.62).split(",")[1];
          try {
            const result = await Api.post("/equipment/detect", { imageBase64: frameBase64 });
            if (result.error === "MODEL_NOT_CONFIGURED") {
              renderEvidence(workspace, "Model not configured. Add a trained local YOLO model to the backend.");
              stopStream();
              return;
            }
            for (const detection of result.detections || []) {
              const name = String(detection.equipmentName || "").trim();
              if (!name) continue;
              const current = evidence.get(name) || { confidence: 0, frames: 0, status: null, imageBase64: frameBase64 };
              if (current.status) continue;
              current.frames += 1;
              if ((Number(detection.confidence) || 0) >= current.confidence) {
                current.confidence = Number(detection.confidence) || 0;
                current.imageBase64 = frameBase64;
              }
              evidence.set(name, current);
            }
            renderEvidence(workspace, `Roboflow responded in ${result.latencyMs ?? "?"} ms · review each result`);
          } catch (error) {
            renderEvidence(workspace, `Detection paused: ${error.message || "try another angle"}`);
          } finally {
            detectionInFlight = false;
          }
        }
        if (running) frameHandle = window.setTimeout(detectFrame, 900);
      };
      renderEvidence(workspace, "Recording and detecting equipment…");
      detectFrame();
    } catch (error) {
      workspace.innerHTML = `<div class="banner banner-error">Camera permission denied. ${error.message || ""}</div>`;
    }
  };

  const finishTour = async (workspace) => {
    stopStream();
    const reliable = [...evidence.entries()].filter(([, item]) => item.status === "CONFIRMED");
    workspace.innerHTML = `
      <div class="card">
        <div class="card-label">Gym tour analyzed</div>
        <p class="card-sub">${reliable.length} equipment types were explicitly confirmed by you. Rejected or unreviewed predictions will not be added.</p>
        <div class="card-sub" style="margin:12px 0;">Are you done recording your whole gym?</div>
        <div class="btn-row"><button class="btn btn-mint" id="gym-tour-done">Yes</button><button class="btn btn-outline" id="gym-tour-continue">No, continue recording</button></div>
        <div class="chip-group" style="margin-top:14px;">${reliable.map(([name]) => `<span class="pill">${name}</span>`).join("") || "No reliable equipment yet."}</div>
      </div>`;
    $("gym-tour-done").addEventListener("click", async () => {
      const button = $("gym-tour-done");
      button.disabled = true;
      try {
        await Api.post("/equipment/gym-tour", { completed: true, detections: reliable.map(([equipmentName, item]) => ({ equipmentName, confidence: item.confidence, evidenceFrames: item.frames })) });
        await Api.post("/equipment/gym-profile/confirm-same", { confirmedDate: new Date().toLocaleDateString("en-CA") });
        profile = await Api.get("/equipment/gym-profile");
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
        <button class="btn btn-outline" id="gym-scan-cancel" style="display:none;">Stop &amp; Review</button>
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
  let latestDetections = [];

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
      latestDetections = [];
      resultsDiv.style.display = "none";
      resultsDiv.innerHTML = "";

      // Start sampled-frame inference. The loop awaits each request, so only one
      // frame is in flight at a time.
      detectLoop();
    } catch (e) {
      feedback.textContent = "Camera permission denied";
      feedback.style.display = "flex";
    }
  });

  cancelBtn.addEventListener("click", () => {
    detecting = false;
    if (stream) stream.getTracks().forEach(t => t.stop());
    stream = null;
    video.srcObject = null;
    video.style.display = "none";
    feedback.style.display = "none";
    startBtn.style.display = "inline-flex";
    cancelBtn.style.display = "none";
    if (latestDetections.length > 0) {
      renderDetectionResults(latestDetections, []);
    } else {
      resultsDiv.style.display = "block";
      resultsDiv.textContent = "No equipment was confidently recognized. Start another live scan and point the camera at the equipment."; 
    }
  });

  async function detectLoop() {
    if (!detecting) return;
    
    if (video.readyState === video.HAVE_ENOUGH_DATA) {
      // Sample a resized frame rather than uploading full-resolution camera
      // images. This loop awaits each inference before requesting the next frame,
      // so slow Roboflow responses never create a queue of stale frames.
      const scale = Math.min(1, 960 / video.videoWidth);
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      const context = canvas.getContext("2d");
      if (!context) {
        feedback.textContent = "Could not prepare a camera frame. Please try again.";
        if (detecting) setTimeout(detectLoop, 500);
        return;
      }
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.72);
      const base64 = dataUrl.split(",")[1];
      
      try {
        const result = await Api.post("/equipment/detect", { imageBase64: base64 });
        if (!result.configured) {
          feedback.textContent = result.message || "Equipment detection is not configured on the backend.";
        } else {
          latestDetections = Array.isArray(result.detections) ? result.detections : [];
          const unique = new Map();
          latestDetections.forEach(d => {
            const existing = unique.get(d.equipmentName);
            if (!existing || d.confidence > existing.confidence) unique.set(d.equipmentName, d);
          });
          feedback.textContent = unique.size
            ? `Live detection: ${unique.size} equipment types recognized. Move the camera to scan more, then tap Stop & Review.`
            : "Live scan running. No known equipment recognized yet; adjust the camera angle or lighting.";
          resultsDiv.style.display = "block";
          resultsDiv.textContent = unique.size
            ? "Currently detected: " + Array.from(unique.keys()).join(", ")
            : "Waiting for equipment detections…";
        }
      } catch (e) {
        feedback.textContent = e.message || "Live equipment detection failed. Check the connection and try again.";
        console.error("Detection error:", e);
      }
    }
    // Pace requests and avoid accumulating stale webcam frames.
    if (detecting) setTimeout(detectLoop, 350);
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
    
    rescanBtn.addEventListener("click", async () => {
      resultsDiv.style.display = "none";
      latestDetections = [];
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        video.srcObject = stream;
        video.style.display = "block";
        feedback.style.display = "flex";
        feedback.textContent = "Live scan running... point camera at equipment";
        startBtn.style.display = "none";
        cancelBtn.style.display = "inline-flex";
        detecting = true;
        detectLoop();
      } catch (e) {
        feedback.textContent = "Could not start the camera. Check browser camera permission and try again.";
        feedback.style.display = "flex";
      }
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

/* ---------------- Public landing interactions ---------------- */
const siteMenuButton = document.querySelector(".site-menu-toggle");
const siteNavigation = document.getElementById("site-navigation");
siteMenuButton?.addEventListener("click", () => {
  const isOpen = siteNavigation?.classList.toggle("is-open") ?? false;
  siteMenuButton.setAttribute("aria-expanded", String(isOpen));
  siteMenuButton.setAttribute("aria-label", isOpen ? "Close navigation" : "Open navigation");
});
siteNavigation?.addEventListener("click", (event) => {
  if (event.target.closest("a")) {
    siteNavigation.classList.remove("is-open");
    siteMenuButton?.setAttribute("aria-expanded", "false");
    siteMenuButton?.setAttribute("aria-label", "Open navigation");
  }
});
document.addEventListener("click", (event) => {
  const cta = event.target.closest("a[data-cta-placement]");
  if (cta) trackMarketingEvent("signup_cta_click", cta.dataset.ctaPlacement || "unknown");
});
const landingYear = document.getElementById("landing-year");
if (landingYear) landingYear.textContent = String(new Date().getFullYear());

/* ---------------- Kickoff ---------------- */
void boot();
