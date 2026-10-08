// No AI assistant and no bot account authors or co-authors a commit here.
//
// GitHub lists every author and every `Co-authored-by:` on the default branch
// as a contributor of the repository. A pull request whose commits carried
// "Co-authored-by: Copilot" put Copilot on that list in October 2026, and the
// only way to take it off again was to rewrite develop's history and
// force-push it. This check stops such a commit at the pull request, where
// removing the line is a matter of amending a message.
//
// Usage: node scripts/check-commit-authors.mjs <revision range>
// e.g. `origin/develop..HEAD`. Exits 1 and names each offending commit.
//
// The committer is not checked: GitHub itself commits the merges it makes on
// the web as "GitHub <noreply@github.com>", and a committer is not listed as a
// contributor.

import { execFileSync } from "node:child_process";

const range = process.argv[2];
if (!range) {
  console.error("usage: node scripts/check-commit-authors.mjs <revision range>");
  process.exit(2);
}

/**
 * An identity that is an AI assistant or a bot rather than a person: the
 * assistants that write co-author lines, and GitHub's `[bot]` accounts.
 */
const NOT_A_PERSON =
  /\bcopilot\b|\bclaude\b|anthropic|openai|chatgpt|\bcodex\b|\bgemini\b|cursoragent|\bcursor\.(?:com|sh)\b|\bdevin\b|\[bot\]/i;

const UNIT = "\x1f";
const RECORD = "\x1e";
const log = execFileSync(
  "git",
  [
    "log",
    `--format=%H${UNIT}%an <%ae>${UNIT}%(trailers:key=Co-authored-by,valueonly,separator=${UNIT})${RECORD}`,
    range,
  ],
  { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
);

const findings = [];
for (const record of log.split(RECORD)) {
  const fields = record.trim().split(UNIT).map((field) => field.trim()).filter(Boolean);
  if (fields.length === 0) continue;
  const [hash, author, ...coAuthors] = fields;
  if (NOT_A_PERSON.test(author)) findings.push(`${hash.slice(0, 10)}  author: ${author}`);
  for (const coAuthor of coAuthors) {
    if (NOT_A_PERSON.test(coAuthor)) findings.push(`${hash.slice(0, 10)}  co-author: ${coAuthor}`);
  }
}

if (findings.length > 0) {
  console.error("Commits authored or co-authored by an AI assistant or a bot account:");
  for (const finding of findings) console.error(`  ${finding}`);
  console.error(
    "\nGitHub would list these accounts as contributors of the repository. Remove the\n" +
      "Co-authored-by line (git commit --amend, or git rebase -i for older commits),\n" +
      "or re-author the commit under a person's account, and push again.",
  );
  process.exit(1);
}
console.log(`Commit authors are people: ${range}`);
