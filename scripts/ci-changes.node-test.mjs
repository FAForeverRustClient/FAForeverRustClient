import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { detectChecks, selectChecks } from "./ci-changes.mjs";

const all = { rust: true, frontend: true, bindings: true, conformance: true };
const docs = { rust: false, frontend: false, bindings: false, conformance: false };
const ui = { ...docs, frontend: true };

test("documentation and snippets retain only the always-on workflow guards", () => {
  assert.deepEqual(selectChecks(["README.md", "docs/ci.md", "changelog/snippets/fix.667.md"]), docs);
});

test("UI changes skip Rust compilation but generated contracts are still verified", () => {
  assert.deepEqual(selectChecks(["docs/ci.md", "ui/src/App.tsx", "ui/public/icon.png"]), ui);
  assert.deepEqual(selectChecks(["ui/name\nwith newline.ts"]), ui);
  assert.deepEqual(selectChecks(["ui/src/ipc/bindings.ts"]), { ...ui, bindings: true });
  for (const fixture of ["reducer-conformance.json", "reducer-conformance-orderings.json"]) {
    assert.deepEqual(selectChecks([`ui/src/store/__fixtures__/${fixture}`]), { ...ui, conformance: true });
  }
});

test("Rust inputs and unknown paths run every check, including Markdown fixtures", () => {
  for (const path of [
    "crates/faf-domain/src/protocol/fixtures/changelog.md", "src-tauri/tauri.conf.json",
    "Cargo.lock", ".cargo/config.toml", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml",
    "scripts/ci-changes.mjs", ".github/workflows/ci.yml", "vite.config.ts", "vendor/new.json",
    "docs/build-input.json", "new-directory/source.ts", "ui-other/source.ts", "docs/README.md.rs",
  ]) {
    assert.deepEqual(selectChecks(["docs/ci.md", path]), all, path);
  }
  assert.deepEqual(selectChecks([]), all);
});

test("pushes and invalid event data cannot suppress checks", () => {
  assert.deepEqual(detectChecks({ event: "push" }), all);
  assert.deepEqual(detectChecks({ event: "pull_request", base: "--help", head: "HEAD" }), all);
  assert.deepEqual(detectChecks({ event: "pull_request" }), all);
});

test("the real Git diff covers the whole PR, renames, deletions and large file lists", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "faf-ci-changes-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  // Tree objects exercise the real diff without creating commits or identities.
  git("init", "--quiet");
  const blob = git("hash-object", "-w", "--stdin");
  const tree = (paths) => {
    git("read-tree", "--empty");
    execFileSync("git", ["update-index", "-z", "--index-info"], {
      cwd, input: paths.map((path) => `100644 ${blob}\t${path}\0`).join(""),
      stdio: ["pipe", "pipe", "pipe"],
    });
    return git("write-tree");
  };
  const base = tree(["crates/old.rs", "ui/old.ts"]);
  const docsHead = tree(["docs/old.md", "ui/old.ts"]);
  const detect = (head, from = base) => detectChecks({ event: "pull_request", base: from, head, cwd });
  assert.deepEqual(detect(docsHead), all, "moving Rust into docs still checks its removed source");

  const docsBase = tree(["docs/readme.md"]);
  const uiHead = tree(["docs/readme.md", "ui/new.ts"]);
  const snippetHead = tree(["docs/readme.md", "ui/new.ts", "changelog/snippets/fix.667.md"]);
  assert.deepEqual(detect(snippetHead, docsBase), ui, "a later snippet must not hide earlier UI commits");
  const output = join(cwd, "workflow-outputs");
  execFileSync(process.execPath, [fileURLToPath(new URL("./ci-changes.mjs", import.meta.url))], {
    cwd, stdio: ["ignore", "pipe", "pipe"], env: {
      ...process.env, GITHUB_EVENT_NAME: "pull_request", CI_BASE_SHA: docsBase,
      CI_HEAD_SHA: snippetHead, GITHUB_OUTPUT: output,
    },
  });
  assert.equal(readFileSync(output, "utf8"), "rust=false\nfrontend=true\nbindings=false\nconformance=false\n");
  const deletedHead = tree(["docs/readme.md"]);
  assert.deepEqual(detect(deletedHead, uiHead), ui, "deleted UI files still need frontend tests");

  const manyDocs = Array.from({ length: 350 }, (_, index) => `docs/${index}.md`);
  assert.deepEqual(detect(tree([...manyDocs, "crates/last.rs"]), docsBase), all);
  assert.deepEqual(detect(tree(["docs/name with spaces.md"]), docsBase), docs);
  // Git for Windows rejects control characters in index paths; Linux accepts them.
  if (process.platform !== "win32") {
    assert.deepEqual(detect(tree(["ui/name\nwith newline.ts"]), docsBase), ui);
  }
  assert.deepEqual(detect("f".repeat(40)), all, "unavailable history runs all checks");
});
