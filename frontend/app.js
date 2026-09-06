/* ---------------- Equipment camera scan (shared) ---------------- */
// Opens the camera, lets the user snap a photo, POSTs it to
// /equipment/detect, and hands back the detected equipment names (mapped to
// real Equipment rows) plus ready-made exercise suggestions with how-to
// instructions. Reused by onboarding and the Workout tab.
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
  $(id).classList.add("active");
}

/* ---------------- Boot ---------------- */
async function boot() {
  if (!Api.token()) {
    showScreen("screen-auth");
    return;
  }
  try {
    await Api.get("/user/profile");
    enterMainApp();
  } catch (e) {
    if (e.status === 404) {
      await loadEquipmentChips();
      showScreen("screen-onboarding");
    } else {
      Api.clearTokens();
      showScreen("screen-auth");
    }
  }
}

/* ---------------- Auth screen ---------------- */
$("auth-toggle").addEventListener("click", () => {
  State.isRegisterMode = !State.isRegisterMode;
  $("auth-title").textContent = State.isRegisterMode ? "Create your account" : "Welcome back";
  $("auth-submit").textContent = State.isRegisterMode ? "Sign up" : "Log in";
  $("auth-toggle").textContent = State.isRegisterMode
    ? "Already have an account? Log in"
    : "New here? Create an account";
});

$("auth-submit").addEventListener("click", async () => {
  const email = $("auth-email").value.trim();
  const password = $("auth-password").value;
  const bannerEl = $("auth-banner");
  banner(bannerEl, "info", "");
  if (!email || !password) {
    banner(bannerEl, "error", "Enter an email and password.");
    return;
  }
  try {
    const path = State.isRegisterMode ? "/auth/register" : "/auth/login";
    const data = await Api.post(path, { email, password });
    Api.setTokens(data.accessToken, data.refreshToken);
    await boot();
  } catch (e) {
    banner(bannerEl, "error", e.message || "Something went wrong.");
  }
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
  $("screen-auth").classList.remove("active");
  $("screen-onboarding").classList.remove("active");
  $("main-app").style.display = "flex";
  $("bottom-nav").style.display = "flex";
  switchTab("today");
}

document.querySelectorAll(".nav-item").forEach((btn) => {
  btn.addEventListener("click", () => switchTab(btn.dataset.tab));
});

function switchTab(tab) {
  document.querySelectorAll("#main-app .screen").forEach((s) => s.classList.remove("active"));
  $("screen-" + tab).classList.add("active");
  document.querySelectorAll(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));

  if (tab === "today") loadToday();
  if (tab === "workout") loadWorkout();
  if (tab === "diet") loadDiet();
  if (tab === "gym") loadGym();
  // vision tab is user-initiated (camera permission) — no auto-load
}

