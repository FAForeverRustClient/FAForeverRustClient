// The chat's mention rules, taken from the website. Presentation only: the
// service resolves mentions itself, so what is pinned here is what the reader
// sees and what the composer offers.

import { describe, expect, it } from "vitest";
import { player, team, tourney } from "../fixtures";
import { applyMention, mentionCandidates, mentionQuery, mentionSpans } from "./chatPresentation";

describe("mentionSpans", () => {
  it("marks each @word at the start or after a space", () => {
    expect(mentionSpans("@Ada gl, @Nuggets!")).toEqual([
      { kind: "mention", text: "@Ada" },
      { kind: "text", text: " gl, " },
      { kind: "mention", text: "@Nuggets!" },
    ]);
  });

  it("leaves an address inside a word alone", () => {
    expect(mentionSpans("mail me at a@b.c")).toEqual([{ kind: "text", text: "mail me at a@b.c" }]);
  });
});

describe("mentionQuery", () => {
  it("finds the word being typed after an @", () => {
    expect(mentionQuery("hi @Ad", 6)).toEqual({ start: 3, query: "ad" });
  });

  it("is off once a space follows, and inside a word", () => {
    expect(mentionQuery("hi @Ada ", 8)).toBeNull();
    expect(mentionQuery("a@b", 3)).toBeNull();
  });
});

describe("mentionCandidates", () => {
  const event = tourney({
    players: [player({ id: "p1", name: "Ada" }), player({ id: "p2", name: "Nuggets" })],
    teams: [team({ id: "t1", name: "Adamant" })],
  });

  it("offers entrants and teams by substring", () => {
    expect(mentionCandidates(event, "ad")).toEqual(["Ada", "Adamant"]);
  });

  it("offers everyone to an organiser only", () => {
    expect(mentionCandidates(event, "every")).toEqual([]);
    const organised = tourney({ ...event, viewer: { ...event.viewer, organiser: true } });
    expect(mentionCandidates(organised, "every")).toEqual(["everyone"]);
  });
});

describe("applyMention", () => {
  it("replaces the typed word and puts the caret after it", () => {
    expect(applyMention("hi @Ad there", 6, { start: 3, query: "ad" }, "Ada")).toEqual({
      text: "hi @Ada  there",
      caret: 8,
    });
  });
});
