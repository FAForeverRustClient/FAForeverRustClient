import { describe, expect, it } from "vitest";
import { allFolderEntries, FOLDER_GROUPS } from "./gameFolders";

describe("the folder catalogue", () => {
  it("gives every entry an id of its own", () => {
    const ids = allFolderEntries().map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("covers every client folder the shell knows how to open", () => {
    // The bridge's `ClientFolder` union, spelled out: a folder added there and
    // not here would silently never be reachable from either surface.
    const folders = allFolderEntries()
      .map((entry) => (entry.target.kind === "client" ? entry.target.folder : null))
      .filter((folder) => folder !== null);
    expect(folders).toEqual(["maps", "mods", "replays", "vault", "gameCache", "gamePrefs"]);
  });

  it("covers both log folders", () => {
    const logs = allFolderEntries()
      .map((entry) => (entry.target.kind === "log" ? entry.target.log : null))
      .filter((log) => log !== null);
    expect(logs).toEqual(["game", "client"]);
  });

  it("puts the client folders before the diagnostics", () => {
    expect(FOLDER_GROUPS.map((group) => group.id)).toEqual(["client", "diagnostics"]);
  });
});
