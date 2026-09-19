import { afterEach, describe, expect, it } from "vitest";

import {
  addSettingsIndexEntry,
  sectionMatches,
  removeSettingsIndexEntry,
  resetSettingsIndexForTests,
  settingsIndexEntriesForTests,
} from "./settingsSearch";

afterEach(resetSettingsIndexForTests);

describe("the settings search index", () => {
  it("finds a section by any word a row contributed", () => {
    addSettingsIndexEntry("appearance", "Sidebar width");
    addSettingsIndexEntry("appearance", "Normal is the width the client opens at.");

    // The label, a word from the hint, and the case the reader typed.
    expect(sectionMatches("appearance", "sidebar")).toBe(true);
    expect(sectionMatches("appearance", "WIDTH")).toBe(true);
    expect(sectionMatches("appearance", "opens at")).toBe(true);
    expect(sectionMatches("appearance", "wine prefix")).toBe(false);
  });

  it("matches a name however the reader punctuates it", () => {
    addSettingsIndexEntry("chat", "Auto-join #newbie channel");

    for (const query of ["auto-join", "auto join"]) {
      expect(sectionMatches("chat", query), query).toBe(true);
    }
  });

  it("answers yes for every section while the box is empty", () => {
    addSettingsIndexEntry("chat", "Hide foe messages");
    expect(sectionMatches("chat", "")).toBe(true);
    expect(sectionMatches("chat", "   ")).toBe(true);
    // Including one that has contributed nothing at all.
    expect(sectionMatches("cache", "")).toBe(true);
  });

  it("keeps a phrase two rows share until both are gone", () => {
    // A label and the ARIA label of its own control are the same words, which
    // is why the entries are counted rather than held in a set: unmounting one
    // must not take the phrase away from the other.
    addSettingsIndexEntry("chat", "Visible history");
    addSettingsIndexEntry("chat", "Visible history");

    removeSettingsIndexEntry("chat", "Visible history");
    expect(sectionMatches("chat", "visible history")).toBe(true);

    removeSettingsIndexEntry("chat", "Visible history");
    expect(sectionMatches("chat", "visible history")).toBe(false);
  });

  it("forgets a section once its last row has unmounted", () => {
    addSettingsIndexEntry("diagnostics", "Client logs");
    expect(settingsIndexEntriesForTests("diagnostics")).toEqual(["client logs"]);

    removeSettingsIndexEntry("diagnostics", "Client logs");
    expect(settingsIndexEntriesForTests("diagnostics")).toEqual([]);
  });

  it("ignores a row with nothing to say rather than matching everything", () => {
    // A row whose label is an element rather than a string contributes no text.
    // The empty phrase must not become an entry, or `includes("")` would make
    // that section match every query ever typed.
    addSettingsIndexEntry("game", "   ");
    expect(settingsIndexEntriesForTests("game")).toEqual([]);
    expect(sectionMatches("game", "anything")).toBe(false);
  });
});
