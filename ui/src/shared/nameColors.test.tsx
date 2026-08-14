import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ChatPreferences, SocialState } from "../ipc/bindings";
import {
  PlayerName,
  assignedPlayerColor,
  includesName,
  nickHue,
  playerColorLookup,
  resolvePlayerStyle,
} from "./nameColors";

const EMPTY_SOCIAL: SocialState = {
  friends: [],
  foes: [],
  players: [],
};

const DEFAULT_CHAT_PREFS: ChatPreferences = {
  showJoinsParts: false,
  showTimestamps: true,
  use24HourTime: true,
  coloredNames: false,
  rosterWidth: 236,
  hideFoeMessages: true,
  visibleMessageLimit: 500,
  autoJoinChannels: [],
  autoJoinLanguageChannel: true,
  mutedPlayers: [],
  readMarkers: {},
  hiddenRosterCategories: [],
  nameColors: {
    friends: "",
    foes: "",
    moderators: "",
    admins: "",
    players: {},
  },
};

describe("nameColors", () => {
  it("computes deterministic hues per nickname", () => {
    expect(nickHue("Player1")).toBe(nickHue("Player1"));
    expect(nickHue("Bebra560")).not.toBe(nickHue("sixkill_bad"));
  });

  it("matches names case-insensitively with accents", () => {
    expect(includesName(["Alice", "Bob"], "alice")).toBe(true);
    expect(includesName(["Alice", "Bob"], "ALICE")).toBe(true);
    expect(includesName(["Alice", "Bob"], "Charlie")).toBe(false);
  });

  it("keeps accents significant, so lookups are not merely stripped", () => {
    // The replaced `localeCompare(…, { sensitivity: "accent" })` ignored case
    // but respected accents. Losing the second half would silently merge
    // distinct nicknames onto one colour.
    expect(includesName(["René"], "rené")).toBe(true);
    expect(includesName(["René"], "Rene")).toBe(false);
    expect(assignedPlayerColor({ "René": "#fff" }, "Rene")).toBeUndefined();
  });

  it("looks assigned colours up case-insensitively", () => {
    const players = { Alice: "#123456" };
    expect(assignedPlayerColor(players, "alice")).toBe("#123456");
    expect(assignedPlayerColor(players, "ALICE")).toBe("#123456");
    expect(assignedPlayerColor(players, "Bob")).toBeUndefined();
  });

  it("caches derived lookups per source object and rebuilds when it changes", () => {
    // The cache is what makes this O(1) per nickname instead of O(assigned
    // colours). It is keyed on identity, and the frontend reducer only
    // replaces slices an event actually touched.
    const players = { Alice: "#123456" };
    expect(playerColorLookup(players)).toBe(playerColorLookup(players));
    expect(playerColorLookup({ Alice: "#123456" })).not.toBe(playerColorLookup(players));

    const renamed = { Alice: "#abcdef" };
    expect(assignedPlayerColor(renamed, "alice")).toBe("#abcdef");
  });

  it("prioritizes specifically assigned player colors", () => {
    const social: SocialState = {
      friends: ["Alice"],
      foes: [],
      players: [],
    };
    const prefs: ChatPreferences = {
      ...DEFAULT_CHAT_PREFS,
      nameColors: {
        ...DEFAULT_CHAT_PREFS.nameColors,
        friends: "#00ff00",
        players: { alice: "#ff00ff" },
      },
    };

    const style = resolvePlayerStyle("Alice", social, prefs);
    expect(style).toEqual({ color: "#ff00ff" });
  });

  it("resolves friend color when assigned", () => {
    const social: SocialState = {
      friends: ["Alice"],
      foes: [],
      players: [],
    };
    const prefs: ChatPreferences = {
      ...DEFAULT_CHAT_PREFS,
      nameColors: {
        ...DEFAULT_CHAT_PREFS.nameColors,
        friends: "#0000ff",
      },
    };

    const style = resolvePlayerStyle("Alice", social, prefs);
    expect(style).toEqual({ color: "#0000ff" });
  });

  it("resolves foe color when assigned", () => {
    const social: SocialState = {
      friends: [],
      foes: ["Bob"],
      players: [],
    };
    const prefs: ChatPreferences = {
      ...DEFAULT_CHAT_PREFS,
      nameColors: {
        ...DEFAULT_CHAT_PREFS.nameColors,
        foes: "#ff0000",
      },
    };

    const style = resolvePlayerStyle("Bob", social, prefs);
    expect(style).toEqual({ color: "#ff0000" });
  });

  it("falls back to random hue when coloredNames is enabled", () => {
    const prefs: ChatPreferences = {
      ...DEFAULT_CHAT_PREFS,
      coloredNames: true,
    };

    const style = resolvePlayerStyle("Charlie", EMPTY_SOCIAL, prefs);
    expect(style).toBeDefined();
    expect(style?.color).toMatch(/^hsl\(\d+, 75%, 65%\)$/);
  });

  it("returns undefined when no special color is configured and coloredNames is off", () => {
    const style = resolvePlayerStyle("Dave", EMPTY_SOCIAL, DEFAULT_CHAT_PREFS);
    expect(style).toBeUndefined();
  });

  it("renders PlayerName element markup with title and content", () => {
    const markup = renderToStaticMarkup(<PlayerName name="Alice" className="test-player" />);
    expect(markup).toContain('<span class="test-player" title="Alice">Alice</span>');
  });
});
