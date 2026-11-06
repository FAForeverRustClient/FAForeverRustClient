// Build the Unit History lookup from the public FAForever/fa tag trees.
// Only Git object IDs, paths and release numbers are included. A blobless
// checkout is sufficient. No game source files are read or redistributed.
//
// Usage: node scripts/generate-unit-history-index.mjs <FAForever/fa checkout>
// Refresh the checkout's numeric release tags first. The output is deterministic.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

const repo = process.argv[2];
if (process.argv.length !== 3 || !repo) {
  throw new Error("Usage: node scripts/generate-unit-history-index.mjs <FAForever/fa checkout>");
}
const git = (...args) => execFileSync("git", ["-C", repo, ...args], {
  encoding: "utf8",
  maxBuffer: 8 * 1024 * 1024,
  env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
});

const tags = git("for-each-ref", "--format=%(refname:short)", "refs/tags")
  .trim()
  .split(/\r?\n/)
  .filter((tag) => /^[1-9]\d{3}$/.test(tag))
  .map(Number)
  .sort((left, right) => left - right);
if (tags.length === 0) throw new Error("No numeric FAF release tags found");

const paths = new Map();
const coveredTags = [];
for (const tag of tags) {
  const tree = git("ls-tree", "-rz", "refs/tags/" + tag, "--", "units", "schook/units");
  let covered = true;
  for (const entry of tree.split("\0")) {
    if (!entry) continue;
    const separator = entry.indexOf("\t");
    const path = entry.slice(separator + 1);
    if (!/^(?:schook\/)?units\/[a-zA-Z0-9_]+\/[a-zA-Z0-9_]+_unit\.(?:bp|BP)$/.test(path)) {
      // A submodule or symlink can hide files from ls-tree.
      if (/^(?:120000|160000) /.test(entry)) covered = false;
      continue;
    }
    const match = /^100(?:644|755) blob ([0-9a-f]{40})$/.exec(entry.slice(0, separator));
    if (!match) {
      covered = false;
      continue;
    }
    const [, id] = match;
    if (!paths.has(path)) paths.set(path, new Map());
    const objects = paths.get(path);
    if (!objects.has(id)) objects.set(id, []);
    objects.get(id).push(tag);
  }
  if (covered) coveredTags.push(tag);
}
if (paths.size === 0 || coveredTags.length === 0) throw new Error("No unit blueprint object IDs found");

const index = {
  tags: coveredTags,
  paths: Object.fromEntries([...paths].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([path, objects]) => [path, [...objects]])),
};
const contents = gzipSync(JSON.stringify(index), { level: 9 });
writeFileSync(new URL("../crates/faf-app/assets/unit-history-index-v1.json.gz", import.meta.url), contents);
console.log("Indexed " + paths.size + " blueprint paths across " + coveredTags.length + " tags (" + contents.length + " bytes).");