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

  async function request(path, opts = {}) {
    const headers = Object.assign({ "Content-Type": "application/json" }, opts.headers || {});
    if (token()) headers.Authorization = "Bearer " + token();

    const isSessionCheck = path === "/auth/me";
    const method = opts.method || "GET";
    const requestOptions = {
      method,
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      credentials: "include",
    };
    const timeoutMs = isSessionCheck ? 7000 : 10000;
    let { response, text } = await fetchResponse(path, requestOptions, timeoutMs);

    // A protected request may refresh once, but transport failures are never
    // retried automatically. The page can show the error and offer a manual retry.
    if (response.status === 401 && path !== "/auth/refresh" && path !== "/auth/me" && !path.startsWith("/auth/")) {
      try {
        const refreshResult = await fetchResponse("/auth/refresh", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refreshToken: localStorage.getItem("refreshToken") }),
          credentials: "include",
        }, 10000);
        if (refreshResult.response.ok) {
          const data = JSON.parse(refreshResult.text || "{}");
          if (data.accessToken) {
            setTokens(data.accessToken, null);
            headers.Authorization = "Bearer " + data.accessToken;
          } else {
            delete headers.Authorization;
          }
          ({ response, text } = await fetchResponse(path, { ...requestOptions, headers }, timeoutMs));
        } else {
          unauthenticate();
        }
      } catch {
        unauthenticate();
      }
    }

    try {
      return parseResponse(response, text);
    } catch (error) {
      if (error.status === 401 && path !== "/auth/me") unauthenticate();
      throw error;
    }
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
