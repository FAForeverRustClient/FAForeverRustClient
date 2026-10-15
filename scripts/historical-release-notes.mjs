import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = new URL("../changelog/historical/", import.meta.url);
const history = JSON.parse(await readFile(new URL("history.json", directory), "utf8"));
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const repository = "https://github.com/FAForeverRustClient/FAForeverRustClient";
const write = process.argv.includes("--write");

for (const release of history) {
  if (![release.version, release.base].every((tag) => /^v\d+\.\d+\.\d+$/.test(tag))) {
    throw new Error("Historical notes must name existing release versions.");
  }
  const range = `${release.base}..${release.version}`;
  const commits = git("rev-list", range).split("\n");
  const sources = release.sections.flatMap(([, changes]) => changes.map(([, source]) => source));
  for (const source of sources) {
    if (!/^[a-f0-9]{8,40}$/.test(source) || commits.filter((sha) => sha.startsWith(source)).length !== 1) {
      throw new Error(`${release.version}: source ${source} is not uniquely in ${range}.`);
    }
  }
  const pullFor = new Map();
  const merges = git("log", "--first-parent", "--merges", "--reverse", "--format=%H %s", range).split("\n");
  for (const merge of merges) {
    const match = /^(\w+) Merge pull request #(\d+)\b/.exec(merge);
    if (!match) continue;
    for (const commit of git("rev-list", `${match[1]}^1..${match[1]}`).split("\n")) {
      pullFor.set(commit, match[2]);
    }
  }
  const lines = [`Changes since ${release.base}.`, ""];
  for (const [heading, changes] of release.sections) {
    lines.push(`## ${heading}`, "");
    for (const [text, source] of changes) {
      if (!text.endsWith(".") || text.includes("\u2014")) throw new Error("Use a complete sentence without an em dash.");
      const commit = commits.find((sha) => sha.startsWith(source));
      const pull = pullFor.get(commit);
      const citation = pull ? `(#${pull})` : `[Source](${repository}/commit/${commit})`;
      lines.push(`- ${text} ${citation}`);
    }
    lines.push("");
  }
  lines.push(`[Full changes](${repository}/compare/${range.replace("..", "...")})`, "", "Download the installer for your platform from the assets below.", "");
  const expected = lines.join("\n");
  const path = new URL(`${release.version}.md`, directory);
  if (write) await writeFile(path, expected);
  else if (await readFile(path, "utf8") !== expected) throw new Error(`${release.version}: regenerate its historical notes.`);
  console.log(`${release.version}: ${sources.length} source-verified changes${write ? " written" : " checked"}.`);
}
