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

  async function request(path, opts = {}) {
    const headers = Object.assign({ "Content-Type": "application/json" }, opts.headers || {});
    if (token()) headers["Authorization"] = "Bearer " + token();

    let res = await fetch(window.API_BASE + path, {
      method: opts.method || "GET",
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });

    // one silent refresh attempt on 401
    if (res.status === 401 && localStorage.getItem("refreshToken") && path !== "/auth/refresh") {
      const refreshed = await fetch(window.API_BASE + "/auth/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: localStorage.getItem("refreshToken") }),
      });
      if (refreshed.ok) {
        const data = await refreshed.json();
        setTokens(data.accessToken, null);
        headers["Authorization"] = "Bearer " + data.accessToken;
        res = await fetch(window.API_BASE + path, {
          method: opts.method || "GET",
          headers,
          body: opts.body ? JSON.stringify(opts.body) : undefined,
        });
      } else {
        clearTokens();
      }
    }

    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
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
