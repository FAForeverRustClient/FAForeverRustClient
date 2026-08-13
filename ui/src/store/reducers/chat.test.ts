// Conformance tests for the frontend chat reducer.
//
// This file exists because `reduceChat` is a *hand-written twin* of
// `faf_domain::state::chat::reduce`. TypeScript's exhaustive switch catches a
// missing event variant; nothing catches the same variant taking a different
// transition. That is not hypothetical: `userLeft` and `userElevationChanged`
// used to create a channel here that the Rust reducer leaves alone, and there
// is no reconciliation that would have healed it: `src-tauri` re-sends a full
// snapshot only when the event broadcast lags.
//
// Each case below names the Rust arm it mirrors. When you change one, change
// both.

import { describe, expect, it } from "vitest";
import type { ChatChannel, ChatEvent, ChatMessage, ChatState, ChatUser } from "../../ipc/bindings";
import { mentions, reduceChat } from "./chat";

const DEFAULT_CHANNEL = "#aeolus";

function state(overrides: Partial<ChatState> = {}): ChatState {
  return {
    status: "connected",
    username: "Ada",
    channels: [],
    retainedHistories: [],
    activeChannel: "",
    showJoinsParts: false,
    serverAutoJoin: [],
    ...overrides,
  };
}

function channel(name: string, overrides: Partial<ChatChannel> = {}): ChatChannel {
  return {
    name,
    topic: "",
    messages: [],
    users: [],
    unread: 0,
    unreadMentions: 0,
    ...overrides,
  };
}

function user(name: string, elevation = ""): ChatUser {
  return { name, elevation };
}

let nextMessageId = 0;

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  nextMessageId += 1;
  return {
    id: `m${nextMessageId}`,
    sender: "Bob",
    content: "hello",
    timestamp: "2026-01-01T00:00:00Z",
    kind: "message",
    ...overrides,
  };
}

const apply = (initial: ChatState, ...events: ChatEvent[]): ChatState =>
  events.reduce(reduceChat, initial);

