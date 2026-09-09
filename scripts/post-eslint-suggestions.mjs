import { execFileSync } from "node:child_process";

const token = process.env.GITHUB_TOKEN;
const repository = process.env.GITHUB_REPOSITORY;
const pullNumber = process.env.PR_NUMBER;
const commitId = process.env.GITHUB_SHA;

if (!token || !repository || !pullNumber || !commitId) {
  throw new Error("GitHub review environment is incomplete");
}

try {
  execFileSync("npx", ["eslint", "src/**/*.ts", "--fix"], { stdio: "inherit", shell: true });
} catch {
  // ESLint may report non-fixable errors after applying available fixes.
}

const diff = execFileSync("git", ["diff", "--unified=0", "--", "src/**/*.ts"], { encoding: "utf8", shell: true });
const comments = [];
let file;
let newLine;

for (const line of diff.split("\n")) {
  if (line.startsWith("+++ b/")) {
    file = line.slice(6);
  } else if (line.startsWith("@@")) {
    const match = line.match(/\+(\d+)/);
    newLine = match ? Number(match[1]) : undefined;
  } else if (file && line.startsWith("+") && !line.startsWith("+++")) {
    comments.push({
      path: file,
      line: newLine,
      side: "RIGHT",
      body: `Automated ESLint fix suggestion:\n\n\`\`\`suggestion\n${line.slice(1)}\n\`\`\``,
    });
    newLine += 1;
  } else if (file && !line.startsWith("-") && newLine) {
    newLine += 1;
  }
}

if (comments.length === 0) {
  process.exit(0);
}

const response = await fetch(`https://api.github.com/repos/${repository}/pulls/${pullNumber}/reviews`, {
  method: "POST",
  headers: {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ commit_id: commitId, event: "COMMENT", body: "Mechanical ESLint fixes are available as suggestions below.", comments }),
});

if (!response.ok) {
  throw new Error(`GitHub review API returned ${response.status}: ${await response.text()}`);
}