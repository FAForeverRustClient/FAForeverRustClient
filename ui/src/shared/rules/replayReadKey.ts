/**
 * Twin of `faf_domain::state::replay_read_key`: the name a replay's details
 * and analysis reads go by.
 *
 * A replay with a game id is named by it, wherever its file came from: the
 * vault's copy and a downloaded copy of one game say the same about it. A file
 * whose header names no game is uid 0, like every other such file, so it is
 * named by its path instead, as `normalizeReplayPath` spells it: one file
 * reached through two spellings is one read, not two. The panel works the key
 * out here to find its own answer among the ones the backend keyed, and the
 * conformance fixture holds this to the Rust function.
 */
export function replayReadKey(uid: number, localPath: string | null | undefined): string {
  return uid <= 0 && localPath ? `path:${normalizeReplayPath(localPath)}` : `uid:${uid}`;
}

/**
 * Twin of `faf_domain::state::normalize_replay_path`: one spelling for every
 * way of writing the same replay file's path, worked out from the text alone.
 *
 * Separators become `/`, repeated ones collapse, `.` segments go, `..` takes
 * the segment before it, and a trailing separator is dropped. A path with a
 * drive letter (`C:`) or a UNC `//` prefix is lowercased too, because Windows
 * does not tell `Replays` from `replays`; any other path keeps its case,
 * because Linux does.
 *
 * Lexical only: nothing here asks the filesystem. `..` cannot climb above the
 * root of an absolute path and is kept at the start of a relative one, and a
 * relative path that resolves to nothing is `.`. The conformance fixture holds
 * this to the Rust function through the read key.
 */
export function normalizeReplayPath(path: string): string {
  const unified = path.replace(/\\/g, "/");
  // What comes before the first segment, and whether case is to be folded.
  let prefix = "";
  let rest = unified;
  let windows = false;
  if (unified.startsWith("//")) {
    prefix = "//";
    rest = unified.slice(2);
    windows = true;
  } else if (/^[A-Za-z]:/.test(unified)) {
    prefix = unified.slice(0, 2);
    rest = unified.slice(2);
    windows = true;
  }
  // A UNC path is always absolute. A drive letter may be followed by a
  // relative path (`C:replays`), which is relative to that drive.
  const rooted = prefix === "//" || rest.startsWith("/");

  const segments: string[] = [];
  for (const segment of rest.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      const last = segments[segments.length - 1];
      if (last !== undefined && last !== "..") segments.pop();
      // Above the root is still the root; above where a relative path starts
      // is somewhere this cannot name, so it stays.
      else if (!rooted) segments.push("..");
      continue;
    }
    segments.push(segment);
  }

  const normalized = (prefix + (rooted && prefix !== "//" ? "/" : "") + segments.join("/")) || ".";
  return windows ? normalized.toLowerCase() : normalized;
}
