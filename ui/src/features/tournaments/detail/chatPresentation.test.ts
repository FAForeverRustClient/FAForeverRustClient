// The chat's mention rules, taken from the website, and how a post becomes a
// line of the Chat tab's log. Presentation only: the service resolves
// mentions itself, so what is pinned here is what the reader sees and what
// the composer offers.

import { describe, expect, it } from "vitest";
import type { ChatPost } from "../../../ipc/bindings";
import { player, team, tourney } from "../fixtures";
import {
  applyMention,
  mentionCandidates,
  mentionQuery,
  postMessage,
  quotedPosts,
  roomUsers,
} from "./chatPresentation";

const post = (over: Partial<ChatPost> = {}): ChatPost => ({
  id: "p1",
  author: "Ada",
  fafId: 7,
  body: "gl hf",
  at: 1_800_000_000,
  system: false,
  replyTo: null,
  everyone: false,
  ...over,
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

describe("postMessage", () => {
  it("is an ordinary line, keyed on the post for replies", () => {
    expect(postMessage(post({ replyTo: { id: "p0", author: "Bob", body: "hi" } }))).toEqual({
      id: "p1",
      sender: "Ada",
      content: "gl hf",
      timestamp: new Date(1_800_000_000_000).toISOString(),
      kind: "message",
      msgid: "p1",
      replyTo: "p0",
    });
  });

  it("makes the service's announcements info lines without a name or a time it does not have", () => {
    const line = postMessage(post({ author: "server", system: true, at: null }));
    expect(line.kind).toBe("info");
    expect(line.sender).toBe("");
    expect(line.timestamp).toBe("");
  });
});

describe("quotedPosts", () => {
  it("keeps the service's snapshot of each quoted post, whether or not it is still loaded", () => {
    const quotes = quotedPosts([post({ id: "p2", replyTo: { id: "gone", author: "Bob", body: "first" } })]);
    expect(quotes.get("gone")).toMatchObject({ sender: "Bob", content: "first", msgid: "gone" });
    expect(quotes.size).toBe(1);
  });
});

describe("roomUsers", () => {
  it("marks the organisers as operators and lists each name once", () => {
    const event = tourney({
      organisers: ["Ada"],
      players: [player({ id: "p1", name: "ada" }), player({ id: "p2", name: "Nuggets" })],
    });
    expect(roomUsers(event)).toEqual([
      { name: "Ada", elevation: "@" },
      { name: "Nuggets", elevation: "" },
    ]);
  });
});
