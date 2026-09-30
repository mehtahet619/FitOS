const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../frontend");
const port = Number(process.env.FRONTEND_PORT || 5173);
const types = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
};

http.createServer((req, res) => {
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname); }
  catch { res.writeHead(400).end("Bad request"); return; }

  let file = path.resolve(root, `.${pathname}`);
  if (file !== root && !file.startsWith(`${root}${path.sep}`)) {
    res.writeHead(403).end("Forbidden"); return;
  }
  if (pathname === "/") file = path.join(root, "index.html");
  if (!path.extname(pathname)) file = path.join(root, "index.html");

  fs.readFile(file, (error, content) => {
    if (error) { res.writeHead(404).end("Not found"); return; }
    res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(content);
  });
}).listen(port, "127.0.0.1", () => {
  console.log(`FitOS frontend ready at http://localhost:${port}`);
});
