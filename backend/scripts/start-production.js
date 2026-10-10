const { spawn } = require("node:child_process");
const path = require("node:path");

const databaseUrl = process.env.DATABASE_URL || "";
const migrationFile = /^postgres(?:ql)?:\/\//i.test(databaseUrl)
  ? "migrate-postgres.js"
  : "migrate.js";
const commands = [
  path.join(__dirname, "..", "dist", "db", migrationFile),
  path.join(__dirname, "..", "dist", "db", "seed.js"),
  path.join(__dirname, "..", "dist", "server.js"),
];

function runNext(index) {
  if (index >= commands.length) return;
  const child = spawn(process.execPath, [commands[index]], {
    env: process.env,
    stdio: "inherit",
  });

  child.once("error", () => {
    console.error("Production startup step could not be started.");
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    if (code !== 0) {
      process.exitCode = code || 1;
      return;
    }
    runNext(index + 1);
  });
}

runNext(0);
