const Api = (() => {
  function token() {
    return localStorage.getItem("accessToken");
  }
  function setTokens(access, refresh) {
    if (access) localStorage.setItem("accessToken", access);
    if (refresh) localStorage.setItem("refreshToken", refresh);
  }
  function clearTokens() {
    localStorage.removeItem("accessToken");
    localStorage.removeItem("refreshToken");
  }

  async function fetchWithRetry(url, options, settings = {}) {
    let lastError;
    const maxAttempts = settings.maxAttempts || 3;
    const timeoutMs = settings.timeoutMs || 10000;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        return await fetch(url, { ...options, signal: controller.signal });
      } catch (error) {
        lastError = error;
        if (attempt + 1 < maxAttempts) await new Promise((resolve) => setTimeout(resolve, 700 * (attempt + 1)));
      } finally {
        clearTimeout(timeout);
      }
    }
    const error = new Error(lastError?.name === "AbortError" ? "The FitOS API took too long to respond. Please try again." : "Cannot reach the FitOS API. Check your connection and try again.");
    error.cause = lastError;
    throw error;
  }

  async function request(path, opts = {}) {
    const headers = Object.assign({ "Content-Type": "application/json" }, opts.headers || {});
    if (token()) headers["Authorization"] = "Bearer " + token();

    const isSessionCheck = path === "/auth/me";
    let res = await fetchWithRetry(window.API_BASE + path, {
      method: opts.method || "GET",
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      credentials: "include",
    }, isSessionCheck ? { maxAttempts: 1, timeoutMs: 7000 } : undefined);

    // one silent refresh attempt on 401
    if (res.status === 401 && path !== "/auth/refresh" && path !== "/auth/me" && !path.startsWith("/auth/")) {
      const refreshed = await fetchWithRetry(window.API_BASE + "/auth/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: localStorage.getItem("refreshToken") }),
        credentials: "include",
      });
      if (refreshed.ok) {
        const data = await refreshed.json();
        if (data.accessToken) {
          setTokens(data.accessToken, null);
          headers["Authorization"] = "Bearer " + data.accessToken;
        } else {
          delete headers.Authorization;
        }
        res = await fetchWithRetry(window.API_BASE + path, {
          method: opts.method || "GET",
          headers,
          body: opts.body ? JSON.stringify(opts.body) : undefined,
          credentials: "include",
        });
      } else {
        clearTokens();
        if (window.AuthState && window.AuthState.status === "AUTHENTICATED" && path !== "/auth/me") window.AuthState.unauthenticated();
      }
    }

    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      const err = new Error((json && (json.message || json.error)) || res.statusText);
      err.status = res.status;
      err.body = json;
      if (res.status === 401 && window.AuthState && path !== "/auth/me") window.AuthState.unauthenticated();
      throw err;
    }
    return json;
  }

  return {
    token,
    setTokens,
    clearTokens,
    get: (path) => request(path),
    post: (path, body) => request(path, { method: "POST", body }),
    put: (path, body) => request(path, { method: "PUT", body }),
    del: (path) => request(path, { method: "DELETE" }),
  };
})();