describe("channel bookkeeping", () => {
  it("focuses the first channel joined, and always the default one", () => {
    // Rust: `ChannelJoined` takes focus when nothing is active, or when the
    // channel is the default one.
    const first = apply(state(), { type: "channelJoined", payload: { channel: "#uef" } });
    expect(first.activeChannel).toBe("#uef");

    const withDefault = apply(first, {
      type: "channelJoined",
      payload: { channel: DEFAULT_CHANNEL },
    });
    expect(withDefault.activeChannel).toBe(DEFAULT_CHANNEL);

    const other = apply(withDefault, { type: "channelJoined", payload: { channel: "#aeon" } });
    expect(other.activeChannel).toBe(DEFAULT_CHANNEL);
  });

  it("sorts the default channel first, then public, then private", () => {
    // Rust: `sort_channels`.
    const next = apply(
      state(),
      { type: "channelJoined", payload: { channel: "Zoe" } },
      { type: "channelJoined", payload: { channel: "#uef" } },
      { type: "channelJoined", payload: { channel: DEFAULT_CHANNEL } },
      { type: "channelJoined", payload: { channel: "#aeon" } },
    );
    expect(next.channels.map((c) => c.name)).toEqual([DEFAULT_CHANNEL, "#aeon", "#uef", "Zoe"]);
  });

  it("falls back to another channel when the active one is left", () => {
    // Rust: `ChannelLeft`.
    const next = apply(
      state({ channels: [channel("#uef"), channel("#aeon")], activeChannel: "#uef" }),
      { type: "channelLeft", payload: { channel: "#uef" } },
    );
    expect(next.channels.map((c) => c.name)).toEqual(["#aeon"]);
    expect(next.activeChannel).toBe("#aeon");
  });

  it("leaves no active channel when the last one goes", () => {
    const next = apply(state({ channels: [channel("#uef")], activeChannel: "#uef" }), {
      type: "channelLeft",
      payload: { channel: "#uef" },
    });
    expect(next.activeChannel).toBe("");
  });

  it("restores only locally retained messages when a channel is rejoined", () => {
    const saved = message({ content: "worth keeping" });
    const next = apply(
      state({
        channels: [channel("#uef", {
          topic: "stale topic",
          messages: [saved],
          users: [user("Bob", "@")],
          unread: 3,
          unreadMentions: 1,
        })],
        activeChannel: "#uef",
      }),
      { type: "channelLeft", payload: { channel: "#uef" } },
      { type: "channelJoined", payload: { channel: "#uef" } },
    );

    expect(next.channels).toEqual([channel("#uef", { messages: [saved] })]);
    expect(next.retainedHistories).toEqual([]);
  });

  it("restores a closed conversation when a new private message recreates it", () => {
    const oldMessage = message({ content: "old" });
    const newMessage = message({ content: "new" });
    const next = apply(
      state({ channels: [channel("Bob", { messages: [oldMessage] })], activeChannel: "" }),
      { type: "channelLeft", payload: { channel: "Bob" } },
      { type: "messageReceived", payload: { channel: "Bob", message: newMessage } },
    );

    expect(next.channels[0]?.messages).toEqual([oldMessage, newMessage]);
    expect(next.retainedHistories).toEqual([]);
  });

  it("ignores a selection of a channel that is not joined", () => {
    // Rust: `ChannelSelected` uses `channel_mut`, so an unknown name is a no-op
    // rather than a way to point `active_channel` at nothing.
    const before = state({ channels: [channel("#uef")], activeChannel: "#uef" });
    expect(apply(before, { type: "channelSelected", payload: { channel: "#nope" } })).toEqual(
      before,
    );
  });

  it("clears both counters when a channel is selected", () => {
    const next = apply(
      state({
        channels: [channel("#uef", { unread: 4, unreadMentions: 2 })],
        activeChannel: "",
      }),
      { type: "channelSelected", payload: { channel: "#uef" } },
    );
    expect(next.channels[0]).toMatchObject({ unread: 0, unreadMentions: 0 });
    expect(next.activeChannel).toBe("#uef");
  });
});

describe("roster events for a channel we are not in", () => {
  // The regression this file was written for. Rust uses `channel_mut` (no
  // creation) for these two, and `ensure_channel` (creation) for the rest.

  it("drops a userLeft for an unknown channel instead of creating a ghost", () => {
    const before = state({ channels: [channel("#uef")], activeChannel: "#uef" });
    const next = apply(before, {
      type: "userLeft",
      payload: { channel: "#gone", user: "Bob" },
    });
    expect(next.channels.map((c) => c.name)).toEqual(["#uef"]);
  });

  it("drops an elevation change for an unknown channel", () => {
    const before = state({ channels: [channel("#uef")], activeChannel: "#uef" });
    const next = apply(before, {
      type: "userElevationChanged",
      payload: { channel: "#gone", user: "Bob", elevation: "@" },
    });
    expect(next.channels.map((c) => c.name)).toEqual(["#uef"]);
  });

  it("does not resurrect a channel we just left", () => {
    // The concrete sequence: we are kicked, and a QUIT for that channel is
    // still in flight behind the PART.
    const next = apply(
      state({ channels: [channel("#uef", { users: [user("Bob")] })], activeChannel: "#uef" }),
      { type: "channelLeft", payload: { channel: "#uef" } },
      { type: "userLeft", payload: { channel: "#uef", user: "Bob" } },
    );
    expect(next.channels).toEqual([]);
    expect(next.activeChannel).toBe("");
  });

  it("still creates a channel for events that announce one", () => {
    // The other half of the rule: `usersUpdated`, `topicChanged`,
    // `userJoined` and `messageReceived` all use `ensure_channel` in Rust,
    // because they are how a channel first becomes known.
    const next = apply(
      state(),
      { type: "topicChanged", payload: { channel: "#uef", topic: "hi" } },
      { type: "userJoined", payload: { channel: "#aeon", user: user("Bob") } },
    );
    expect(next.channels.map((c) => c.name).sort()).toEqual(["#aeon", "#uef"]);
  });
});

