const Api = (() => {
  let refreshInFlight = null;
  function setTokens(access, refresh) {
    if (access) localStorage.setItem("accessToken", access);
    if (refresh) localStorage.setItem("refreshToken", refresh);
  }
  function clearTokens() {
    localStorage.removeItem("accessToken");
    localStorage.removeItem("refreshToken");
  }

  async function fetchResponse(path, options, timeoutMs) {
    const controller = new AbortController();
    const startedAt = performance.now();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(window.API_BASE + path, {
        ...options,
        signal: controller.signal,
      });
      // Keep the deadline active until the complete body has arrived. fetch()
      // resolves at the headers, so clearing the timer there leaves res.text()
      // able to wait forever on a stalled response body.
      const text = await response.text();
      if (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1") {
        console.info(`[API] ${options.method || "GET"} ${path} ${response.status} ${Math.round(performance.now() - startedAt)}ms`);
      }
      return { response, text };
    } catch (cause) {
      const timedOut = cause?.name === "AbortError";
      const error = new Error(timedOut
        ? "The FitOS API took too long to respond. Please try again."
        : "Cannot reach the FitOS API. Check your connection and try again.");
      error.cause = cause;
      error.retryable = true;
      error.timedOut = timedOut;
      if (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1") {
        console.warn(`[API] ${options.method || "GET"} ${path} ${timedOut ? "timeout" : "network error"} ${Math.round(performance.now() - startedAt)}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  function parseResponse(response, text) {
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!response.ok) {
      const message = response.status === 429
        ? "Too many requests. Please wait a moment and try again."
        : (json && (json.message || json.error)) || response.statusText;
      const error = new Error(message);
      error.status = response.status;
      error.body = json;
      throw error;
    }
    return json;
  }

  function unauthenticate() {
    clearTokens();
    if (window.AuthState) window.AuthState.unauthenticated();
  }

  // Refresh tokens rotate on every use. Share a single refresh request when
  // multiple protected requests receive an expired access token together.
  function refreshSession() {
    if (!refreshInFlight) {
      refreshInFlight = fetchResponse("/auth/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        credentials: "include",
      }, 10000).then(({ response, text }) => {
        if (!response.ok) return false;
        const data = JSON.parse(text || "{}");
        if (data.accessToken) setTokens(data.accessToken, null);
        return true;
      }).finally(() => { refreshInFlight = null; });
    }
    return refreshInFlight;
  }

  async function request(path, opts = {}) {
    const headers = Object.assign({ "Content-Type": "application/json" }, opts.headers || {});

    const isSessionCheck = path === "/auth/me";
    const method = opts.method || "GET";
    const requestOptions = {
      method,
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      credentials: "include",
    };
    const timeoutMs = Number.isFinite(opts.timeoutMs)
      ? Math.max(1000, opts.timeoutMs)
      : isSessionCheck ? 7000 : 10000;
    let { response, text } = await fetchResponse(path, requestOptions, timeoutMs);

    // /auth/me intentionally reports an expired access cookie as an
    // unauthenticated session. Try the refresh cookie before boot treats that
    // response as a logout (including after reload with a still-valid refresh).
    if (response.ok && isSessionCheck) {
      let session = null;
      try { session = JSON.parse(text || "{}"); } catch { session = null; }
      if (session?.authenticated === false && await refreshSession()) {
        ({ response, text } = await fetchResponse(path, requestOptions, timeoutMs));
      }
    }

    // A protected request may refresh once, but transport failures are never
    // retried automatically. The page can show the error and offer a manual retry.
    if (response.status === 401 && path !== "/auth/refresh" && path !== "/auth/me" && !path.startsWith("/auth/")) {
      try {
        if (await refreshSession()) {
          ({ response, text } = await fetchResponse(path, { ...requestOptions, headers }, timeoutMs));
        } else {
          unauthenticate();
        }
      } catch {
        unauthenticate();
      }
    }

    try {
      const data = parseResponse(response, text);
      // Analytics receives only a fixed event name after a successful response.
      // Never forward request bodies, email addresses, tokens, prices, or API paths.
      const normalizedMethod = method.toUpperCase();
      let eventName = null;
      if (normalizedMethod === "POST" && path === "/auth/register/verify-otp") eventName = "sign_up";
      else if (normalizedMethod === "POST" && (path === "/auth/login/verify-otp" || path === "/auth/login")) eventName = "login";
      else if (normalizedMethod === "POST" && path === "/workouts/plan") eventName = "workout_plan_created";
      else if (normalizedMethod === "POST" && path === "/workouts/generate") eventName = "workout_generated";
      else if (normalizedMethod === "POST" && path === "/equipment/detect") eventName = "equipment_analysis_completed";
      if (eventName && window.FitOSAnalytics) window.FitOSAnalytics.track(eventName);
      return data;
    } catch (error) {
      if (error.status === 401 && path !== "/auth/me") unauthenticate();
      throw error;
    }
  }

  return {
    setTokens,
    clearTokens,
    get: (path) => request(path),
    post: (path, body, opts = {}) => request(path, { ...opts, method: "POST", body }),
    put: (path, body) => request(path, { method: "PUT", body }),
    del: (path) => request(path, { method: "DELETE" }),
  };
})();
// Top-level `const` in a classic script is not a window property; other scripts (food-tracker.js) read window.Api.
window.Api = Api;