/* ================= TODAY ================= */
async function loadToday() {
  const el = $("today-content");
  el.innerHTML = `<div class="empty-state">Loading…</div>`;
  try {
    const [dashboard, profile] = await Promise.all([
      Api.get("/progress/dashboard"),
      Api.get("/user/profile"),
    ]);
    $("today-greeting").textContent = `Hi, ${profile.name.split(" ")[0]}`;

    let nutrition = null;
    try { nutrition = await Api.get("/nutrition/today"); } catch (_) {}

    let gym = null;
    try { gym = await Api.get("/gym/today"); } catch (_) {}

    const plan = dashboard.todaysPlan;
    el.innerHTML = `
      <div class="card">
        <div class="card-label">🏋️ Today's Workout</div>
        ${plan
          ? `<div class="card-value">${plan.focus}</div><div class="card-sub">${plan.durationMin} min · ${plan.status}</div>`
          : `<div class="card-sub">No workout generated yet — head to the Workout tab.</div>`}
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
    const workout = await Api.get("/workouts/today");
    renderWorkout(workout);
  } catch (e) {
    if (e.status === 404) {
      renderGenerateWorkoutPrompt();
    } else {
      el.innerHTML = `<div class="empty-state">${e.message}</div>`;
    }
  }
}

function renderWorkoutScanButton() {
  const scanArea = $("workout-scan-area");
  scanArea.innerHTML = `<button class="btn btn-outline" id="workout-scan-btn" style="margin-bottom:14px;">📷 Scan my equipment</button>`;
  $("workout-scan-btn").addEventListener("click", () => {
    scanArea.innerHTML = "";
    startEquipmentScan("workout-scan-area", async (detectedNames) => {
      scanArea.innerHTML = `<div class="empty-state"><span class="spinner"></span> Updating your equipment…</div>`;
      try {
        // Merge with whatever equipment the user already has on file rather
        // than overwriting it — a scan finds what's in front of the camera,
        // not necessarily everything the user owns.
        const current = await Api.get("/equipment/user/equipment");
        const merged = Array.from(new Set([...current.map((c) => c.name), ...detectedNames]));
        await Api.post("/equipment/user/equipment", { equipmentNames: merged });
        scanArea.innerHTML = `<div class="banner banner-success">Added ${detectedNames.join(", ")} to your equipment.</div>`;
      } catch (e) {
        scanArea.innerHTML = `<div class="banner banner-error">${e.message}</div>`;
      }
    });
  });
}

function renderGenerateWorkoutPrompt() {
  $("workout-focus-label").textContent = "No workout yet";
  const el = $("workout-content");
  const focuses = ["Chest + Triceps", "Back + Biceps", "Legs", "Shoulders + Core", "Full Body"];
  el.innerHTML = `
    <div class="card">
      <div class="card-label">Choose today's focus</div>
      <div class="chip-group" id="focus-chips">
        ${focuses.map((f, i) => `<button class="chip ${i === 0 ? "active" : ""}" data-focus="${f}">${f}</button>`).join("")}
      </div>
    </div>
    <button class="btn btn-primary" id="generate-workout-btn">Generate workout</button>
  `;
  let selectedFocus = focuses[0];
  document.querySelectorAll("#focus-chips .chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      document.querySelectorAll("#focus-chips .chip").forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
      selectedFocus = chip.dataset.focus;
    });
  });
  $("generate-workout-btn").addEventListener("click", async () => {
    $("generate-workout-btn").disabled = true;
    $("generate-workout-btn").innerHTML = `<span class="spinner"></span> Generating…`;
    try {
      await Api.post("/workouts/generate", { focus: selectedFocus });
      await loadWorkout();
    } catch (e) {
      el.innerHTML = `<div class="banner banner-error">${e.message}</div>` + el.innerHTML;
      $("generate-workout-btn").disabled = false;
      $("generate-workout-btn").textContent = "Generate workout";
    }
  });
}

function renderWorkout(workout) {
  $("workout-focus-label").textContent = `${workout.focus} · ${workout.durationMin} min · ${workout.status}`;
  const el = $("workout-content");
  el.innerHTML = `
    <div class="card" id="exercise-list"></div>
    ${workout.status !== "completed" ? `<button class="btn btn-primary" id="complete-workout-btn">Mark workout complete</button>` : ""}
  `;
  const listEl = $("exercise-list");
  workout.exercises.forEach((ex) => {
    const row = document.createElement("div");
    row.className = "exercise-row";
    row.innerHTML = `
      <div>
        <div class="exercise-name">${ex.name}</div>
        <div class="exercise-meta">${ex.primaryMuscle} · ${ex.targetSets} sets × ${ex.repRangeLow}-${ex.repRangeHigh} reps</div>
        <div class="exercise-meta">${ex.status}${ex.painReported ? " · ⚠️ pain reported" : ""}</div>
      </div>
      <div class="btn-row" style="width:auto;">
        <button class="btn btn-outline" style="width:auto; padding:8px 12px;" data-action="swap" data-id="${ex.workoutExerciseId}">No equipment?</button>
      </div>
    `;
    listEl.appendChild(row);
  });

  listEl.querySelectorAll('[data-action="swap"]').forEach((btn) => {
    btn.addEventListener("click", async () => {
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
        btn.disabled = false;
        btn.textContent = "No equipment?";
      }
    });
  });

  const completeBtn = $("complete-workout-btn");
  if (completeBtn) {
    completeBtn.addEventListener("click", async () => {
      await Api.post(`/workouts/${workout.id}/complete`, {});
      await loadWorkout();
    });
  }
}

/* ================= DIET ================= */
async function loadDiet() {
  const el = $("diet-content");
  el.innerHTML = `<div class="empty-state">Loading…</div>`;
  try {
    const nutrition = await Api.get("/nutrition/today");
    renderDiet(nutrition);
  } catch (e) {
    if (e.status === 404) {
      el.innerHTML = `
        <div class="empty-state">No nutrition plan generated for today yet.</div>
        <button class="btn btn-primary" id="generate-diet-btn">Generate today's meal plan</button>
      `;
      $("generate-diet-btn").addEventListener("click", async () => {
        try {
          await Api.post("/nutrition/generate", {});
          await loadDiet();
        } catch (err) {
          el.innerHTML = `<div class="banner banner-error">${err.message}</div>` + el.innerHTML;
        }
      });
    } else {
      el.innerHTML = `<div class="empty-state">${e.message}</div>`;
    }
  }
}

function renderDiet(nutrition) {
  const el = $("diet-content");
  el.innerHTML = `
    <div class="card">
      <div class="card-label">Today's totals</div>
      <div class="card-value">${nutrition.totals.calories} kcal</div>
      <div class="card-sub">P ${Math.round(nutrition.totals.proteinG)}g · C ${Math.round(nutrition.totals.carbsG)}g · F ${Math.round(nutrition.totals.fatG)}g</div>
    </div>
    <div class="card" id="meals-card"></div>
    <div class="banner banner-info">${nutrition.disclaimer}</div>
    <div id="nearby-results"></div>
  `;
  const mealsCard = $("meals-card");
  nutrition.meals.forEach((meal) => {
    const row = document.createElement("div");
    row.className = "meal-row";
    row.innerHTML = `
      <div class="meal-slot">${meal.slot}</div>
      <div class="meal-name">${meal.name}</div>
      <div class="meal-macros">${meal.calories} kcal · P${Math.round(meal.proteinG)}g · ₹${meal.estPriceInr}</div>
      <button class="btn btn-outline" style="margin-top:8px; width:auto; padding:8px 12px;" data-food-id="${meal.foodId}" data-food-name="${meal.name}">Find this near me</button>
    `;
    mealsCard.appendChild(row);
  });

  mealsCard.querySelectorAll("[data-food-id]").forEach((btn) => {
    btn.addEventListener("click", () => findNearby(btn.dataset.foodId, btn.dataset.foodName));
  });
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

/* ---------------- Kickoff ---------------- */
boot();
