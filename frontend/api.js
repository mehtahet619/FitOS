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

  async function fetchWithRetry(url, options) {
    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await fetch(url, options);
      } catch (error) {
        lastError = error;
        if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 700 * (attempt + 1)));
      }
    }
    const error = new Error("Cannot reach the FitOS API. Check that the API service is running and its URL is configured correctly.");
    error.cause = lastError;
    throw error;
  }

  async function request(path, opts = {}) {
    const headers = Object.assign({ "Content-Type": "application/json" }, opts.headers || {});
    if (token()) headers["Authorization"] = "Bearer " + token();

    let res = await fetchWithRetry(window.API_BASE + path, {
      method: opts.method || "GET",
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });

    // one silent refresh attempt on 401
    if (res.status === 401 && localStorage.getItem("refreshToken") && path !== "/auth/refresh") {
      const refreshed = await fetchWithRetry(window.API_BASE + "/auth/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: localStorage.getItem("refreshToken") }),
      });
      if (refreshed.ok) {
        const data = await refreshed.json();
        setTokens(data.accessToken, null);
        headers["Authorization"] = "Bearer " + data.accessToken;
        res = await fetchWithRetry(window.API_BASE + path, {
          method: opts.method || "GET",
          headers,
          body: opts.body ? JSON.stringify(opts.body) : undefined,
        });
      } else {
        clearTokens();
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
      const err = new Error((json && json.error) || res.statusText);
      err.status = res.status;
      err.body = json;
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
  };
})();