describe("roster maintenance", () => {
  it("updates an elevation in place rather than duplicating the user", () => {
    // Rust: `UserJoined` matches on name first; IRC re-announces members on
    // a MODE change, and a second row for the same nick is a visible bug.
    const next = apply(
      state({ channels: [channel("#uef", { users: [user("Bob")] })] }),
      { type: "userJoined", payload: { channel: "#uef", user: user("Bob", "@") } },
    );
    expect(next.channels[0].users).toEqual([user("Bob", "@")]);
  });

  it("keeps the roster sorted case-insensitively", () => {
    // Rust: `sort_users`.
    const next = apply(
      state({ channels: [channel("#uef")] }),
      { type: "usersUpdated", payload: { channel: "#uef", users: [user("zoe"), user("Ada")] } },
    );
    expect(next.channels[0].users.map((u) => u.name)).toEqual(["Ada", "zoe"]);
  });

  it("renames a user everywhere, including ourselves", () => {
    // Rust: `UserRenamed` updates `state.username` and every roster.
    const next = apply(
      state({
        username: "Ada",
        channels: [
          channel("#uef", { users: [user("Ada"), user("Bob")] }),
          channel("#aeon", { users: [user("Ada")] }),
        ],
      }),
      { type: "userRenamed", payload: { oldName: "Ada", newName: "Zara" } },
    );
    expect(next.username).toBe("Zara");
    expect(next.channels[0].users.map((u) => u.name)).toEqual(["Bob", "Zara"]);
    expect(next.channels[1].users.map((u) => u.name)).toEqual(["Zara"]);
  });

  it("empties rosters on disconnect but keeps channels and history", () => {
    // Rust: `Disconnected` is deliberate, matching the Java client's per-channel
    // history retention across reconnects.
    const next = apply(
      state({
        channels: [channel("#uef", { users: [user("Bob")], messages: [message()] })],
      }),
      { type: "disconnected" },
    );
    expect(next.status).toBe("disconnected");
    expect(next.channels[0].users).toEqual([]);
    expect(next.channels[0].messages).toHaveLength(1);
  });
});

describe("unread counting", () => {
  const inactive = () => state({ channels: [channel("#uef")], activeChannel: "#other" });
  const receive = (initial: ChatState, msg: Partial<ChatMessage>, name = "#uef") =>
    apply(initial, {
      type: "messageReceived",
      payload: { channel: name, message: message(msg) },
    });

  it("counts a message in an inactive channel", () => {
    expect(receive(inactive(), {}).channels[0]).toMatchObject({ unread: 1, unreadMentions: 0 });
  });

  it("does not count messages in the active channel", () => {
    const next = receive(state({ channels: [channel("#uef")], activeChannel: "#uef" }), {});
    expect(next.channels[0].unread).toBe(0);
  });

  it("does not count our own lines, or client commentary", () => {
    // Rust: `from_self` plus the Info/Error kinds are excluded.
    expect(receive(inactive(), { sender: "Ada" }).channels[0].unread).toBe(0);
    expect(receive(inactive(), { kind: "info" }).channels[0].unread).toBe(0);
    expect(receive(inactive(), { kind: "error" }).channels[0].unread).toBe(0);
  });

  it("retains restored history without recreating an unread badge", () => {
    const next = apply(inactive(), {
      type: "messageReceivedQuietly",
      payload: { channel: "#uef", message: message({ content: "old history" }) },
    });
    expect(next.channels[0]).toMatchObject({ unread: 0, unreadMentions: 0 });
    expect(next.channels[0].messages).toHaveLength(1);
  });

  it("counts a mention as both unread and a mention", () => {
    const next = receive(inactive(), { content: "Ada: ping" });
    expect(next.channels[0]).toMatchObject({ unread: 1, unreadMentions: 1 });
  });

  it("treats every message in a private conversation as a mention", () => {
    // Rust: `is_private` short-circuits the mention check.
    const next = apply(state({ channels: [channel("Bob")], activeChannel: "#other" }), {
      type: "messageReceived",
      payload: { channel: "Bob", message: message({ content: "hey" }) },
    });
    expect(next.channels[0]).toMatchObject({ unread: 1, unreadMentions: 1 });
  });

  it("keeps only the most recent messages", () => {
    // Rust: `MAX_MESSAGES` drain. Both sides must keep the *newest*.
    let next = state({ channels: [channel("#uef")], activeChannel: "#uef" });
    for (let i = 0; i < 520; i += 1) {
      next = receive(next, { content: `line ${i}` });
    }
    expect(next.channels[0].messages).toHaveLength(500);
    const last = next.channels[0].messages[next.channels[0].messages.length - 1];
    expect(last.content).toBe("line 519");
  });
});

