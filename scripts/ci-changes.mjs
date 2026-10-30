// Select expensive PR checks from the complete diff of the merge being tested.
// Only known documentation and UI paths may skip Rust checks. Unknown inputs,
// missing history and pushes to main/develop always run the full suite.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ALL_CHECKS = { rust: true, frontend: true, bindings: true, conformance: true };

export function selectChecks(paths) {
  if (paths.length === 0) return { ...ALL_CHECKS };

  const checks = { rust: false, frontend: false, bindings: false, conformance: false };
  for (const path of paths) {
    // Match directories explicitly: Markdown fixtures in crates/ are build inputs.
    if (path === "README.md" || /^(?:docs|changelog)\/.*\.md$/.test(path)) continue;

    if (path.startsWith("ui/")) {
      checks.frontend = true;
      if (path === "ui/src/ipc/bindings.ts") checks.bindings = true;
      if (/^ui\/src\/store\/__fixtures__\/reducer-conformance(?:-orderings)?\.json$/.test(path)) {
        checks.conformance = true;
      }
      continue;
    }

    // Includes Rust, manifests, scripts, workflows, configuration and new paths.
    return { ...ALL_CHECKS };
  }
  return checks;
}

export function detectChecks({ event, base, head, cwd = process.cwd() }) {
  if (event !== "pull_request") return { ...ALL_CHECKS };
  // Commit IDs only, never branch names or shell text from an event payload.
  const commitId = /^(?:[a-f\d]{40}|[a-f\d]{64})$/i;
  if (!commitId.test(base ?? "") || !commitId.test(head ?? "")) return { ...ALL_CHECKS };

  try {
    // No GitHub API pagination/file limit. NULs preserve spaces and newlines;
    // disabling rename detection checks both the old and new paths of a move.
    const changed = execFileSync("git", [
      "diff", "--name-only", "--no-renames", "-z", base, head, "--",
    ], { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
    return selectChecks(changed.split("\0").filter(Boolean));
  } catch {
    console.warn("Could not determine changed paths; running every check.");
    return { ...ALL_CHECKS };
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const checks = detectChecks({
    event: process.env.GITHUB_EVENT_NAME,
    base: process.env.CI_BASE_SHA,
    head: process.env.CI_HEAD_SHA,
  });
  const output = Object.entries(checks).map(([name, enabled]) => `${name}=${enabled}`).join("\n") + "\n";
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output);
  process.stdout.write(output);
}