describe("server auto-join list", () => {
  // Twin of `normalize_channels`. The conformance fixture replays one case
  // through both reducers; these cover the edges it does not carry.

  it("adds the prefix the lobby omits and keeps the server's order", () => {
    const next = apply(state(), {
      type: "autoJoinAnnounced",
      payload: { channels: ["aeolus", "german", "#clan_qai"] },
    });
    expect(next.serverAutoJoin).toEqual(["#aeolus", "#german", "#clan_qai"]);
  });

  it("drops blanks and case-insensitive duplicates", () => {
    const next = apply(state(), {
      type: "autoJoinAnnounced",
      payload: { channels: [" aeolus ", "#AEOLUS", "", "   "] },
    });
    expect(next.serverAutoJoin).toEqual(["#aeolus"]);
  });

  it("folds only ASCII case, matching Rust's eq_ignore_ascii_case", () => {
    // Rust would keep both: it does not case-fold non-ASCII. A `toLowerCase()`
    // here would collapse them and silently diverge from the backend.
    const next = apply(state(), {
      type: "autoJoinAnnounced",
      payload: { channels: ["#ÉLITE", "#élite"] },
    });
    expect(next.serverAutoJoin).toEqual(["#ÉLITE", "#élite"]);
  });

  it("caps the list at 20", () => {
    const next = apply(state(), {
      type: "autoJoinAnnounced",
      payload: { channels: Array.from({ length: 40 }, (_, i) => `#chan${i}`) },
    });
    expect(next.serverAutoJoin).toHaveLength(20);
  });

  it("replaces the list rather than accumulating", () => {
    // Each `social` message carries the complete set.
    const next = apply(
      state(),
      { type: "autoJoinAnnounced", payload: { channels: ["aeolus", "german"] } },
      { type: "autoJoinAnnounced", payload: { channels: ["aeolus"] } },
    );
    expect(next.serverAutoJoin).toEqual(["#aeolus"]);
  });
});

describe("mentions", () => {
  // Twin of `faf_domain::state::chat::mentions`, which has its own Rust tests.
  it("matches on a word boundary, case-insensitively", () => {
    expect(mentions("hey Ada how are you", "ada")).toBe(true);
    expect(mentions("ADA!", "Ada")).toBe(true);
    expect(mentions("Adamant", "Ada")).toBe(false);
    expect(mentions("nomad Ada", "Ada")).toBe(true);
  });

  it("scans past a non-boundary hit rather than giving up", () => {
    // "Adamant" must not mask the real mention that follows it.
    expect(mentions("Adamant and Ada", "Ada")).toBe(true);
  });

  it("treats bracket and dash characters as part of a nickname", () => {
    // FAF nicknames carry clan tags like `[ECO]`.
    expect(mentions("[ECO]Ada", "Ada")).toBe(false);
    expect(mentions("hi Ada-", "Ada")).toBe(false);
  });

  it("never matches an empty username", () => {
    expect(mentions("anything", "")).toBe(false);
  });
});
